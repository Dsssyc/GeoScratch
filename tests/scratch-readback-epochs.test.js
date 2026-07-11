import { expect } from 'chai'
import {
    ReadbackOperation,
    ScratchDiagnosticError,
    ScratchRuntime,
    layoutCodec,
} from 'geoscratch'
import { createFakeGpu, replaceResourceAllocationForTest } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_STORAGE = 0x80
const GPU_TEXTURE_USAGE_COPY_SRC = 0x1
const GPU_TEXTURE_USAGE_COPY_DST = 0x2

async function createRuntimeFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })

    return { ...fake, runtime }
}

async function createReadableBuffer(runtime, label = 'readback source') {

    return await runtime.createBuffer({
        label,
        size: 16,
        usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
    })
}

function createUpload(runtime, target, values = [ 1, 2, 3, 4 ]) {

    return runtime.createUploadCommand({
        label: `upload ${target.label}`,
        target,
        data: new Float32Array(values),
    })
}

function submitUpload(runtime, target, values) {

    return runtime.createSubmission({ validation: 'throw' })
        .upload(createUpload(runtime, target, values))
        .submit()
}

function createParticleCodec() {

    return layoutCodec({
        label: 'readback epoch particle layout',
        name: 'ReadbackEpochParticle',
        fields: [
            { name: 'position', type: 'vec3f' },
            { name: 'mass', type: 'f32' },
        ],
    }, {
        usage: [ 'storage', 'readback' ],
    })
}

async function expectDiagnostic(action, expected) {

    let caught
    try {
        await action()
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(ScratchDiagnosticError)
    expect(caught.diagnostic).to.include(expected)

    return caught.diagnostic
}

describe('scratch ReadbackOperation epoch provenance', () => {

    it('captures producer epochs from after submissions that write the source', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = await createReadableBuffer(runtime, 'produced source')
        const submitted = submitUpload(runtime, source)
        const readback = runtime.createReadback({
            label: 'read produced source',
            source,
            after: submitted,
            range: { offset: 0, byteLength: 16 },
        })

        expect(readback).to.be.instanceOf(ReadbackOperation)
        expect(readback.producerEpoch).to.deep.equal(submitted.producerEpochs[0])
        expect(readback.contentEpoch).to.equal(submitted.producerEpochs[0].contentEpoch)
        expect(readback.allocationVersion).to.equal(submitted.producerEpochs[0].allocationVersion)

        await submitted.done
    })

    it('keeps after as a completion fence when it does not produce the source', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = await createReadableBuffer(runtime, 'unproduced source')
        const fenceTarget = await createReadableBuffer(runtime, 'fence target')
        source.gpuBuffer.data.set(new Uint8Array([ 1, 2, 3, 4 ]))
        const submitted = submitUpload(runtime, fenceTarget)
        const readback = runtime.createReadback({
            source,
            after: submitted,
            range: { offset: 0, byteLength: 4 },
        })
        const bytes = await readback.toBytes()

        expect(readback.producerEpoch).to.equal(undefined)
        expect(readback.contentEpoch).to.equal(source.contentEpoch)
        expect([ ...bytes ]).to.deep.equal([ 1, 2, 3, 4 ])
    })

    it('rejects readback creation when after points to an older source content epoch', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = await createReadableBuffer(runtime, 'stale creation source')
        const first = submitUpload(runtime, source, [ 1, 2, 3, 4 ])
        submitUpload(runtime, source, [ 5, 6, 7, 8 ])

        const diagnostic = await expectDiagnostic(() => runtime.createReadback({
            source,
            after: first,
            range: { offset: 0, byteLength: 16 },
        }), {
            code: 'SCRATCH_READBACK_SOURCE_EPOCH_STALE',
            severity: 'error',
            phase: 'readback',
        })

        expect(diagnostic.related).to.deep.equal([ source.subject, first.subject ])
        expect(diagnostic.expected).to.deep.equal({ contentEpoch: 1 })
        expect(diagnostic.actual).to.deep.include({ contentEpoch: 2 })
    })

    it('rejects readback consumption when the source advances after creation', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const source = await createReadableBuffer(runtime, 'stale consume source')
        const submitted = submitUpload(runtime, source, [ 1, 2, 3, 4 ])
        const readback = runtime.createReadback({
            source,
            after: submitted,
            range: { offset: 0, byteLength: 16 },
        })
        const copyCount = calls.copies.length
        const queueSubmissionCount = calls.queueSubmissions.length
        const queueWriteCount = calls.queueWrites.length
        submitUpload(runtime, source, [ 5, 6, 7, 8 ])

        const diagnostic = await expectDiagnostic(() => readback.toBytes(), {
            code: 'SCRATCH_READBACK_SOURCE_EPOCH_STALE',
            severity: 'error',
            phase: 'readback',
        })

        expect(diagnostic.related).to.deep.equal([ source.subject, submitted.subject ])
        expect(diagnostic.expected).to.deep.equal({ contentEpoch: 1 })
        expect(diagnostic.actual).to.deep.include({ contentEpoch: 2 })
        expect(calls.copies).to.have.length(copyCount)
        expect(calls.queueWrites).to.have.length(queueWriteCount + 1)
        expect(calls.queueSubmissions).to.have.length(queueSubmissionCount)
    })

    it('rejects stale allocation versions before staging copy', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const source = await createReadableBuffer(runtime, 'stale allocation source')
        const submitted = submitUpload(runtime, source)
        const readback = runtime.createReadback({
            source,
            after: submitted,
            range: { offset: 0, byteLength: 16 },
        })
        const copyCount = calls.copies.length
        const queueSubmissionCount = calls.queueSubmissions.length

        replaceResourceAllocationForTest(source)

        const diagnostic = await expectDiagnostic(() => readback.toBytes(), {
            code: 'SCRATCH_READBACK_SOURCE_ALLOCATION_STALE',
            severity: 'error',
            phase: 'readback',
        })

        expect(diagnostic.related).to.deep.equal([ source.subject, submitted.subject ])
        expect(diagnostic.expected).to.deep.equal({ allocationVersion: 1 })
        expect(diagnostic.actual).to.deep.include({ allocationVersion: 2 })
        expect(calls.copies).to.have.length(copyCount)
        expect(calls.queueSubmissions).to.have.length(queueSubmissionCount)
    })

    it('keeps copied buffer provenance independent from later texture replacement', async() => {

        const { runtime } = await createRuntimeFixture()
        const texture = await runtime.createTexture({
            label: 'readback upstream texture',
            size: { width: 2, height: 2 },
            format: 'rgba8unorm',
            usage: GPU_TEXTURE_USAGE_COPY_SRC | GPU_TEXTURE_USAGE_COPY_DST,
        })
        const source = await runtime.createBuffer({
            label: 'texture copy readback buffer',
            size: 512,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
        })
        const upload = runtime.createTextureUploadCommand({
            target: texture,
            data: new Uint8Array(16),
            layout: { bytesPerRow: 8, rowsPerImage: 2 },
            size: { width: 2, height: 2 },
        })
        const copy = runtime.createCopyCommand({
            source: { resource: texture, contentEpoch: 1 },
            target: source,
            targetLayout: { offset: 0, bytesPerRow: 256, rowsPerImage: 2 },
            size: { width: 2, height: 2 },
            whenMissing: 'throw',
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .copy(copy)
            .submit()
        const readback = runtime.createReadback({
            source,
            after: submitted,
            range: { offset: 0, byteLength: 16 },
        })

        await texture.resize([ 4, 4 ])
        const bytes = await readback.toBytes()

        expect(bytes).to.have.length(16)
        expect(readback.source).to.equal(source)
        expect(readback.allocationVersion).to.equal(1)
        expect(readback.contentEpoch).to.equal(1)
        expect(texture.allocationVersion).to.equal(2)
        expect(texture.state).to.equal('empty')
    })

    it('rejects readback creation when after points to an older source allocation version', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = await createReadableBuffer(runtime, 'stale allocation creation source')
        const submitted = submitUpload(runtime, source)

        replaceResourceAllocationForTest(source)

        const diagnostic = await expectDiagnostic(() => runtime.createReadback({
            source,
            after: submitted,
            range: { offset: 0, byteLength: 16 },
        }), {
            code: 'SCRATCH_READBACK_SOURCE_ALLOCATION_STALE',
            severity: 'error',
            phase: 'readback',
        })

        expect(diagnostic.related).to.deep.equal([ source.subject, submitted.subject ])
        expect(diagnostic.expected).to.deep.equal({ allocationVersion: 1 })
        expect(diagnostic.actual).to.deep.include({ allocationVersion: 2 })
    })

    it('keeps layout-aware readback working with captured producer epochs', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const values = [
            { position: [ 1, 2, 3 ], mass: 4 },
            { position: [ 5, 6, 7 ], mass: 8 },
        ]
        const uploadView = codec.uploadView(values)
        const source = await runtime.createBuffer({
            label: 'layout producer source',
            size: uploadView.byteLength,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
            layout: codec.artifact,
            elementCount: values.length,
        })
        const upload = runtime.createUploadCommand({
            target: source,
            data: uploadView,
            layout: codec.artifact,
        })
        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(upload)
            .submit()
        const readback = runtime.createReadback({
            source,
            after: submitted,
            range: { offset: 0, byteLength: uploadView.byteLength },
        })
        const view = await readback.toLayoutView()

        expect(readback.producerEpoch).to.deep.equal(submitted.producerEpochs[0])
        expect(view.toArray()).to.deep.equal(values)
    })
})
