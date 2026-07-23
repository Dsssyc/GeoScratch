import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRenderPipeline,
    ScratchRuntime,
} from 'geoscratch'
import {
    createFakeGpu,
    createFakePipelineError,
    createTestProgram,
    triangleWgsl,
} from './scratch-test-utils.js'

describe('ScratchRuntime async render pipeline creation', () => {

    it('rejects local validation through a Promise before pipeline-native effects', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const invalidProgram = runtime.createRenderPipeline({ program: null })

        expect(invalidProgram).to.be.instanceOf(Promise)
        const programError = await rejectedDiagnostic(invalidProgram)
        expect(programError.diagnostic.code).to.equal('SCRATCH_PIPELINE_PROGRAM_INVALID')
        expect(calls.pipelineLayouts).to.have.length(0)
        expect(calls.asyncPipelineRequests).to.have.length(0)
        expect(runtime.diagnostics.operations()).to.have.length(0)

        const computeProgram = await createTestProgram(runtime, {
            sourceParts: [ '@compute @workgroup_size(1) fn main() {}' ],
            compute: 'main',
        })
        calls.nativeTimeline.length = 0
        const stageError = await rejectedDiagnostic(
            runtime.createRenderPipeline({
                program: computeProgram,
                targets: [ { format: 'bgra8unorm' } ],
            })
        )
        expect(stageError.diagnostic.code).to.equal('SCRATCH_PIPELINE_VERTEX_STAGE_MISSING')
        expect(calls.nativeTimeline).to.deep.equal([])
        expect(calls.pipelineLayouts).to.have.length(0)
        expect(calls.asyncPipelineRequests).to.have.length(0)
    })

    it('creates one immutable wrapper from acknowledged stage modules', async() => {

        const fixture = await createRenderFixture()
        const pipeline = await fixture.runtime.createRenderPipeline(fixture.descriptor)

        expect(pipeline).to.be.instanceOf(ScratchRenderPipeline)
        expect(pipeline.pipelineKind).to.equal('render')
        expect(pipeline.vertex).to.deep.equal(fixture.program.vertex)
        expect(pipeline.fragment).to.deep.equal(fixture.program.fragment)
        expect(pipeline.vertex.entryPoint).to.equal('vsMain')
        expect(pipeline.fragment.entryPoint).to.equal('fsMain')
        expect(pipeline.vertex.constants).to.deep.equal({ vertexScale: 2 })
        expect(pipeline.fragment.constants).to.deep.equal({ fragmentAlpha: 0.5 })
        expect(pipeline.creationReport.stages).to.deep.equal([
            {
                stage: 'vertex',
                shaderModuleId: fixture.shaderModule.id,
                sourceHash: fixture.shaderModule.compilationReport.sourceHash,
                entryPoint: 'vsMain',
                constantKeys: [ 'vertexScale' ],
            },
            {
                stage: 'fragment',
                shaderModuleId: fixture.shaderModule.id,
                sourceHash: fixture.shaderModule.compilationReport.sourceHash,
                entryPoint: 'fsMain',
                constantKeys: [ 'fragmentAlpha' ],
            },
        ])
        expect(fixture.calls.shaderModules).to.have.length(1)
        expect(fixture.calls.asyncPipelineRequests).to.have.length(1)
        const nativeDescriptor = fixture.calls.asyncPipelineRequests[0].descriptor
        expect(nativeDescriptor.vertex).to.deep.include({
            module: fixture.shaderModule.gpuShaderModule,
            entryPoint: 'vsMain',
            constants: { vertexScale: 2 },
        })
        expect(nativeDescriptor.fragment).to.deep.include({
            module: fixture.shaderModule.gpuShaderModule,
            entryPoint: 'fsMain',
            constants: { fragmentAlpha: 0.5 },
        })
        expect(nativeDescriptor.layout).to.equal(fixture.calls.pipelineLayouts[0])
        expect(Object.isExtensible(pipeline)).to.equal(false)

        const [ operation ] = fixture.runtime.diagnostics.operations({
            targetKind: 'pipeline',
            pipelineId: pipeline.id,
        })
        expect(operation).to.deep.include({
            kind: 'render-pipeline-creation',
            status: 'succeeded',
        })
        expect(operation.pipelineCreationReport).to.deep.equal(pipeline.creationReport)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.deep.include({
            id: pipeline.id,
            label: fixture.descriptor.label,
            pipelineKind: 'render',
            programId: fixture.program.id,
            programContractHash: pipeline.creationReport.contractHash,
            descriptorHash: operation.descriptor.hash,
            state: 'ready',
            lastCreationOperationId: operation.id,
            stages: pipeline.creationReport.stages,
        })
    })

    it('snapshots the descriptor and issues every native step before awaiting', async() => {

        const fixture = await createRenderFixture({
            deferAsyncPipelines: true,
            deferErrorScopePops: true,
        })
        const pending = fixture.runtime.createRenderPipeline(fixture.descriptor)
        let settled = false
        pending.finally(() => {
            settled = true
        })

        expect(fixture.calls.nativeTimeline).to.deep.equal(expectedRenderIssueTimeline())
        expect(fixture.errors.scopeDepth).to.equal(0)
        fixture.descriptor.targets[0].blend.color.srcFactor = 'zero'
        fixture.descriptor.vertexBuffers[0].attributes[0].offset = 128
        fixture.descriptor.depthStencil.stencilFront.compare = 'never'
        fixture.descriptor.multisample.count = 8

        fixture.pipelines.resolvePipeline(0)
        fixture.errors.settlePop(2)
        await settleMicrotasks()
        expect(settled).to.equal(false)
        fixture.errors.settlePop(0)
        await settleMicrotasks()
        expect(settled).to.equal(false)
        fixture.errors.settlePop(1)

        const pipeline = await pending
        const nativeDescriptor = fixture.calls.asyncPipelineRequests[0].descriptor
        expect(nativeDescriptor.fragment.targets[0].blend.color.srcFactor).to.equal('src-alpha')
        expect(nativeDescriptor.vertex.buffers[0].attributes[0].offset).to.equal(0)
        expect(nativeDescriptor.depthStencil.stencilFront.compare).to.equal('always')
        expect(nativeDescriptor.multisample.count).to.equal(4)
        expect(pipeline.fragment.constants).to.deep.equal({ fragmentAlpha: 0.5 })
    })

    it('classifies and source-sanitizes native pipeline failures', async() => {

        const fixture = await createRenderFixture()
        const sourceExcerpt = 'fn vsMain(@builtin(vertex_index) vertexIndex: u32)'
        const nativeError = createFakePipelineError(
            'validation',
            `render pipeline rejected near ${sourceExcerpt}`
        )
        fixture.pipelines.rejectNextPipeline('render', nativeError)

        const failure = await rejectedDiagnostic(
            fixture.runtime.createRenderPipeline(fixture.descriptor)
        )
        expect(failure.diagnostic.code).to.equal('SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED')
        expect(failure.cause).to.equal(nativeError)
        expect(failure.incident.pipelineErrorReason).to.equal('validation')
        expect(failure.incident.nativeError.sourceExcerptRedacted).to.equal(true)
        expect(JSON.stringify(failure.incident)).not.to.include(sourceExcerpt)
        assertFailedPipelineFacts(fixture, failure, 'failed')
    })

    it('classifies support-object, synchronous, and scope-settlement failures', async() => {

        const layoutFixture = await createRenderFixture()
        const layoutError = Object.assign(new Error('render layout OOM'), {
            name: 'GPUOutOfMemoryError',
        })
        layoutFixture.errors.failNext('createPipelineLayout', 'out-of-memory', layoutError)
        const layoutFailure = await rejectedDiagnostic(
            layoutFixture.runtime.createRenderPipeline(layoutFixture.descriptor)
        )
        expect(layoutFailure.diagnostic.code).to.equal('SCRATCH_PIPELINE_SUPPORT_OBJECT_FAILED')
        expect(layoutFailure.incident.nativeErrorCategory).to.equal('out-of-memory')
        assertFailedPipelineFacts(layoutFixture, layoutFailure, 'failed')

        const nativeFixture = await createRenderFixture()
        const nativeError = new Error('createRenderPipelineAsync synchronous failure')
        nativeFixture.errors.throwNext('createRenderPipelineAsync', nativeError)
        const nativeFailure = await rejectedDiagnostic(
            nativeFixture.runtime.createRenderPipeline(nativeFixture.descriptor)
        )
        expect(nativeFailure.diagnostic.code).to.equal('SCRATCH_PIPELINE_CREATION_NATIVE_FAILED')
        expect(nativeFailure.cause).to.equal(nativeError)
        assertFailedPipelineFacts(nativeFixture, nativeFailure, 'failed')

        const scopeFixture = await createRenderFixture({ deferErrorScopePops: true })
        const scopePending = scopeFixture.runtime.createRenderPipeline(scopeFixture.descriptor)
        const scopeError = new Error('render scope settlement failed')
        scopeFixture.errors.rejectPop(0, scopeError)
        scopeFixture.errors.settlePop(1)
        scopeFixture.errors.settlePop(2)
        const scopeFailure = await rejectedDiagnostic(scopePending)
        expect(scopeFailure.diagnostic.code).to.equal('SCRATCH_PIPELINE_CREATION_SCOPE_FAILED')
        expect(scopeFailure.cause).to.equal(scopeError)
        assertFailedPipelineFacts(scopeFixture, scopeFailure, 'failed')
    })

    it('rechecks every lifecycle dependency after native settlement', async() => {

        const cases = [
            [ 'program', fixture => fixture.program.dispose(), 'SCRATCH_PIPELINE_CREATION_PROGRAM_DISPOSED' ],
            [ 'layout', fixture => fixture.bindLayout.dispose(), 'SCRATCH_PIPELINE_CREATION_BIND_LAYOUT_DISPOSED' ],
            [ 'device', fixture => fixture.errors.loseDevice(), 'SCRATCH_PIPELINE_CREATION_DEVICE_LOST' ],
        ]
        for (const [ name, act, code ] of cases) {
            const fixture = await createRenderFixture({ deferAsyncPipelines: true })
            const pending = fixture.runtime.createRenderPipeline(fixture.descriptor)
            act(fixture)
            await settleMicrotasks()
            fixture.pipelines.resolvePipeline(0)

            const error = await rejectedDiagnostic(pending)
            expect(error.diagnostic.code, name).to.equal(code)
            assertFailedPipelineFacts(fixture, error, 'cancelled')
        }
    })

    it('keeps concurrent render transactions isolated under reverse settlement', async() => {

        const fixture = await createRenderFixture({ deferAsyncPipelines: true })
        const first = fixture.runtime.createRenderPipeline({
            ...fixture.descriptor,
            label: 'first render pipeline',
        })
        const second = fixture.runtime.createRenderPipeline({
            ...fixture.descriptor,
            label: 'second render pipeline',
        })
        let firstSettled = false
        first.finally(() => {
            firstSettled = true
        })

        fixture.pipelines.resolvePipeline(1)
        const secondPipeline = await second
        expect(firstSettled).to.equal(false)
        fixture.pipelines.resolvePipeline(0)
        const firstPipeline = await first

        expect(firstPipeline.id).not.to.equal(secondPipeline.id)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.have.length(2)
        expect(fixture.runtime.diagnostics.operations({
            kind: 'render-pipeline-creation',
            status: 'succeeded',
        })).to.have.length(2)
    })

    it('removes render facts exactly once on wrapper and Runtime disposal', async() => {

        const fixture = await createRenderFixture()
        const pipeline = await fixture.runtime.createRenderPipeline(fixture.descriptor)

        pipeline.dispose()
        pipeline.dispose()
        expect(pipeline.isDisposed).to.equal(true)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.have.length(0)
        expect(fixture.runtime.diagnostics.operations({ kind: 'pipeline-disposal' }))
            .to.have.length(1)

        const live = await fixture.runtime.createRenderPipeline({
            ...fixture.descriptor,
            label: 'runtime-owned render pipeline',
        })
        fixture.runtime.dispose()
        expect(live.isDisposed).to.equal(true)
        expect(fixture.runtime.diagnostics.operations({ kind: 'pipeline-disposal' }))
            .to.have.length(2)
    })
})

async function createRenderFixture(deferred = {}) {

    const controls = {
        deferAsyncPipelines: false,
        deferErrorScopePops: false,
    }
    const fake = createFakeGpu(controls)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const shaderModule = await runtime.createShaderModule({
        label: 'async render module',
        sourceParts: [ { code: triangleWgsl } ],
    })
    const vertexConstants = { vertexScale: 2 }
    const fragmentConstants = { fragmentAlpha: 0.5 }
    const program = runtime.createProgram({
        label: 'async render program',
        vertex: {
            module: shaderModule,
            entryPoint: 'vsMain',
            constants: vertexConstants,
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fsMain',
            constants: fragmentConstants,
        },
    })
    vertexConstants.vertexScale = 99
    fragmentConstants.fragmentAlpha = 0
    const bindLayout = await runtime.createBindLayout({
        group: 0,
        entries: [ {
            binding: 0,
            name: 'unusedUniform',
            type: 'uniform',
            visibility: [ 'vertex' ],
        } ],
    })
    fake.errors.resetHistory()
    Object.assign(controls, deferred)
    return {
        ...fake,
        runtime,
        shaderModule,
        program,
        bindLayout,
        descriptor: renderDescriptor(program, bindLayout),
    }
}

function renderDescriptor(program, bindLayout) {

    return {
        label: 'async render pipeline',
        program,
        layout: { mode: 'explicit', bindLayouts: [ bindLayout ] },
        vertexBuffers: [ {
            arrayStride: 8,
            stepMode: 'vertex',
            attributes: [ { shaderLocation: 0, offset: 0, format: 'float32x2' } ],
        } ],
        targets: [ {
            format: 'bgra8unorm',
            blend: {
                color: {
                    operation: 'add',
                    srcFactor: 'src-alpha',
                    dstFactor: 'one-minus-src-alpha',
                },
                alpha: {
                    operation: 'add',
                    srcFactor: 'one',
                    dstFactor: 'zero',
                },
            },
            writeMask: 0xF,
        } ],
        primitive: {
            topology: 'triangle-strip',
            stripIndexFormat: 'uint32',
            frontFace: 'cw',
            cullMode: 'back',
            unclippedDepth: true,
        },
        depthStencil: {
            format: 'depth24plus-stencil8',
            depthWriteEnabled: true,
            depthCompare: 'less',
            stencilFront: {
                compare: 'always',
                failOp: 'keep',
                depthFailOp: 'keep',
                passOp: 'replace',
            },
            stencilBack: {
                compare: 'equal',
                failOp: 'zero',
                depthFailOp: 'invert',
                passOp: 'keep',
            },
            stencilReadMask: 0xFF,
            stencilWriteMask: 0x7F,
            depthBias: 2,
            depthBiasSlopeScale: 1.5,
            depthBiasClamp: 0.25,
        },
        multisample: {
            count: 4,
            mask: 0xFFFF,
            alphaToCoverageEnabled: true,
        },
    }
}

function assertFailedPipelineFacts(fixture, error, status) {

    expect(error.incident.kind).to.equal('pipeline-failure')
    expect(error.incident.target.pipelineKind).to.equal('render')
    expect(error.incident.target.programId).to.equal(fixture.program.id)
    const operations = fixture.runtime.diagnostics.operations({
        targetKind: 'pipeline',
        pipelineId: error.incident.target.pipelineId,
    })
    expect(operations).to.have.length(1)
    expect(operations[0].status).to.equal(status)
    expect(operations[0].incidentId).to.equal(error.incident.id)
    expect(fixture.runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
    expect(fixture.runtime.diagnostics.snapshot().pipelines).to.have.length(0)
}

function expectedRenderIssueTimeline() {

    return [
        { type: 'push-error-scope', filter: 'out-of-memory' },
        { type: 'push-error-scope', filter: 'internal' },
        { type: 'push-error-scope', filter: 'validation' },
        { type: 'create-pipeline-layout' },
        { type: 'create-render-pipeline-async' },
        { type: 'pop-error-scope', filter: 'validation' },
        { type: 'pop-error-scope', filter: 'internal' },
        { type: 'pop-error-scope', filter: 'out-of-memory' },
    ]
}

async function settleMicrotasks() {

    await Promise.resolve()
    await Promise.resolve()
}

async function rejectedDiagnostic(promise) {

    try {
        await promise
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        return error
    }
    throw new Error('Expected a ScratchDiagnosticError rejection.')
}
