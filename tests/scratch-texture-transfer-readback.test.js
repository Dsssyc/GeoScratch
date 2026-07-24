import { expect } from 'chai'
import * as scr from 'geoscratch'
import {
    advanceResourceContentEpochForTest,
    createFakeGpu,
    replaceResourceAllocationForTest,
} from './scratch-test-utils.js'
import { setResourceContentState } from '../packages/geoscratch/dist/scratch/resource.js'

const BUFFER_COPY_SRC = 0x4
const BUFFER_COPY_DST = 0x8
const TEXTURE_COPY_SRC = 0x1
const TEXTURE_COPY_DST = 0x2

async function settleMicrotasks(count = 24) {

    for (let index = 0; index < count; index++) await Promise.resolve()
}

async function rejectedDiagnostic(action, code) {

    let caught
    try {
        await action()
    } catch (error) {
        caught = error
    }

    expect(caught).to.be.instanceOf(scr.ScratchDiagnosticError)
    expect(caught.diagnostic.code).to.equal(code)
    return caught
}

async function createRuntime(options = {}, features = []) {

    const fake = createFakeGpu(options)
    for (const feature of features) {
        fake.adapter.features.add(feature)
        fake.device.features.add(feature)
    }
    const runtime = await scr.ScratchRuntime.create({
        gpu: fake.gpu,
        ...(options.readback !== undefined ? { readback: options.readback } : {}),
    })
    return { fake, runtime }
}

async function createTexture(runtime, descriptor = {}) {

    return runtime.createTexture({
        label: 'texture readback source',
        size: { width: 3, height: 2 },
        format: 'rgba8unorm',
        usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST,
        ...descriptor,
    })
}

function submitTextureUpload(runtime, texture, descriptor = {}) {

    const width = descriptor.size?.width ?? texture.width
    const height = descriptor.size?.height ?? texture.height
    const bytesPerRow = descriptor.layout?.bytesPerRow ?? width * 4
    const rowsPerImage = descriptor.layout?.rowsPerImage ?? height
    const upload = runtime.createTextureUploadCommand({
        target: texture,
        data: descriptor.data ?? new Uint8Array(bytesPerRow * rowsPerImage),
        layout: { bytesPerRow, rowsPerImage, ...descriptor.layout },
        size: { width, height, ...descriptor.size },
        ...(descriptor.aspect !== undefined ? { aspect: descriptor.aspect } : {}),
    })
    return runtime.submission().upload(upload).submit()
}

async function createReadableTextureFixture(options = {}) {

    const { fake, runtime } = await createRuntime(options)
    const texture = await createTexture(runtime)
    submitTextureUpload(runtime, texture)
    return { fake, runtime, texture }
}

describe('scratch texture transfer and readback closure', () => {

    it('lowers TextureUpload aspect through the single queue write path', async () => {

        const { fake, runtime } = await createRuntime()
        const texture = await createTexture(runtime, {
            size: { width: 2, height: 2 },
            format: 'depth24plus-stencil8',
        })
        const command = runtime.createTextureUploadCommand({
            target: texture,
            data: new Uint8Array([ 0, 1, 2, 3, 4 ]),
            layout: { offset: 1, bytesPerRow: 2, rowsPerImage: 2 },
            size: { width: 2, height: 2 },
            aspect: 'stencil-only',
        })

        runtime.submission().upload(command).submit()

        expect(command.aspect).to.equal('stencil-only')
        expect(fake.calls.queueTextureWrites).to.have.length(1)
        expect(fake.calls.queueTextureWrites[0].destination).to.deep.equal({
            texture: texture.gpuTexture,
            mipLevel: 0,
            origin: { x: 0, y: 0, z: 0 },
            aspect: 'stencil-only',
        })
        expect(fake.calls.queueTextureWrites[0].layout).to.deep.equal({
            offset: 1,
            bytesPerRow: 2,
            rowsPerImage: 2,
        })
    })

    it('defaults texture upload aspect to all and validates selected footprints', async () => {

        const { runtime } = await createRuntime()
        const color = await createTexture(runtime, {
            size: { width: 1, height: 1 },
        })
        const command = runtime.createTextureUploadCommand({
            target: color,
            data: new Uint8Array(4),
            size: { width: 1, height: 1 },
        })

        expect(command.aspect).to.equal('all')
        await rejectedDiagnostic(() => Promise.resolve().then(
            () => runtime.createTextureUploadCommand({
                target: color,
                data: new Uint8Array(4),
                size: { width: 1, height: 1 },
                aspect: 'stencil-only',
            })
        ), 'SCRATCH_COMMAND_TEXTURE_UPLOAD_INVALID')

        const depthStencil = await createTexture(runtime, {
            size: { width: 1, height: 1 },
            format: 'depth24plus-stencil8',
        })
        await rejectedDiagnostic(() => Promise.resolve().then(
            () => runtime.createTextureUploadCommand({
                target: depthStencil,
                data: new Uint8Array(1),
                size: { width: 1, height: 1 },
            })
        ), 'SCRATCH_COMMAND_TEXTURE_UPLOAD_INVALID')
    })

    it('uses physical block extents for compressed queue uploads', async () => {

        const { fake, runtime } = await createRuntime({}, [
            'core-features-and-limits',
            'texture-compression-bc',
        ])
        const texture = await createTexture(runtime, {
            size: { width: 12, height: 12 },
            mipLevelCount: 2,
            format: 'bc1-rgba-unorm',
        })
        const command = runtime.createTextureUploadCommand({
            target: texture,
            data: new Uint8Array(32),
            mipLevel: 1,
            size: { width: 8, height: 8 },
        })

        runtime.submission().upload(command).submit()

        expect(command.layout).to.deep.equal({
            offset: 0,
            bytesPerRow: 16,
            rowsPerImage: 2,
        })
        expect(fake.calls.queueTextureWrites[0].size).to.deep.equal({
            width: 8,
            height: 8,
            depthOrArrayLayers: 1,
        })
    })

    it('normalizes texture readback source and emits aligned native staging', async () => {

        const { fake, runtime, texture } = await createReadableTextureFixture({ deferMaps: true })
        const operation = runtime.createReadback({
            label: 'direct texture readback',
            source: {
                resource: texture,
                origin: [ 0, 0, 0 ],
                size: [ 3, 2, 1 ],
            },
        })

        expect(operation.sourceKind).to.equal('texture')
        expect(operation.source).to.deep.include({
            resource: texture,
            mipLevel: 0,
            origin: { x: 0, y: 0, z: 0 },
            size: { width: 3, height: 2, depthOrArrayLayers: 1 },
            aspect: 'all',
        })
        expect(operation.rowLayout).to.deep.equal({
            format: 'rgba8unorm',
            aspect: 'all',
            blockWidth: 1,
            blockHeight: 1,
            bytesPerBlock: 4,
            widthInBlocks: 3,
            heightInBlocks: 2,
            logicalBytesPerRow: 12,
            logicalRowsPerImage: 2,
            logicalBytesPerImage: 24,
            logicalByteLength: 24,
            stagingBytesPerRow: 256,
            stagingRowsPerImage: 2,
            stagingBytesPerImage: 512,
            stagingByteLength: 512,
        })

        const bytesPromise = operation.toBytes()
        await settleMicrotasks()
        expect(fake.calls.textureBufferCopies).to.have.length(1)
        expect(fake.calls.textureBufferCopies[0]).to.deep.include({
            source: {
                texture: texture.gpuTexture,
                mipLevel: 0,
                origin: { x: 0, y: 0, z: 0 },
                aspect: 'all',
            },
            size: { width: 3, height: 2, depthOrArrayLayers: 1 },
        })
        expect(fake.calls.textureBufferCopies[0].destination).to.deep.include({
            offset: 0,
            bytesPerRow: 256,
            rowsPerImage: 2,
        })
        expect(fake.calls.buffers.at(-1).descriptor.size).to.equal(512)

        fake.calls.buffers.at(-1).data.set(
            Uint8Array.from({ length: 12 }, (_, index) => index + 1),
            0
        )
        fake.calls.buffers.at(-1).data.set(
            Uint8Array.from({ length: 12 }, (_, index) => index + 13),
            256
        )
        fake.readbacks.resolveMap(0)

        expect([ ...await bytesPromise ]).to.deep.equal(
            Array.from({ length: 24 }, (_, index) => index + 1)
        )
        expect(operation.state).to.equal('consumed')
    })

    it('keeps direct and explicit texture-to-buffer row layouts composable', async () => {

        const { runtime, texture } = await createReadableTextureFixture()
        const direct = runtime.createReadback({
            source: { resource: texture, size: [ 3, 2, 1 ] },
        })
        const target = await runtime.createBuffer({
            size: direct.rowLayout.stagingByteLength,
            usage: BUFFER_COPY_SRC | BUFFER_COPY_DST,
        })
        const explicit = runtime.createCopyCommand({
            source: { resource: texture, contentEpoch: texture.contentEpoch },
            target: target.region(),
            targetLayout: {
                bytesPerRow: direct.rowLayout.stagingBytesPerRow,
                rowsPerImage: direct.rowLayout.stagingRowsPerImage,
            },
            size: direct.source.size,
            whenMissing: 'throw',
        })

        expect(explicit.targetLayout).to.deep.equal({
            bytesPerRow: direct.rowLayout.stagingBytesPerRow,
            rowsPerImage: direct.rowLayout.stagingRowsPerImage,
        })
        direct.dispose()
    })

    it('rejects stale texture allocation, content, and indeterminate sources before copy', async () => {

        for (const scenario of [
            {
                code: 'SCRATCH_READBACK_SOURCE_ALLOCATION_STALE',
                mutate(texture) {

                    replaceResourceAllocationForTest(texture)
                },
            },
            {
                code: 'SCRATCH_READBACK_SOURCE_EPOCH_STALE',
                mutate(texture) {

                    advanceResourceContentEpochForTest(texture)
                },
            },
        ]) {
            const { fake, runtime, texture } = await createReadableTextureFixture()
            const operation = runtime.createReadback({
                source: { resource: texture, size: [ 3, 2, 1 ] },
            })
            const copyCount = fake.calls.textureBufferCopies.length
            scenario.mutate(texture)

            await rejectedDiagnostic(() => operation.toBytes(), scenario.code)
            expect(fake.calls.textureBufferCopies).to.have.length(copyCount)
        }

        const { fake, runtime, texture } = await createReadableTextureFixture()
        const operation = runtime.createReadback({
            source: { resource: texture, size: [ 3, 2, 1 ] },
        })
        const copyCount = fake.calls.textureBufferCopies.length
        setResourceContentState(texture, 'indeterminate', texture.contentEpoch)

        await rejectedDiagnostic(
            () => operation.toBytes(),
            'SCRATCH_READBACK_SOURCE_CONTENT_INDETERMINATE'
        )
        expect(fake.calls.textureBufferCopies).to.have.length(copyCount)
    })

    it('validates depth, stencil, compressed, and block-aligned texture sources', async () => {

        const { runtime } = await createRuntime({}, [
            'core-features-and-limits',
            'texture-compression-bc',
        ])
        const depthStencil = await createTexture(runtime, {
            size: { width: 2, height: 2 },
            format: 'depth32float-stencil8',
        })
        advanceResourceContentEpochForTest(depthStencil)
        const depth = runtime.createReadback({
            source: {
                resource: depthStencil,
                size: [ 2, 2, 1 ],
                aspect: 'depth-only',
            },
        })
        const stencil = runtime.createReadback({
            source: {
                resource: depthStencil,
                size: [ 2, 2, 1 ],
                aspect: 'stencil-only',
            },
        })
        expect(depth.rowLayout.logicalBytesPerRow).to.equal(8)
        expect(stencil.rowLayout.logicalBytesPerRow).to.equal(2)

        const compressed = await createTexture(runtime, {
            size: { width: 4, height: 4 },
            format: 'bc1-rgba-unorm',
        })
        advanceResourceContentEpochForTest(compressed)
        const blocks = runtime.createReadback({
            source: { resource: compressed, size: [ 4, 4, 1 ] },
        })
        expect(blocks.rowLayout).to.deep.include({
            blockWidth: 4,
            blockHeight: 4,
            bytesPerBlock: 8,
            logicalBytesPerRow: 8,
        })

        await rejectedDiagnostic(() => Promise.resolve().then(
            () => runtime.createReadback({
                source: { resource: compressed, size: [ 3, 4, 1 ] },
            })
        ), 'SCRATCH_READBACK_TEXTURE_SOURCE_INVALID')
        await rejectedDiagnostic(() => Promise.resolve().then(
            () => runtime.createReadback({
                source: {
                    resource: depthStencil,
                    origin: [ 0, 0, 0 ],
                    size: [ 1, 2, 1 ],
                    aspect: 'depth-only',
                },
            })
        ), 'SCRATCH_READBACK_TEXTURE_SOURCE_INVALID')

        depth.dispose()
        stencil.dispose()
        blocks.dispose()
    })

    it('returns a one-owner mapped lease without a host-copy materialization', async () => {

        const { fake, runtime, texture } = await createReadableTextureFixture({ deferMaps: true })
        const operation = runtime.createReadback({
            source: { resource: texture, size: [ 3, 2, 1 ] },
        })
        const leasePromise = operation.map()
        await settleMicrotasks()
        const competing = await rejectedDiagnostic(
            () => operation.toBytes(),
            'SCRATCH_READBACK_IN_PROGRESS'
        )
        expect(competing.diagnostic.actual).to.deep.include({ materializationOwners: 1 })

        const staging = fake.calls.buffers.at(-1)
        staging.data[0] = 17
        staging.data[256] = 23
        fake.readbacks.resolveMap(0)
        const lease = await leasePromise
        const view = lease.view

        expect(lease).to.be.instanceOf(scr.MappedReadbackLease)
        expect(lease.operation).to.equal(operation)
        expect(lease.state).to.equal('mapped')
        expect(lease.byteLength).to.equal(512)
        expect(lease.rowLayout).to.equal(operation.rowLayout)
        expect(new Uint8Array(view)[0]).to.equal(17)
        expect(new Uint8Array(view)[256]).to.equal(23)
        expect(operation.state).to.equal('mapped')
        expect(operation.isResultRetained).to.equal(false)

        lease.dispose()

        expect(lease.state).to.equal('released')
        expect(operation.state).to.equal('consumed')
        expect(view.byteLength).to.equal(0)
        expect(() => lease.view).to.throw(scr.ScratchDiagnosticError)
        expect(runtime.diagnostics.snapshot().readbackMemory.activeMappings).to.equal(0)
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
    })

    it('maps buffer readback staging with the same one-shot lease contract', async () => {

        const { fake, runtime } = await createRuntime({ deferMaps: true })
        const buffer = await runtime.createBuffer({
            size: 16,
            usage: BUFFER_COPY_SRC | BUFFER_COPY_DST,
        })
        buffer.gpuBuffer.data.set([ 4, 3, 2, 1 ])
        const operation = runtime.createReadback({ source: buffer.region() })
        const leasePromise = operation.map()
        await settleMicrotasks()
        fake.readbacks.resolveMap(0)
        const lease = await leasePromise
        const view = lease.view

        expect(lease.rowLayout).to.equal(undefined)
        expect(lease.byteLength).to.equal(16)
        expect([ ...new Uint8Array(view).subarray(0, 4) ]).to.deep.equal([ 4, 3, 2, 1 ])

        lease.dispose()
        expect(view.byteLength).to.equal(0)
        expect(operation.state).to.equal('consumed')
    })

    it('rejects map after retained host bytes without staging a second copy', async () => {

        const { fake, runtime, texture } = await createReadableTextureFixture()
        const operation = runtime.createReadback({
            source: { resource: texture, size: [ 3, 2, 1 ] },
            retain: 'until-dispose',
        })
        await operation.toBytes()
        const copyCount = fake.calls.textureBufferCopies.length

        await rejectedDiagnostic(
            () => operation.map(),
            'SCRATCH_READBACK_IN_PROGRESS'
        )

        expect(fake.calls.textureBufferCopies).to.have.length(copyCount)
        expect(operation.state).to.equal('ready')
        operation.dispose()
    })

    it('cancels a pending mapped lease request and releases its staging owner', async () => {

        const { fake, runtime, texture } = await createReadableTextureFixture({ deferMaps: true })
        const operation = runtime.createReadback({
            source: { resource: texture, size: [ 3, 2, 1 ] },
        })
        const leasePromise = operation.map()
        await settleMicrotasks()

        operation.cancel('not visible')
        await rejectedDiagnostic(
            () => leasePromise,
            'SCRATCH_READBACK_CANCELLED'
        )

        expect(runtime.diagnostics.snapshot().readbackMemory.activeMappings).to.equal(0)
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
        expect(fake.calls.buffers.at(-1).destroyed).to.equal(true)
    })

    it('fails a mapped lease on native cleanup failure without restoring authority', async () => {

        const { fake, runtime, texture } = await createReadableTextureFixture({ deferMaps: true })
        const operation = runtime.createReadback({
            source: { resource: texture, size: [ 3, 2, 1 ] },
        })
        const leasePromise = operation.map()
        await settleMicrotasks()
        fake.readbacks.resolveMap(0)
        const lease = await leasePromise
        const view = lease.view
        fake.errors.throwNext('unmap', new Error('cleanup failed'))

        lease.dispose()

        expect(lease.state).to.equal('failed')
        expect(operation.state).to.equal('failed')
        expect(view.byteLength).to.equal(0)
        expect(runtime.diagnostics.incidents({ readbackId: operation.id }).at(-1)).to.deep.include({
            diagnosticCode: 'SCRATCH_READBACK_CLEANUP_FAILED',
            failureStage: 'cleanup',
        })
        expect(runtime.diagnostics.snapshot().readbackMemory.activeMappings).to.equal(0)
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
    })

    for (const lifecycle of [ 'cancel', 'dispose', 'runtime-dispose', 'device-loss' ]) {
        it(`invalidates an active mapped lease on ${lifecycle}`, async () => {

            const { fake, runtime, texture } = await createReadableTextureFixture({ deferMaps: true })
            const operation = runtime.createReadback({
                source: { resource: texture, size: [ 3, 2, 1 ] },
            })
            const leasePromise = operation.map()
            await settleMicrotasks()
            fake.readbacks.resolveMap(0)
            const lease = await leasePromise
            const view = lease.view

            if (lifecycle === 'cancel') operation.cancel('superseded')
            else if (lifecycle === 'dispose') operation.dispose()
            else if (lifecycle === 'runtime-dispose') runtime.dispose()
            else fake.errors.loseDevice({ reason: 'unknown', message: 'test device loss' })
            await settleMicrotasks()

            expect(lease.state).to.equal(
                lifecycle === 'cancel'
                    ? 'cancelled'
                    : lifecycle === 'dispose'
                        ? 'disposed'
                        : 'failed'
            )
            expect(view.byteLength).to.equal(0)
            expect(() => lease.view).to.throw(scr.ScratchDiagnosticError)
            expect(runtime.diagnostics.snapshot().readbackMemory.activeMappings).to.equal(0)
            expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
        })
    }

    it('charges padded texture staging against the bounded readback budget', async () => {

        const { fake, runtime } = await createRuntime({
            readback: { maxPendingOperations: 2, maxStagingBytes: 511 },
        })
        const texture = await createTexture(runtime)
        advanceResourceContentEpochForTest(texture)
        const operation = runtime.createReadback({
            source: { resource: texture, size: [ 3, 2, 1 ] },
        })
        const bufferCount = fake.calls.buffers.length

        await rejectedDiagnostic(
            () => operation.toBytes(),
            'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED'
        )

        expect(fake.calls.buffers).to.have.length(bufferCount)
        expect(fake.calls.textureBufferCopies).to.have.length(0)
        expect(runtime.diagnostics.snapshot().readbackMemory.currentStagingBytes).to.equal(0)
    })

    it('snapshots texture readback getters once and rejects cross-runtime resources', async () => {

        const { runtime, texture } = await createReadableTextureFixture()
        const reads = {
            source: 0,
            resource: 0,
            mipLevel: 0,
            origin: 0,
            size: 0,
            aspect: 0,
            layout: 0,
        }
        const source = {
            get resource() {

                reads.resource++
                if (reads.resource > 1) throw new Error('resource read twice')
                return texture
            },
            get mipLevel() {

                reads.mipLevel++
                if (reads.mipLevel > 1) throw new Error('mipLevel read twice')
                return 0
            },
            get origin() {

                reads.origin++
                if (reads.origin > 1) throw new Error('origin read twice')
                return [ 0, 0, 0 ]
            },
            get size() {

                reads.size++
                if (reads.size > 1) throw new Error('size read twice')
                return [ 3, 2, 1 ]
            },
            get aspect() {

                reads.aspect++
                if (reads.aspect > 1) throw new Error('aspect read twice')
                return 'all'
            },
            get layout() {

                reads.layout++
                if (reads.layout > 1) throw new Error('layout read twice')
                return undefined
            },
        }
        const operation = runtime.createReadback({
            get source() {

                reads.source++
                if (reads.source > 1) throw new Error('source read twice')
                return source
            },
        })

        expect(reads).to.deep.equal({
            source: 1,
            resource: 1,
            mipLevel: 1,
            origin: 1,
            size: 1,
            aspect: 1,
            layout: 1,
        })
        operation.dispose()

        const { runtime: otherRuntime } = await createRuntime()
        await rejectedDiagnostic(() => Promise.resolve().then(
            () => otherRuntime.createReadback({
                source: { resource: texture, size: [ 3, 2, 1 ] },
            })
        ), 'SCRATCH_RESOURCE_WRONG_RUNTIME')
    })

    it('keeps mapped lease construction private and buffer readback compatible', async () => {

        expect(() => new scr.MappedReadbackLease()).to.throw()

        const { runtime } = await createRuntime()
        const buffer = await runtime.createBuffer({
            size: 16,
            usage: BUFFER_COPY_SRC | BUFFER_COPY_DST,
        })
        const operation = runtime.createReadback({ source: buffer.region() })

        expect(operation.sourceKind).to.equal('buffer')
        expect(operation.rowLayout).to.equal(undefined)
        operation.dispose()
    })
})
