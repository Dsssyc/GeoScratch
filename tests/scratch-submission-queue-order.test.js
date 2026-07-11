import { expect } from 'chai'
import { ScratchDiagnosticError, ScratchRuntime } from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_BUFFER_USAGE_QUERY_RESOLVE = 0x200
const GPU_TEXTURE_USAGE_COPY_DST = 0x2
const GPU_TEXTURE_USAGE_COPY_SRC = 0x1
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10

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

function createExternalImageUpload(runtime, label, options = {}) {

    const source = options.source ?? { width: 4, height: 4, revision: 0 }
    const target = runtime.createTexture({
        label: `${label} target`,
        size: options.targetSize ?? { width: 4, height: 4 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_COPY_SRC |
            GPU_TEXTURE_USAGE_COPY_DST |
            GPU_TEXTURE_USAGE_TEXTURE_BINDING |
            GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const command = runtime.createExternalImageUploadCommand({
        label,
        source,
        sourceOrigin: options.sourceOrigin ?? { x: 0, y: 0 },
        target,
        size: options.size ?? { width: 2, height: 2 },
    })

    return { source, target, command }
}

function createComputeWork(runtime) {

    const output = runtime.createBuffer({
        label: 'external upload compute output',
        size: 16,
        usage: GPU_BUFFER_USAGE_STORAGE,
    })
    const program = runtime.createProgram({
        modules: [ '@compute @workgroup_size(1) fn csMain() {}' ],
        entryPoints: { compute: 'csMain' },
    })
    const pipeline = runtime.createComputePipeline({ program, bindLayouts: [] })
    const command = runtime.createDispatchCommand({
        pipeline,
        count: { workgroups: [ 1 ] },
        resources: { read: [], write: [ output ] },
        whenMissing: 'throw',
    })
    const pass = runtime.createComputePass({ label: 'external upload compute pass' })

    return { output, command, pass }
}

function createRenderWork(runtime) {

    const target = runtime.createTexture({
        label: 'external upload render target',
        size: { width: 2, height: 2 },
        format: 'rgba8unorm',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    })
    const pass = runtime.createRenderPass({
        label: 'external upload render pass',
        color: [ {
            target,
            load: 'clear',
            store: 'store',
            clear: [ 0, 0, 0, 1 ],
        } ],
    })

    return { target, pass }
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

function createFallbackCompute(runtime) {

    const missing = runtime.createBuffer({
        label: 'fallback missing input',
        size: 16,
        usage: GPU_BUFFER_USAGE_STORAGE,
    })
    const ready = runtime.createBuffer({
        label: 'fallback ready input',
        size: 16,
        usage: GPU_BUFFER_USAGE_STORAGE,
    })
    const output = runtime.createBuffer({
        label: 'fallback output',
        size: 16,
        usage: GPU_BUFFER_USAGE_STORAGE,
    })
    ready._advanceContentEpoch()
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
    const pipeline = runtime.createComputePipeline({ program, bindLayouts: [] })
    const fallback = runtime.createDispatchCommand({
        label: 'selected fallback dispatch',
        pipeline,
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ { resource: ready, contentEpoch: 1 } ],
            write: [ output ],
        },
        whenMissing: 'throw',
    })
    const primary = runtime.createDispatchCommand({
        label: 'missing primary dispatch',
        pipeline,
        count: { workgroups: [ 1 ] },
        resources: {
            read: [ { resource: missing, contentEpoch: 1 } ],
            write: [ output ],
        },
        whenMissing: 'use-fallback',
        fallback,
    })
    const pass = runtime.createComputePass({ label: 'fallback compute pass' })

    return { primary, fallback, pass, output }
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

    it('keeps leading, trailing, and interleaved external image uploads in exact queue order', async() => {

        for (const placement of [ 'leading', 'trailing', 'interleaved' ]) {
            const fixture = await createOrderingFixture()
            const external = createExternalImageUpload(fixture.runtime, `${placement} external image upload`)
            const builder = fixture.runtime.createSubmission({ validation: 'throw' })

            if (placement === 'leading') {
                builder.upload(external.command).copy(fixture.firstCopy)
            } else if (placement === 'trailing') {
                builder.copy(fixture.firstCopy).upload(external.command)
            } else {
                builder.copy(fixture.firstCopy).upload(external.command).copy(fixture.secondCopy)
            }
            const submitted = builder.submit()

            expect(timelineTypes(fixture.calls)).to.deep.equal(placement === 'leading'
                ? [ 'external-image-upload', 'submit' ]
                : placement === 'trailing'
                    ? [ 'submit', 'external-image-upload' ]
                    : [ 'submit', 'external-image-upload', 'submit' ])
            expect(submitted.commandBuffers).to.have.length(placement === 'interleaved' ? 2 : 1)
            expect(external.target.contentEpoch).to.equal(1)
            await submitted.done
        }
    })

    it('orders all three upload kinds without creating empty command buffers', async() => {

        const fixture = await createOrderingFixture()
        const firstExternal = createExternalImageUpload(fixture.runtime, 'first external image upload')
        const secondExternal = createExternalImageUpload(fixture.runtime, 'second external image upload')
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(fixture.upload)
            .upload(firstExternal.command)
            .upload(fixture.textureUpload)
            .upload(secondExternal.command)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'write-buffer',
            'external-image-upload',
            'write-texture',
            'external-image-upload',
        ])
        expect(submitted.commandBuffers).to.deep.equal([])
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.queueSubmissions).to.have.length(0)
        expect(fixture.calls.submittedWorkDoneRegistrations).to.deep.equal([
            { queueTimelineLength: 4 },
        ])
        expect([
            fixture.uploadTarget.contentEpoch,
            firstExternal.target.contentEpoch,
            fixture.textureTarget.contentEpoch,
            secondExternal.target.contentEpoch,
        ]).to.deep.equal([ 1, 1, 1, 1 ])

        await submitted.done
    })

    it('preserves external upload order relative to copy, readback, compute, and render work', async() => {

        const fixture = await createOrderingFixture()
        const firstExternal = createExternalImageUpload(fixture.runtime, 'external before copy and readback')
        const secondExternal = createExternalImageUpload(fixture.runtime, 'external before compute and render')
        const readback = fixture.runtime.createReadbackCommand({
            source: { resource: fixture.copySource, contentEpoch: 1 },
            whenMissing: 'throw',
        })
        const compute = createComputeWork(fixture.runtime)
        const render = createRenderWork(fixture.runtime)
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(firstExternal.command)
            .copy(fixture.firstCopy)
            .readback(readback)
            .upload(secondExternal.command)
            .compute(compute.pass, [ compute.command ])
            .render(render.pass, [])
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'external-image-upload',
            'submit',
            'external-image-upload',
            'submit',
        ])
        expect(submitted.commandBuffers).to.have.length(2)
        expect(fixture.calls.copies).to.have.length(2)
        expect(fixture.calls.computePasses).to.have.length(1)
        expect(fixture.calls.renderPasses).to.have.length(1)
        expect(readback.result({ after: submitted }).contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => access.stepIndex)).to.deep.equal([
            0,
            1, 1,
            2,
            3,
            4,
            5,
        ])

        await submitted.done
    })

    it('records exactly one external upload target write and producer epoch', async() => {

        const fixture = await createOrderingFixture()
        const external = createExternalImageUpload(fixture.runtime, 'ledger external image upload')
        const allocationVersion = external.target.allocationVersion
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(external.command)
            .submit()

        expect(submitted.resourceAccesses).to.have.length(1)
        expect(submitted.resourceAccesses[0]).to.include({
            stepIndex: 0,
            stepKind: 'upload',
            commandKind: 'upload',
            commandId: external.command.id,
            resourceId: external.target.id,
            access: 'write',
            contentEpochBefore: 0,
            contentEpochAfter: 1,
            allocationVersion,
        })
        expect(submitted.producerEpochs).to.have.length(1)
        expect(submitted.producerEpochs[0]).to.include({
            resourceId: external.target.id,
            contentEpoch: 1,
            allocationVersion,
        })
        expect(submitted.producerEpochs[0].producedBy).to.deep.equal({
            stepIndex: 0,
            stepKind: 'upload',
            commandKind: 'upload',
            commandId: external.command.id,
        })
        expect(external.target.allocationVersion).to.equal(allocationVersion)
        expect(submitted.commandBuffers).to.deep.equal([])

        await submitted.done
    })

    it('keeps zero-area external uploads ordered but absent from epochs and ledgers', async() => {

        const fixture = await createOrderingFixture()
        const external = createExternalImageUpload(fixture.runtime, 'zero-area external image upload', {
            size: { width: 0, height: 2 },
        })
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(external.command)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([ 'external-image-upload' ])
        expect(external.target.contentEpoch).to.equal(0)
        expect(external.target.state).to.equal('empty')
        expect(submitted.resourceAccesses).to.deep.equal([])
        expect(submitted.producerEpochs).to.deep.equal([])
        expect(submitted.commandBuffers).to.deep.equal([])
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.calls.submittedWorkDoneRegistrations).to.deep.equal([
            { queueTimelineLength: 1 },
        ])

        await submitted.done
    })

    it('does not let a zero-area external upload satisfy a later resource epoch dependency', async() => {

        const fixture = await createOrderingFixture()
        const external = createExternalImageUpload(fixture.runtime, 'zero-area dependency upload', {
            size: { width: 0, height: 1 },
        })
        const target = fixture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const copy = fixture.runtime.createCopyCommand({
            source: { resource: external.target, contentEpoch: 1 },
            target,
            size: { width: 1, height: 1 },
            whenMissing: 'throw',
        })

        expectScratchDiagnostic(() => fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(external.command)
            .copy(copy)
            .submit(), 'SCRATCH_COMMAND_RESOURCE_NOT_READY')

        expect(timelineTypes(fixture.calls)).to.deep.equal([])
        expect(external.target.contentEpoch).to.equal(0)
        expect(target.contentEpoch).to.equal(0)
    })

    it('lets a non-empty external upload produce a texture epoch for a later GPU copy', async() => {

        const fixture = await createOrderingFixture()
        const external = createExternalImageUpload(fixture.runtime, 'external producer upload')
        const target = fixture.runtime.createTexture({
            size: { width: 4, height: 4 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_DST,
        })
        const copy = fixture.runtime.createCopyCommand({
            source: { resource: external.target, contentEpoch: 1 },
            target,
            size: { width: 2, height: 2 },
            whenMissing: 'throw',
        })
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(external.command)
            .copy(copy)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([ 'external-image-upload', 'submit' ])
        expect(external.target.contentEpoch).to.equal(1)
        expect(target.contentEpoch).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            resourceId: access.resourceId,
            access: access.access,
            contentEpochAfter: access.contentEpochAfter,
        }))).to.deep.equal([
            { stepIndex: 0, resourceId: external.target.id, access: 'write', contentEpochAfter: 1 },
            { stepIndex: 1, resourceId: external.target.id, access: 'read', contentEpochAfter: 1 },
            { stepIndex: 1, resourceId: target.id, access: 'write', contentEpochAfter: 1 },
        ])

        await submitted.done
    })

    it('preflights every external upload before the first physical queue action', async() => {

        const fixture = await createOrderingFixture()
        const first = createExternalImageUpload(fixture.runtime, 'valid external preflight')
        const second = createExternalImageUpload(fixture.runtime, 'invalid external preflight')
        second.source.width = 1
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(first.command)
            .upload(second.command)

        expectScratchDiagnostic(() => builder.submit(), 'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID')

        expect(timelineTypes(fixture.calls)).to.deep.equal([])
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.firstCopyTarget.contentEpoch).to.equal(0)
        expect(first.target.contentEpoch).to.equal(0)
        expect(second.target.contentEpoch).to.equal(0)
        expect(builder.isSubmitted).to.equal(false)
    })

    it('stops external upload replay after a native failure and remains non-retryable', async() => {

        const fixture = await createOrderingFixture()
        const first = createExternalImageUpload(fixture.runtime, 'successful external action')
        const failed = createExternalImageUpload(fixture.runtime, 'failed external action')
        const later = createExternalImageUpload(fixture.runtime, 'unreplayed external action')
        const nativeCopy = fixture.queue.copyExternalImageToTexture.bind(fixture.queue)
        const cause = new DOMException('injected source failure', 'OperationError')
        let nativeCalls = 0
        fixture.queue.copyExternalImageToTexture = (...args) => {
            nativeCalls++
            if (nativeCalls === 2) throw cause
            nativeCopy(...args)
        }
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(first.command)
            .upload(failed.command)
            .upload(later.command)

        let caught
        try {
            builder.submit()
        } catch (error) {
            caught = error
        }

        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic.code).to.equal('SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_FAILED')
        expect(caught.cause).to.equal(cause)
        expect(timelineTypes(fixture.calls)).to.deep.equal([ 'submit', 'external-image-upload' ])
        expect(nativeCalls).to.equal(2)
        expect(fixture.firstCopyTarget.contentEpoch).to.equal(1)
        expect(first.target.contentEpoch).to.equal(1)
        expect(failed.target.contentEpoch).to.equal(0)
        expect(later.target.contentEpoch).to.equal(0)
        expect(builder.isSubmitted).to.equal(true)
        expectScratchDiagnostic(() => builder.submit(), 'SCRATCH_SUBMISSION_WORK_ALREADY_SUBMITTED')
        expect(nativeCalls).to.equal(2)
    })

    it('commits no effects when the first external image queue action fails', async() => {

        const fixture = await createOrderingFixture()
        const failed = createExternalImageUpload(fixture.runtime, 'first failed external action')
        const cause = new DOMException('first action failed', 'OperationError')
        let nativeCalls = 0
        fixture.queue.copyExternalImageToTexture = () => {
            nativeCalls++
            throw cause
        }
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .upload(failed.command)
            .copy(fixture.firstCopy)

        let caught
        try {
            builder.submit()
        } catch (error) {
            caught = error
        }

        expect(caught).to.be.instanceOf(ScratchDiagnosticError)
        expect(caught.diagnostic.code).to.equal('SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_FAILED')
        expect(caught.cause).to.equal(cause)
        expect(nativeCalls).to.equal(1)
        expect(timelineTypes(fixture.calls)).to.deep.equal([])
        expect(fixture.calls.queueSubmissions).to.have.length(0)
        expect(failed.target.contentEpoch).to.equal(0)
        expect(fixture.firstCopyTarget.contentEpoch).to.equal(0)
        expect(builder.isSubmitted).to.equal(true)
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

    it('segments effectful render passes at an upload boundary', async() => {

        const fixture = await createOrderingFixture()
        const target = fixture.runtime.createTexture({
            label: 'queue order render target',
            size: { width: 2, height: 2 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        })
        const pass = fixture.runtime.createRenderPass({
            label: 'queue order render pass',
            color: [ {
                target,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            } ],
        })
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .render(pass, [])
            .upload(fixture.upload)
            .render(pass, [])
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'submit',
            'write-buffer',
            'submit',
        ])
        expect(fixture.calls.renderPasses).to.have.length(2)
        expect(submitted.commandBuffers).to.have.length(2)
        expect(target.contentEpoch).to.equal(2)
        expect(target.allocationVersion).to.equal(1)
        expect(submitted.resourceAccesses.map(access => ({
            stepIndex: access.stepIndex,
            stepKind: access.stepKind,
            passId: access.passId,
            resourceId: access.resourceId,
            allocationVersion: access.allocationVersion,
        })).filter(access => access.resourceId === target.id)).to.deep.equal([
            { stepIndex: 0, stepKind: 'render', passId: pass.id, resourceId: target.id, allocationVersion: 1 },
            { stepIndex: 2, stepKind: 'render', passId: pass.id, resourceId: target.id, allocationVersion: 1 },
        ])

        await submitted.done
    })

    it('segments query resolves at an upload boundary', async() => {

        const fixture = await createOrderingFixture()
        const querySet = fixture.runtime.createQuerySet({
            label: 'queue order query set',
            type: 'timestamp',
            count: 1,
        })
        querySet._advanceSlotContentEpoch(0)
        const destination = fixture.runtime.createBuffer({
            label: 'queue order resolve destination',
            size: 8,
            usage: GPU_BUFFER_USAGE_QUERY_RESOLVE,
        })
        const resolve = fixture.runtime.createResolveQuerySetCommand({
            label: 'queue order resolve',
            source: {
                querySet,
                slots: [ { index: 0, contentEpoch: 1 } ],
            },
            destination,
            whenMissing: 'throw',
        })
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .resolve(resolve)
            .upload(fixture.upload)
            .resolve(resolve)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'submit',
            'write-buffer',
            'submit',
        ])
        expect(fixture.calls.resolveQueries).to.have.length(2)
        expect(submitted.commandBuffers).to.have.length(2)
        expect(destination.contentEpoch).to.equal(2)
        expect(destination.allocationVersion).to.equal(1)

        await submitted.done
    })

    it('encodes only the selected fallback after an upload boundary', async() => {

        const fixture = await createOrderingFixture()
        const compute = createFallbackCompute(fixture.runtime)
        const submitted = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(fixture.upload)
            .compute(compute.pass, [ compute.primary ])
            .copy(fixture.secondCopy)
            .submit()

        expect(timelineTypes(fixture.calls)).to.deep.equal([
            'submit',
            'write-buffer',
            'submit',
        ])
        expect(fixture.calls.computePasses).to.have.length(1)
        expect(fixture.calls.dispatchCalls).to.have.length(1)
        expect(submitted.commandBuffers).to.have.length(2)
        expect(submitted.executionOutcomes.map(outcome => outcome.status)).to.deep.equal([
            'executed',
            'fallback-executed',
        ])
        const fallbackWrite = submitted.resourceAccesses.find(access => (
            access.resourceId === compute.output.id && access.access === 'write'
        ))
        expect(fallbackWrite).to.include({
            stepIndex: 2,
            stepKind: 'compute',
            commandKind: 'dispatch',
            commandId: compute.fallback.id,
            passId: compute.pass.id,
            contentEpochBefore: 0,
            contentEpochAfter: 1,
            allocationVersion: 1,
        })

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

    it('validates every upload queue capability before an earlier segment can be submitted', async() => {

        const fixture = await createOrderingFixture()
        fixture.queue.writeTexture = undefined
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(fixture.textureUpload)

        expectScratchDiagnostic(() => builder.submit(), 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE')

        expect(timelineTypes(fixture.calls)).to.deep.equal([])
        expect(fixture.calls.commandEncoders).to.have.length(0)
        expect(fixture.firstCopyTarget.contentEpoch).to.equal(0)
        expect(fixture.textureTarget.contentEpoch).to.equal(0)
        expect(builder.isSubmitted).to.equal(false)
    })

    it('rejects detached upload data before changing logical or physical state', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const target = runtime.createBuffer({
            label: 'detached upload target',
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })
        const data = new ArrayBuffer(16)
        const upload = runtime.createUploadCommand({ target, data })
        structuredClone(data, { transfer: [ data ] })

        expectScratchDiagnostic(() => runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .submit(), 'SCRATCH_COMMAND_UPLOAD_RANGE_INVALID')

        expect(target.contentEpoch).to.equal(0)
        expect(target.state).to.equal('empty')
        expect(timelineTypes(fake.calls)).to.deep.equal([])
        expect(fake.calls.commandEncoders).to.have.length(0)
    })

    it('commits only successful actions and forbids retry after an unexpected replay failure', async() => {

        const fixture = await createOrderingFixture()
        fixture.queue.writeTexture = () => {
            throw new Error('injected texture write failure')
        }
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .copy(fixture.firstCopy)
            .upload(fixture.textureUpload)

        expect(() => builder.submit()).to.throw('injected texture write failure')

        expect(timelineTypes(fixture.calls)).to.deep.equal([ 'submit' ])
        expect(fixture.firstCopyTarget.contentEpoch).to.equal(1)
        expect(fixture.textureTarget.contentEpoch).to.equal(0)
        expect(builder.isSubmitted).to.equal(true)
        expectScratchDiagnostic(() => builder.submit(), 'SCRATCH_SUBMISSION_WORK_ALREADY_SUBMITTED')
        expect(timelineTypes(fixture.calls)).to.deep.equal([ 'submit' ])
    })

    it('restores resource and query state when timeline preparation fails before replay', async() => {

        const fixture = await createOrderingFixture()
        const querySet = fixture.runtime.createQuerySet({
            label: 'preparation rollback query set',
            type: 'timestamp',
            count: 2,
        })
        const pass = fixture.runtime.createComputePass({
            label: 'preparation rollback pass',
            timestampWrites: {
                querySet,
                begin: 0,
                end: 1,
            },
        })
        const createCommandEncoder = fixture.device.createCommandEncoder.bind(fixture.device)
        let failCopyEncoding = true
        fixture.device.createCommandEncoder = (descriptor) => {
            const encoder = createCommandEncoder(descriptor)
            const copyBufferToBuffer = encoder.copyBufferToBuffer.bind(encoder)
            encoder.copyBufferToBuffer = (...args) => {
                if (failCopyEncoding) throw new Error('injected copy encoding failure')
                copyBufferToBuffer(...args)
            }
            return encoder
        }
        const builder = fixture.runtime.createSubmission({ validation: 'throw' })
            .compute(pass, [])
            .copy(fixture.firstCopy)

        expect(() => builder.submit()).to.throw('injected copy encoding failure')

        expect(querySet.slotStates).to.deep.equal([ 'empty', 'empty' ])
        expect(querySet.slotContentEpochs).to.deep.equal([ 0, 0 ])
        expect(fixture.firstCopyTarget.state).to.equal('empty')
        expect(fixture.firstCopyTarget.contentEpoch).to.equal(0)
        expect(timelineTypes(fixture.calls)).to.deep.equal([])
        expect(fixture.calls.queueSubmissions).to.have.length(0)
        expect(builder.isSubmitted).to.equal(false)

        failCopyEncoding = false
        const submitted = builder.submit()

        expect(querySet.slotStates).to.deep.equal([ 'ready', 'ready' ])
        expect(querySet.slotContentEpochs).to.deep.equal([ 1, 1 ])
        expect(fixture.firstCopyTarget.contentEpoch).to.equal(1)
        expect(timelineTypes(fixture.calls)).to.deep.equal([ 'submit' ])

        await submitted.done
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
            commandKind: access.commandKind,
            commandId: access.commandId,
            resourceId: access.resourceId,
            access: access.access,
            contentEpochBefore: access.contentEpochBefore,
            contentEpochAfter: access.contentEpochAfter,
            allocationVersion: access.allocationVersion,
        }))).to.deep.equal([
            { stepIndex: 0, stepKind: 'copy', commandKind: 'copy', commandId: fixture.firstCopy.id, resourceId: fixture.copySource.id, access: 'read', contentEpochBefore: 1, contentEpochAfter: 1, allocationVersion: 1 },
            { stepIndex: 0, stepKind: 'copy', commandKind: 'copy', commandId: fixture.firstCopy.id, resourceId: fixture.firstCopyTarget.id, access: 'write', contentEpochBefore: 0, contentEpochAfter: 1, allocationVersion: 1 },
            { stepIndex: 1, stepKind: 'upload', commandKind: 'upload', commandId: fixture.upload.id, resourceId: fixture.uploadTarget.id, access: 'write', contentEpochBefore: 0, contentEpochAfter: 1, allocationVersion: 1 },
            { stepIndex: 2, stepKind: 'copy', commandKind: 'copy', commandId: fixture.secondCopy.id, resourceId: fixture.copySource.id, access: 'read', contentEpochBefore: 1, contentEpochAfter: 1, allocationVersion: 1 },
            { stepIndex: 2, stepKind: 'copy', commandKind: 'copy', commandId: fixture.secondCopy.id, resourceId: fixture.secondCopyTarget.id, access: 'write', contentEpochBefore: 0, contentEpochAfter: 1, allocationVersion: 1 },
        ])
        expect(submitted.producerEpochs.map(epoch => ({
            resourceId: epoch.resourceId,
            contentEpoch: epoch.contentEpoch,
            allocationVersion: epoch.allocationVersion,
            stepIndex: epoch.producedBy.stepIndex,
            stepKind: epoch.producedBy.stepKind,
            commandKind: epoch.producedBy.commandKind,
            commandId: epoch.producedBy.commandId,
        }))).to.deep.equal([
            { resourceId: fixture.firstCopyTarget.id, contentEpoch: 1, allocationVersion: 1, stepIndex: 0, stepKind: 'copy', commandKind: 'copy', commandId: fixture.firstCopy.id },
            { resourceId: fixture.uploadTarget.id, contentEpoch: 1, allocationVersion: 1, stepIndex: 1, stepKind: 'upload', commandKind: 'upload', commandId: fixture.upload.id },
            { resourceId: fixture.secondCopyTarget.id, contentEpoch: 1, allocationVersion: 1, stepIndex: 2, stepKind: 'copy', commandKind: 'copy', commandId: fixture.secondCopy.id },
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
