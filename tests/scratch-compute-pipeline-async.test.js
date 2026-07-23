import { expect } from 'chai'
import {
    ScratchComputePipeline,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import {
    createFakeGpu,
    createFakePipelineError,
    createTestProgram,
    triangleWgsl,
} from './scratch-test-utils.js'

const computeWgsl = `
override scale: f32 = 1.0;

@compute @workgroup_size(1)
fn csMain() {
    let value = scale;
}
`

describe('ScratchRuntime async compute pipeline creation', () => {

    it('rejects local validation through a Promise before pipeline-native effects', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const invalidProgram = runtime.createComputePipeline({ program: null })

        expect(invalidProgram).to.be.instanceOf(Promise)
        const programError = await rejectedDiagnostic(invalidProgram)
        expect(programError.diagnostic.code).to.equal('SCRATCH_PIPELINE_PROGRAM_INVALID')
        expect(calls.pipelineLayouts).to.have.length(0)
        expect(calls.asyncPipelineRequests).to.have.length(0)
        expect(runtime.diagnostics.operations()).to.have.length(0)

        const renderProgram = await createTestProgram(runtime, {
            sourceParts: [ triangleWgsl ],
            vertex: 'vsMain',
            fragment: 'fsMain',
        })
        calls.nativeTimeline.length = 0
        const stageError = await rejectedDiagnostic(
            runtime.createComputePipeline({ program: renderProgram })
        )
        expect(stageError.diagnostic.code).to.equal('SCRATCH_PIPELINE_COMPUTE_STAGE_MISSING')
        expect(calls.nativeTimeline).to.deep.equal([])
        expect(calls.pipelineLayouts).to.have.length(0)
        expect(calls.asyncPipelineRequests).to.have.length(0)
    })

    it('creates one immutable wrapper from an acknowledged ShaderModule', async() => {

        const fixture = await createComputeFixture()
        const pipeline = await fixture.runtime.createComputePipeline(fixture.descriptor)

        expect(pipeline).to.be.instanceOf(ScratchComputePipeline)
        expect(pipeline.pipelineKind).to.equal('compute')
        expect(pipeline.compute).to.deep.equal(fixture.program.compute)
        expect(pipeline.compute.entryPoint).to.equal('csMain')
        expect(pipeline.compute.constants).to.deep.equal({ scale: 2 })
        expect(pipeline.creationReport).to.deep.include({
            pipelineId: pipeline.id,
            pipelineKind: 'compute',
            programId: fixture.program.id,
        })
        expect(pipeline.creationReport.stages).to.deep.equal([ {
            stage: 'compute',
            shaderModuleId: fixture.shaderModule.id,
            sourceHash: fixture.shaderModule.compilationReport.sourceHash,
            entryPoint: 'csMain',
            constantKeys: [ 'scale' ],
        } ])
        expect(fixture.calls.shaderModules).to.have.length(1)
        expect(fixture.calls.asyncPipelineRequests).to.have.length(1)
        const nativeDescriptor = fixture.calls.asyncPipelineRequests[0].descriptor
        expect(nativeDescriptor.compute).to.deep.equal({
            module: fixture.shaderModule.gpuShaderModule,
            entryPoint: 'csMain',
            constants: { scale: 2 },
        })
        expect(nativeDescriptor.layout).to.equal(fixture.calls.pipelineLayouts[0])
        expect(Object.isExtensible(pipeline)).to.equal(false)

        const [ operation ] = fixture.runtime.diagnostics.operations({
            targetKind: 'pipeline',
            pipelineId: pipeline.id,
        })
        expect(operation).to.deep.include({
            kind: 'compute-pipeline-creation',
            status: 'succeeded',
        })
        expect(operation.pipelineCreationReport).to.deep.equal(pipeline.creationReport)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.deep.include({
            id: pipeline.id,
            label: fixture.descriptor.label,
            pipelineKind: 'compute',
            programId: fixture.program.id,
            programContractHash: pipeline.creationReport.contractHash,
            descriptorHash: operation.descriptor.hash,
            state: 'ready',
            lastCreationOperationId: operation.id,
            stages: pipeline.creationReport.stages,
        })
    })

    it('issues every pipeline operation before awaiting settlement', async() => {

        const fixture = await createComputeFixture({
            deferAsyncPipelines: true,
            deferErrorScopePops: true,
        })
        const pending = fixture.runtime.createComputePipeline(fixture.descriptor)
        let settled = false
        pending.finally(() => {
            settled = true
        })

        expect(fixture.calls.nativeTimeline).to.deep.equal(expectedComputeIssueTimeline())
        expect(fixture.errors.scopeDepth).to.equal(0)
        fixture.pipelines.resolvePipeline(0)
        fixture.errors.settlePop(2)
        await settleMicrotasks()
        expect(settled).to.equal(false)
        fixture.errors.settlePop(0)
        await settleMicrotasks()
        expect(settled).to.equal(false)
        fixture.errors.settlePop(1)

        const pipeline = await pending
        expect(pipeline.compute.constants).to.deep.equal({ scale: 2 })
        expect(fixture.runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
    })

    it('classifies native pipeline, support-object, and scope failures', async() => {

        const pipelineFixture = await createComputeFixture()
        const pipelineError = createFakePipelineError('internal', 'compute pipeline failed')
        pipelineFixture.pipelines.rejectNextPipeline('compute', pipelineError)
        const pipelineFailure = await rejectedDiagnostic(
            pipelineFixture.runtime.createComputePipeline(pipelineFixture.descriptor)
        )
        expect(pipelineFailure.diagnostic.code)
            .to.equal('SCRATCH_PIPELINE_CREATION_INTERNAL_FAILED')
        expect(pipelineFailure.cause).to.equal(pipelineError)
        assertFailedPipelineFacts(pipelineFixture, pipelineFailure, 'failed')

        const layoutFixture = await createComputeFixture()
        const layoutError = Object.assign(new Error('compute layout OOM'), {
            name: 'GPUOutOfMemoryError',
        })
        layoutFixture.errors.failNext('createPipelineLayout', 'out-of-memory', layoutError)
        const layoutFailure = await rejectedDiagnostic(
            layoutFixture.runtime.createComputePipeline(layoutFixture.descriptor)
        )
        expect(layoutFailure.diagnostic.code).to.equal('SCRATCH_PIPELINE_SUPPORT_OBJECT_FAILED')
        expect(layoutFailure.incident.nativeErrorCategory).to.equal('out-of-memory')
        assertFailedPipelineFacts(layoutFixture, layoutFailure, 'failed')

        const scopeFixture = await createComputeFixture({ deferErrorScopePops: true })
        const scopePromise = scopeFixture.runtime.createComputePipeline(scopeFixture.descriptor)
        const scopeError = new Error('compute scope settlement failed')
        scopeFixture.errors.rejectPop(0, scopeError)
        scopeFixture.errors.settlePop(1)
        scopeFixture.errors.settlePop(2)
        const scopeFailure = await rejectedDiagnostic(scopePromise)
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
            const fixture = await createComputeFixture({ deferAsyncPipelines: true })
            const pending = fixture.runtime.createComputePipeline(fixture.descriptor)
            act(fixture)
            await settleMicrotasks()
            fixture.pipelines.resolvePipeline(0)

            const error = await rejectedDiagnostic(pending)
            expect(error.diagnostic.code, name).to.equal(code)
            assertFailedPipelineFacts(fixture, error, 'cancelled')
        }
    })

    it('keeps concurrent render and compute transactions isolated', async() => {

        const controls = { deferAsyncPipelines: false }
        const fake = createFakeGpu(controls)
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const renderProgram = await createTestProgram(runtime, {
            sourceParts: [ triangleWgsl ],
            vertex: 'vsMain',
            fragment: 'fsMain',
        })
        const computeProgram = await createTestProgram(runtime, {
            sourceParts: [ computeWgsl ],
            compute: 'csMain',
        })
        fake.errors.resetHistory()
        controls.deferAsyncPipelines = true

        const renderPending = runtime.createRenderPipeline({
            program: renderProgram,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const computePending = runtime.createComputePipeline({ program: computeProgram })
        let renderSettled = false
        renderPending.finally(() => {
            renderSettled = true
        })

        fake.pipelines.resolvePipeline(1)
        const computePipeline = await computePending
        expect(renderSettled).to.equal(false)
        fake.pipelines.resolvePipeline(0)
        const renderPipeline = await renderPending

        expect(renderPipeline.pipelineKind).to.equal('render')
        expect(computePipeline.pipelineKind).to.equal('compute')
        expect(runtime.diagnostics.snapshot().pipelines).to.have.length(2)
    })

    it('removes compute facts exactly once on wrapper and Runtime disposal', async() => {

        const fixture = await createComputeFixture()
        const pipeline = await fixture.runtime.createComputePipeline(fixture.descriptor)

        pipeline.dispose()
        pipeline.dispose()
        expect(pipeline.isDisposed).to.equal(true)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.have.length(0)
        expect(fixture.runtime.diagnostics.operations({ kind: 'pipeline-disposal' }))
            .to.have.length(1)

        const live = await fixture.runtime.createComputePipeline({
            ...fixture.descriptor,
            label: 'runtime-owned compute pipeline',
        })
        fixture.runtime.dispose()
        expect(live.isDisposed).to.equal(true)
        expect(fixture.runtime.diagnostics.operations({ kind: 'pipeline-disposal' }))
            .to.have.length(2)
    })
})

async function createComputeFixture(deferred = {}) {

    const controls = {
        deferAsyncPipelines: false,
        deferErrorScopePops: false,
    }
    const fake = createFakeGpu(controls)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const shaderModule = await runtime.createShaderModule({
        label: 'async compute module',
        sourceParts: [ { code: computeWgsl } ],
    })
    const constants = { scale: 2 }
    const program = runtime.createProgram({
        label: 'async compute program',
        compute: {
            module: shaderModule,
            entryPoint: 'csMain',
            constants,
        },
    })
    constants.scale = 9
    const bindLayout = await runtime.createBindLayout({
        group: 0,
        entries: [ {
            binding: 0,
            name: 'unusedUniform',
            type: 'uniform',
            visibility: [ 'compute' ],
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
        descriptor: {
            label: 'async compute pipeline',
            program,
            layout: { mode: 'explicit', bindLayouts: [ bindLayout ] },
        },
    }
}

function assertFailedPipelineFacts(fixture, error, status) {

    expect(error.incident.kind).to.equal('pipeline-failure')
    expect(error.incident.target.pipelineKind).to.equal('compute')
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

function expectedComputeIssueTimeline() {

    return [
        { type: 'push-error-scope', filter: 'out-of-memory' },
        { type: 'push-error-scope', filter: 'internal' },
        { type: 'push-error-scope', filter: 'validation' },
        { type: 'create-pipeline-layout' },
        { type: 'create-compute-pipeline-async' },
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
