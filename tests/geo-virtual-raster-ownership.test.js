import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'
import {
    GeoDiagnosticError,
    VirtualRasterResidency,
    adoptVirtualRasterPageTransfer,
    ownedVirtualRasterPagePayload,
    prepareVirtualRasterPageTransfer,
    virtualRasterAddressSpace,
    virtualRasterPlane,
} from 'geoscratch/geo'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

describe('virtual raster payload ownership contract', () => {

    it('moves one whole backing buffer across the transferable boundary', () => {

        const { page } = fixture()
        const source = new Uint8Array([ 1, 2, 3, 4 ])
        const prepared = prepareVirtualRasterPageTransfer({
            page,
            width: 2,
            height: 2,
            channels: 1,
            data: source,
            contentVersion: 'v1',
        })
        const transferred = structuredClone(prepared.value, {
            transfer: [ ...prepared.transferables ],
        })
        const adopted = adoptVirtualRasterPageTransfer(transferred)

        expect(source.byteLength).to.equal(0)
        expect(prepared.transferables).to.have.length(1)
        expect(adopted.data).to.deep.equal(new Uint8Array([ 1, 2, 3, 4 ]))
        expect(adopted.data.buffer.byteLength).to.equal(4)
    })

    it('consumes an owned payload once and rejects a second residency owner', () => {

        const { page, residency } = fixture()
        const payload = ownedVirtualRasterPagePayload({
            page,
            width: 2,
            height: 2,
            channels: 1,
            data: new Uint8Array([ 1, 2, 3, 4 ]),
            contentVersion: 'v1',
        })

        expect(residency.stage(payload, { generation: 1 }).status).to.equal('staged')
        expect(() => residency.stage(payload, { generation: 1 }))
            .to.throw(GeoDiagnosticError)
    })

    it('publishes mapping separately and releases staging only after acknowledgement', async() => {

        const { page, residency } = fixture()
        residency.stage(ownedVirtualRasterPagePayload({
            page,
            width: 2,
            height: 2,
            channels: 1,
            data: new Uint8Array([ 1, 2, 3, 4 ]),
            contentVersion: 'v1',
        }), { generation: 7 })

        const publication = residency.publish()
        expect(publication.snapshot.resolve(page)).to.deep.include({
            status: 'resident',
            generation: 1,
            contentEpoch: 1,
        })
        expect(publication.inspect()).to.deep.include({
            state: 'pending',
            stagingBytes: 4,
            uploadPageCount: 1,
        })
        const residencyFacts = residency.inspect()
        expect(residencyFacts).to.deep.include({ stagingBytes: 4 })
        for (const foreignFact of [
            'pendingCount',
            'pendingBytes',
            'activeNetworkCount',
            'activeDecodeCount',
            'decodeBytes',
            'memoryCacheBytes',
            'persistentMetadataBytes',
        ]) {
            expect(residencyFacts).not.to.have.property(foreignFact)
        }

        await publication.acknowledge()

        expect(publication.inspect()).to.deep.include({ state: 'acknowledged', stagingBytes: 0 })
        expect(residency.inspect()).to.deep.include({ stagingBytes: 0, residentCount: 1 })
        const unchanged = residency.publish()
        expect(unchanged.inspect()).to.deep.include({ stagingBytes: 0, uploadPageCount: 0 })
        expect(unchanged.snapshot.resolve(page).status).to.equal('resident')
        await unchanged.acknowledge()
    })

    it('rejects an obsolete generation before cache, staging, or publication', () => {

        const { page, residency } = fixture()
        residency.reconcileGeneration(4, [ page ])
        const outcome = residency.stage(ownedVirtualRasterPagePayload({
            page,
            width: 2,
            height: 2,
            channels: 1,
            data: new Uint8Array([ 1, 2, 3, 4 ]),
            contentVersion: 'v1',
        }), { generation: 3 })

        expect(outcome.status).to.equal('stale')
        expect(residency.inspect()).to.deep.include({ stagedCount: 0, staleResponseCount: 1 })
        expect(residency.publish().snapshot.resolve(page).status).to.equal('missing')
    })

    it('rebases a staged page when the same page remains required by a newer generation', () => {

        const { page, residency } = fixture()
        residency.reconcileGeneration(1, [ page ])
        expect(residency.stage(ownedVirtualRasterPagePayload({
            page,
            width: 2,
            height: 2,
            channels: 1,
            data: new Uint8Array([ 1, 2, 3, 4 ]),
            contentVersion: 'v1',
        }), { generation: 1 }).status).to.equal('staged')

        residency.reconcileGeneration(2, [ page ])

        expect(residency.inspect()).to.deep.include({
            demandGeneration: 2,
            stagedCount: 1,
            stagingBytes: 4,
            staleResponseCount: 0,
        })
    })

    it('adopts an owned payload without a second typed-array copy', () => {

        const residency = read(
            'packages', 'geoscratch', 'src', 'geo', 'virtual-raster-residency.ts'
        )
        expect(residency).not.to.include('clonePayload')
        expect(residency).not.to.match(/Uint8Array\.from\(payload\.data\)/)
        expect(residency).not.to.match(/Float32Array\.from\(payload\.data\)/)
    })

    it('keeps decoded bytes out of immutable residency snapshots', () => {

        const virtualRaster = read(
            'packages', 'geoscratch', 'src', 'geo', 'virtual-raster.ts'
        )
        const physicalPage = virtualRaster.slice(
            virtualRaster.indexOf('export type VirtualRasterPhysicalPage'),
            virtualRaster.indexOf('export class VirtualRasterAddressSpace')
        )
        expect(physicalPage).not.to.include('payload:')
        expect(virtualRaster).not.to.include('snapshotPhysicalPages')
    })

    it('keeps independent residency leases authoritative until each owner releases', async() => {

        const { addressSpace, residency } = fixture({
            extent: [ 6, 2 ],
            maxPhysicalPages: 2,
        })
        const first = addressSpace.page({ level: 0, x: 0, y: 0 })
        const second = addressSpace.page({ level: 0, x: 1, y: 0 })
        const third = addressSpace.page({ level: 0, x: 2, y: 0 })
        stagePage(residency, first, 1)
        stagePage(residency, second, 1)
        const initial = residency.publish()
        const firstGeneration = initial.snapshot.resolve(first).generation
        const secondGeneration = initial.snapshot.resolve(second).generation
        await initial.acknowledge()
        const terrain = residency.createLease({ id: 'terrain-frontier', maximumPages: 1 })
        const analysis = residency.createLease({ id: 'analysis-frontier', maximumPages: 1 })

        expect(terrain.retain(first, firstGeneration)).to.equal(true)
        expect(analysis.retain(second, secondGeneration)).to.equal(true)
        stagePage(residency, third, 2)
        const blocked = residency.publish()
        expect(blocked.snapshot.resolve(third).status).to.equal('failed')
        expect(blocked.snapshot.resolve(first).status).to.equal('resident')
        expect(blocked.snapshot.resolve(second).status).to.equal('resident')
        await blocked.acknowledge()

        expect(terrain.release(first, firstGeneration)).to.equal(true)
        stagePage(residency, third, 3, 'v2')
        const admitted = residency.publish()
        expect(admitted.snapshot.resolve(first).status).to.equal('missing')
        expect(admitted.snapshot.resolve(second).status).to.equal('resident')
        expect(admitted.snapshot.resolve(third).status).to.equal('resident')
        await admitted.acknowledge()
    })

    it('does not let a stale release target a later assignment of the same page', async() => {

        const { addressSpace, residency } = fixture({
            extent: [ 4, 2 ],
            maxPhysicalPages: 1,
        })
        const first = addressSpace.page({ level: 0, x: 0, y: 0 })
        const second = addressSpace.page({ level: 0, x: 1, y: 0 })
        stagePage(residency, first, 1)
        const firstPublication = residency.publish()
        const staleGeneration = firstPublication.snapshot.resolve(first).generation
        await firstPublication.acknowledge()
        const lease = residency.createLease({ id: 'frontier', maximumPages: 1 })
        lease.retain(first, staleGeneration)
        lease.release(first, staleGeneration)

        stagePage(residency, second, 2)
        await residency.publish().acknowledge()
        stagePage(residency, first, 3, 'v2')
        const replacement = residency.publish()
        const currentGeneration = replacement.snapshot.resolve(first).generation
        await replacement.acknowledge()
        expect(currentGeneration).not.to.equal(staleGeneration)
        expect(lease.retain(first, currentGeneration)).to.equal(true)
        expect(lease.release(first, staleGeneration)).to.equal(false)

        stagePage(residency, second, 4, 'v2')
        const blocked = residency.publish()
        expect(blocked.snapshot.resolve(first)).to.deep.include({
            status: 'resident',
            generation: currentGeneration,
        })
        expect(blocked.snapshot.resolve(second).status).to.equal('failed')
        await blocked.acknowledge()
    })

    it('reports bounded lease facts and rejects owner budget overflow', async() => {

        const { addressSpace, residency } = fixture({
            extent: [ 4, 2 ],
            maxPhysicalPages: 2,
        })
        const first = addressSpace.page({ level: 0, x: 0, y: 0 })
        const second = addressSpace.page({ level: 0, x: 1, y: 0 })
        stagePage(residency, first, 1)
        stagePage(residency, second, 1)
        const publication = residency.publish()
        const firstGeneration = publication.snapshot.resolve(first).generation
        const secondGeneration = publication.snapshot.resolve(second).generation
        await publication.acknowledge()
        const lease = residency.createLease({
            id: 'bounded-owner',
            maximumPages: 1,
            maxHistory: 2,
        })

        expect(lease.retain(first, firstGeneration)).to.equal(true)
        let failure
        try {
            lease.retain(second, secondGeneration)
        } catch (error) {
            failure = error
        }
        expect(failure).to.be.instanceOf(GeoDiagnosticError)
        expect(failure.diagnostic).to.include({
            code: 'GEO_VIRTUAL_RASTER_RESIDENCY_LEASE_OVERFLOW',
            phase: 'residency',
        })
        expect(lease.facts()).to.deep.include({
            id: 'bounded-owner',
            disposed: false,
            retainedPageCount: 1,
            maximumPages: 1,
        })
        expect(lease.facts().retainedPages).to.deep.equal([
            { pageKey: first.key, generation: firstGeneration },
        ])
        expect(lease.facts().history).to.have.length.at.most(2)
        expect(Object.isFrozen(lease.facts().retainedPages)).to.equal(true)
    })

    it('invalidates a lease when its pending publication is abandoned', async() => {

        const { page, residency } = fixture()
        stagePage(residency, page, 1)
        const publication = residency.publish()
        const generation = publication.snapshot.resolve(page).generation
        const lease = residency.createLease({ id: 'pending-upload', maximumPages: 1 })
        expect(lease.retain(page, generation)).to.equal(true)

        await publication.abandon()

        expect(lease.facts()).to.deep.include({ retainedPageCount: 0 })
        expect(residency.currentSnapshot.resolve(page).status).to.equal('missing')
    })

    it('releases eviction authority when a residency lease is disposed', async() => {

        const { addressSpace, residency } = fixture({
            extent: [ 4, 2 ],
            maxPhysicalPages: 1,
        })
        const first = addressSpace.page({ level: 0, x: 0, y: 0 })
        const second = addressSpace.page({ level: 0, x: 1, y: 0 })
        stagePage(residency, first, 1)
        const initial = residency.publish()
        const generation = initial.snapshot.resolve(first).generation
        await initial.acknowledge()
        const lease = residency.createLease({ id: 'disposable-owner', maximumPages: 1 })
        lease.retain(first, generation)

        lease.dispose()
        lease.dispose()
        stagePage(residency, second, 2)
        const replacement = residency.publish()

        expect(lease.facts()).to.deep.include({ disposed: true, retainedPageCount: 0 })
        expect(replacement.snapshot.resolve(first).status).to.equal('missing')
        expect(replacement.snapshot.resolve(second).status).to.equal('resident')
        await replacement.acknowledge()
    })
})

function fixture({ extent = [ 2, 2 ], maxPhysicalPages = 1 } = {}) {

    const addressSpace = virtualRasterAddressSpace({
        id: 'ownership.raster',
        dimensions: 2,
        extent,
        pageSize: [ 2, 2 ],
        levelCount: 1,
    })
    const plane = virtualRasterPlane({
        id: 'ownership.height',
        addressSpace,
        kind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        gpuFormat: 'r8unorm',
    })
    const residency = new VirtualRasterResidency({
        addressSpace,
        plane,
        maxPhysicalPages,
        maxStagingBytes: maxPhysicalPages * 4,
    })
    return {
        addressSpace,
        plane,
        residency,
        page: addressSpace.page({ level: 0, x: 0, y: 0 }),
    }
}

function stagePage(residency, page, generation, contentVersion = 'v1') {

    return residency.stage(ownedVirtualRasterPagePayload({
        page,
        width: 2,
        height: 2,
        channels: 1,
        data: new Uint8Array([ 1, 2, 3, 4 ]),
        contentVersion,
    }), { generation })
}
