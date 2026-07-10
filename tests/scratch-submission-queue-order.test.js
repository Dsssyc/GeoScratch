import { expect } from 'chai'
import { ScratchDiagnosticError, ScratchRuntime } from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_TEXTURE_USAGE_COPY_DST = 0x2

function timelineTypes(calls) {

    return calls.queueTimeline.map(action => action.type)
}

function expectScratchDiagnostic(action, code) {

    try {
        action()
        throw new Error('expected Scratch diagnostic')
    } catch (error) {
        expect(error).to.be.instanceOf(ScratchDiagnosticError)
        expect(error.diagnostic.code).to.equal(code)
        return error.diagnostic
    }
}

function createTextureUpload(runtime, label) {

    const target = runtime.createTexture({
        label: `${label} target`,
        size: { width: 1, height: 1 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_COPY_DST,
    })
    const command = runtime.createTextureUploadCommand({
        label,
        target,
        data: new Uint8Array([ 1, 2, 3, 4 ]),
        layout: {
            bytesPerRow: 4,
            rowsPerImage: 1,
        },
        size: { width: 1, height: 1 },
    })

    return { target, command }
}

function createBufferUpload(runtime, label, data = new Uint8Array(16)) {

    const target = runtime.createBuffer({
        label: `${label} target`,
        size: data.byteLength,
        usage: GPU_BUFFER_USAGE_COPY_DST,
    })
    const command = runtime.createUploadCommand({ label, target, data })

    return { target, command }
}

function createSkippedCompute(runtime, whenMissing) {

    const missing = runtime.createBuffer({
        label: `${whenMissing} missing input`,
        size: 16,
        usage: GPU_BUFFER_USAGE_STORAGE,
    })
    const output = runtime.createBuffer({
        label: `${whenMissing} output`,
        size: 16,
        usage: GPU_BUFFER_USAGE_STORAGE,
    })
    const program = runtime.createProgram({
        modules: [
            `
                @compute @workgroup_size(1)
                fn csMain() {
                }
            `,
        ],
        entryPoints: { compute: 'csMain' },
    })
    const pipeline = runtime.createComputePipeline({
        program,
        bindLayouts: [],
    })
    const command = runtime.createDispatchCommand({
        label: `${whenMissing} dispatch`,
        pipeline,
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ { resource: missing, contentEpoch: 1 } ],
            write: [ output ],
        },
        whenMissing,
    })
    const pass = runtime.createComputePass({
        label: `${whenMissing} pass`,
    })

    return { command, pass, missing, output }
}

async function createOrderingFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
    const copySource = runtime.createBuffer({
        label: 'queue order copy source',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
    })
    const firstCopyTarget = runtime.createBuffer({
        label: 'queue order first copy target',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_DST,
    })
    const secondCopyTarget = runtime.createBuffer({
        label: 'queue order second copy target',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_DST,
    })
    const uploadTarget = runtime.createBuffer({
        label: 'queue order upload target',
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_DST,
    })

    copySource._advanceContentEpoch()

    const firstCopy = runtime.createCopyCommand({
        label: 'queue order first copy',
        source: { resource: copySource, contentEpoch: 1 },
        target: firstCopyTarget,
        byteLength: 16,
        whenMissing: 'throw',
    })
    const secondCopy = runtime.createCopyCommand({
        label: 'queue order second copy',
        source: { resource: copySource, contentEpoch: 1 },
        target: secondCopyTarget,
        byteLength: 16,
        whenMissing: 'throw',
    })
    const upload = runtime.createUploadCommand({
        label: 'queue order upload',
        target: uploadTarget,
        data: new Uint8Array(16),
    })
    const texture = createTextureUpload(runtime, 'queue order texture upload')

    return {
        ...fake,
        runtime,
        copySource,
        firstCopyTarget,
        secondCopyTarget,
        uploadTarget,
        firstCopy,
        secondCopy,
        upload,
        textureTarget: texture.target,
        textureUpload: texture.command,
    }
}

describe('scratch submission queue order', () => {

    it('keeps a leading queue upload before later encoded GPU work', async() => {

        const fixture = await createOrderingFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .copy(fixture.firstCopy)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'write-buffer',
            'submit',
        ])
        expect(submitted.commandBuffers).to.have.length(1)

        await submitted.done
    })

    it('keeps a trailing queue upload after earlier encoded GPU work', async() => {

        const fixture = await createOrderingFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(fixture.upload)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'submit',
            'write-buffer',
        ])
        expect(submitted.commandBuffers).to.have.length(1)

        await submitted.done
    })

    it('splits encoded GPU work around an interleaved queue upload', async() => {

        const fixture = await createOrderingFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(fixture.upload)
            .copy(fixture.secondCopy)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'submit',
            'write-buffer',
            'submit',
        ])
        expect(submitted.commandBuffers).to.have.length(2)
        expect(fixture.calls.queueSubmissions).to.deep.equal([
            [ submitted.commandBuffers[0] ],
            [ submitted.commandBuffers[1] ],
        ])
        expect(fixture.queue.submittedWorkDoneCalls).to.equal(1)
        expect(fixture.calls.submittedWorkDoneRegistrations).to.deep.equal([
            { queueTimelineLength: 3 },
        ])

        await submitted.done
    })

    it('keeps a leading texture upload before later encoded GPU work', async() => {

        const fixture = await createOrderingFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.textureUpload)
            .copy(fixture.firstCopy)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'write-texture',
            'submit',
        ])
        expect(submitted.commandBuffers).to.have.length(1)
        expect(fixture.textureTarget.contentEpoch).to.equal(1)

        await submitted.done
    })

    it('keeps a trailing texture upload after earlier encoded GPU work', async() => {

        const fixture = await createOrderingFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(fixture.textureUpload)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'submit',
            'write-texture',
        ])
        expect(submitted.commandBuffers).to.have.length(1)
        expect(fixture.textureTarget.contentEpoch).to.equal(1)

        await submitted.done
    })

    it('splits encoded GPU work around an interleaved texture upload', async() => {

        const fixture = await createOrderingFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(fixture.textureUpload)
            .copy(fixture.secondCopy)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'submit',
            'write-texture',
            'submit',
        ])
        expect(submitted.commandBuffers).to.have.length(2)
        expect(fixture.calls.queueSubmissions).to.deep.equal([
            [ submitted.commandBuffers[0] ],
            [ submitted.commandBuffers[1] ],
        ])

        await submitted.done
    })

    it('keeps alternating buffer and texture uploads ordered without fake command buffers', async() => {

        const fixture = await createOrderingFixture()
        const secondBuffer = createBufferUpload(fixture.runtime, 'second buffer upload')
        const secondTexture = createTextureUpload(fixture.runtime, 'second texture upload')
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .upload(fixture.textureUpload)
            .upload(secondBuffer.command)
            .upload(secondTexture.command)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'write-buffer',
            'write-texture',
            'write-buffer',
            'write-texture',
        ])
        expect(submitted.commandBuffers).to.deep.equal([])
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
        expect([
            fixture.uploadTarget.contentEpoch,
            fixture.textureTarget.contentEpoch,
            secondBuffer.target.contentEpoch,
            secondTexture.target.contentEpoch,
        ]).to.deep.equal([ 1, 1, 1, 1 ])
        expect(fixture.queue.submittedWorkDoneCalls).to.equal(1)
        expect(fixture.calls.submittedWorkDoneRegistrations).to.deep.equal([
            { queueTimelineLength: 4 },
        ])

        await submitted.done
    })

    it('does not create an empty segment between consecutive uploads', async() => {

        const fixture = await createOrderingFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(fixture.upload)
            .upload(fixture.textureUpload)
            .copy(fixture.secondCopy)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'submit',
            'write-buffer',
            'write-texture',
            'submit',
        ])
        expect(fixture.calls.commandEncoders).to.have.length(2)
        expect(fixture.calls.queueSubmissions).to.have.length(2)
        expect(submitted.commandBuffers).to.have.length(2)

        await submitted.done
    })

    it('coalesces adjacent encoded steps into one command-buffer segment', async() => {

        const fixture = await createOrderingFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .copy(fixture.secondCopy)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([ 'submit' ])
        expect(fixture.calls.commandEncoders).to.have.length(1)
        expect(fixture.calls.copies).to.have.length(2)
        expect(fixture.calls.queueSubmissions).to.deep.equal([
            [ submitted.commandBuffers[0] ],
        ])
        expect(submitted.commandBuffers).to.have.length(1)

        await submitted.done
    })

    it('does not create a segment for a skipped command', async() => {

        const fixture = await createOrderingFixture()
        const skipped = createSkippedCompute(fixture.runtime, 'skip-command')
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .compute(skipped.pass, [ skipped.command ])
            .upload(fixture.textureUpload)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'write-buffer',
            'write-texture',
        ])
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.computePasses).to.have.length(0)
        expect(submitted.commandBuffers).to.deep.equal([])
        expect(submitted.executionOutcomes.map(outcome => outcome.status)).to.deep.equal([
            'skipped-empty',
            'skipped-command',
        ])

        await submitted.done
    })

    it('does not create a segment for a skipped pass', async() => {

        const fixture = await createOrderingFixture()
        const skipped = createSkippedCompute(fixture.runtime, 'skip-pass')
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .compute(skipped.pass, [ skipped.command ])
            .upload(fixture.textureUpload)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'write-buffer',
            'write-texture',
        ])
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.computePasses).to.have.length(0)
        expect(submitted.commandBuffers).to.deep.equal([])
        expect(submitted.executionOutcomes.map(outcome => outcome.status)).to.deep.equal([
            'skipped-pass',
            'skipped-pass',
        ])

        await submitted.done
    })

    it('returns already-complete work for an effect-free submission', async() => {

        const fixture = await createOrderingFixture()
        const emptyPass = fixture.runtime.createComputePass({ label: 'effect-free pass' })
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .compute(emptyPass, [])
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([])
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.computePasses).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
        expect(fixture.queue.submittedWorkDoneCalls).to.equal(0)
        expect(submitted.commandBuffers).to.deep.equal([])
        expect(submitted.then).to.equal(undefined)

        await submitted.done
    })

    it('performs all validation before an earlier declared upload can touch the queue', async() => {

        const fixture = await createOrderingFixture()
        const refresh = fixture.runtime.createUploadCommand({
            label: 'refresh before invalid copy',
            target: fixture.copySource,
            data: new Uint8Array(16).fill(5),
        })

        const diagnostic = expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(refresh)
            .copy(fixture.secondCopy)
            .submit(), 'SCRATCH_SUBMISSION_STALE_READ')

        expect(diagnostic.actual).to.deep.include({ stepIndex: 1 })
        expect(timelineTypes(fixture.calls)).to.deep.equal([])
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.queueWrites).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
        expect(fixture.copySource.contentEpoch).to.equal(1)
        expect(fixture.secondCopyTarget.contentEpoch).to.equal(0)
    })

    it('preserves physical order in warn and off validation modes', async() => {

        for (const validation of [ 'warn', 'off' ]) {
            const fixture = await createOrderingFixture()
            const refreshBytes = new Uint8Array(16).fill(9)
            const refresh = fixture.runtime.createUploadCommand({
                label: `${validation} refresh`,
                target: fixture.copySource,
                data: refreshBytes,
            })
            const submitted = fixture.runtime.createSubmission({ validation })
                .copy(fixture.firstCopy)
                .upload(refresh)
                .copy(fixture.secondCopy)
                .submit()

            expect(timelineTypes(fixture.calls)).to.deep.equal([
                'submit',
                'write-buffer',
                'submit',
            ])
            expect(submitted.commandBuffers).to.have.length(2)
            expect(submitted.diagnostics).to.have.length(validation === 'warn' ? 1 : 0)
            expect(Array.from(fixture.firstCopyTarget.gpuBuffer.data)).to.deep.equal(new Array(16).fill(0))
            expect(Array.from(fixture.secondCopyTarget.gpuBuffer.data)).to.deep.equal(new Array(16).fill(9))

            await submitted.done
        }
    })

    it('keeps queue segments, resource accesses, and producer epochs in one declared order', async() => {

        const fixture = await createOrderingFixture()
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(fixture.upload)
            .copy(fixture.secondCopy)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'submit',
            'write-buffer',
            'submit',
        ])
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            resourceId: access.resourceId,
            access: access.access,
            contentEpochBefore: access.contentEpochBefore,
            contentEpochAfter: access.contentEpochAfter,
        }))).to.deep.equal([
            { stepIndex: 0, stepKind: 'copy', resourceId: fixture.copySource.id, access: 'read', contentEpochBefore: 1, contentEpochAfter: 1 },
            { stepIndex: 0, stepKind: 'copy', resourceId: fixture.firstCopyTarget.id, access: 'write', contentEpochBefore: 0, contentEpochAfter: 1 },
            { stepIndex: 1, stepKind: 'upload', resourceId: fixture.uploadTarget.id, access: 'write', contentEpochBefore: 0, contentEpochAfter: 1 },
            { stepIndex: 2, stepKind: 'copy', resourceId: fixture.copySource.id, access: 'read', contentEpochBefore: 1, contentEpochAfter: 1 },
            { stepIndex: 2, stepKind: 'copy', resourceId: fixture.secondCopyTarget.id, access: 'write', contentEpochBefore: 0, contentEpochAfter: 1 },
        ])
        expect(submitted.producerEpochs.map(epoch => ({
            resourceId: epoch.resourceId,
            contentEpoch: epoch.contentEpoch,
            stepIndex: epoch.producedBy.stepIndex,
            stepKind: epoch.producedBy.stepKind,
        }))).to.deep.equal([
            { resourceId: fixture.firstCopyTarget.id, contentEpoch: 1, stepIndex: 0, stepKind: 'copy' },
            { resourceId: fixture.uploadTarget.id, contentEpoch: 1, stepIndex: 1, stepKind: 'upload' },
            { resourceId: fixture.secondCopyTarget.id, contentEpoch: 1, stepIndex: 2, stepKind: 'copy' },
        ])
        expect(fixture.uploadTarget.contentEpoch).to.equal(1)

        await submitted.done
    })

    it('submits ordered readback staging before a later upload', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const source = runtime.createBuffer({
            label: 'readback before upload source',
            size: 8,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const initialUpload = runtime.createUploadCommand({
            target: source,
            data: new Uint32Array([ 1, 2 ]),
        })
        initialUpload.execute(fake.queue)
        fake.calls.queueTimeline.length = 0
        const readback = runtime.createReadbackCommand({
            label: 'read before later upload',
            source: { resource: source, contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const laterUpload = runtime.createUploadCommand({
            target: source,
            data: new Uint32Array([ 9, 10 ]),
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .readback(readback)
            .upload(laterUpload)
            .submit()
        const operation = readback.result({ after: submitted })

        expect(timelineTypes(fake.calls)).to.deep.equal([
            'submit',
            'write-buffer',
        ])
        expect(operation.contentEpoch).to.equal(1)
        expect(Array.from(await operation.toArray(Uint32Array))).to.deep.equal([ 1, 2 ])
    })

    it('enqueues an upload before later ordered readback staging', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const source = runtime.createBuffer({
            label: 'upload before readback source',
            size: 8,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const upload = runtime.createUploadCommand({
            target: source,
            data: new Uint32Array([ 3, 4 ]),
        })
        const readback = runtime.createReadbackCommand({
            label: 'read uploaded bytes',
            source: { resource: source, contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .readback(readback)
            .submit()
        const operation = readback.result({ after: submitted })

        expect(timelineTypes(fake.calls)).to.deep.equal([
            'write-buffer',
            'submit',
        ])
        expect(operation.contentEpoch).to.equal(1)
        expect(Array.from(await operation.toArray(Uint32Array))).to.deep.equal([ 3, 4 ])
    })

    it('keeps readback operations and producer epochs distinct across an upload boundary', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const source = runtime.createBuffer({
            label: 'two epoch readback source',
            size: 8,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const firstUpload = runtime.createUploadCommand({
            label: 'epoch one upload',
            target: source,
            data: new Uint32Array([ 1, 2 ]),
        })
        const firstReadback = runtime.createReadbackCommand({
            label: 'epoch one readback',
            source: { resource: source, contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const secondUpload = runtime.createUploadCommand({
            label: 'epoch two upload',
            target: source,
            data: new Uint32Array([ 7, 8 ]),
        })
        const secondReadback = runtime.createReadbackCommand({
            label: 'epoch two readback',
            source: { resource: source, contentEpoch: 2 },
            whenMissing: 'throw',
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(firstUpload)
            .readback(firstReadback)
            .upload(secondUpload)
            .readback(secondReadback)
            .submit()
        const firstOperation = firstReadback.result({ after: submitted })
        const secondOperation = secondReadback.result({ after: submitted })

        expect(timelineTypes(fake.calls)).to.deep.equal([
            'write-buffer',
            'submit',
            'write-buffer',
            'submit',
        ])
        expect(submitted.commandBuffers).to.have.length(2)
        expect(firstOperation).to.not.equal(secondOperation)
        expect(firstOperation.stagingBuffer).to.not.equal(secondOperation.stagingBuffer)
        expect([ firstOperation.contentEpoch, secondOperation.contentEpoch ]).to.deep.equal([ 1, 2 ])
        expect([
            firstOperation.producerEpoch?.contentEpoch,
            secondOperation.producerEpoch?.contentEpoch,
        ]).to.deep.equal([ 1, 2 ])
        expect([
            firstOperation.producerEpoch?.producedBy.stepIndex,
            secondOperation.producerEpoch?.producedBy.stepIndex,
        ]).to.deep.equal([ 0, 2 ])
        expect(Array.from(await firstOperation.toArray(Uint32Array))).to.deep.equal([ 1, 2 ])
        expect(Array.from(await secondOperation.toArray(Uint32Array))).to.deep.equal([ 7, 8 ])
    })
})
