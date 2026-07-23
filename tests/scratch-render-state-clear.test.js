import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
} from 'geoscratch'
import {
    createFakeGpu,
    replaceResourceAllocationForTest,
    triangleWgsl,
} from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

async function expectScratchDiagnostic(action, expected) {

    try {
        await action()
        throw new Error('expected Scratch diagnostic')
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic).to.include(expected)
        return error.diagnostic
    }
}

async function createRenderFixture(size = [ 32, 24 ]) {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const target = await runtime.createTexture({
        size,
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: {
            vertex: 'vsMain',
            fragment: 'fsMain',
        },
    })
    const pipeline = await runtime.createRenderPipeline({
        program,
        targets: [ { format: 'rgba8unorm' } ],
    })
    const pass = runtime.createRenderPass({
        color: [ { target: target.view() } ],
    })

    return { fake, runtime, target, pipeline, pass }
}

function createDraw(runtime, pipeline, renderState) {

    return runtime.createDrawCommand({
        pipeline,
        count: { vertexCount: 3 },
        resources: { read: [], write: [] },
        whenMissing: 'throw',
        ...(renderState !== undefined ? { renderState } : {}),
    })
}

describe('scratch declarative render state', () => {

    it('snapshots authored state and resets every native state before each draw', async() => {

        const fixture = await createRenderFixture([ 40, 30 ])
        const viewport = {
            x: 2,
            y: 3,
            width: 20,
            height: 15,
            minDepth: 0.25,
            maxDepth: 0.75,
        }
        const scissor = { x: 4, y: 5, width: 12, height: 10 }
        const blendConstant = [ 0.1, 0.2, 0.3, 0.4 ]
        const authored = { viewport, scissor, blendConstant, stencilReference: 7 }
        const explicit = createDraw(fixture.runtime, fixture.pipeline, authored)
        const defaults = createDraw(fixture.runtime, fixture.pipeline)

        viewport.width = 1
        scissor.height = 1
        blendConstant[0] = 1
        authored.stencilReference = 99

        const submitted = fixture.runtime.submission()
            .render(fixture.pass, [ explicit, defaults ])
            .submit()
        const stateActions = fixture.fake.calls.renderPasses[0].actions.filter(action =>
            [
                'setViewport',
                'setScissorRect',
                'setBlendConstant',
                'setStencilReference',
            ].includes(action.type)
        )

        expect(explicit.renderState).to.deep.equal({
            viewport: {
                x: 2,
                y: 3,
                width: 20,
                height: 15,
                minDepth: 0.25,
                maxDepth: 0.75,
            },
            scissor: { x: 4, y: 5, width: 12, height: 10 },
            blendConstant: [ 0.1, 0.2, 0.3, 0.4 ],
            stencilReference: 7,
        })
        expect(Object.isFrozen(explicit.renderState)).to.equal(true)
        expect(Object.isFrozen(explicit.renderState.viewport)).to.equal(true)
        expect(Object.isFrozen(explicit.renderState.scissor)).to.equal(true)
        expect(Object.isFrozen(explicit.renderState.blendConstant)).to.equal(true)
        expect(defaults.renderState).to.deep.equal({
            viewport: 'full-attachment',
            scissor: 'full-attachment',
            blendConstant: [ 0, 0, 0, 0 ],
            stencilReference: 0,
        })
        expect(stateActions).to.deep.equal([
            {
                type: 'setViewport',
                x: 2,
                y: 3,
                width: 20,
                height: 15,
                minDepth: 0.25,
                maxDepth: 0.75,
            },
            { type: 'setScissorRect', x: 4, y: 5, width: 12, height: 10 },
            { type: 'setBlendConstant', color: [ 0.1, 0.2, 0.3, 0.4 ] },
            { type: 'setStencilReference', reference: 7 },
            {
                type: 'setViewport',
                x: 0,
                y: 0,
                width: 40,
                height: 30,
                minDepth: 0,
                maxDepth: 1,
            },
            { type: 'setScissorRect', x: 0, y: 0, width: 40, height: 30 },
            { type: 'setBlendConstant', color: [ 0, 0, 0, 0 ] },
            { type: 'setStencilReference', reference: 0 },
        ])

        await submitted.done
    })

    it('resolves full-attachment state from the current resized allocation', async() => {

        const fixture = await createRenderFixture([ 16, 8 ])
        const draw = createDraw(fixture.runtime, fixture.pipeline, {
            viewport: 'full-attachment',
            scissor: 'full-attachment',
        })

        const first = fixture.runtime.submission().render(fixture.pass, [ draw ]).submit()
        await first.done
        await fixture.target.resize([ 30, 18 ])
        const second = fixture.runtime.submission().render(fixture.pass, [ draw ]).submit()

        const states = fixture.fake.calls.renderPasses.map(renderPass =>
            renderPass.actions.filter(action =>
                action.type === 'setViewport' || action.type === 'setScissorRect'
            )
        )
        expect(states[0]).to.deep.equal([
            {
                type: 'setViewport',
                x: 0,
                y: 0,
                width: 16,
                height: 8,
                minDepth: 0,
                maxDepth: 1,
            },
            { type: 'setScissorRect', x: 0, y: 0, width: 16, height: 8 },
        ])
        expect(states[1]).to.deep.equal([
            {
                type: 'setViewport',
                x: 0,
                y: 0,
                width: 30,
                height: 18,
                minDepth: 0,
                maxDepth: 1,
            },
            { type: 'setScissorRect', x: 0, y: 0, width: 30, height: 18 },
        ])

        await second.done
    })

    it('rejects invalid authored and pass-resolved state before native effects', async() => {

        const fixture = await createRenderFixture([ 16, 12 ])
        const invalidStates = [
            null,
            { viewport: { x: 0, y: 0, width: Number.NaN, height: 1 } },
            { viewport: { x: 0, y: 0, width: -1, height: 1 } },
            { viewport: { x: 0, y: 0, width: 1, height: 1, minDepth: 0.8, maxDepth: 0.2 } },
            { viewport: { x: 16_384, y: 0, width: 1, height: 1 } },
            { scissor: { x: 0.5, y: 0, width: 1, height: 1 } },
            { blendConstant: [ 0, 0, Number.POSITIVE_INFINITY, 0 ] },
            { stencilReference: 0x1_0000_0000 },
        ]

        for (const renderState of invalidStates) {
            await expectScratchDiagnostic(() => createDraw(
                fixture.runtime,
                fixture.pipeline,
                renderState
            ), {
                code: 'SCRATCH_COMMAND_RENDER_STATE_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }

        const outOfBounds = createDraw(fixture.runtime, fixture.pipeline, {
            scissor: { x: 8, y: 0, width: 9, height: 12 },
        })
        await expectScratchDiagnostic(() => fixture.runtime.submission()
            .render(fixture.pass, [ outOfBounds ])
            .submit(), {
            code: 'SCRATCH_COMMAND_RENDER_STATE_INVALID',
            severity: 'error',
            phase: 'command',
        })
        expect(fixture.fake.calls.commandEncoders).to.have.length(0)
    })
})

describe('scratch ClearBufferCommand', () => {

    it('uses native clearBuffer in declared order and records one buffer write', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const buffer = await runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const upload = runtime.createUploadCommand({
            target: buffer.region(),
            data: new Uint8Array(16).fill(7),
        })
        const clear = runtime.createClearBufferCommand({
            label: 'clear middle',
            target: buffer.region({ offset: 4, size: 8 }),
        })

        const submitted = runtime.submission()
            .upload(upload)
            .clear(clear)
            .submit()

        expect(clear.commandKind).to.equal('clear')
        expect(fake.calls.clearBuffers).to.deep.equal([ {
            buffer: buffer.gpuBuffer,
            offset: 4,
            size: 8,
        } ])
        expect(fake.calls.queueTimeline.map(action => action.type)).to.deep.equal([
            'write-buffer',
            'submit',
        ])
        expect([ ...buffer.gpuBuffer.data ]).to.deep.equal([
            7, 7, 7, 7,
            0, 0, 0, 0,
            0, 0, 0, 0,
            7, 7, 7, 7,
        ])
        expect(buffer.contentEpoch).to.equal(2)
        expect(submitted.resourceAccesses.map(access => ({
            stepKind: access.stepKind,
            commandKind: access.commandKind,
            access: access.access,
            before: access.contentEpochBefore,
            after: access.contentEpochAfter,
        }))).to.deep.equal([
            {
                stepKind: 'upload',
                commandKind: 'upload',
                access: 'write',
                before: 0,
                after: 1,
            },
            {
                stepKind: 'clear',
                commandKind: 'clear',
                access: 'write',
                before: 1,
                after: 2,
            },
        ])
        expect(submitted.potentialWrites).to.deep.include({
            kind: 'resource',
            resourceId: buffer.id,
            resourceKind: 'BufferResource',
            subject: buffer.subject,
            allocationVersion: 1,
            contentEpoch: 2,
        })

        await submitted.done
    })

    it('satisfies a later same-submission content dependency in declared order', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const source = await runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const target = await runtime.createBuffer({
            size: 8,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const clear = runtime.createClearBufferCommand({
            target: source.region(),
        })
        const copy = runtime.createCopyCommand({
            source: {
                region: source.region(),
                contentEpoch: 1,
            },
            target: target.region(),
            whenMissing: 'throw',
        })

        const submitted = runtime.submission()
            .clear(clear)
            .copy(copy)
            .submit()

        expect(fake.calls.clearBuffers).to.have.length(1)
        expect(fake.calls.copies).to.have.length(1)
        expect(fake.calls.commandEncoders).to.have.length(1)
        expect(source.contentEpoch).to.equal(1)
        expect(target.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepKind: access.stepKind,
            resourceId: access.resourceId,
            access: access.access,
            before: access.contentEpochBefore,
            after: access.contentEpochAfter,
        }))).to.deep.equal([
            {
                stepKind: 'clear',
                resourceId: source.id,
                access: 'write',
                before: 0,
                after: 1,
            },
            {
                stepKind: 'copy',
                resourceId: source.id,
                access: 'read',
                before: 1,
                after: 1,
            },
            {
                stepKind: 'copy',
                resourceId: target.id,
                access: 'write',
                before: 0,
                after: 1,
            },
        ])

        await submitted.done
    })

    it('treats a zero-size clear as a physical and logical no-op', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const buffer = await runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const clear = runtime.createClearBufferCommand({
            target: buffer.region({ offset: 4, size: 0 }),
        })

        const submitted = runtime.submission().clear(clear).submit()

        expect(fake.calls.clearBuffers).to.deep.equal([])
        expect(fake.calls.commandEncoders).to.deep.equal([])
        expect(fake.calls.queueSubmissions).to.deep.equal([])
        expect(buffer.contentEpoch).to.equal(0)
        expect(buffer.state).to.equal('empty')
        expect(submitted.resourceAccesses).to.deep.equal([])
        expect(submitted.producerEpochs).to.deep.equal([])
        expect(submitted.potentialWrites).to.deep.equal([])
        expect((await submitted.nativeOutcome).status).to.equal('no-native-work')
        await submitted.done
    })

    it('rejects invalid target, usage, alignment, and replacement range', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const sourceOnly = await runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC,
        })
        const target = await runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })

        for (const descriptor of [
            null,
            7,
            'clear',
            [],
            { target: undefined },
            { target: sourceOnly.region({ offset: 0, size: 4 }) },
            { target: target.region({ offset: 2, size: 4 }) },
            { target: target.region({ offset: 4, size: 6 }) },
        ]) {
            await expectScratchDiagnostic(() => runtime.createClearBufferCommand(descriptor), {
                code: 'SCRATCH_COMMAND_CLEAR_BUFFER_INVALID',
                severity: 'error',
                phase: 'command',
            })
        }

        const clear = runtime.createClearBufferCommand({
            target: target.region({ offset: 8, size: 8 }),
        })
        replaceResourceAllocationForTest(target, {
            ...target.descriptor,
            size: 8,
        })

        await expectScratchDiagnostic(() => runtime.submission().clear(clear).submit(), {
            code: 'SCRATCH_COMMAND_CLEAR_BUFFER_INVALID',
            severity: 'error',
            phase: 'command',
        })
        expect(fake.calls.commandEncoders).to.deep.equal([])
    })

    it('rejects a disposed target before native effects', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const buffer = await runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const clear = runtime.createClearBufferCommand({
            target: buffer.region(),
        })
        buffer.dispose()

        await expectScratchDiagnostic(() => runtime.submission().clear(clear).submit(), {
            code: 'SCRATCH_RESOURCE_DISPOSED',
            severity: 'error',
            phase: 'resource',
        })
        expect(fake.calls.commandEncoders).to.deep.equal([])
    })

    it('attributes native clear failure and marks only the target write indeterminate', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const buffer = await runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const clear = runtime.createClearBufferCommand({
            target: buffer.region({ offset: 0, size: 16 }),
        })
        const nativeError = Object.assign(new Error('clear validation'), {
            name: 'GPUValidationError',
        })
        const capture = runtime.diagnostics.capture({ nativeSubmissionDetail: 'step' })
        fake.errors.failNext('clearBuffer', 'validation', nativeError)

        const submitted = runtime.submission().clear(clear).submit()
        const nativeOutcome = await submitted.nativeOutcome
        const clearFailure = nativeOutcome.outcomes.find(outcome =>
            outcome.stage === 'command-encode'
        )

        expect(nativeOutcome.status).to.equal('observed-failed')
        expect(clearFailure).to.deep.include({
            stage: 'command-encode',
            nativeErrorCategory: 'validation',
        })
        expect(clearFailure.location).to.deep.include({
            kind: 'standalone-command',
            stepIndex: 0,
            commandId: clear.id,
            commandKind: 'clear',
        })
        await expectScratchDiagnostic(() => submitted.done, {
            code: 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED',
            severity: 'error',
            phase: 'submission',
        })
        expect(buffer.contentEpoch).to.equal(1)
        expect(buffer.state).to.equal('indeterminate')
        expect(submitted.potentialWrites).to.have.length(1)
        capture.stop()
    })

    it('marks the clear target indeterminate when device loss precedes queue completion', async() => {

        const fake = createFakeGpu({ deferSubmittedWorkDone: true })
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const buffer = await runtime.createBuffer({
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const clear = runtime.createClearBufferCommand({
            target: buffer.region(),
        })

        const submitted = runtime.submission().clear(clear).submit()
        expect((await submitted.nativeOutcome).status).to.equal('observed-succeeded')
        expect(buffer.state).to.equal('ready')
        expect(buffer.contentEpoch).to.equal(1)

        fake.errors.loseDevice({
            reason: 'destroyed',
            message: 'clear device loss details must remain private',
        })
        await Promise.resolve()
        fake.readbacks.resolveQueueCompletion(0)

        await expectScratchDiagnostic(() => submitted.done, {
            code: 'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION',
            severity: 'error',
            phase: 'submission',
        })
        expect(buffer.state).to.equal('indeterminate')
        expect(buffer.contentEpoch).to.equal(1)
    })
})
