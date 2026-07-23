import { expect } from 'chai'
import * as scr from 'geoscratch'
import { createFakeGpu } from './scratch-test-utils.js'

const MAP_READ = 0x1
const MAP_WRITE = 0x2
const COPY_SRC = 0x4
const COPY_DST = 0x8

async function settleMicrotasks(count = 16) {

    for (let index = 0; index < count; index++) await Promise.resolve()
}

async function rejectedDiagnostic(promise, code) {

    try {
        await promise
    } catch (error) {
        expect(error).to.be.instanceOf(scr.ScratchDiagnosticError)
        if (code !== undefined) expect(error.diagnostic.code).to.equal(code)
        return error
    }
    throw new Error(`Expected ${code ?? 'ScratchDiagnosticError'} rejection.`)
}

async function createMappedFixture(mode, fakeOptions = {}) {

    const fake = createFakeGpu(fakeOptions)
    const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
    const usage = mode === 'read' ? MAP_READ | COPY_DST : MAP_WRITE | COPY_SRC
    const creation = runtime.createBuffer({ label: `${mode} mapping`, size: 32, usage })
    if (fakeOptions.deferErrorScopePops) {
        fake.errors.settlePop(0)
        fake.errors.settlePop(1)
    }
    const buffer = await creation
    return { fake, runtime, buffer }
}

describe('Scratch buffer host mapping', () => {

    it('publishes a closed READ lease, bounded active facts, and no content production', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('read')
        buffer.gpuBuffer.data.set([ 1, 2, 3, 4 ], 8)
        const startingEpoch = buffer.contentEpoch
        const region = buffer.region({ offset: 8, size: 8 })
        const lease = await runtime.mapBuffer({ region, mode: 'read' })
        const view = lease.view

        expect(lease).to.be.instanceOf(scr.MappedBufferLease)
        expect(lease).to.include({
            buffer,
            region,
            mode: 'read',
            state: 'mapped',
            allocationVersion: buffer.allocationVersion,
            contentEpoch: startingEpoch,
        })
        expect([ ...new Uint8Array(view).slice(0, 4) ]).to.deep.equal([ 1, 2, 3, 4 ])
        expect(runtime.diagnostics.snapshot().bufferMappings.find(fact => fact.id === lease.id)).to.deep.include({
            id: lease.id,
            resourceId: buffer.id,
            offset: 8,
            size: 8,
            mode: 'read',
            state: 'mapped',
            allocationVersion: buffer.allocationVersion,
            contentEpoch: startingEpoch,
        })
        expect(runtime.diagnostics.snapshot().bufferMapping).to.deep.include({
            currentMappings: 1,
            currentSelectedBytes: 8,
        })
        expect(runtime.diagnostics.snapshot().readbackMemory.activeMappings).to.equal(0)

        lease.dispose()
        lease.dispose()

        expect(lease.state).to.equal('released')
        expect(buffer.contentEpoch).to.equal(startingEpoch)
        expect(view.byteLength).to.equal(0)
        expect(fake.calls.unmaps).to.have.length(1)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
        expect(runtime.diagnostics.snapshot().bufferMapping.currentMappings).to.equal(0)
        expect(() => lease.view).to.throw(scr.ScratchDiagnosticError)
        expect(runtime.diagnostics.operations({ resourceId: buffer.id }).at(-1)).to.deep.include({
            kind: 'buffer-mapping',
            status: 'succeeded',
        })
    })

    it('commits WRITE bytes and advances contentEpoch exactly once on release', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('write')
        const startingEpoch = buffer.contentEpoch
        const lease = await runtime.mapBuffer({
            region: buffer.region({ offset: 8, size: 8 }),
            mode: 'write',
        })
        new Uint8Array(lease.view).set([ 9, 8, 7, 6 ])

        lease.dispose()
        lease.dispose()

        expect([ ...fake.calls.buffers.at(-1).data.slice(8, 12) ]).to.deep.equal([ 9, 8, 7, 6 ])
        expect(buffer.contentEpoch).to.equal(startingEpoch + 1)
        expect(buffer.state).to.equal('ready')
        expect(buffer.allocationVersion).to.equal(1)
        expect(fake.calls.unmaps).to.have.length(1)
    })

    it('claims one O(1) authority before mapAsync and releases it after AbortSignal cancellation', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('read', { deferMaps: true })
        const controller = new AbortController()
        const region = buffer.region({ size: 16 })
        const first = runtime.mapBuffer({ region, mode: 'read', signal: controller.signal })
        await settleMicrotasks()
        expect(fake.calls.maps).to.have.length(1)

        await rejectedDiagnostic(
            runtime.mapBuffer({ region, mode: 'read' }),
            'SCRATCH_BUFFER_MAPPING_CONFLICT'
        )
        expect(fake.calls.maps).to.have.length(1)

        controller.abort()
        await rejectedDiagnostic(first, 'SCRATCH_BUFFER_MAPPING_ABORTED')
        expect(fake.calls.unmaps).to.have.length(1)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])

        const second = runtime.mapBuffer({ region, mode: 'read' })
        await settleMicrotasks()
        fake.readbacks.resolveMap(1)
        const lease = await second
        lease.dispose()
        expect(fake.calls.maps).to.have.length(2)
    })

    it('treats a pre-aborted signal as cancellation without native mapping side effects', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('read')
        const controller = new AbortController()
        controller.abort()
        const beforeUnmaps = fake.calls.unmaps.length

        await rejectedDiagnostic(
            runtime.mapBuffer({
                region: buffer.region(),
                mode: 'read',
                signal: controller.signal,
            }),
            'SCRATCH_BUFFER_MAPPING_ABORTED'
        )

        expect(fake.calls.maps).to.have.length(0)
        expect(fake.calls.unmaps).to.have.length(beforeUnmaps)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
    })

    it('rejects invalid descriptors before native mapping side effects', async () => {

        const fake = createFakeGpu()
        const runtime = await scr.ScratchRuntime.create({ gpu: fake.gpu })
        const read = await runtime.createBuffer({ size: 32, usage: MAP_READ | COPY_DST })
        const write = await runtime.createBuffer({ size: 32, usage: MAP_WRITE | COPY_SRC })
        const otherFake = createFakeGpu()
        const otherRuntime = await scr.ScratchRuntime.create({ gpu: otherFake.gpu })
        const other = await otherRuntime.createBuffer({ size: 32, usage: MAP_READ | COPY_DST })
        const before = fake.calls.maps.length

        const cases = [
            [ { region: read.region(), mode: 'invalid' }, 'SCRATCH_BUFFER_MAPPING_MODE_INVALID' ],
            [ { region: read.region({ offset: 4, size: 8 }), mode: 'read' }, 'SCRATCH_BUFFER_MAPPING_RANGE_INVALID' ],
            [ { region: read.region({ offset: 8, size: 6 }), mode: 'read' }, 'SCRATCH_BUFFER_MAPPING_RANGE_INVALID' ],
            [ { region: write.region(), mode: 'read' }, 'SCRATCH_BUFFER_MAPPING_USAGE_INVALID' ],
            [ { region: other.region(), mode: 'read' }, 'SCRATCH_BUFFER_MAPPING_RUNTIME_MISMATCH' ],
            [ { region: read.region(), mode: 'read', signal: {} }, 'SCRATCH_BUFFER_MAPPING_SIGNAL_INVALID' ],
        ]
        for (const [ descriptor, code ] of cases) {
            await rejectedDiagnostic(runtime.mapBuffer(descriptor), code)
        }

        expect(fake.calls.maps).to.have.length(before)
    })

    it('joins map and error-scope settlement in arbitrary order without leaking authority', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('read', {
            deferMaps: true,
            deferErrorScopePops: true,
        })
        const mapping = runtime.mapBuffer({ region: buffer.region({ size: 16 }), mode: 'read' })
        await settleMicrotasks()
        const mappingPops = fake.errors.pendingPops.slice(-3)
        expect(mappingPops.map(pop => pop.filter)).to.deep.equal([
            'validation',
            'internal',
            'out-of-memory',
        ])

        fake.readbacks.resolveMap(0)
        const pendingPops = fake.errors.pendingPops
        for (const index of [ pendingPops.length - 2, pendingPops.length - 3, pendingPops.length - 1 ]) {
            fake.errors.settlePop(index)
        }
        const lease = await mapping
        lease.dispose()

        expect(fake.errors.scopeDepth).to.equal(0)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
    })

    it('cleans an active lease once when its resource is disposed', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('write')
        const lease = await runtime.mapBuffer({ region: buffer.region(), mode: 'write' })
        const view = lease.view

        buffer.dispose()
        buffer.dispose()

        expect(lease.state).to.equal('disposed')
        expect(view.byteLength).to.equal(0)
        expect(fake.calls.unmaps).to.have.length(1)
        expect(fake.calls.bufferDestroys).to.have.length(1)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
        expect(() => lease.view).to.throw(scr.ScratchDiagnosticError)
    })

    it('marks possible WRITE content indeterminate when native release fails', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('write')
        const startingEpoch = buffer.contentEpoch
        const lease = await runtime.mapBuffer({ region: buffer.region(), mode: 'write' })
        new Uint8Array(lease.view)[0] = 42
        fake.errors.throwNext('unmap', new Error('opaque unmap failure'))

        let failure
        try {
            lease.dispose()
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(scr.ScratchDiagnosticError)
        expect(failure.diagnostic.code).to.equal('SCRATCH_BUFFER_MAPPING_RELEASE_FAILED')
        expect(lease.state).to.equal('failed')
        expect(buffer.state).to.equal('indeterminate')
        expect(buffer.contentEpoch).to.equal(startingEpoch + 1)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
        expect(runtime.diagnostics.operations({
            kind: 'buffer-mapping',
            resourceId: buffer.id,
        }).at(-1)).to.deep.include({ status: 'failed' })
        expect(runtime.diagnostics.incidents({
            kind: 'buffer-mapping-failure',
            resourceId: buffer.id,
        }).at(-1)).to.deep.include({ failureStage: 'release' })
    })

    it('cancels an active WRITE lease on device loss and preserves uncertainty', async () => {

        const { fake, runtime, buffer } = await createMappedFixture('write')
        const startingEpoch = buffer.contentEpoch
        const lease = await runtime.mapBuffer({ region: buffer.region(), mode: 'write' })
        new Uint8Array(lease.view)[0] = 42

        fake.errors.loseDevice({ reason: 'unknown', message: 'opaque device loss' })
        await settleMicrotasks()

        expect(lease.state).to.equal('disposed')
        expect(buffer.state).to.equal('indeterminate')
        expect(buffer.contentEpoch).to.equal(startingEpoch + 1)
        expect(fake.calls.unmaps).to.have.length(1)
        expect(runtime.diagnostics.snapshot().bufferMappings).to.deep.equal([])
        expect(runtime.diagnostics.operations({
            kind: 'buffer-mapping',
            resourceId: buffer.id,
        }).at(-1)).to.deep.include({
            status: 'cancelled',
            nativeErrorCategory: 'device-lost',
        })
    })

    it('prevents public construction and prototype forgery', async () => {

        const { runtime, buffer } = await createMappedFixture('read')
        expect(() => new scr.MappedBufferLease()).to.throw(TypeError)
        const forged = Object.create(scr.MappedBufferLease.prototype)
        expect(() => forged.view).to.throw(TypeError)

        const lease = await runtime.mapBuffer({ region: buffer.region(), mode: 'read' })
        lease.dispose()
    })
})
