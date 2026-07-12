import { expect } from 'chai'
import {
    ScratchComputePipeline,
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import {
    createFakeGpu,
    createFakePipelineError,
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

    it('rejects local validation through a Promise without native or operation effects', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const promise = runtime.createComputePipeline({ program: null })

        expect(promise).to.be.instanceOf(Promise)
        const error = await rejectedDiagnostic(promise)
        expect(error.diagnostic.code).to.equal('SCRATCH_PIPELINE_PROGRAM_INVALID')
        expect(calls.nativeTimeline).to.deep.equal([])
        expect(calls.shaderModules).to.have.length(0)
        expect(calls.pipelineLayouts).to.have.length(0)
        expect(calls.asyncPipelineRequests).to.have.length(0)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
        expect(runtime.diagnostics.operations()).to.have.length(0)

        const program = runtime.createProgram({
            modules: [ computeWgsl ],
            entryPoints: {},
        })
        const entryPointError = await rejectedDiagnostic(
            runtime.createComputePipeline({ program })
        )
        expect(entryPointError.diagnostic.code).to.equal('SCRATCH_PROGRAM_ENTRY_POINT_MISSING')
        expect(entryPointError.diagnostic.message).to.include('ComputePipeline')

        const bindLayoutError = await rejectedDiagnostic(
            runtime.createComputePipeline({
                program: createProgram(runtime),
                bindLayouts: null,
            })
        )
        expect(bindLayoutError.diagnostic.code)
            .to.equal('SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE')
        expect(bindLayoutError.diagnostic.message).to.include('ComputePipeline')
        expect(calls.nativeTimeline).to.deep.equal([])
        expect(runtime.diagnostics.operations()).to.have.length(0)
    })

    it('creates one ready immutable wrapper through the native async compute path', async() => {

        const fixture = await createComputeFixture({
            compilationMessages: [ compilationMessage('warning', 'portable warning') ],
        })
        const pipeline = await fixture.runtime.createComputePipeline(fixture.descriptor)

        expect(pipeline).to.be.instanceOf(ScratchComputePipeline)
        expect(pipeline.pipelineKind).to.equal('compute')
        expect(pipeline.computeEntryPoint).to.equal('csMain')
        expect(pipeline.constants).to.deep.equal({ scale: 2 })
        expect(pipeline.compilationReport).to.deep.include({
            pipelineId: pipeline.id,
            pipelineKind: 'compute',
            programId: fixture.program.id,
            errorCount: 0,
            warningCount: 1,
            infoCount: 0,
        })
        expect(fixture.calls.nativeTimeline).to.deep.equal(expectedComputeIssueTimeline())
        expect(fixture.calls.asyncPipelineRequests).to.have.length(1)
        expect(fixture.calls.asyncPipelineRequests[0].kind).to.equal('compute')
        expect(fixture.calls.computePipelines).to.have.length(1)
        const nativeDescriptor = fixture.calls.asyncPipelineRequests[0].descriptor
        expect(nativeDescriptor.compute).to.deep.include({
            entryPoint: 'csMain',
            constants: { scale: 2 },
        })
        expect(nativeDescriptor.compute.module).to.equal(fixture.calls.shaderModules[0])
        expect(nativeDescriptor.layout).to.equal(fixture.calls.pipelineLayouts[0])
        expect(nativeDescriptor.label).to.equal(`${fixture.descriptor.label} [scratch:${pipeline.id}]`)
        expect(fixture.calls.shaderModules[0].descriptor.label)
            .to.equal(`${fixture.descriptor.label} shader module [scratch:${pipeline.id}]`)
        expect(fixture.calls.pipelineLayouts[0].descriptor.label)
            .to.equal(`${fixture.descriptor.label} layout [scratch:${pipeline.id}]`)
        expect(Object.isExtensible(pipeline)).to.equal(false)

        const operations = fixture.runtime.diagnostics.operations({
            targetKind: 'pipeline',
            pipelineId: pipeline.id,
        })
        expect(operations).to.have.length(1)
        expect(operations[0]).to.deep.include({
            kind: 'compute-pipeline-creation',
            status: 'succeeded',
        })
        expect(operations[0].compilationReport).to.equal(pipeline.compilationReport)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.deep.include({
            id: pipeline.id,
            label: fixture.descriptor.label,
            pipelineKind: 'compute',
            programId: fixture.program.id,
            programSourceHash: pipeline.compilationReport.combinedSourceHash,
            descriptorHash: operations[0].descriptor.hash,
            state: 'ready',
            lastCreationOperationId: operations[0].id,
            compilation: { errorCount: 0, warningCount: 1, infoCount: 0 },
        })
        expect(fixture.runtime.diagnostics.incidents({ pipelineId: pipeline.id })).to.have.length(0)
        expect(fixture.calls.uncapturedErrors).to.have.length(0)
    })

    it('pops every scope before awaiting and snapshots constants and source', async() => {

        const fixture = await createComputeFixture({
            deferCompilationInfo: true,
            deferAsyncPipelines: true,
            deferErrorScopePops: true,
        })
        const originalSource = fixture.program.modules[0]
        const promise = fixture.runtime.createComputePipeline(fixture.descriptor)
        let settled = false
        promise.finally(() => {
            settled = true
        })

        expect(fixture.calls.nativeTimeline).to.deep.equal(expectedComputeIssueTimeline())
        expect(fixture.errors.scopeDepth).to.equal(0)
        fixture.descriptor.constants.scale = 9
        fixture.program.modules[0] = 'mutated after native issue'

        fixture.pipelines.resolvePipeline(0)
        fixture.errors.settlePop(2)
        await settleMicrotasks()
        expect(settled).to.equal(false)
        fixture.errors.settlePop(0)
        fixture.pipelines.resolveCompilation(0, { messages: [] })
        await settleMicrotasks()
        expect(settled).to.equal(false)
        fixture.errors.settlePop(1)

        const pipeline = await promise
        expect(fixture.calls.asyncPipelineRequests[0].descriptor.compute.constants)
            .to.deep.equal({ scale: 2 })
        expect(fixture.calls.shaderModules[0].descriptor.code).to.equal(originalSource)
        expect(pipeline.constants).to.deep.equal({ scale: 2 })
        expect(() => {
            pipeline.constants.scale = 10
        }).to.throw(TypeError)
    })

    it('classifies compute compilation, pipeline, and support-object failures', async() => {

        const compilationFixture = await createComputeFixture({
            compilationMessages: [ compilationMessage('error', 'compute shader failed') ],
        })
        const compilationFailure = await rejectedDiagnostic(
            compilationFixture.runtime.createComputePipeline(compilationFixture.descriptor)
        )
        expect(compilationFailure.diagnostic.code)
            .to.equal('SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED')
        expect(compilationFailure.incident.failureStage).to.equal('shader-compilation')
        assertFailedPipelineFacts(compilationFixture, compilationFailure, 'failed')

        const pipelineFixture = await createComputeFixture()
        const pipelineError = createFakePipelineError('internal', 'compute pipeline failed')
        pipelineFixture.pipelines.rejectNextPipeline('compute', pipelineError)
        const pipelineFailure = await rejectedDiagnostic(
            pipelineFixture.runtime.createComputePipeline(pipelineFixture.descriptor)
        )
        expect(pipelineFailure.diagnostic.code)
            .to.equal('SCRATCH_PIPELINE_CREATION_INTERNAL_FAILED')
        expect(pipelineFailure.cause).to.equal(pipelineError)
        expect(pipelineFailure.incident.pipelineErrorReason).to.equal('internal')
        assertFailedPipelineFacts(pipelineFixture, pipelineFailure, 'failed')

        const supportFixture = await createComputeFixture()
        const supportError = Object.assign(new Error('compute support OOM'), {
            name: 'GPUOutOfMemoryError',
        })
        supportFixture.errors.failNext('createPipelineLayout', 'out-of-memory', supportError)
        const supportFailure = await rejectedDiagnostic(
            supportFixture.runtime.createComputePipeline(supportFixture.descriptor)
        )
        expect(supportFailure.diagnostic.code).to.equal('SCRATCH_PIPELINE_SUPPORT_OBJECT_FAILED')
        expect(supportFailure.incident.nativeErrorCategory).to.equal('out-of-memory')
        expect(supportFailure.incident).not.to.have.property('pressure')
        assertFailedPipelineFacts(supportFixture, supportFailure, 'failed')

        const nativeFixture = await createComputeFixture()
        const nativeError = new Error('createComputePipelineAsync synchronous failure')
        nativeFixture.errors.throwNext('createComputePipelineAsync', nativeError)
        const nativeFailure = await rejectedDiagnostic(
            nativeFixture.runtime.createComputePipeline(nativeFixture.descriptor)
        )
        expect(nativeFailure.diagnostic.code).to.equal('SCRATCH_PIPELINE_CREATION_NATIVE_FAILED')
        expect(nativeFailure.cause).to.equal(nativeError)
        expect(nativeFixture.errors.scopeDepth).to.equal(0)
        assertFailedPipelineFacts(nativeFixture, nativeFailure, 'failed')
    })

    it('cancels pending compute creation on every lifecycle dependency', async() => {

        const cases = [
            {
                codes: [
                    'SCRATCH_PIPELINE_CREATION_RUNTIME_DISPOSED',
                    'SCRATCH_PIPELINE_CREATION_DEVICE_LOST',
                ],
                act: fixture => fixture.runtime.dispose(),
            },
            {
                codes: [ 'SCRATCH_PIPELINE_CREATION_DEVICE_LOST' ],
                act: async(fixture) => {
                    fixture.errors.loseDevice({ reason: 'unknown', message: 'lost during compute creation' })
                    await settleMicrotasks()
                },
            },
            {
                codes: [ 'SCRATCH_PIPELINE_CREATION_PROGRAM_DISPOSED' ],
                act: fixture => fixture.program.dispose(),
            },
            {
                codes: [ 'SCRATCH_PIPELINE_CREATION_BIND_LAYOUT_DISPOSED' ],
                act: fixture => fixture.bindLayout.dispose(),
            },
        ]
        for (const testCase of cases) {
            const fixture = await createComputeFixture({
                deferCompilationInfo: true,
                deferAsyncPipelines: true,
            })
            const promise = fixture.runtime.createComputePipeline(fixture.descriptor)
            await testCase.act(fixture)
            fixture.pipelines.resolveCompilation(0, { messages: [] })
            fixture.pipelines.resolvePipeline(0)

            const error = await rejectedDiagnostic(promise)
            expect(error.diagnostic.code).to.equal(testCase.codes.length === 1
                ? testCase.codes[0]
                : 'SCRATCH_PIPELINE_CREATION_MULTIPLE_FAILURES')
            expect(error.incident.outcomes.map(outcome => outcome.diagnosticCode))
                .to.deep.equal(testCase.codes)
            expect(error.incident.failureStage).to.equal('lifecycle-recheck')
            assertFailedPipelineFacts(fixture, error, 'cancelled')
        }
    })

    it('keeps concurrent render and compute transactions isolated', async() => {

        const fake = createFakeGpu({
            deferCompilationInfo: true,
            deferAsyncPipelines: true,
            deferErrorScopePops: true,
        })
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const renderProgram = runtime.createProgram({
            modules: [ triangleWgsl ],
            entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
        })
        const computeProgram = createProgram(runtime)
        const renderPromise = runtime.createRenderPipeline({
            label: 'concurrent render pipeline',
            program: renderProgram,
            targets: [ { format: 'bgra8unorm' } ],
        })
        const computePromise = runtime.createComputePipeline({
            label: 'concurrent compute pipeline',
            program: computeProgram,
        })
        let renderSettled = false
        renderPromise.finally(() => {
            renderSettled = true
        })

        fake.pipelines.resolvePipeline(1)
        fake.pipelines.resolveCompilation(1, { messages: [] })
        fake.errors.settlePop(5)
        fake.errors.settlePop(3)
        fake.errors.settlePop(4)
        const computePipeline = await computePromise
        expect(renderSettled).to.equal(false)

        fake.pipelines.resolveCompilation(0, { messages: [] })
        fake.pipelines.resolvePipeline(0)
        fake.errors.settlePop(2)
        fake.errors.settlePop(0)
        fake.errors.settlePop(1)
        const renderPipeline = await renderPromise

        expect(renderPipeline.pipelineKind).to.equal('render')
        expect(computePipeline.pipelineKind).to.equal('compute')
        expect(runtime.diagnostics.snapshot().pipelines).to.have.length(2)
        expect(fake.errors.scopeDepth).to.equal(0)
    })

    it('removes compute current facts exactly once on wrapper and runtime disposal', async() => {

        const fixture = await createComputeFixture()
        const pipeline = await fixture.runtime.createComputePipeline(fixture.descriptor)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.have.length(1)

        pipeline.dispose()
        pipeline.dispose()
        expect(pipeline.isDisposed).to.equal(true)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.have.length(0)
        expect(fixture.runtime.diagnostics.operations({ kind: 'pipeline-disposal' })).to.have.length(1)

        const live = await fixture.runtime.createComputePipeline({
            ...fixture.descriptor,
            label: 'runtime-owned live compute pipeline',
        })
        fixture.runtime.dispose()
        expect(live.isDisposed).to.equal(true)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.have.length(0)
        expect(fixture.runtime.diagnostics.operations({ kind: 'pipeline-disposal' })).to.have.length(2)
    })
})

async function createComputeFixture(options = {}) {

    const fake = createFakeGpu(options)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const program = createProgram(runtime)
    const bindLayout = runtime.createBindLayout({
        group: 0,
        entries: [ {
            binding: 0,
            name: 'unusedUniform',
            type: 'uniform',
            visibility: [ 'compute' ],
        } ],
    })
    return {
        ...fake,
        runtime,
        program,
        bindLayout,
        descriptor: {
            label: 'async compute pipeline',
            program,
            compute: 'csMain',
            bindLayouts: [ bindLayout ],
            constants: { scale: 2 },
        },
    }
}

function createProgram(runtime) {

    return runtime.createProgram({
        label: 'async compute program',
        modules: [ computeWgsl ],
        entryPoints: { compute: 'csMain' },
    })
}

function assertFailedPipelineFacts(fixture, error, status) {

    expect(error.incident.kind).to.equal('pipeline-failure')
    expect(error.incident.target.kind).to.equal('pipeline')
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
    expect(fixture.calls.uncapturedErrors).to.have.length(0)
    expect(JSON.stringify(error.incident)).not.to.include(computeWgsl)
}

function expectedComputeIssueTimeline() {

    return [
        { type: 'push-error-scope', filter: 'out-of-memory' },
        { type: 'push-error-scope', filter: 'internal' },
        { type: 'push-error-scope', filter: 'validation' },
        { type: 'create-shader-module' },
        { type: 'create-pipeline-layout' },
        { type: 'get-compilation-info' },
        { type: 'create-compute-pipeline-async' },
        { type: 'pop-error-scope', filter: 'validation' },
        { type: 'pop-error-scope', filter: 'internal' },
        { type: 'pop-error-scope', filter: 'out-of-memory' },
    ]
}

function compilationMessage(type, message) {

    return { type, message, offset: 0, length: 0, lineNum: 0, linePos: 0 }
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
