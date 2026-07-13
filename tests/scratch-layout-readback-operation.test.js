import { readdirSync } from 'node:fs'
import { expect } from 'chai'
import {
    ReadbackOperation,
    ScratchDiagnosticError,
    ScratchRuntime,
    layoutCodec,
} from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_MAP_READ = 0x1
const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_STORAGE = 0x80

function createParticleCodec() {

    return layoutCodec({
        label: 'readback particle layout',
        name: 'ReadbackParticle',
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

async function createLayoutBackedBuffer(runtime, codec, values, options = {}) {

    const bytes = codec.pack(values)
    const size = options.size ?? bytes.byteLength
    const buffer = await runtime.createBuffer({
        label: options.label ?? 'layout readback buffer',
        size,
        usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_STORAGE,
        layout: codec.artifact,
        elementCount: values.length,
    })

    buffer.gpuBuffer.data.set(bytes)

    return { buffer, bytes }
}

async function expectAsyncDiagnostic(fn, include) {

    let caught
    try {
        await fn()
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(ScratchDiagnosticError)
    expect(caught.diagnostic).to.include(include)

    return caught.diagnostic
}

describe('scratch layout-aware ReadbackOperation', () => {

    it('captures source layout when creating readback operations', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const values = [
            createParticleValues(0),
            createParticleValues(10),
        ]
        const { buffer } = await createLayoutBackedBuffer(runtime, codec, values)

        const readback = runtime.createReadback({
            label: 'read layout buffer',
            source: buffer,
        })

        expect(readback).to.be.instanceOf(ReadbackOperation)
        expect(readback.source).to.equal(buffer)
        expect(readback.layout).to.equal(codec.artifact)
        expect(readback.contentEpoch).to.equal(buffer.contentEpoch)
        expect(readback.allocationVersion).to.equal(buffer.allocationVersion)
    })

    it('keeps raw source buffers layout-free', async() => {

        const { runtime } = await createRuntimeFixture()
        const raw = await runtime.createBuffer({
            label: 'raw readback buffer',
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_STORAGE,
        })

        const readback = runtime.createReadback({
            source: raw,
            range: { offset: 0, byteLength: 16 },
        })

        expect(readback.layout).to.equal(undefined)
    })

    it('returns a LayoutReadbackView through the normal readback path', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const values = [
            createParticleValues(0),
            createParticleValues(10),
        ]
        const { buffer, bytes } = await createLayoutBackedBuffer(runtime, codec, values)

        const readback = runtime.createReadback({
            source: buffer,
            range: { offset: 0, byteLength: bytes.byteLength },
        })
        const view = await readback.toLayoutView()

        expect(view.artifact).to.equal(codec.artifact)
        expect(view.bytes).to.be.instanceOf(Uint8Array)
        expect([ ...view.bytes ]).to.deep.equal([ ...bytes ])
        expect(view.byteLength).to.equal(bytes.byteLength)
        expect(view.count).to.equal(values.length)
        expect(view.toObject(1)).to.deep.equal(values[1])
        expect(view.toArray()).to.deep.equal(values)
        expect(calls.copies[0]).to.deep.include({
            source: buffer.gpuBuffer,
            sourceOffset: 0,
            destinationOffset: 0,
            size: bytes.byteLength,
        })
        expect(calls.maps[0]).to.deep.include({
            mode: GPU_BUFFER_USAGE_MAP_READ,
            offset: 0,
            size: bytes.byteLength,
        })
    })

    it('reads the same bytes as toBytes', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const values = [
            createParticleValues(0),
            createParticleValues(10),
        ]
        const { buffer } = await createLayoutBackedBuffer(runtime, codec, values)

        const byteReadback = runtime.createReadback({ source: buffer })
        const viewReadback = runtime.createReadback({ source: buffer })
        const bytes = await byteReadback.toBytes()
        const view = await viewReadback.toLayoutView()

        expect([ ...view.bytes ]).to.deep.equal([ ...bytes ])
    })

    it('keeps toLayoutView consume-on-read', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const values = [ createParticleValues(0) ]
        const { buffer } = await createLayoutBackedBuffer(runtime, codec, values)

        const layoutReadback = runtime.createReadback({ source: buffer })
        await layoutReadback.toLayoutView()
        expect(layoutReadback.state).to.equal('consumed')

        const layoutConsumed = await expectAsyncDiagnostic(() => layoutReadback.toLayoutView(), {
            code: 'SCRATCH_READBACK_ALREADY_CONSUMED',
            severity: 'error',
            phase: 'readback',
        })
        expect(layoutConsumed.subject).to.deep.equal(layoutReadback.subject)
        expect(layoutConsumed.related).to.deep.equal([ buffer.subject ])
        expect(layoutConsumed.actual).to.deep.include({
            state: 'consumed',
            retain: 'consume-on-read',
            sourceId: buffer.id,
        })

        const bytesReadback = runtime.createReadback({ source: buffer })
        await bytesReadback.toBytes()

        const bytesConsumed = await expectAsyncDiagnostic(() => bytesReadback.toLayoutView(), {
            code: 'SCRATCH_READBACK_ALREADY_CONSUMED',
            severity: 'error',
            phase: 'readback',
        })
        expect(bytesConsumed.subject).to.deep.equal(bytesReadback.subject)
        expect(bytesConsumed.related).to.deep.equal([ buffer.subject ])
        expect(bytesConsumed.actual).to.deep.include({
            state: 'consumed',
            retain: 'consume-on-read',
            sourceId: buffer.id,
        })
    })

    it('rejects layout views on raw buffers with structured diagnostics', async() => {

        const { runtime } = await createRuntimeFixture()
        const raw = await runtime.createBuffer({
            label: 'raw output',
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_STORAGE,
        })
        const readback = runtime.createReadback({ source: raw })

        const diagnostic = await expectAsyncDiagnostic(() => readback.toLayoutView(), {
            code: 'SCRATCH_READBACK_LAYOUT_MISSING',
            severity: 'error',
            phase: 'readback',
        })

        expect(diagnostic.subject).to.deep.equal(readback.subject)
        expect(diagnostic.related).to.deep.equal([ raw.subject ])
        expect(diagnostic.expected).to.deep.equal({ layout: 'LayoutArtifact' })
        expect(diagnostic.actual).to.deep.include({
            state: 'requested',
            retain: 'consume-on-read',
            sourceId: raw.id,
            layout: undefined,
        })
    })

    it('rejects layout views whose byte length is not a positive stride multiple', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const values = [
            createParticleValues(0),
            createParticleValues(10),
        ]
        const byteLength = codec.artifact.stride + 1
        const { buffer } = await createLayoutBackedBuffer(runtime, codec, values)
        const readback = runtime.createReadback({
            source: buffer,
            range: { offset: 0, byteLength },
        })

        const diagnostic = await expectAsyncDiagnostic(() => readback.toLayoutView(), {
            code: 'SCRATCH_CODEC_BYTE_LENGTH_MISMATCH',
            severity: 'error',
            phase: 'layout-codec',
        })

        expect(diagnostic.subject).to.deep.equal({
            kind: 'LayoutArtifact',
            abiHash: codec.artifact.abiHash,
            schemaHash: codec.artifact.schemaHash,
            label: codec.artifact.label,
        })
        expect(diagnostic.expected).to.deep.equal({ byteLength: `positive multiple of ${codec.artifact.stride}` })
        expect(diagnostic.actual).to.deep.equal({ byteLength })
    })

    it('keeps LayoutCodec createReadbackView working after the helper split', async() => {

        const { runtime } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const values = [
            createParticleValues(0),
            createParticleValues(10),
        ]
        const { bytes } = await createLayoutBackedBuffer(runtime, codec, values)
        const view = codec.createReadbackView(bytes)

        expect(view.artifact).to.equal(codec.artifact)
        expect(view.count).to.equal(values.length)
        expect(view.toObject(1)).to.deep.equal(values[1])
    })

    it('does not add source-level JavaScript, declarations, or buffer readback helpers', async() => {

        const { runtime } = await createRuntimeFixture()
        const raw = await runtime.createBuffer({
            label: 'raw output',
            size: 16,
            usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_STORAGE,
        })
        const files = readdirSync(new URL('../packages/geoscratch/src/scratch/', import.meta.url))
            .filter(name => name.endsWith('.js') || name.endsWith('.d.ts'))

        expect(files).to.deep.equal([])
        expect(raw.toBytes).to.equal(undefined)
        expect(raw.toArray).to.equal(undefined)
        expect(raw.toObject).to.equal(undefined)
        expect(raw.read).to.equal(undefined)
        expect(raw.write).to.equal(undefined)
    })
})
