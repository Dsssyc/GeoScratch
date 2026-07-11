import { expect } from 'chai'
import {
    ScratchDiagnosticError,
    ScratchRuntime,
    layoutCodec,
} from 'geoscratch'
import {
    advanceResourceContentEpochForTest,
    createFakeGpu,
    replaceResourceAllocationForTest,
} from './scratch-test-utils.js'

const GPU_BUFFER_USAGE_COPY_SRC = 0x4
const GPU_BUFFER_USAGE_COPY_DST = 0x8
const GPU_BUFFER_USAGE_STORAGE = 0x80

async function createRuntimeFixture() {

    const fake = createFakeGpu()
    const runtime = await ScratchRuntime.create({ gpu: fake.gpu })

    return { ...fake, runtime }
}

function createReadableBuffer(runtime, label = 'retention source', byteLength = 16) {

    return runtime.createBuffer({
        label,
        size: byteLength,
        usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_STORAGE,
    })
}

function setBytes(buffer, bytes) {

    buffer.gpuBuffer.data.set(bytes)
}

function setFloats(buffer, values) {

    new Float32Array(buffer.gpuBuffer.data.buffer).set(values)
}

function createParticleCodec() {

    return layoutCodec({
        label: 'retained particle layout',
        name: 'RetainedParticle',
        fields: [
            { name: 'position', type: 'vec3f' },
            { name: 'mass', type: 'f32' },
        ],
    }, {
        usage: [ 'storage', 'readback' ],
    })
}

function createLayoutBuffer(runtime, codec, values) {

    const bytes = codec.pack(values)
    const buffer = runtime.createBuffer({
        label: 'retained layout source',
        size: bytes.byteLength,
        usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_STORAGE,
        layout: codec.artifact,
        elementCount: values.length,
    })
    buffer.gpuBuffer.data.set(bytes)

    return { buffer, bytes }
}

async function expectScratchDiagnostic(action, expected) {

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

function operationActual(readback) {

    return {
        state: readback.state,
        retain: readback.retain,
        sourceId: readback.source.id,
        range: readback.range,
        contentEpoch: readback.contentEpoch,
        allocationVersion: readback.allocationVersion,
    }
}

describe('scratch ReadbackOperation retention lifecycle', () => {

    it('defaults to consume-on-read and rejects a second read with structured operation facts', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = createReadableBuffer(runtime, 'default consume source', 4)
        setBytes(source, [ 1, 2, 3, 4 ])
        const readback = runtime.createReadback({
            source,
            range: { offset: 0, byteLength: 4 },
        })

        expect(readback.retain).to.equal('consume-on-read')
        expect(readback.isResultRetained).to.equal(false)
        expect(readback.retainedByteLength).to.equal(undefined)

        const bytes = await readback.toBytes()

        expect([ ...bytes ]).to.deep.equal([ 1, 2, 3, 4 ])
        expect(readback.state).to.equal('consumed')
        expect(readback.isResultRetained).to.equal(false)
        expect(readback.retainedByteLength).to.equal(undefined)

        const diagnostic = await expectScratchDiagnostic(() => readback.toBytes(), {
            code: 'SCRATCH_READBACK_ALREADY_CONSUMED',
            severity: 'error',
            phase: 'readback',
        })

        expect(diagnostic.actual).to.deep.include(operationActual(readback))
    })

    it('retains bytes until dispose and reuses one staging copy for repeated byte reads', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const source = createReadableBuffer(runtime, 'retained byte source', 4)
        setBytes(source, [ 4, 3, 2, 1 ])
        const readback = runtime.createReadback({
            source,
            range: { offset: 0, byteLength: 4 },
            retain: 'until-dispose',
        })

        const commandEncoderCount = calls.commandEncoders.length
        const copyCount = calls.copies.length
        const queueSubmissionCount = calls.queueSubmissions.length
        const mapCount = calls.maps.length
        const bufferCount = calls.buffers.length

        const first = await readback.toBytes()

        expect([ ...first ]).to.deep.equal([ 4, 3, 2, 1 ])
        expect(readback.state).to.equal('ready')
        expect(readback.isResultRetained).to.equal(true)
        expect(readback.retainedByteLength).to.equal(4)
        expect(calls.commandEncoders).to.have.length(commandEncoderCount + 1)
        expect(calls.copies).to.have.length(copyCount + 1)
        expect(calls.queueSubmissions).to.have.length(queueSubmissionCount + 1)
        expect(calls.maps).to.have.length(mapCount + 1)
        expect(calls.buffers).to.have.length(bufferCount + 1)

        first[0] = 99
        const second = await readback.toBytes()
        const third = await readback.toBytes()

        expect(second).to.not.equal(first)
        expect(third).to.not.equal(second)
        expect([ ...second ]).to.deep.equal([ 4, 3, 2, 1 ])
        expect([ ...third ]).to.deep.equal([ 4, 3, 2, 1 ])
        expect(calls.commandEncoders).to.have.length(commandEncoderCount + 1)
        expect(calls.copies).to.have.length(copyCount + 1)
        expect(calls.queueSubmissions).to.have.length(queueSubmissionCount + 1)
        expect(calls.maps).to.have.length(mapCount + 1)
        expect(calls.buffers).to.have.length(bufferCount + 1)
    })

    it('returns fresh typed array copies from retained bytes', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = createReadableBuffer(runtime, 'retained float source', 16)
        setFloats(source, [ 1, 2, 3, 4 ])
        const readback = runtime.createReadback({
            source,
            retain: 'until-dispose',
        })

        const first = await readback.toArray(Float32Array)
        first[0] = 99
        const second = await readback.toArray(Float32Array)

        expect(first).to.be.instanceOf(Float32Array)
        expect(second).to.be.instanceOf(Float32Array)
        expect(second).to.not.equal(first)
        expect([ ...second ]).to.deep.equal([ 1, 2, 3, 4 ])
        expect(readback.state).to.equal('ready')
    })

    it('returns fresh layout views from retained bytes', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const codec = createParticleCodec()
        const values = [
            { position: [ 1, 2, 3 ], mass: 4 },
            { position: [ 5, 6, 7 ], mass: 8 },
        ]
        const { buffer, bytes } = createLayoutBuffer(runtime, codec, values)
        const readback = runtime.createReadback({
            source: buffer,
            retain: 'until-dispose',
        })
        const copyCount = calls.copies.length

        const first = await readback.toLayoutView()
        first.bytes[0] = 255
        const second = await readback.toLayoutView()

        expect(first.bytes).to.not.equal(second.bytes)
        expect([ ...second.bytes ]).to.deep.equal([ ...bytes ])
        expect(second.toArray()).to.deep.equal(values)
        expect(readback.state).to.equal('ready')
        expect(calls.copies).to.have.length(copyCount + 1)
    })

    it('keeps retained results readable after source content epoch advances post-materialization', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = createReadableBuffer(runtime, 'retained epoch source', 4)
        setBytes(source, [ 1, 2, 3, 4 ])
        const readback = runtime.createReadback({
            source,
            range: { offset: 0, byteLength: 4 },
            retain: 'until-dispose',
        })

        await readback.toBytes()
        setBytes(source, [ 9, 9, 9, 9 ])
        advanceResourceContentEpochForTest(source)

        const retained = await readback.toBytes()

        expect(source.contentEpoch).to.equal(readback.contentEpoch + 1)
        expect([ ...retained ]).to.deep.equal([ 1, 2, 3, 4 ])
        expect(readback.state).to.equal('ready')
    })

    it('rejects source content epoch drift before retained materialization without staging', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const source = createReadableBuffer(runtime, 'pre materialization stale source', 4)
        const readback = runtime.createReadback({
            source,
            range: { offset: 0, byteLength: 4 },
            retain: 'until-dispose',
        })
        advanceResourceContentEpochForTest(source)

        const diagnostic = await expectScratchDiagnostic(() => readback.toBytes(), {
            code: 'SCRATCH_READBACK_SOURCE_EPOCH_STALE',
            severity: 'error',
            phase: 'readback',
        })

        expect(diagnostic.actual).to.deep.include({
            retain: 'until-dispose',
            sourceId: source.id,
            contentEpoch: source.contentEpoch,
        })
        expect(calls.commandEncoders).to.have.length(0)
        expect(calls.copies).to.have.length(0)
        expect(calls.maps).to.have.length(0)
        expect(calls.queueSubmissions).to.have.length(0)
    })

    it('rejects source allocation drift before retained materialization without staging', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const source = createReadableBuffer(runtime, 'pre materialization allocation source', 4)
        const readback = runtime.createReadback({
            source,
            range: { offset: 0, byteLength: 4 },
            retain: 'until-dispose',
        })
        replaceResourceAllocationForTest(source)

        const diagnostic = await expectScratchDiagnostic(() => readback.toBytes(), {
            code: 'SCRATCH_READBACK_SOURCE_ALLOCATION_STALE',
            severity: 'error',
            phase: 'readback',
        })

        expect(diagnostic.actual).to.deep.include({
            retain: 'until-dispose',
            sourceId: source.id,
            allocationVersion: source.allocationVersion,
        })
        expect(calls.commandEncoders).to.have.length(0)
        expect(calls.copies).to.have.length(0)
        expect(calls.maps).to.have.length(0)
        expect(calls.queueSubmissions).to.have.length(0)
    })

    it('cancel before first materialization rejects later reads without staging work', async() => {

        const { runtime, calls } = await createRuntimeFixture()
        const source = createReadableBuffer(runtime, 'cancel pending source', 4)
        const readback = runtime.createReadback({
            source,
            range: { offset: 0, byteLength: 4 },
            retain: 'until-dispose',
        })

        readback.cancel('tile hidden')

        const diagnostic = await expectScratchDiagnostic(() => readback.toBytes(), {
            code: 'SCRATCH_READBACK_CANCELLED',
            severity: 'error',
            phase: 'readback',
        })

        expect(diagnostic.actual).to.deep.include({
            state: 'cancelled',
            retain: 'until-dispose',
            reason: 'tile hidden',
        })
        expect(readback.isResultRetained).to.equal(false)
        expect(readback.retainedByteLength).to.equal(undefined)
        expect(calls.commandEncoders).to.have.length(0)
        expect(calls.copies).to.have.length(0)
        expect(calls.maps).to.have.length(0)
        expect(calls.queueSubmissions).to.have.length(0)
    })

    it('cancel after retained materialization clears retained bytes and rejects later reads', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = createReadableBuffer(runtime, 'cancel ready source', 4)
        setBytes(source, [ 1, 1, 1, 1 ])
        const readback = runtime.createReadback({
            source,
            range: { offset: 0, byteLength: 4 },
            retain: 'until-dispose',
        })
        await readback.toBytes()

        readback.cancel('not needed')

        expect(readback.state).to.equal('cancelled')
        expect(readback.isResultRetained).to.equal(false)
        expect(readback.retainedByteLength).to.equal(undefined)
        await expectScratchDiagnostic(() => readback.toBytes(), {
            code: 'SCRATCH_READBACK_CANCELLED',
            severity: 'error',
            phase: 'readback',
        })
    })

    it('dispose after retained materialization clears retained bytes and rejects later reads', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = createReadableBuffer(runtime, 'dispose ready source', 4)
        setBytes(source, [ 2, 2, 2, 2 ])
        const readback = runtime.createReadback({
            source,
            range: { offset: 0, byteLength: 4 },
            retain: 'until-dispose',
        })
        await readback.toBytes()

        readback.dispose()

        expect(readback.state).to.equal('disposed')
        expect(readback.isResultRetained).to.equal(false)
        expect(readback.retainedByteLength).to.equal(undefined)
        await expectScratchDiagnostic(() => readback.toBytes(), {
            code: 'SCRATCH_READBACK_OPERATION_DISPOSED',
            severity: 'error',
            phase: 'readback',
        })
    })

    it('map failure marks the operation failed and clears retained and staging state', async() => {

        const { runtime, device } = await createRuntimeFixture()
        const source = createReadableBuffer(runtime, 'failed retained source', 4)
        setBytes(source, [ 7, 7, 7, 7 ])
        const readback = runtime.createReadback({
            source,
            range: { offset: 0, byteLength: 4 },
            retain: 'until-dispose',
        })
        const createBuffer = device.createBuffer.bind(device)
        device.createBuffer = (descriptor) => {
            const buffer = createBuffer(descriptor)
            if ((descriptor.usage & 0x1) !== 0) {
                buffer.mapAsync = async() => {
                    throw new Error('map denied')
                }
            }
            return buffer
        }

        const diagnostic = await expectScratchDiagnostic(() => readback.toBytes(), {
            code: 'SCRATCH_READBACK_MAP_FAILED',
            severity: 'error',
            phase: 'readback',
        })

        expect(readback.state).to.equal('failed')
        expect(readback.isResultRetained).to.equal(false)
        expect(readback.retainedByteLength).to.equal(undefined)
        expect(readback.stagingBuffer).to.equal(undefined)
        expect(diagnostic.actual).to.deep.include({
            state: 'failed',
            retain: 'until-dispose',
            sourceId: source.id,
        })
    })

    it('rejects invalid retain policies with structured diagnostics', async() => {

        const { runtime } = await createRuntimeFixture()
        const source = createReadableBuffer(runtime, 'invalid retain source', 4)

        const diagnostic = await expectScratchDiagnostic(() => runtime.createReadback({
            source,
            range: { offset: 0, byteLength: 4 },
            retain: 'forever',
        }), {
            code: 'SCRATCH_READBACK_RETAIN_INVALID',
            severity: 'error',
            phase: 'readback',
        })

        expect(diagnostic.actual).to.deep.include({
            retain: 'forever',
            sourceId: source.id,
        })
    })
})
