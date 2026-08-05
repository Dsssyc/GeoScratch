import { expect } from 'chai'
import { ScratchRuntime } from 'geoscratch'
import {
    VirtualRasterResidency,
    createVirtualRasterGpuState,
    ownedVirtualRasterPagePayload,
    virtualRasterAccessor,
    virtualRasterAddressSpace,
    virtualRasterPlane,
    virtualRasterSamplingProfile,
} from 'geoscratch/geo'
import { createFakeGpu } from './scratch-test-utils.js'

function scalarPage(page, values, contentVersion = 'v1') {

    return Object.freeze({
        page,
        width: 2,
        height: 2,
        channels: 1,
        data: Uint8Array.from(values),
        contentVersion,
    })
}

function fixture({ maxPhysicalPages = 4, maxHistory = 8, pageValues } = {}) {

    const addressSpace = virtualRasterAddressSpace({
        id: 'test.raster',
        dimensions: 2,
        extent: [ 4, 2 ],
        pageSize: [ 2, 2 ],
        levelCount: 3,
    })
    const plane = virtualRasterPlane({
        id: 'height',
        addressSpace,
        kind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        gpuFormat: 'r8unorm',
        noData: 255,
        scale: 2,
        offset: -10,
    })
    const defaults = new Map([
        [ '2/0/0', [ 5, 5, 5, 5 ] ],
        [ '1/0/0', [ 10, 10, 10, 10 ] ],
        [ '0/0/0', [ 0, 10, 0, 10 ] ],
        [ '0/1/0', [ 20, 30, 20, 30 ] ],
    ])
    const pages = new Map(addressSpace.pages().map(page => {
        const values = pageValues?.(page) ?? defaults.get(page.key) ?? [ 0, 0, 0, 0 ]
        return [ page.key, scalarPage(page, values) ]
    }))
    const residency = new VirtualRasterResidency({
        addressSpace,
        plane,
        maxPhysicalPages,
        maxStagingBytes: maxPhysicalPages * 4,
        maxHistory,
    })
    const cpuPages = Object.freeze({
        get(page) {
            return pages.get(page.key)
        },
    })
    return { addressSpace, plane, residency, pages, cpuPages }
}

function stage(residency, page, generation = 1) {

    const payload = pagePayload(page)
    return residency.stage(payload, { generation })
}

function pagePayload(page) {

    return ownedVirtualRasterPagePayload({
        page: page.page,
        width: page.width,
        height: page.height,
        channels: page.channels,
        data: Uint8Array.from(page.data),
        contentVersion: page.contentVersion,
    })
}

describe('Geo virtual raster', () => {

    it('keeps 1D and 3D logical address math extensible without inventing physical 4D textures', () => {

        const profile = virtualRasterAddressSpace({
            id: 'test.profile',
            dimensions: 1,
            extent: [ 17 ],
            pageSize: [ 4 ],
            levelCount: 3,
        })
        const volume = virtualRasterAddressSpace({
            id: 'test.volume',
            dimensions: 3,
            extent: [ 16, 8, 4 ],
            pageSize: [ 4, 4, 2 ],
            levelCount: 3,
        })
        const page = volume.page({ level: 0, x: 3, y: 1, z: 1 })

        expect(profile.pageGrid(0)).to.deep.equal([ 5 ])
        expect(profile.pageGrid(2)).to.deep.equal([ 2 ])
        expect(volume.parent(page)).to.deep.include({
            level: 1,
            coordinates: [ 1, 0, 0 ],
            key: '1/1/0/0',
        })
        expect(volume.tableIndex(page)).to.equal(15)
        expect(page).to.not.have.any.keys('texel', 'subTexel', 'physicalSlot')
    })

    it('keeps logical page identity independent from physical slots', () => {

        const { addressSpace } = fixture()
        const child = addressSpace.page({ level: 0, x: 1, y: 0 })
        const parent = addressSpace.parent(child)

        expect(child).to.deep.include({
            addressSpaceId: 'test.raster',
            dimensions: 2,
            level: 0,
            coordinates: [ 1, 0 ],
            key: '0/1/0',
        })
        expect(parent).to.deep.include({ level: 1, coordinates: [ 0, 0 ], key: '1/0/0' })
        expect(child).to.not.have.property('slot')
        expect(addressSpace.levelExtent(0)).to.deep.equal([ 4, 2 ])
        expect(addressSpace.levelExtent(1)).to.deep.equal([ 2, 1 ])
        expect(addressSpace.pageGrid(0)).to.deep.equal([ 2, 1 ])
        expect(Object.isFrozen(child)).to.equal(true)
    })

    it('publishes staged loads only at immutable snapshot boundaries', async() => {

        const { addressSpace, residency, pages } = fixture()
        stage(residency, pages.get('1/0/0'))

        expect(residency.inspect().stagedCount).to.equal(1)
        expect(residency.currentSnapshot.resolve(
            addressSpace.page({ level: 0, x: 1, y: 0 }),
        ).status).to.equal('missing')

        const publication = residency.publish()
        const snapshot = publication.snapshot
        const resolved = snapshot.resolve(addressSpace.page({ level: 0, x: 1, y: 0 }))

        expect(resolved).to.deep.include({
            status: 'fallback',
            requestedLevel: 0,
            resolvedLevel: 1,
            physicalSlot: 0,
        })
        expect(snapshot.epoch).to.equal(1)
        expect(Object.isFrozen(snapshot)).to.equal(true)
        expect(Object.isFrozen(snapshot.pageTable)).to.equal(true)
        await publication.acknowledge()
    })

    it('uses deterministic bounded LRU eviction and bounded history', async() => {

        const { addressSpace, residency, pages } = fixture({
            maxPhysicalPages: 2,
            maxHistory: 3,
        })
        stage(residency, pages.get('1/0/0'))
        stage(residency, pages.get('0/0/0'))
        const first = residency.publish()
        first.snapshot.resolve(addressSpace.page({ level: 0, x: 0, y: 0 }))
        await first.acknowledge()
        residency.markUsed(addressSpace.page({ level: 0, x: 0, y: 0 }))

        stage(residency, pages.get('0/1/0'), 2)
        const second = residency.publish()

        expect(second.snapshot.resolve(addressSpace.page({ level: 0, x: 0, y: 0 })).status)
            .to.equal('resident')
        expect(second.snapshot.resolve(addressSpace.page({ level: 1, x: 0, y: 0 })).status)
            .to.equal('missing')
        const facts = residency.inspect()
        expect(facts.residentCount).to.equal(2)
        expect(facts.residentGpuBytes).to.equal(8)
        expect(facts.stagingBytes).to.equal(4)
        expect(facts.evictionCount).to.equal(1)
        expect(facts.history.length).to.be.at.most(3)
        await second.acknowledge()
    })

    it('pins a coarse fallback page while deterministically evicting unpinned detail', async() => {

        const { addressSpace, residency, pages } = fixture({ maxPhysicalPages: 2 })
        const parent = addressSpace.page({ level: 1, x: 0, y: 0 })
        const firstDetail = addressSpace.page({ level: 0, x: 0, y: 0 })
        const secondDetail = addressSpace.page({ level: 0, x: 1, y: 0 })
        residency.pin(parent)
        stage(residency, pages.get(parent.key))
        stage(residency, pages.get(firstDetail.key))
        await residency.publish().acknowledge()

        stage(residency, pages.get(secondDetail.key), 2)
        const publication = residency.publish()
        const snapshot = publication.snapshot

        expect(snapshot.resolve(parent).status).to.equal('resident')
        expect(snapshot.resolve(firstDetail).status).to.equal('fallback')
        expect(snapshot.resolve(firstDetail).resolvedPage.key).to.equal(parent.key)
        expect(snapshot.resolve(secondDetail).status).to.equal('resident')
        expect(residency.inspect()).to.deep.include({
            pinnedCount: 1,
            residentCount: 2,
            evictionCount: 1,
        })
        await publication.acknowledge()
    })

    it('rejects an obsolete generation before publication', async() => {

        const { addressSpace, residency, pages } = fixture()
        const page = addressSpace.page({ level: 0, x: 0, y: 0 })
        residency.reconcileGeneration(2, [ page ])
        const outcome = stage(residency, pages.get(page.key), 1)

        expect(outcome).to.deep.include({ status: 'stale', page })
        expect(residency.inspect()).to.deep.include({
            stagedCount: 0,
            staleResponseCount: 1,
        })
        await residency.publish().acknowledge()
    })

    it('reconstructs bilinear footprints across physical page boundaries', async() => {

        const { addressSpace, plane, residency, pages, cpuPages } = fixture()
        stage(residency, pages.get('0/0/0'))
        stage(residency, pages.get('0/1/0'))
        const publication = residency.publish()
        const snapshot = publication.snapshot
        const accessor = virtualRasterAccessor({ addressSpace, plane })
        const profile = virtualRasterSamplingProfile({
            filter: 'bilinear',
            level: 0,
            outerBoundary: 'clamp',
        })
        const sample = accessor.sample(snapshot, {
            texel: [ 1.5, 0 ],
            profile,
        }, cpuPages)

        expect(sample.status).to.equal('resident')
        expect(sample.value).to.deep.equal([ 20 ])
        expect(sample.physicalSlots).to.deep.equal([ 0, 1 ])
        expect(sample.requestedLevel).to.equal(0)
        expect(sample.resolvedLodRange).to.deep.equal([ 0, 0 ])
        await publication.acknowledge()
    })

    it('decodes NoData and parent fallback without NaN propagation', async() => {

        const { addressSpace, plane, residency, pages, cpuPages } = fixture({
            pageValues: () => [ 255, 10, 10, 10 ],
        })
        stage(residency, pages.get('1/0/0'))
        const publication = residency.publish()
        const snapshot = publication.snapshot
        const accessor = virtualRasterAccessor({ addressSpace, plane })
        const sample = accessor.sample(snapshot, {
            texel: [ 0, 0 ],
            profile: virtualRasterSamplingProfile({
                filter: 'nearest',
                level: 0,
                outerBoundary: 'no-data',
            }),
        }, cpuPages)

        expect(sample.status).to.equal('no-data')
        expect(sample.value).to.equal(undefined)
        expect(sample.resolvedLodRange).to.deep.equal([ 1, 1 ])
        await publication.acknowledge()
    })

    it('generates one explicit-level accessor contract for all shader stages', () => {

        const { addressSpace, plane } = fixture()
        const accessor = virtualRasterAccessor({ addressSpace, plane })
        const wgsl = accessor.wgslModule({
            namespace: 'HeightField',
            group: 2,
            pageTableBinding: 0,
            atlasBinding: 1,
        })

        expect(wgsl).to.include('@group(2) @binding(0) var<storage, read> HeightField_page_table')
        expect(wgsl).to.include('@group(2) @binding(1) var HeightField_atlas: texture_2d<f32>')
        expect(wgsl).to.include('fn HeightField_load_texel')
        expect(wgsl).to.include('fn HeightField_sample_nearest')
        expect(wgsl).to.include('fn HeightField_sample_bilinear')
        expect(wgsl).to.include('fn HeightField_sample_vertex')
        expect(wgsl).to.include('fn HeightField_sample_fragment')
        expect(wgsl).to.include('fn HeightField_sample_compute')
        expect(wgsl).to.not.include('atomic')
        expect(wgsl).to.not.include('textureSample(')
    })

    it('lowers a publication into stable Scratch atlas/page-table resources and uploads', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const { addressSpace, plane, residency, pages } = fixture({ maxPhysicalPages: 2 })
        stage(residency, pages.get('0/0/0'))
        stage(residency, pages.get('0/1/0'))
        const publication = residency.publish()
        const snapshot = publication.snapshot
        const gpuState = await createVirtualRasterGpuState(runtime, {
            addressSpace,
            plane,
            maxPhysicalPages: 2,
        })
        const stableAtlas = gpuState.atlas
        const stablePageTable = gpuState.pageTable
        const update = gpuState.stage(publication)

        expect(update.atlasUploads).to.have.length(2)
        expect(update.pageTableUpload).to.exist
        expect(update.commands).to.have.length(3)
        const builder = runtime.createSubmission({ validation: 'throw' })
        for (const command of update.commands) builder.upload(command)
        const work = builder.submit()
        await work.nativeOutcome
        await work.done
        await gpuState.acknowledge(publication, work)

        expect(update.atlasUploads.every(upload => upload.isDisposed)).to.equal(true)
        expect(update.pageTableUpload.isDisposed).to.equal(false)
        expect(gpuState.atlas).to.equal(stableAtlas)
        expect(gpuState.pageTable).to.equal(stablePageTable)
        const unchanged = residency.publish()
        expect(gpuState.stage(unchanged).commands).to.deep.equal([])
        const emptyWork = runtime.createSubmission({ validation: 'throw' }).submit()
        await gpuState.acknowledge(unchanged, emptyWork)
        stage(residency, scalarPage(
            pages.get('0/0/0').page,
            [ 1, 2, 3, 4 ],
            'v2'
        ), 2)
        const changedAfterEmpty = residency.publish()
        const changedUpdate = gpuState.stage(changedAfterEmpty)
        expect(changedUpdate.atlasUploads).to.have.length(1)
        await gpuState.abandon(changedAfterEmpty)
        expect(fake.calls.queueTextureWrites).to.have.length(2)
        expect(fake.calls.queueWrites).to.have.length(1)
        expect(gpuState.facts()).to.deep.include({
            snapshotEpoch: snapshot.epoch,
            maxPhysicalPages: 2,
            atlasWidth: 4,
            atlasHeight: 2,
            pageTableEntryCount: 4,
        })

        gpuState.dispose()
        residency.dispose()
        runtime.dispose()
    })

    it('disposes staged and published bytes without retaining unbounded facts', async() => {

        const { residency, pages } = fixture()
        const stagedPayload = pagePayload(pages.get('0/0/0'))
        residency.stage(stagedPayload, { generation: 1 })
        const publication = residency.publish()
        expect(publication.inspect().stagingBytes).to.equal(4)
        residency.dispose()
        await publication.abandon()

        expect(stagedPayload.data.byteLength).to.equal(0)
        expect(residency.inspect()).to.deep.include({
            disposed: true,
            stagedCount: 0,
            residentCount: 0,
            stagingBytes: 0,
        })
    })
})
