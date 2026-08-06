import { expect } from 'chai'
import { GPURuntime } from 'geoscratch/scratch'
import {
    GeoDiagnosticError,
    VirtualRasterResidency,
    WebMercatorQuad,
    createVirtualRasterGpuState,
    ownedVirtualRasterPagePayload,
    tileMatrixCoverage,
    virtualRasterAccessor,
    virtualRasterAddressSpace,
    virtualRasterPlane,
    virtualRasterSamplingProfile,
    virtualRasterTileAddressSpace,
} from 'geoscratch/geo'
import { createFakeGpu } from './scratch-test-utils.js'

const SLOT_TABLE_WORDS = 12
const SLOT_INVALID = 0xffff_ffff

async function expectGeoDiagnostic(action, expected) {

    let failure
    try {
        await action()
    } catch (error) {
        failure = error
    }
    expect(failure).to.be.instanceOf(GeoDiagnosticError)
    expect(failure.diagnostic).to.include(expected)
    return failure.diagnostic
}

function submitUpdate(runtime, update, validation = 'throw') {

    const builder = runtime.createSubmission({ validation })
    for (const command of update.commands) builder.upload(command)
    return builder.submit()
}

function wordsFromWrite(write) {

    return new Uint32Array(write.data.buffer, write.data.byteOffset, write.data.byteLength / 4)
}

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

function tileFixture() {

    const coverage = tileMatrixCoverage({
        tileMatrixSet: WebMercatorQuad,
        limits: [
            { matrixId: '8', minTileRow: 101, maxTileRow: 102, minTileCol: 212, maxTileCol: 214 },
            { matrixId: '9', minTileRow: 202, maxTileRow: 205, minTileCol: 424, maxTileCol: 429 },
        ],
    })
    const addressSpace = virtualRasterTileAddressSpace({
        id: 'test.tile-raster',
        coverage,
    })
    const plane = virtualRasterPlane({
        id: 'tile-height',
        addressSpace,
        kind: 'scalar',
        channels: 1,
        sampleType: 'unorm8',
        gpuFormat: 'r8unorm',
    })
    const [ width, height ] = addressSpace.pageSize
    const data = new Uint8Array(width * height).fill(17)
    const page = Object.freeze({
        page: addressSpace.pageFromTile({
            matrixId: '9',
            tileRow: 204,
            tileCol: 428,
        }),
        width,
        height,
        channels: 1,
        data,
        contentVersion: 'tile-v3',
    })
    const residency = new VirtualRasterResidency({
        addressSpace,
        plane,
        maxPhysicalPages: 1,
        maxStagingBytes: data.byteLength,
    })
    return { coverage, addressSpace, plane, page, residency }
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

    it('keeps a terminal child failure distinct from an available parent fallback', async() => {

        const { addressSpace, residency, pages } = fixture()
        const parent = addressSpace.page({ level: 1, x: 0, y: 0 })
        const child = addressSpace.page({ level: 0, x: 1, y: 0 })
        stage(residency, pages.get(parent.key))
        await residency.publish().acknowledge()

        expect(residency.fail(child, {
            generation: 0,
            detail: 'SOURCE_PAGE_MISSING',
        })).to.deep.include({ status: 'failed' })
        const publication = residency.publish()

        expect(publication.snapshot.resolve(child)).to.deep.include({
            status: 'failed',
            requestedLevel: child.level,
        })
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

        const fakeOptions = { deferErrorScopePops: false }
        const fake = createFakeGpu(fakeOptions)
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
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
        const stableSlotTable = gpuState.slotTable
        const update = gpuState.stage(publication)

        expect(update.atlasUploads).to.have.length(2)
        expect(update.pageTableUpload).to.exist
        expect(update.slotTableUpload).to.exist
        expect(update.commands).to.have.length(4)
        expect(update.commands.at(-1)).to.equal(update.slotTableUpload)
        expect(gpuState.slotTable).to.equal(stableSlotTable)
        expect(gpuState.facts()).to.deep.include({
            slotTableBytes: 2 * SLOT_TABLE_WORDS * Uint32Array.BYTES_PER_ELEMENT,
        })
        const work = submitUpdate(runtime, update)
        expect(await work.nativeOutcome).to.deep.include({ status: 'observed-succeeded' })
        await work.done
        await gpuState.acknowledge(publication, work)

        const slotWords = wordsFromWrite(fake.calls.queueWrites.find(write =>
            write.data.byteLength === 2 * SLOT_TABLE_WORDS * Uint32Array.BYTES_PER_ELEMENT
        ))
        for (const [ slot, page ] of [ '0/0/0', '0/1/0' ].entries()) {
            const entry = snapshot.resolve(pages.get(page).page)
            const base = slot * SLOT_TABLE_WORDS
            expect(slotWords[base]).to.equal(1)
            expect(slotWords[base + 7]).to.equal(entry.generation)
            expect(slotWords[base + 8]).to.equal(entry.contentEpoch)
            expect(slotWords[base + 9]).to.equal(snapshot.epoch)
            expect(Array.from(slotWords.slice(base + 2, base + 6)))
                .to.deep.equal([ SLOT_INVALID, SLOT_INVALID, SLOT_INVALID, SLOT_INVALID ])
        }
        expect(update.atlasUploads.every(upload => upload.isDisposed)).to.equal(true)
        expect(update.pageTableUpload.isDisposed).to.equal(false)
        expect(update.slotTableUpload.isDisposed).to.equal(false)
        expect(gpuState.atlas).to.equal(stableAtlas)
        expect(gpuState.pageTable).to.equal(stablePageTable)
        expect(gpuState.slotTable).to.equal(stableSlotTable)
        const unchanged = residency.publish()
        expect(gpuState.stage(unchanged).commands).to.deep.equal([])
        const unrelated = await runtime.createBuffer({
            label: 'unrelated publication acknowledgement work',
            size: Uint32Array.BYTES_PER_ELEMENT,
            usage: 0x08,
        })
        const unrelatedUpload = runtime.createUploadCommand({
            label: 'unrelated publication acknowledgement upload',
            target: unrelated.region(),
            data: new Uint32Array([ 0 ]),
        })
        fakeOptions.deferErrorScopePops = true
        fake.errors.failNext('writeBuffer', 'validation', new Error('unrelated publication work failed'))
        const rejectedEffectfulWork = runtime.createSubmission({ validation: 'throw' })
            .upload(unrelatedUpload)
            .submit()
        const acknowledgedWithoutObservation = await Promise.race([
            gpuState.acknowledge(unchanged, rejectedEffectfulWork).then(() => true),
            new Promise(resolve => setTimeout(() => resolve(false), 50)),
        ])
        expect(acknowledgedWithoutObservation).to.equal(true)
        expect(gpuState.facts()).to.deep.include({ snapshotEpoch: unchanged.snapshot.epoch })
        expect(fake.errors.pendingPops).to.not.be.empty
        for (let index = 0; index < fake.errors.pendingPops.length; index++) {
            fake.errors.settlePop(index)
        }
        expect(await rejectedEffectfulWork.nativeOutcome).to.deep.include({ status: 'observed-failed' })
        await rejectedEffectfulWork.done.catch(() => undefined)
        fakeOptions.deferErrorScopePops = false
        unrelatedUpload.dispose()
        unrelated.dispose()
        stage(residency, pages.get('1/0/0'), 2)
        const changedAfterEmpty = residency.publish()
        const changedUpdate = gpuState.stage(changedAfterEmpty)
        expect(changedUpdate.atlasUploads).to.have.length(1)
        await gpuState.abandon(changedAfterEmpty)
        const releasedSlotPublication = residency.publish()
        const releasedSlotUpdate = gpuState.stage(releasedSlotPublication)
        expect(releasedSlotUpdate.atlasUploads).to.deep.equal([])
        expect(releasedSlotUpdate.commands).to.have.length(2)
        const releasedSlotWork = submitUpdate(runtime, releasedSlotUpdate)
        await gpuState.acknowledge(releasedSlotPublication, releasedSlotWork)
        const releasedSlotWords = wordsFromWrite(fake.calls.queueWrites.at(-1))
        expect(Array.from(releasedSlotWords.slice(0, SLOT_TABLE_WORDS)))
            .to.deep.equal(Array(SLOT_TABLE_WORDS).fill(0))
        expect(fake.calls.queueTextureWrites).to.have.length(2)
        expect(fake.calls.queueWrites).to.have.length(4)
        expect(gpuState.facts()).to.deep.include({
            snapshotEpoch: releasedSlotPublication.snapshot.epoch,
            maxPhysicalPages: 2,
            atlasWidth: 4,
            atlasHeight: 2,
            pageTableEntryCount: 4,
        })

        gpuState.dispose()
        residency.dispose()
        runtime.dispose()
    })

    it('commits GPU acknowledgement authority only after publication settlement wins', async() => {

        const fakeOptions = { deferErrorScopePops: false }
        const fake = createFakeGpu(fakeOptions)
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const { addressSpace, plane, residency, pages } = fixture({ maxPhysicalPages: 1 })
        stage(residency, pages.get('0/0/0'))
        const publication = residency.publish()
        const gpuState = await createVirtualRasterGpuState(runtime, {
            addressSpace,
            plane,
            maxPhysicalPages: 1,
        })
        const update = gpuState.stage(publication)
        fakeOptions.deferErrorScopePops = true
        const work = submitUpdate(runtime, update)
        const acknowledgement = gpuState.acknowledge(publication, work)
        await Promise.resolve()

        expect(gpuState.facts()).to.deep.include({
            snapshotEpoch: -1,
            acknowledgementSerial: 0,
            stagedSnapshotEpoch: publication.snapshot.epoch,
        })
        await expectGeoDiagnostic(() => gpuState.abandon(publication), {
            code: 'GEO_VIRTUAL_RASTER_GPU_PUBLICATION_PENDING',
            phase: 'residency',
        })
        for (let index = 0; index < fake.errors.pendingPops.length; index++) {
            fake.errors.settlePop(index)
        }
        await acknowledgement

        expect(publication.inspect().state).to.equal('acknowledged')
        expect(gpuState.facts()).to.deep.include({
            snapshotEpoch: publication.snapshot.epoch,
            acknowledgementSerial: 1,
        })
        expect(gpuState.facts()).not.to.have.property('stagedSnapshotEpoch')

        gpuState.dispose()
        residency.dispose()
        runtime.dispose()
    })

    it('cleans staged GPU authority when an acknowledgement loses the publication race', async() => {

        const fakeOptions = { deferErrorScopePops: false }
        const fake = createFakeGpu(fakeOptions)
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const { addressSpace, plane, residency, pages } = fixture({ maxPhysicalPages: 1 })
        stage(residency, pages.get('0/0/0'))
        const publication = residency.publish()
        const gpuState = await createVirtualRasterGpuState(runtime, {
            addressSpace,
            plane,
            maxPhysicalPages: 1,
        })
        const update = gpuState.stage(publication)
        fakeOptions.deferErrorScopePops = true
        const work = submitUpdate(runtime, update)
        const acknowledgement = gpuState.acknowledge(publication, work).then(
            () => ({ status: 'fulfilled' }),
            error => ({ status: 'rejected', error })
        )
        await Promise.resolve()
        await publication.abandon()
        for (let index = 0; index < fake.errors.pendingPops.length; index++) {
            fake.errors.settlePop(index)
        }
        const result = await acknowledgement

        expect(result.status).to.equal('rejected')
        expect(result.error).to.be.instanceOf(GeoDiagnosticError)
        expect(gpuState.facts()).to.deep.include({
            snapshotEpoch: -1,
            acknowledgementSerial: 0,
        })
        expect(gpuState.facts()).not.to.have.property('stagedSnapshotEpoch')
        expect(update.atlasUploads.every(upload => upload.isDisposed)).to.equal(true)

        fakeOptions.deferErrorScopePops = false
        const recovery = residency.publish()
        const recoveryUpdate = gpuState.stage(recovery)
        const recoveryWork = submitUpdate(runtime, recoveryUpdate)
        await gpuState.acknowledge(recovery, recoveryWork)
        expect(gpuState.facts()).to.deep.include({
            snapshotEpoch: recovery.snapshot.epoch,
            acknowledgementSerial: 1,
        })

        gpuState.dispose()
        residency.dispose()
        runtime.dispose()
    })

    it('does not publish GPU authority when runtime disposal wins the acknowledgement commit', async() => {

        const fakeOptions = { deferErrorScopePops: false }
        const fake = createFakeGpu(fakeOptions)
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const { addressSpace, plane, residency, pages } = fixture({ maxPhysicalPages: 1 })
        stage(residency, pages.get('0/0/0'))
        const publication = residency.publish()
        const gpuState = await createVirtualRasterGpuState(runtime, {
            addressSpace,
            plane,
            maxPhysicalPages: 1,
        })
        const update = gpuState.stage(publication)
        const work = submitUpdate(runtime, update)
        expect(await work.nativeOutcome).to.deep.include({ status: 'observed-succeeded' })
        const acknowledgement = gpuState.acknowledge(publication, work).then(
            () => ({ status: 'fulfilled' }),
            error => ({ status: 'rejected', error })
        )

        runtime.dispose()
        const result = await acknowledgement

        expect(result.status).to.equal('rejected')
        expect(result.error).to.be.instanceOf(Error)
        expect(publication.inspect().state).to.be.oneOf([ 'pending', 'acknowledged' ])
        expect(gpuState.facts()).to.deep.include({
            snapshotEpoch: -1,
            acknowledgementSerial: 0,
        })
        expect(gpuState.acknowledges(publication.snapshot)).to.equal(false)

        gpuState.dispose()
        residency.dispose()
    })

    it('retains staged uploads when abandon loses to external acknowledgement', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const { addressSpace, plane, residency, pages } = fixture({ maxPhysicalPages: 1 })
        stage(residency, pages.get('0/0/0'))
        const publication = residency.publish()
        const gpuState = await createVirtualRasterGpuState(runtime, {
            addressSpace,
            plane,
            maxPhysicalPages: 1,
        })
        const update = gpuState.stage(publication)
        const externalAcknowledgement = publication.acknowledge()
        await expectGeoDiagnostic(() => gpuState.abandon(publication), {
            code: 'GEO_VIRTUAL_RASTER_PUBLICATION_SETTLED',
            phase: 'residency',
        })

        expect(gpuState.facts()).to.deep.include({
            snapshotEpoch: -1,
            acknowledgementSerial: 0,
            stagedSnapshotEpoch: publication.snapshot.epoch,
        })
        expect(update.atlasUploads.every(upload => !upload.isDisposed)).to.equal(true)

        await externalAcknowledgement
        const work = submitUpdate(runtime, update)
        await gpuState.acknowledge(publication, work)
        expect(gpuState.facts()).to.deep.include({
            snapshotEpoch: publication.snapshot.epoch,
            acknowledgementSerial: 1,
        })
        expect(gpuState.acknowledges(publication.snapshot)).to.equal(true)

        gpuState.dispose()
        residency.dispose()
        runtime.dispose()
    })

    it('keeps terminal failures GPU-distinct without sampling an atlas slot', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const { addressSpace, plane, residency, pages, cpuPages } = fixture({ maxPhysicalPages: 1 })
        const residentPage = pages.get('0/0/0')
        const failedPage = pages.get('0/1/0')
        expect(stage(residency, residentPage)).to.deep.include({ status: 'staged' })
        expect(stage(residency, failedPage)).to.deep.include({ status: 'failed' })
        const publication = residency.publish()
        const entry = publication.snapshot.resolve(failedPage.page)
        const gpuState = await createVirtualRasterGpuState(runtime, {
            addressSpace,
            plane,
            maxPhysicalPages: 1,
        })
        const update = gpuState.stage(publication)
        const work = submitUpdate(runtime, update)
        await gpuState.acknowledge(publication, work)

        const pageTableWords = wordsFromWrite(fake.calls.queueWrites.find(write =>
            write.data.byteLength === addressSpace.pageTableEntryCount * 8 * Uint32Array.BYTES_PER_ELEMENT
        ))
        const base = addressSpace.tableIndex(failedPage.page) * 8
        expect(Array.from(pageTableWords.slice(base, base + 8))).to.deep.equal([
            SLOT_INVALID,
            SLOT_INVALID,
            failedPage.page.level,
            4,
            0,
            0,
            failedPage.page.level,
            publication.snapshot.epoch,
        ])
        const accessor = virtualRasterAccessor({ addressSpace, plane })
        const sample = accessor.sample(publication.snapshot, {
            texel: [ 2, 0 ],
            profile: virtualRasterSamplingProfile({
                filter: 'nearest',
                level: 0,
                outerBoundary: 'clamp',
            }),
        }, cpuPages)
        expect(sample.status).to.equal('failed')
        const wgsl = accessor.wgslModule({ group: 0, pageTableBinding: 0, atlasBinding: 1 })
        expect(wgsl).to.include(
            'fn GeoVirtualRaster_failed(level: u32) -> GeoVirtualRasterSample { return GeoVirtualRasterSample(vec4f(0.0), 4u, level, level); }'
        )
        const failedBranch = wgsl.indexOf(
            'if (status == 4u) { return GeoVirtualRaster_failed(level); }'
        )
        expect(failedBranch).to.be.greaterThan(-1)
        for (const laterAccess of [
            'let resolved_level = GeoVirtualRaster_page_table[base + 2u];',
            'let slot = vec2u(GeoVirtualRaster_page_table[base], GeoVirtualRaster_page_table[base + 1u]);',
            'let raw = textureLoad(GeoVirtualRaster_atlas,',
        ]) {
            expect(failedBranch).to.be.lessThan(wgsl.indexOf(laterAccess))
        }

        gpuState.dispose()
        residency.dispose()
        runtime.dispose()
    })

    it('encodes every tile slot field with distinct sampling and matrix levels', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const { coverage, addressSpace, plane, page, residency } = tileFixture()
        expect(stage(residency, page, 37)).to.deep.include({ status: 'staged' })
        const publication = residency.publish()
        const snapshot = publication.snapshot
        const gpuState = await createVirtualRasterGpuState(runtime, {
            addressSpace,
            plane,
            maxPhysicalPages: 1,
        })
        const update = gpuState.stage(publication)
        const work = submitUpdate(runtime, update)
        await gpuState.acknowledge(publication, work)

        const entry = snapshot.resolve(page.page)
        const tile = page.page.tile
        const slotWords = wordsFromWrite(fake.calls.queueWrites.find(write =>
            write.data.byteLength === SLOT_TABLE_WORDS * Uint32Array.BYTES_PER_ELEMENT
        ))
        expect(Array.from(slotWords)).to.deep.equal([
            1,
            page.page.level,
            coverage.tileMatrixSet.tileMatrices.findIndex(matrix => matrix.id === tile.matrixId),
            tile.tileRow,
            tile.tileCol,
            coverage.index(tile),
            entry.physicalSlot,
            entry.generation,
            entry.contentEpoch,
            snapshot.epoch,
            snapshot.epoch,
            0,
        ])
        expect(slotWords[1]).to.not.equal(slotWords[2])
        expect(slotWords[2]).to.equal(9)
        expect(slotWords[3]).to.equal(204)
        expect(slotWords[4]).to.equal(428)
        expect(slotWords[5]).to.equal(22)

        gpuState.dispose()
        residency.dispose()
        runtime.dispose()
    })

    it('keeps a staged publication pending after terminal native failures', async() => {

        for (const outcome of [ 'observed-failed', 'observation-failed', 'unobserved' ]) {
            const fakeOptions = { deferErrorScopePops: false }
            const fake = createFakeGpu(fakeOptions)
            const runtime = await GPURuntime.create({
                gpu: fake.gpu,
                ...(outcome === 'unobserved' ? { diagnostics: { submissionScopes: 'off' } } : {}),
            })
            const { addressSpace, plane, residency, pages } = fixture({ maxPhysicalPages: 1 })
            stage(residency, pages.get('0/0/0'))
            const publication = residency.publish()
            const gpuState = await createVirtualRasterGpuState(runtime, {
                addressSpace,
                plane,
                maxPhysicalPages: 1,
            })
            const update = gpuState.stage(publication)
            fakeOptions.deferErrorScopePops = outcome === 'observation-failed'
            if (outcome === 'observed-failed') {
                fake.errors.failNext('writeBuffer', 'validation', new Error('slot upload failed'))
            }
            const work = submitUpdate(runtime, update)
            if (outcome === 'observation-failed') {
                fake.errors.rejectPop(0, new Error('native observation failed'))
                for (let index = 1; index < fake.errors.pendingPops.length; index++) {
                    fake.errors.settlePop(index)
                }
            }
            expect(await work.nativeOutcome).to.deep.include({ status: outcome })
            if (outcome === 'observed-failed' || outcome === 'observation-failed') {
                await work.done.catch(() => undefined)
            } else {
                await work.done
            }
            const diagnostic = await expectGeoDiagnostic(() => gpuState.acknowledge(publication, work), {
                code: 'GEO_VIRTUAL_RASTER_GPU_PUBLICATION_NATIVE_OUTCOME_FAILED',
                phase: 'residency',
            })
            expect(diagnostic.actual).to.deep.include({
                submissionId: work.id,
                snapshotEpoch: publication.snapshot.epoch,
                nativeOutcome: outcome,
            })
            expect(gpuState.facts()).to.deep.include({
                snapshotEpoch: -1,
                stagedSnapshotEpoch: publication.snapshot.epoch,
            })
            expect(publication.inspect().stagingBytes).to.equal(4)
            await gpuState.abandon(publication)
            gpuState.dispose()
            residency.dispose()
            runtime.dispose()
        }
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
