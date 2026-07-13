import { expect } from 'chai'
import { ScratchRuntime } from 'geoscratch'
import {
    createFakeExternalImageSource,
    createFakeGpu,
    triangleWgsl,
} from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_TEXTURE_USAGE_COPY_DST = 0x2
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

async function createCopyFixture(options = {}) {

    const fake = createFakeGpu(options.fakeOptions)
    const runtime = await ScratchRuntime.create({
        gpu: fake.gpu,
        ...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
    })
    const source = await runtime.createBuffer({
        label: 'native observation copy source',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
    })
    const firstTarget = await runtime.createBuffer({
        label: 'native observation first copy target',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_DST,
    })
    const secondTarget = await runtime.createBuffer({
        label: 'native observation second copy target',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_DST,
    })
    const upload = runtime.createUploadCommand({
        label: 'native observation upload',
        target: source,
        data: new Uint8Array(16),
    })
    const firstCopy = runtime.createCopyCommand({
        label: 'native observation first copy',
        source: { resource: source, contentEpoch: 1 },
        target: firstTarget,
        byteLength: 16,
        whenMissing: 'throw',
    })
    const secondCopy = runtime.createCopyCommand({
        label: 'native observation second copy',
        source: { resource: source, contentEpoch: 1 },
        target: secondTarget,
        byteLength: 16,
        whenMissing: 'throw',
    })

    fake.calls.errorScopes.length = 0
    fake.calls.nativeTimeline.length = 0
    return { ...fake, runtime, source, firstTarget, secondTarget, upload, firstCopy, secondCopy }
}

async function waitForSubmissionOperation(runtime, submissionId) {

    for (let attempt = 0; attempt < 20; attempt++) {
        const operation = runtime.diagnostics.operations({ submissionId })[0]
        if (operation !== undefined) return operation
        await Promise.resolve()
    }
    throw new Error(`submission native operation ${submissionId} did not settle`)
}

async function createRenderFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const target = await runtime.createTexture({
        size: { width: 2, height: 2 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const program = runtime.createProgram({
        modules: [ triangleWgsl ],
        entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
    })
    const pipeline = await runtime.createRenderPipeline({
        program,
        targets: [ { format: 'rgba8unorm' } ],
    })
    const draw = runtime.createDrawCommand({
        pipeline,
        count: { vertexCount: 3 },
        resources: { read: [], write: [] },
        whenMissing: 'throw',
    })
    const pass = runtime.createRenderPass({
        label: 'native observation render pass',
        color: [ { target, load: 'clear', store: 'store' } ],
    })
    fake.calls.errorScopes.length = 0
    fake.calls.nativeTimeline.length = 0
    return {
        ...fake,
        runtime,
        submit: () => runtime.submission().render(pass, [ draw ]).submit(),
        location: submissionId => ({
            kind: 'pass-command',
            submissionId,
            stepIndex: 0,
            passId: pass.id,
            passKind: 'render',
            commandId: draw.id,
            commandKind: 'draw',
        }),
        passLocation: submissionId => ({
            kind: 'pass',
            submissionId,
            stepIndex: 0,
            passId: pass.id,
            passKind: 'render',
        }),
    }
}

async function createComputeFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const output = await runtime.createBuffer({
        size: 16,
        usage: GPU_BUFFER_USAGE_STORAGE,
    })
    const program = runtime.createProgram({
        modules: [ '@compute @workgroup_size(1) fn csMain() {}' ],
        entryPoints: { compute: 'csMain' },
    })
    const pipeline = await runtime.createComputePipeline({ program })
    const dispatch = runtime.createDispatchCommand({
        pipeline,
        count: { workgroups: [ 1 ] },
        resources: { read: [], write: [ output ] },
        whenMissing: 'throw',
    })
    const pass = runtime.createComputePass({ label: 'native observation compute pass' })
    fake.calls.errorScopes.length = 0
    fake.calls.nativeTimeline.length = 0
    return {
        ...fake,
        runtime,
        submit: () => runtime.submission().compute(pass, [ dispatch ]).submit(),
        location: submissionId => ({
            kind: 'pass-command',
            submissionId,
            stepIndex: 0,
            passId: pass.id,
            passKind: 'compute',
            commandId: dispatch.id,
            commandKind: 'dispatch',
        }),
        passLocation: submissionId => ({
            kind: 'pass',
            submissionId,
            stepIndex: 0,
            passId: pass.id,
            passKind: 'compute',
        }),
    }
}

async function createTextureUploadFixture(external = false) {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const target = await runtime.createTexture({
        size: { width: 2, height: 2 },
        format: 'rgba8unorm',
        usage: external
            ? GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_RENDER_ATTACHMENT
            : GPU_TEXTURE_USAGE_COPY_DST,
    })
    const command = external
        ? runtime.createExternalImageUploadCommand({
            source: createFakeExternalImageSource('ImageData'),
            target,
            size: { width: 1, height: 1 },
        })
        : runtime.createTextureUploadCommand({
            target,
            data: new Uint8Array(4),
            layout: { bytesPerRow: 4, rowsPerImage: 1 },
            size: { width: 1, height: 1 },
        })
    fake.calls.errorScopes.length = 0
    fake.calls.nativeTimeline.length = 0
    return {
        ...fake,
        runtime,
        submit: () => runtime.submission().upload(command).submit(),
        actionKind: external ? 'external-image-upload' : 'texture-upload',
    }
}

describe('scratch submission native integration', () => {

    it('keeps one summary bundle around actual multi-step encoding and queue replay', async () => {

        const fixture = await createCopyFixture()
        const submitted = fixture.runtime.submission()
            .upload(fixture.upload)
            .copy(fixture.firstCopy)
            .copy(fixture.secondCopy)
            .submit()
        const operation = await waitForSubmissionOperation(fixture.runtime, submitted.id)

        expect(fixture.calls.errorScopes).to.deep.equal([
            { action: 'push', filter: 'out-of-memory' },
            { action: 'push', filter: 'internal' },
            { action: 'push', filter: 'validation' },
            { action: 'pop', filter: 'validation' },
            { action: 'pop', filter: 'internal' },
            { action: 'pop', filter: 'out-of-memory' },
        ])
        expect(operation.nativeOutcome).to.deep.include({
            submissionId: submitted.id,
            mode: 'summary',
            status: 'observed-succeeded',
        })
        expect(fixture.calls.queueTimeline.map(action => action.type)).to.deep.equal([
            'write-buffer',
            'submit',
        ])
        await submitted.done
    })

    it('attributes detailed command encoding failure to the standalone command', async () => {

        const fixture = await createCopyFixture()
        const capture = fixture.runtime.diagnostics.capture({ nativeSubmissionDetail: 'step' })
        fixture.errors.failNext(
            'copyBufferToBuffer',
            'validation',
            new Error('detailed copy validation')
        )
        const submitted = fixture.runtime.submission()
            .upload(fixture.upload)
            .copy(fixture.firstCopy)
            .submit()
        const operation = await waitForSubmissionOperation(fixture.runtime, submitted.id)
        const copyFailure = operation.nativeOutcome.outcomes.find(outcome =>
            outcome.stage === 'command-encode'
        )

        expect(operation.nativeOutcome.mode).to.equal('detailed')
        expect(copyFailure).to.deep.include({
            nativeErrorCategory: 'validation',
            location: {
                kind: 'standalone-command',
                submissionId: submitted.id,
                stepIndex: 1,
                commandId: fixture.firstCopy.id,
                commandKind: 'copy',
            },
        })
        expect(fixture.calls.errorScopes.filter(call => call.action === 'push')).to.have.length(15)
        expect(fixture.calls.errorScopes.filter(call => call.action === 'pop')).to.have.length(15)
        expect(fixture.calls.debugGroups.map(call => call.action)).to.deep.equal([ 'push', 'pop' ])
        expect(fixture.calls.debugGroups[0].label.length).to.be.at.most(256)
        capture.stop()
    })

    it('balances summary scopes before propagating a synchronous queue exception', async () => {

        const fixture = await createCopyFixture()
        const expected = new Error('synchronous queue submit failure')
        fixture.errors.throwNext('submit', expected)

        expect(() => fixture.runtime.submission()
            .upload(fixture.upload)
            .copy(fixture.firstCopy)
            .submit()
        ).to.throw(expected)
        expect(fixture.errors.scopeDepth).to.equal(0)
        expect(fixture.calls.errorScopes.slice(-3)).to.deep.equal([
            { action: 'pop', filter: 'validation' },
            { action: 'pop', filter: 'internal' },
            { action: 'pop', filter: 'out-of-memory' },
        ])
        for (let attempt = 0; attempt < 20; attempt++) {
            if (
                fixture.runtime.diagnostics.snapshot().submissionNative
                    .currentPendingNativeObservations === 0
            ) break
            await Promise.resolve()
        }
        expect(fixture.runtime.diagnostics.snapshot().submissionNative.currentPendingNativeObservations)
            .to.equal(0)
    })

    it('attributes every actual encoder, pass, command, and queue boundary', async () => {

        const cases = [
            {
                method: 'createCommandEncoder',
                stage: 'encoder-create',
                create: createCopyFixture,
                submit: fixture => fixture.runtime.submission()
                    .upload(fixture.upload).copy(fixture.firstCopy).submit(),
                location: (_fixture, submissionId) => ({
                    kind: 'encoder-segment', submissionId, segmentIndex: 0,
                }),
            },
            {
                method: 'finish',
                stage: 'encoder-finish',
                create: createCopyFixture,
                submit: fixture => fixture.runtime.submission()
                    .upload(fixture.upload).copy(fixture.firstCopy).submit(),
                location: (_fixture, submissionId) => ({
                    kind: 'encoder-segment', submissionId, segmentIndex: 0,
                }),
            },
            {
                method: 'writeBuffer',
                stage: 'queue-action',
                create: createCopyFixture,
                submit: fixture => fixture.runtime.submission()
                    .upload(fixture.upload).copy(fixture.firstCopy).submit(),
                location: (_fixture, submissionId) => ({
                    kind: 'queue-action', submissionId, actionIndex: 0, actionKind: 'buffer-upload',
                }),
            },
            {
                method: 'submit',
                stage: 'queue-submit',
                create: createCopyFixture,
                submit: fixture => fixture.runtime.submission()
                    .upload(fixture.upload).copy(fixture.firstCopy).submit(),
                location: (_fixture, submissionId) => ({
                    kind: 'queue-action', submissionId, actionIndex: 1, actionKind: 'command-buffer',
                }),
            },
            {
                method: 'beginRenderPass',
                stage: 'pass-begin',
                create: createRenderFixture,
                location: (fixture, submissionId) => fixture.passLocation(submissionId),
            },
            {
                method: 'draw',
                stage: 'command-encode',
                create: createRenderFixture,
                location: (fixture, submissionId) => fixture.location(submissionId),
            },
            {
                method: 'renderPassEnd',
                stage: 'pass-end',
                create: createRenderFixture,
                location: (fixture, submissionId) => fixture.passLocation(submissionId),
            },
            {
                method: 'beginComputePass',
                stage: 'pass-begin',
                create: createComputeFixture,
                location: (fixture, submissionId) => fixture.passLocation(submissionId),
            },
            {
                method: 'dispatchWorkgroups',
                stage: 'command-encode',
                create: createComputeFixture,
                location: (fixture, submissionId) => fixture.location(submissionId),
            },
            {
                method: 'computePassEnd',
                stage: 'pass-end',
                create: createComputeFixture,
                location: (fixture, submissionId) => fixture.passLocation(submissionId),
            },
            {
                method: 'writeTexture',
                stage: 'queue-action',
                create: () => createTextureUploadFixture(false),
                location: (fixture, submissionId) => ({
                    kind: 'queue-action',
                    submissionId,
                    actionIndex: 0,
                    actionKind: fixture.actionKind,
                }),
            },
            {
                method: 'copyExternalImageToTexture',
                stage: 'queue-action',
                create: () => createTextureUploadFixture(true),
                location: (fixture, submissionId) => ({
                    kind: 'queue-action',
                    submissionId,
                    actionIndex: 0,
                    actionKind: fixture.actionKind,
                }),
            },
        ]

        for (const testCase of cases) {
            const fixture = await testCase.create()
            const capture = fixture.runtime.diagnostics.capture({ nativeSubmissionDetail: 'step' })
            fixture.errors.failNext(
                testCase.method,
                'validation',
                new Error(`${testCase.method} validation`)
            )
            const submitted = testCase.submit?.(fixture) ?? fixture.submit()
            const operation = await waitForSubmissionOperation(fixture.runtime, submitted.id)

            expect(operation.nativeOutcome.outcomes[0], testCase.method).to.deep.include({
                stage: testCase.stage,
                nativeErrorCategory: 'validation',
                location: testCase.location(fixture, submitted.id),
            })
            expect(fixture.errors.scopeDepth, testCase.method).to.equal(0)
            capture.stop()
        }
    })

    it('keeps actual off and effect-free submissions scope-free', async () => {

        const offFixture = await createCopyFixture({
            diagnostics: { submissionScopes: 'off' },
        })
        const offSubmitted = offFixture.runtime.submission()
            .upload(offFixture.upload)
            .copy(offFixture.firstCopy)
            .submit()
        const offOperation = await waitForSubmissionOperation(
            offFixture.runtime,
            offSubmitted.id
        )
        expect(offFixture.calls.errorScopes).to.deep.equal([])
        expect(offOperation.nativeOutcome).to.deep.include({
            mode: 'off',
            status: 'unobserved',
        })

        const emptyFake = createFakeGpu()
        const emptyRuntime = await ScratchRuntime.create({ gpu: emptyFake.gpu })
        emptyFake.calls.errorScopes.length = 0
        const emptySubmitted = emptyRuntime.submission().submit()
        await Promise.resolve()
        expect(emptyFake.calls.errorScopes).to.deep.equal([])
        expect(emptyFake.calls.commandEncoders).to.deep.equal([])
        expect(emptyFake.calls.queueTimeline).to.deep.equal([])
        expect(emptyRuntime.diagnostics.operations({ submissionId: emptySubmitted.id }))
            .to.deep.equal([])
    })
})
