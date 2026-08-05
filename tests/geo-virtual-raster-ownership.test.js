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
        expect(residency.inspect()).to.deep.include({
            pendingBytes: 0,
            decodeBytes: 0,
            stagingBytes: 4,
            memoryCacheBytes: 0,
            persistentMetadataBytes: 0,
        })

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
})

function fixture() {

    const addressSpace = virtualRasterAddressSpace({
        id: 'ownership.raster',
        dimensions: 2,
        extent: [ 2, 2 ],
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
        maxPhysicalPages: 1,
        maxStagingBytes: 4,
    })
    return {
        addressSpace,
        plane,
        residency,
        page: addressSpace.page({ level: 0, x: 0, y: 0 }),
    }
}
