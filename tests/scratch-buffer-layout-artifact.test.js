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

async function expectRejectedDiagnostic(action, include) {

    let caught
    try {
        await action()
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(ScratchDiagnosticError)
    expect(caught.diagnostic).to.include(include)

    return caught.diagnostic
}

describe('scratch BufferRegion layout artifacts', () => {

    it('keeps BufferResource raw and stores interpretation only on BufferRegion', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const buffer = await runtime.createBuffer({
            label: 'particles',
            size: codec.artifact.stride * 2,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
        })
        const rawBuffer = await runtime.createBuffer({
            label: 'raw bytes',
            size: 32,
            usage: GPU_BUFFER_USAGE_COPY_DST,
        })

        const region = buffer.region({ layout: codec.artifact })

        expect(region.layout).to.equal(codec.artifact)
        expect(region.elementCount).to.equal(2)
        expect(region.subject).to.deep.equal({
            kind: 'BufferRegion',
            resourceId: buffer.id,
            offset: 0,
            size: codec.artifact.stride * 2,
            abiHash: codec.artifact.abiHash,
            schemaHash: codec.artifact.schemaHash,
        })
        expect(buffer.descriptor).to.include({
            label: 'particles',
            size: codec.artifact.stride * 2,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
        })
        expect(calls.buffers[0].descriptor).to.deep.equal({
            label: `particles [scratch:${buffer.id}]`,
            size: codec.artifact.stride * 2,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
        })
        expect(buffer).not.to.have.property('layout')
        expect(buffer).not.to.have.property('elementCount')
        expect(rawBuffer.region().layout).to.equal(undefined)
    })

    it('rejects removed resource-global layout fields before native allocation', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const codec = createParticleCodec()

        for (const descriptor of [
            { size: 32, usage: GPU_BUFFER_USAGE_STORAGE, layout: codec.artifact },
            { size: 32, usage: GPU_BUFFER_USAGE_STORAGE, elementCount: 2 },
            { size: 32, usage: GPU_BUFFER_USAGE_STORAGE, layoutByteLength: 32 },
        ]) {
            const diagnostic = await expectRejectedDiagnostic(
                () => runtime.createBuffer(descriptor),
                {
                    code: 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID',
                    severity: 'error',
                    phase: 'resource',
                }
            )
            expect(diagnostic.actual.removedFields).to.deep.equal(
                Object.keys(descriptor).filter(key => ![ 'size', 'usage' ].includes(key))
            )
        }

        expect(calls.buffers).to.have.length(0)
    })

    it('rejects invalid interpreted ranges with structured diagnostics', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()

        const buffer = await runtime.createBuffer({
            size: codec.artifact.stride * 2,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
        })
        const invalidArtifact = expectDiagnostic(() => {
            buffer.region({
                layout: { ...codec.artifact, stride: 0 },
            })
        }, {
            code: 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT',
            severity: 'error',
            phase: 'layout-codec',
        })
        expect(invalidArtifact.expected).to.deep.equal({ layout: 'LayoutArtifact' })
        expect(invalidArtifact.actual).to.deep.equal({ layout: 'object' })

        const misaligned = expectDiagnostic(() => {
            buffer.region({ offset: 4, size: codec.artifact.stride, layout: codec.artifact })
        }, {
            code: 'SCRATCH_BUFFER_REGION_LAYOUT_INVALID',
            severity: 'error',
            phase: 'layout-codec',
        })
        expect(misaligned.subject).to.deep.equal({
            kind: 'BufferRegion',
            resourceId: buffer.id,
            offset: 4,
            size: codec.artifact.stride,
            abiHash: codec.artifact.abiHash,
            schemaHash: codec.artifact.schemaHash,
        })
    })

    it('uploads LayoutCodec upload views only when the target layout matches', async() => {

        const { runtime, queue, calls } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const uploadView = codec.uploadView(createParticleValues())
        const buffer = await runtime.createBuffer({
            label: 'particles',
            size: codec.artifact.stride,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
        })
        const target = buffer.region({ layout: codec.artifact })
        const upload = runtime.createUploadCommand({
            label: 'upload particles',
            target,
            data: uploadView,
        })

        expect(upload.data).to.equal(uploadView.bytes)
        expect(upload.dataOffset).to.equal(uploadView.byteOffset)
        expect(upload.byteLength).to.equal(uploadView.byteLength)
        expect(upload.layout).to.equal(codec.artifact)

        upload.execute(queue)

        expect(calls.queueWrites).to.have.length(1)
        expect(Array.from(buffer.gpuBuffer.data.slice(0, uploadView.byteLength))).to.deep.equal(Array.from(uploadView.bytes))

        const rawOffsetUpload = runtime.createUploadCommand({
            target: buffer.region({ offset: 4, size: uploadView.byteLength - 4 }),
            data: uploadView.bytes,
            dataOffset: 4,
        })
        expect(rawOffsetUpload.dataOffset).to.equal(4)
        expect(rawOffsetUpload.byteLength).to.equal(uploadView.byteLength - 4)
        expect(rawOffsetUpload.layout).to.equal(undefined)

        const mismatchCodec = createParticleCodec('ParticleMismatch')
        const mismatch = expectDiagnostic(() => {
            runtime.createUploadCommand({
                target,
                data: mismatchCodec.uploadView(createParticleValues()),
            })
        }, {
            code: 'SCRATCH_CODEC_SCHEMA_MISMATCH',
            severity: 'error',
            phase: 'layout-codec',
        })
        expect(mismatch.subject).to.deep.equal(target.subject)
        expect(mismatch.expected).to.deep.equal({
            abiHash: codec.artifact.abiHash,
            schemaHash: codec.artifact.schemaHash,
        })
        expect(mismatch.actual).to.deep.equal({
            abiHash: mismatchCodec.artifact.abiHash,
            schemaHash: mismatchCodec.artifact.schemaHash,
        })
        expect(mismatch.evidence).to.have.length(1)
    })

    it('makes the uploaded byte range identical to the target BufferRegion', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const buffer = await runtime.createBuffer({
            label: 'single particle in a larger allocation',
            size: codec.artifact.stride * 2,
            usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
        })

        const diagnostic = expectDiagnostic(() => {
            runtime.createUploadCommand({
                target: buffer.region({ offset: codec.artifact.stride, size: codec.artifact.stride }),
                data: new Uint8Array(4),
            })
        }, {
            code: 'SCRATCH_COMMAND_UPLOAD_RANGE_INVALID',
            severity: 'error',
            phase: 'command',
        })

        expect(diagnostic.actual.reason).to.equal('range')
    })

    it('keeps readback byte interpretation explicit through LayoutCodec', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const values = [
            createParticleValues(0),
            createParticleValues(10),
        ]
        const bytes = codec.pack(values)
        const buffer = await runtime.createBuffer({
            label: 'readback particles',
            size: bytes.byteLength,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_STORAGE,
        })
        const source = buffer.region({ layout: codec.artifact })

        expect(source.layout.abiHash).to.equal(codec.artifact.abiHash)
        expect(source.layout.schemaHash).to.equal(codec.artifact.schemaHash)

        const view = codec.createReadbackView(bytes)

        expect(view.count).to.equal(values.length)
        expect(view.artifact).to.equal(codec.artifact)
        expect(view.toObject(1)).to.deep.equal(values[1])
    })
})
