import { expect } from 'chai'
import { VirtualRasterResidency, ownedVirtualRasterPagePayload,
    virtualRasterAddressSpace, virtualRasterPlane } from 'geoscratch/geo'
import { observeTerrainResidency } from './browser/support/terrain-residency-audit.ts'

function fixture() {
    const addressSpace = virtualRasterAddressSpace({ id: 'terrain-audit', dimensions: 2,
        extent: [4, 2], pageSize: [2, 2], levelCount: 1 })
    const plane = virtualRasterPlane({ id: 'height', addressSpace, kind: 'scalar', channels: 1,
        sampleType: 'unorm8', gpuFormat: 'r8unorm' })
    const residency = new VirtualRasterResidency({ addressSpace, plane, maxPhysicalPages: 2, maxStagingBytes: 8 })
    const audit = observeTerrainResidency(residency)
    const pages = [0, 1].map(x => addressSpace.page({ level: 0, x, y: 0 }))
    const payload = page => ownedVirtualRasterPagePayload({ page, width: 2, height: 2, channels: 1,
        data: new Uint8Array([1, 2, 3, 4]), contentVersion: 'v1' })
    return { residency, audit, pages, payload }
}

describe('Terrain residency proof audit', () => {
    it('separates valid staged retirement from same-page retention and stale adoption', async() => {
        const { residency, audit, pages, payload } = fixture()
        try {
            residency.reconcileGeneration(1, [pages[0]])
            residency.stage(payload(pages[0]), { generation: 1 })
            residency.reconcileGeneration(2, [pages[0]])
            expect(audit.facts().retiredStagedPageCount).to.equal(0)
            residency.reconcileGeneration(3, [pages[1]])
            expect(audit.facts()).to.deep.equal({ retiredStagedPageCount: 1, retiredStagingBytes: 4,
                rejectedStaleOperationCount: 0, unrequiredUploadCount: 0 })
            expect(residency.inspect().staleResponseCount).to.equal(1)
            const publication = residency.publish()
            expect(publication.uploads).to.have.length(0)
            expect(residency.inspect().stagingBytes).to.equal(0)
            await publication.abandon()
        } finally { audit.dispose(); residency.dispose() }
    })

    it('detects stale staging instead of classifying it as retirement', () => {
        const { residency, audit, pages, payload } = fixture()
        try {
            residency.reconcileGeneration(2, [pages[0]])
            residency.stage(payload(pages[0]), { generation: 1 })
            expect(audit.facts().rejectedStaleOperationCount).to.equal(1)
            expect(audit.facts().retiredStagedPageCount).to.equal(0)
        } finally { audit.dispose(); residency.dispose() }
    })

    it('detects an upload outside the observed request target', async() => {
        const { residency, audit, pages, payload } = fixture()
        try {
            residency.reconcileGeneration(1, [pages[0]])
            residency.stage(payload(pages[1]), { generation: 1 })
            const publication = residency.publish()
            expect(audit.facts().unrequiredUploadCount).to.equal(1)
            await publication.abandon()
        } finally { audit.dispose(); residency.dispose() }
    })
})
