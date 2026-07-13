import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRenderPipeline,
    ScratchRuntime,
} from 'geoscratch'
import {
    createFakeGpu,
    createFakePipelineError,
    triangleWgsl,
} from './scratch-test-utils.js'

describe('ScratchRuntime async render pipeline creation', () => {

    it('rejects local validation through a Promise without native or operation effects', async() => {

        const { gpu, calls } = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu })
        const promise = runtime.createRenderPipeline({
            program: null,
            targets: [ { format: 'bgra8unorm' } ],
        })

        expect(promise).to.be.instanceOf(Promise)
        const error = await rejectedDiagnostic(promise)
        expect(error.diagnostic.code).to.equal('SCRATCH_PIPELINE_PROGRAM_INVALID')
        expect(calls.nativeTimeline).to.deep.equal([])
        expect(calls.shaderModules).to.have.length(0)
        expect(calls.pipelineLayouts).to.have.length(0)
        expect(calls.asyncPipelineRequests).to.have.length(0)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
        expect(runtime.diagnostics.operations()).to.have.length(0)
    })

    it('creates one ready wrapper through the native async render path', async() => {

        const { gpu, calls, errors } = createFakeGpu({
            compilationMessages: [
                compilationMessage('warning', 'portable warning', 1, 1, 1, 2),
                compilationMessage('info', 'portable info', 2, 1, 1, 3),
            ],
        })
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const bindLayout = await createIsolatedBindLayout(runtime, errors)
        const descriptor = renderDescriptor(program, bindLayout)

        const pipeline = await runtime.createRenderPipeline(descriptor)

        expect(pipeline).to.be.instanceOf(ScratchRenderPipeline)
        expect(pipeline.pipelineKind).to.equal('render')
        expect(pipeline.vertexEntryPoint).to.equal('vsMain')
        expect(pipeline.fragmentEntryPoint).to.equal('fsMain')
        expect(pipeline.compilationReport).to.deep.include({
            pipelineId: pipeline.id,
            pipelineKind: 'render',
            programId: program.id,
            errorCount: 0,
            warningCount: 1,
            infoCount: 1,
        })
        expect(calls.nativeTimeline).to.deep.equal(expectedRenderIssueTimeline())
        expect(calls.asyncPipelineRequests).to.have.length(1)
        expect(calls.asyncPipelineRequests[0].kind).to.equal('render')
        expect(calls.renderPipelines).to.have.length(1)
        const nativeDescriptor = calls.asyncPipelineRequests[0].descriptor
        expect(nativeDescriptor.vertex).to.deep.include({
            entryPoint: 'vsMain',
            buffers: descriptor.vertexBuffers,
        })
        expect(nativeDescriptor.fragment.entryPoint).to.equal('fsMain')
        expect(nativeDescriptor.fragment.targets).to.deep.equal(descriptor.targets)
        expect(nativeDescriptor.primitive).to.deep.equal({
            topology: 'triangle-strip',
            stripIndexFormat: 'uint32',
            frontFace: 'cw',
            cullMode: 'back',
            unclippedDepth: true,
        })
        expect(nativeDescriptor.depthStencil).to.deep.equal(descriptor.depthStencil)
        expect(nativeDescriptor.multisample).to.deep.equal(descriptor.multisample)
        expect(nativeDescriptor.layout).to.equal(calls.pipelineLayouts[0])
        expect(nativeDescriptor.vertex.module).to.equal(calls.shaderModules[0])
        expect(nativeDescriptor.fragment.module).to.equal(calls.shaderModules[0])
        expect(nativeDescriptor.label).to.equal(`${descriptor.label} [scratch:${pipeline.id}]`)
        expect(calls.shaderModules[0].descriptor.label)
            .to.equal(`${descriptor.label} shader module [scratch:${pipeline.id}]`)
        expect(calls.pipelineLayouts[0].descriptor.label)
            .to.equal(`${descriptor.label} layout [scratch:${pipeline.id}]`)
        expect(Object.isExtensible(pipeline)).to.equal(false)

        const operations = runtime.diagnostics.operations({
            targetKind: 'pipeline',
            pipelineId: pipeline.id,
        })
        expect(operations).to.have.length(1)
        expect(operations[0]).to.deep.include({
            kind: 'render-pipeline-creation',
            status: 'succeeded',
        })
        expect(operations[0].compilationReport).to.equal(pipeline.compilationReport)
        expect(runtime.diagnostics.snapshot().pipelines).to.deep.include({
            id: pipeline.id,
            label: descriptor.label,
            pipelineKind: 'render',
            programId: program.id,
            programSourceHash: pipeline.compilationReport.combinedSourceHash,
            descriptorHash: operations[0].descriptor.hash,
            state: 'ready',
            lastCreationOperationId: operations[0].id,
            compilation: { errorCount: 0, warningCount: 1, infoCount: 1 },
        })
        expect(runtime.diagnostics.incidents({ pipelineId: pipeline.id })).to.have.length(0)
        expect(calls.uncapturedErrors).to.have.length(0)
    })

    it('pops every scope before awaiting and joins arbitrary settlement order', async() => {

        const { gpu, calls, errors, pipelines } = createFakeGpu({
            deferCompilationInfo: true,
            deferAsyncPipelines: true,
            deferErrorScopePops: true,
        })
        const runtime = await ScratchRuntime.create({ gpu })
        const program = createProgram(runtime)
        const bindLayout = await createIsolatedBindLayout(runtime, errors, true)
        const descriptor = renderDescriptor(program, bindLayout)
        const promise = runtime.createRenderPipeline(descriptor)
        let settled = false
        promise.finally(() => {
            settled = true
        })

        expect(promise).to.be.instanceOf(Promise)
        expect(calls.nativeTimeline).to.deep.equal(expectedRenderIssueTimeline())
        expect(errors.scopeDepth).to.equal(0)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(1)

        descriptor.targets[0].blend.color.srcFactor = 'zero'
        descriptor.vertexBuffers[0].attributes[0].offset = 128
        descriptor.depthStencil.stencilFront.compare = 'never'
        descriptor.multisample.count = 8
        program.modules[0] = 'mutated after native issue'

        pipelines.resolvePipeline(0)
        errors.settlePop(2)
        await settleMicrotasks()
        expect(settled).to.equal(false)
        errors.settlePop(0)
        pipelines.resolveCompilation(0, { messages: [] })
        await settleMicrotasks()
        expect(settled).to.equal(false)
        errors.settlePop(1)

        const pipeline = await promise
        const nativeDescriptor = calls.asyncPipelineRequests[0].descriptor
        expect(nativeDescriptor.fragment.targets[0].blend.color.srcFactor).to.equal('src-alpha')
        expect(nativeDescriptor.vertex.buffers[0].attributes[0].offset).to.equal(0)
        expect(nativeDescriptor.depthStencil.stencilFront.compare).to.equal('always')
        expect(nativeDescriptor.multisample.count).to.equal(4)
        expect(calls.shaderModules[0].descriptor.code).to.equal(triangleWgsl)
        expect(runtime.diagnostics.snapshot().pendingOperations).to.have.length(0)
        expect(pipeline.compilationReport.nativeMessageCount).to.equal(0)
    })

    it('rejects shader compilation errors with a mapped bounded report', async() => {

        const fixture = await createRenderFixture({
            compilationMessages: [ compilationMessage(
                'error',
                'shader compilation failed',
                1,
                1,
                2,
                1
            ) ],
        })
        const error = await rejectedDiagnostic(
            fixture.runtime.createRenderPipeline(fixture.descriptor)
        )

        expect(error.diagnostic.code).to.equal('SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED')
        expect(error.incident.failureStage).to.equal('shader-compilation')
        expect(error.incident.compilationReport.errorCount).to.equal(1)
        expect(error.incident.compilationReport.messages[0].locationKind).to.equal('module')
        expect(error.incident.compilationReport.messages[0].moduleLocation.moduleIndex).to.equal(0)
        assertFailedPipelineFacts(fixture, error, 'failed')
    })

    it('classifies validation and internal GPUPipelineError rejections independently of scopes', async() => {

        const cases = [
            [ 'validation', 'SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED' ],
            [ 'internal', 'SCRATCH_PIPELINE_CREATION_INTERNAL_FAILED' ],
        ]
        for (const [ reason, code ] of cases) {
            const fixture = await createRenderFixture()
            const nativeError = createFakePipelineError(reason, `${reason} pipeline rejection`)
            fixture.pipelines.rejectNextPipeline('render', nativeError)

            const error = await rejectedDiagnostic(
                fixture.runtime.createRenderPipeline(fixture.descriptor)
            )

            expect(error.diagnostic.code).to.equal(code)
            expect(error.cause).to.equal(nativeError)
            expect(error.incident.pipelineErrorReason).to.equal(reason)
            expect(error.incident.nativeErrorCategory).to.equal(reason)
            expect(error.incident.failureStage).to.equal('pipeline-creation')
            expect(error.incident.outcomes).to.have.length(1)
            assertFailedPipelineFacts(fixture, error, 'failed')
        }
    })

    it('does not promote a reason-shaped rejection into GPUPipelineError facts', async() => {

        const fixture = await createRenderFixture()
        const forged = { reason: 'validation' }
        fixture.pipelines.rejectNextPipeline('render', forged)

        const error = await rejectedDiagnostic(
            fixture.runtime.createRenderPipeline(fixture.descriptor)
        )

        expect(error.diagnostic.code).to.equal('SCRATCH_PIPELINE_CREATION_NATIVE_FAILED')
        expect(error.incident.nativeErrorCategory).to.equal('native-exception')
        expect(error.incident).not.to.have.property('pipelineErrorReason')
        assertFailedPipelineFacts(fixture, error, 'failed')
    })

    it('source-sanitizes native pipeline error facts without changing the transient cause', async() => {

        const fixture = await createRenderFixture()
        const sourceExcerpt = 'fn vsMain(@builtin(vertex_index) vertexIndex: u32)'
        const nativeError = createFakePipelineError(
            'validation',
            `pipeline rejected near ${sourceExcerpt}`
        )
        fixture.pipelines.rejectNextPipeline('render', nativeError)

        const error = await rejectedDiagnostic(
            fixture.runtime.createRenderPipeline(fixture.descriptor)
        )
        const incidentJson = JSON.stringify(error.incident)

        expect(error.cause).to.equal(nativeError)
        expect(incidentJson).not.to.include(sourceExcerpt)
        expect(error.incident.nativeError.sourceExcerptRedacted).to.equal(true)
        expect(error.incident.outcomes[0].nativeError.sourceExcerptRedacted).to.equal(true)
        assertFailedPipelineFacts(fixture, error, 'failed')

        const scopeFixture = await createRenderFixture()
        const scopeError = new Error(`scope message ${sourceExcerpt}`)
        scopeError.name = `GPUValidationError ${sourceExcerpt}`
        scopeError.reason = `scope reason ${sourceExcerpt}`
        scopeFixture.errors.failNext('createShaderModule', 'validation', scopeError)

        const scopeFailure = await rejectedDiagnostic(
            scopeFixture.runtime.createRenderPipeline(scopeFixture.descriptor)
        )
        const scopeFacts = scopeFailure.incident.nativeError
        expect(JSON.stringify(scopeFailure.incident)).not.to.include(sourceExcerpt)
        expect(scopeFacts.sourceExcerptRedacted).to.equal(true)
        expect(scopeFacts.name).not.to.include(sourceExcerpt)
        expect(scopeFacts.message).not.to.include(sourceExcerpt)
        expect(scopeFacts.reason).not.to.include(sourceExcerpt)
        assertFailedPipelineFacts(scopeFixture, scopeFailure, 'failed')
    })

    it('classifies validation, internal, and OOM support-object scope errors', async() => {

        const cases = [
            [ 'validation', 'GPUValidationError' ],
            [ 'internal', 'GPUInternalError' ],
            [ 'out-of-memory', 'GPUOutOfMemoryError' ],
        ]
        for (const [ filter, name ] of cases) {
            const fixture = await createRenderFixture()
            const nativeError = Object.assign(new Error(`${filter} support failure`), { name })
            fixture.errors.failNext('createShaderModule', filter, nativeError)

            const error = await rejectedDiagnostic(
                fixture.runtime.createRenderPipeline(fixture.descriptor)
            )

            expect(error.diagnostic.code).to.equal('SCRATCH_PIPELINE_SUPPORT_OBJECT_FAILED')
            expect(error.cause).to.equal(nativeError)
            expect(error.incident.nativeErrorCategory).to.equal(filter)
            expect(error.incident.attribution).to.equal('enclosing-operation-family')
            expect(error.incident.failureStage).to.equal('supporting-object-creation')
            assertFailedPipelineFacts(fixture, error, 'failed')
        }
    })

    it('balances scopes and classifies synchronous native exceptions', async() => {

        const methods = [
            'createShaderModule',
            'createPipelineLayout',
            'getCompilationInfo',
            'createRenderPipelineAsync',
        ]
        for (const method of methods) {
            const fixture = await createRenderFixture()
            const nativeError = new Error(`${method} synchronous failure`)
            fixture.errors.throwNext(method, nativeError)

            const error = await rejectedDiagnostic(
                fixture.runtime.createRenderPipeline(fixture.descriptor)
            )

            expect(error.diagnostic.code).to.equal('SCRATCH_PIPELINE_CREATION_NATIVE_FAILED')
            expect(error.cause).to.equal(nativeError)
            expect(fixture.errors.scopeDepth).to.equal(0)
            expect(fixture.calls.errorScopes.filter(scope => scope.action === 'push')).to.have.length(3)
            expect(fixture.calls.errorScopes.filter(scope => scope.action === 'pop')).to.have.length(3)
            assertFailedPipelineFacts(fixture, error, 'failed')
        }
    })

    it('classifies compilation-info and scope settlement failures structurally', async() => {

        const compilationFixture = await createRenderFixture()
        const compilationError = new Error('compilation info rejected')
        compilationFixture.pipelines.rejectNextCompilation(compilationError)
        const compilationFailure = await rejectedDiagnostic(
            compilationFixture.runtime.createRenderPipeline(compilationFixture.descriptor)
        )
        expect(compilationFailure.diagnostic.code).to.equal('SCRATCH_PIPELINE_CREATION_SCOPE_FAILED')
        expect(compilationFailure.cause).to.equal(compilationError)
        expect(compilationFailure.incident.failureStage).to.equal('compilation-info')
        assertFailedPipelineFacts(compilationFixture, compilationFailure, 'failed')

        const scopeFixture = await createRenderFixture({
            deferCompilationInfo: true,
            deferAsyncPipelines: true,
            deferErrorScopePops: true,
        })
        const scopePromise = scopeFixture.runtime.createRenderPipeline(scopeFixture.descriptor)
        const scopeError = new Error('validation scope rejected')
        scopeFixture.pipelines.resolveCompilation(0, { messages: [] })
        scopeFixture.pipelines.resolvePipeline(0)
        scopeFixture.errors.rejectPop(0, scopeError)
        scopeFixture.errors.settlePop(1)
        scopeFixture.errors.settlePop(2)
        const scopeFailure = await rejectedDiagnostic(scopePromise)
        expect(scopeFailure.diagnostic.code).to.equal('SCRATCH_PIPELINE_CREATION_SCOPE_FAILED')
        expect(scopeFailure.cause).to.equal(scopeError)
        expect(scopeFailure.incident.failureStage).to.equal('scope-settlement')
        assertFailedPipelineFacts(scopeFixture, scopeFailure, 'failed')

        const malformedScopeFixture = await createRenderFixture()
        malformedScopeFixture.errors.failNext('createShaderModule', 'validation', {})
        const malformedScopeFailure = await rejectedDiagnostic(
            malformedScopeFixture.runtime.createRenderPipeline(malformedScopeFixture.descriptor)
        )
        expect(malformedScopeFailure.diagnostic.code)
            .to.equal('SCRATCH_PIPELINE_CREATION_SCOPE_FAILED')
        expect(malformedScopeFailure.incident.failureStage).to.equal('scope-settlement')
        assertFailedPipelineFacts(malformedScopeFixture, malformedScopeFailure, 'failed')
    })

    it('rejects a malformed value resolved by the async native pipeline Promise', async() => {

        const fixture = await createRenderFixture({ deferAsyncPipelines: true })
        const promise = fixture.runtime.createRenderPipeline(fixture.descriptor)
        fixture.pipelines.resolvePipeline(0, { type: 'forged render pipeline' })

        const error = await rejectedDiagnostic(promise)
        expect(error.diagnostic.code).to.equal('SCRATCH_PIPELINE_CREATION_NATIVE_FAILED')
        expect(error.incident.failureStage).to.equal('pipeline-creation')
        assertFailedPipelineFacts(fixture, error, 'failed')
    })

    it('retains every independent failure in fixed transaction-stage order', async() => {

        const fixture = await createRenderFixture({
            compilationMessages: [ compilationMessage('error', 'shader failed', 1, 1, 2, 1) ],
        })
        const supportError = Object.assign(new Error('support OOM'), {
            name: 'GPUOutOfMemoryError',
        })
        fixture.errors.failNext('createShaderModule', 'out-of-memory', supportError)
        fixture.pipelines.rejectNextPipeline(
            'render',
            createFakePipelineError('validation', 'pipeline validation failed')
        )

        const error = await rejectedDiagnostic(
            fixture.runtime.createRenderPipeline(fixture.descriptor)
        )

        expect(error.diagnostic.code).to.equal('SCRATCH_PIPELINE_CREATION_MULTIPLE_FAILURES')
        expect(error.incident.nativeErrorCategory).to.equal('none')
        expect(error.incident.attribution).to.equal('unknown')
        expect(error.incident).not.to.have.property('pipelineErrorReason')
        expect(error.incident.outcomes.map(outcome => outcome.stage)).to.deep.equal([
            'supporting-object-creation',
            'shader-compilation',
            'pipeline-creation',
        ])
        expect(error.incident.outcomes.map(outcome => outcome.diagnosticCode)).to.deep.equal([
            'SCRATCH_PIPELINE_SUPPORT_OBJECT_FAILED',
            'SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED',
            'SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED',
        ])
        expect(error.cause).to.equal(supportError)
        assertFailedPipelineFacts(fixture, error, 'failed')
    })

    it('cancels pending creation on runtime, device, Program, and BindLayout lifecycle changes', async() => {

        const cases = [
            {
                codes: [
                    'SCRATCH_PIPELINE_CREATION_RUNTIME_DISPOSED',
                    'SCRATCH_PIPELINE_CREATION_DEVICE_LOST',
                    'SCRATCH_PIPELINE_CREATION_BIND_LAYOUT_DISPOSED',
                ],
                act: fixture => fixture.runtime.dispose(),
            },
            {
                codes: [ 'SCRATCH_PIPELINE_CREATION_DEVICE_LOST' ],
                act: async(fixture) => {
                    fixture.errors.loseDevice({ reason: 'unknown', message: 'lost during pipeline creation' })
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
            const fixture = await createRenderFixture({
                deferCompilationInfo: true,
                deferAsyncPipelines: true,
            })
            const promise = fixture.runtime.createRenderPipeline(fixture.descriptor)
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
            expect(error.incident.outcomes[0].subject).to.be.an('object')
            assertFailedPipelineFacts(fixture, error, 'cancelled')
        }
    })

    it('retains every simultaneous lifecycle failure after native settlement', async() => {

        const fixture = await createRenderFixture({
            deferCompilationInfo: true,
            deferAsyncPipelines: true,
        })
        const promise = fixture.runtime.createRenderPipeline(fixture.descriptor)

        fixture.program.dispose()
        fixture.bindLayout.dispose()
        const sourceExcerpt = 'fn fsMain() -> @location(0) vec4f'
        fixture.errors.loseDevice({
            reason: 'unknown',
            message: `lost with disposed dependencies near ${sourceExcerpt}`,
        })
        await settleMicrotasks()
        fixture.runtime.dispose()
        fixture.pipelines.resolveCompilation(0, { messages: [] })
        fixture.pipelines.resolvePipeline(0)

        const error = await rejectedDiagnostic(promise)
        expect(error.diagnostic.code).to.equal('SCRATCH_PIPELINE_CREATION_MULTIPLE_FAILURES')
        expect(error.incident.outcomes.map(outcome => outcome.diagnosticCode)).to.deep.equal([
            'SCRATCH_PIPELINE_CREATION_RUNTIME_DISPOSED',
            'SCRATCH_PIPELINE_CREATION_DEVICE_LOST',
            'SCRATCH_PIPELINE_CREATION_PROGRAM_DISPOSED',
            'SCRATCH_PIPELINE_CREATION_BIND_LAYOUT_DISPOSED',
        ])
        expect(error.incident.outcomes.every(
            outcome => outcome.stage === 'lifecycle-recheck'
        )).to.equal(true)
        expect(JSON.stringify(error.incident)).not.to.include(sourceExcerpt)
        expect(error.incident.outcomes[1].nativeError.sourceExcerptRedacted).to.equal(true)
        assertFailedPipelineFacts(fixture, error, 'cancelled')
    })

    it('keeps device-loss source text transient across runtime and pipeline evidence', async() => {

        const fixture = await createRenderFixture({
            deferCompilationInfo: true,
            deferAsyncPipelines: true,
        })
        const promise = fixture.runtime.createRenderPipeline(fixture.descriptor)
        const sourceExcerpt = 'fn fsMain() -> @location(0) vec4f'
        const nativeInfo = {
            reason: 'unknown',
            message: `device lost near ${sourceExcerpt}`,
        }

        fixture.errors.loseDevice(nativeInfo)
        await settleMicrotasks()
        fixture.pipelines.resolveCompilation(0, { messages: [] })
        fixture.pipelines.resolvePipeline(0)

        const error = await rejectedDiagnostic(promise)
        const runtimeIncident = fixture.runtime.diagnostics.incidents({ kind: 'device-loss' })[0]
        expect(error.cause).to.equal(nativeInfo)
        expect(error.incident.outcomes[0].nativeError.sourceExcerptRedacted).to.equal(true)
        expect(fixture.runtime.deviceLostInfo).to.deep.equal({
            reason: 'unknown',
            message: '[native device-loss message omitted]',
            nativeMessageOmitted: true,
        })
        expect(runtimeIncident.nativeError).to.deep.include({
            reason: 'unknown',
            message: '[native device-loss message omitted]',
            nativeMessageOmitted: true,
        })
        expect(JSON.stringify(fixture.runtime.deviceLostInfo)).not.to.include(sourceExcerpt)
        expect(JSON.stringify(runtimeIncident)).not.to.include(sourceExcerpt)

        try {
            fixture.runtime.assertActive()
        } catch (runtimeError) {
            expect(JSON.stringify(runtimeError.diagnostic)).not.to.include(sourceExcerpt)
        }
    })

    it('keeps concurrent render transactions isolated under reverse settlement order', async() => {

        const fixture = await createRenderFixture({
            deferCompilationInfo: true,
            deferAsyncPipelines: true,
            deferErrorScopePops: true,
        })
        const first = fixture.runtime.createRenderPipeline({
            ...fixture.descriptor,
            label: 'first concurrent render pipeline',
        })
        const second = fixture.runtime.createRenderPipeline({
            ...fixture.descriptor,
            label: 'second concurrent render pipeline',
        })
        let firstSettled = false
        first.finally(() => {
            firstSettled = true
        })

        fixture.pipelines.resolvePipeline(1)
        fixture.errors.settlePop(5)
        fixture.pipelines.resolveCompilation(1, { messages: [] })
        fixture.errors.settlePop(3)
        fixture.errors.settlePop(4)
        const secondPipeline = await second
        expect(firstSettled).to.equal(false)

        fixture.errors.settlePop(2)
        fixture.pipelines.resolveCompilation(0, { messages: [] })
        fixture.pipelines.resolvePipeline(0)
        fixture.errors.settlePop(0)
        fixture.errors.settlePop(1)
        const firstPipeline = await first

        expect(firstPipeline.id).not.to.equal(secondPipeline.id)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.have.length(2)
        expect(fixture.runtime.diagnostics.operations({
            kind: 'render-pipeline-creation',
            status: 'succeeded',
        })).to.have.length(2)
        expect(fixture.errors.scopeDepth).to.equal(0)
    })

    it('removes current facts exactly once on wrapper and runtime disposal', async() => {

        const fixture = await createRenderFixture()
        const pipeline = await fixture.runtime.createRenderPipeline(fixture.descriptor)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.have.length(1)
        expect(() => {
            pipeline.id = 'mutated'
        }).to.throw(TypeError)
        expect(() => pipeline.targets.push({ format: 'rgba8unorm' })).to.throw(TypeError)
        expect(pipeline.bindLayoutsByGroup).not.to.have.property('set')

        pipeline.dispose()
        pipeline.dispose()
        expect(pipeline.isDisposed).to.equal(true)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.have.length(0)
        expect(fixture.runtime.diagnostics.operations({ kind: 'pipeline-disposal' })).to.have.length(1)
        expect(fixture.runtime.diagnostics.snapshot().aggregates.pipelineDisposals).to.equal(1)

        const live = await fixture.runtime.createRenderPipeline({
            ...fixture.descriptor,
            label: 'runtime-owned live pipeline',
        })
        fixture.runtime.dispose()
        expect(live.isDisposed).to.equal(true)
        expect(fixture.runtime.diagnostics.snapshot().pipelines).to.have.length(0)
        expect(fixture.runtime.diagnostics.operations({ kind: 'pipeline-disposal' })).to.have.length(2)
        expect(fixture.runtime.diagnostics.snapshot().aggregates.pipelineDisposals).to.equal(2)
    })
})

async function createRenderFixture(options = {}) {

    const fake = createFakeGpu(options)
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const program = createProgram(runtime)
    const bindLayout = await createIsolatedBindLayout(
        runtime,
        fake.errors,
        options.deferErrorScopePops
    )
    return {
        ...fake,
        runtime,
        program,
        bindLayout,
        descriptor: renderDescriptor(program, bindLayout),
    }
}

function assertFailedPipelineFacts(fixture, error, status) {

    expect(error.incident.kind).to.equal('pipeline-failure')
    expect(error.incident.target.kind).to.equal('pipeline')
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
    expect(fixture.calls.uncapturedErrors).to.have.length(0)
    expect(JSON.stringify(error.incident)).not.to.include(triangleWgsl)
}

function createProgram(runtime) {

    return runtime.createProgram({
        label: 'async render program',
        modules: [ triangleWgsl ],
        entryPoints: { vertex: 'vsMain', fragment: 'fsMain', compute: 'csMain' },
    })
}

function createBindLayout(runtime) {

    return runtime.createBindLayout({
        group: 0,
        entries: [ {
            binding: 0,
            name: 'unusedUniform',
            type: 'uniform',
            visibility: [ 'vertex' ],
        } ],
    })
}

async function createIsolatedBindLayout(runtime, errors, deferErrorScopePops = false) {

    const creation = createBindLayout(runtime)
    if (deferErrorScopePops) {
        errors.settlePop(0)
        errors.settlePop(1)
        errors.settlePop(2)
    }
    const layout = await creation
    errors.resetHistory()
    return layout
}

function renderDescriptor(program, bindLayout) {

    return {
        label: 'async render pipeline',
        program,
        bindLayouts: [ bindLayout ],
        vertexBuffers: [ {
            arrayStride: 8,
            stepMode: 'vertex',
            attributes: [ { shaderLocation: 0, offset: 0, format: 'float32x2' } ],
        } ],
        targets: [ {
            format: 'bgra8unorm',
            blend: {
                color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'zero' },
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
            stencilFront: { compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'replace' },
            stencilBack: { compare: 'equal', failOp: 'zero', depthFailOp: 'invert', passOp: 'keep' },
            stencilReadMask: 0xFF,
            stencilWriteMask: 0x7F,
            depthBias: 2,
            depthBiasSlopeScale: 1.5,
            depthBiasClamp: 0.25,
        },
        multisample: { count: 4, mask: 0xFFFF, alphaToCoverageEnabled: true },
    }
}

function compilationMessage(type, message, offset, length, lineNum, linePos) {

    return { type, message, offset, length, lineNum, linePos }
}

function expectedRenderIssueTimeline() {

    return [
        { type: 'push-error-scope', filter: 'out-of-memory' },
        { type: 'push-error-scope', filter: 'internal' },
        { type: 'push-error-scope', filter: 'validation' },
        { type: 'create-shader-module' },
        { type: 'create-pipeline-layout' },
        { type: 'get-compilation-info' },
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
