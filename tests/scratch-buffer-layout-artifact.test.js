import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
    layoutCodec,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_STORAGE = 0x80

function createParticleCodec(name = 'Particle') {

    return layoutCodec({
        label: 'particle layout',
        name,
        fields: [
            { name: 'position', type: 'vec3f' },
            { name: 'mass', type: 'f32' },
        ],
    }, {
        usage: [ 'storage', 'readback' ],
    })
}

function createParticleValues(index = 0) {

    return {
        position: [ index + 1, index + 2, index + 3 ],
        mass: index + 4,
    }
}

async function createRuntimeFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })

    return { ...fake, runtime }
}

function expectDiagnostic(fn, include) {

    let caught
    try {
        fn()
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(ScratchDiagnosticError)
    expect(caught.diagnostic).to.include(include)

    return caught.diagnostic
}

describe('scratch BufferResource layout artifacts', () => {

    it('stores optional LayoutArtifact metadata while raw buffers stay valid', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const buffer = runtime.createBuffer({
            label: 'particles',
            size: codec.artifact.stride * 2,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
            layout: codec.artifact,
            elementCount: 2,
        })
        const rawBuffer = runtime.createBuffer({
            label: 'raw bytes',
            size: 32,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })

        expect(buffer.layout).to.equal(codec.artifact)
        expect(buffer.elementCount).to.equal(2)
        expect(buffer.layoutByteLength).to.equal(codec.artifact.stride * 2)
        expect(buffer.layoutSubject).to.deep.equal({
            kind: 'LayoutArtifact',
            hash: codec.artifact.structuralHash,
            label: codec.artifact.label,
        })
        expect(buffer.descriptor).to.include({
            label: 'particles',
            size: codec.artifact.stride * 2,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
        })
        expect(calls.buffers[0].descriptor).to.deep.equal({
            label: 'particles',
            size: codec.artifact.stride * 2,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
        })
        expect(rawBuffer.layout).to.equal(undefined)
        expect(rawBuffer.elementCount).to.equal(undefined)
        expect(rawBuffer.layoutByteLength).to.equal(undefined)
    })

    it('rejects invalid element counts and layout byte lengths with structured diagnostics', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()

        const invalidArtifact = expectDiagnostic(() => {
            runtime.createBuffer({
                size: codec.artifact.stride,
                usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
                layout: {
                    ...codec.artifact,
                    stride: 0,
                },
            })
        }, {
            code: 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
            severity: 'error',
            phase: 'layout-codec',
        })
        expect(invalidArtifact.expected).to.deep.equal({ layout: 'LayoutArtifact' })
        expect(invalidArtifact.actual).to.deep.equal({ layout: 'object' })

        const invalidCount = expectDiagnostic(() => {
            runtime.createBuffer({
                size: codec.artifact.stride,
                usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
                layout: codec.artifact,
                elementCount: 0,
            })
        }, {
            code: 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
            severity: 'error',
            phase: 'layout-codec',
        })
        expect(invalidCount.subject).to.deep.equal({
            kind: 'LayoutArtifact',
            hash: codec.artifact.structuralHash,
            label: codec.artifact.label,
        })
        expect(invalidCount.expected).to.deep.equal({ elementCount: 'positive integer' })
        expect(invalidCount.actual).to.deep.equal({ elementCount: 0 })

        const tooSmall = expectDiagnostic(() => {
            runtime.createBuffer({
                size: codec.artifact.stride - 1,
                usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
                layout: codec.artifact,
                elementCount: 1,
            })
        }, {
            code: 'SCRATCH_CODEC_BYTE_LENGTH_MISMATCH',
            severity: 'error',
            phase: 'layout-codec',
        })
        expect(tooSmall.subject).to.deep.equal({
            kind: 'LayoutArtifact',
            hash: codec.artifact.structuralHash,
            label: codec.artifact.label,
        })
        expect(tooSmall.expected).to.deep.equal({ layoutByteLength: codec.artifact.stride })
        expect(tooSmall.actual).to.deep.equal({ bufferSize: codec.artifact.stride - 1 })
    })

    it('uploads LayoutCodec upload views only when the target layout matches', async() => {

        const { runtime, queue, calls } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const uploadView = codec.uploadView(createParticleValues())
        const buffer = runtime.createBuffer({
            label: 'particles',
            size: codec.artifact.stride,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
            layout: codec.artifact,
        })
        const upload = runtime.createUploadCommand({
            label: 'upload particles',
            target: buffer,
            data: uploadView,
        })

        expect(upload.data).to.equal(uploadView.bytes)
        expect(upload.dataOffset).to.equal(uploadView.byteOffset)
        expect(upload.byteLength).to.equal(uploadView.byteLength)
        expect(upload.layout).to.equal(codec.artifact)

        upload.execute(queue)

        expect(calls.queueWrites).to.have.length(1)
        expect(Array.from(buffer.gpuBuffer.data.slice(0, uploadView.byteLength))).to.deep.equal(Array.from(uploadView.bytes))

        const offsetUpload = runtime.createUploadCommand({
            target: buffer,
            data: uploadView,
            dataOffset: 4,
        })
        expect(offsetUpload.dataOffset).to.equal(4)
        expect(offsetUpload.byteLength).to.equal(uploadView.byteLength - 4)
        expect(offsetUpload.layout).to.equal(codec.artifact)

        const mismatchCodec = createParticleCodec('ParticleMismatch')
        const mismatch = expectDiagnostic(() => {
            runtime.createUploadCommand({
                target: buffer,
                data: mismatchCodec.uploadView(createParticleValues()),
            })
        }, {
            code: 'SCRATCH_CODEC_STRUCTURAL_HASH_MISMATCH',
            severity: 'error',
            phase: 'layout-codec',
        })
        expect(mismatch.subject).to.deep.equal(buffer.layoutSubject)
        expect(mismatch.expected).to.deep.equal({ structuralHash: codec.artifact.structuralHash })
        expect(mismatch.actual).to.deep.equal({ structuralHash: mismatchCodec.artifact.structuralHash })
    })

    it('validates uploads against the layout-declared logical byte range', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const buffer = runtime.createBuffer({
            label: 'single particle in a larger allocation',
            size: codec.artifact.stride * 2,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
            layout: codec.artifact,
            elementCount: 1,
        })

        const diagnostic = expectDiagnostic(() => {
            runtime.createUploadCommand({
                target: buffer,
                data: new Uint8Array(4),
                offset: codec.artifact.stride,
            })
        }, {
            code: 'SCRATCH_CODEC_BYTE_LENGTH_MISMATCH',
            severity: 'error',
            phase: 'layout-codec',
        })

        expect(diagnostic.subject).to.deep.equal(buffer.layoutSubject)
        expect(diagnostic.expected).to.deep.equal({ layoutByteLength: codec.artifact.stride })
        expect(diagnostic.actual).to.deep.equal({
            offset: codec.artifact.stride,
            byteLength: 4,
            rangeEnd: codec.artifact.stride + 4,
        })
    })

    it('keeps readback byte interpretation explicit through LayoutCodec', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const values = [
            createParticleValues(0),
            createParticleValues(10),
        ]
        const bytes = codec.pack(values)
        const buffer = runtime.createBuffer({
            label: 'readback particles',
            size: bytes.byteLength,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_STORAGE,
            layout: codec.artifact,
            elementCount: values.length,
        })

        expect(buffer.layout.structuralHash).to.equal(codec.artifact.structuralHash)

        const view = codec.createReadbackView(bytes)

        expect(view.count).to.equal(values.length)
        expect(view.artifact).to.equal(codec.artifact)
        expect(view.toObject(1)).to.deep.equal(values[1])
    })
})
