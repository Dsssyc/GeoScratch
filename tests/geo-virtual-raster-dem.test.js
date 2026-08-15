import { expect } from 'chai'
import {
    GeoDiagnosticError,
    ViewDemandProducer,
    VirtualRasterRequestScheduler,
    VirtualRasterResidency,
    createVirtualRasterDemandController,
    createGeoViewSnapshot,
    ownedVirtualRasterPagePayload,
    prepareVirtualRasterPageTransfer,
    webMercatorVirtualRasterField,
    webMercatorVirtualRasterWgslModule,
} from 'geoscratch/geo'
import {
    DEM_WEB_MERCATOR_COORDINATE_BITS,
    createDemTileSource,
    fetchDemTileSource,
} from '../examples/underwaterTerrain/dem-source.ts'
import { demWebMercatorManifest as manifest } from './fixtures/dem-webmercator-manifest.js'

describe('DEM WebMercator virtual raster', () => {

    it('validates standard manifest facts and builds a compact tile address space', () => {

        const source = createDemTileSource({
            manifest,
            tileServerUrl: 'http://127.0.0.1:8787/',
        })
        const { model } = source

        expect(source.manifest).to.deep.equal(manifest)
        expect(source.facts.contentVersion).to.equal(source.manifest.contentVersion)
        expect(Object.isFrozen(source)).to.equal(true)
        expect(Object.isFrozen(source.manifest)).to.equal(true)
        expect(Object.isFrozen(source.model)).to.equal(true)
        expect(model.coverage.entryCount).to.equal(49)
        expect(model.addressSpace.pageTableEntryCount).to.equal(49)
        expect(model.addressSpace.pageSize).to.deep.equal([ 256, 256 ])
        expect(model.addressSpace.levelCount).to.equal(7)
        expect(model.addressSpace.matrixId(0)).to.equal('10')
        expect(model.addressSpace.matrixId(6)).to.equal('4')
        expect(model.safetyCoverPages.map(page => page.key)).to.deep.equal([ '4/6/13' ])
        expect(model.addressCodec.coordinateBits).to.equal(DEM_WEB_MERCATOR_COORDINATE_BITS)
        expect(model.addressCodec.quantumMeters).to.be.lessThan(0.001)
        expect(model.spatialProfile.coverage).to.equal(model.coverage)
        expect(model.representation.field).to.equal(model.field)
        expect(model.representation.plane).to.equal(model.plane)
        expect(model.representation.spatialProfile).to.equal(model.spatialProfile)
        expect(model.kind).to.equal('web-mercator-virtual-raster-field')
        expect(model.field).to.deep.include({
            kind: 'geo-field',
            fieldKind: 'scalar',
            channels: 1,
            sampleType: 'unorm8',
            unit: 'm',
            interpolation: 'linear',
        })
        expect(model.plane).to.deep.include({
            fieldKind: 'scalar',
            channels: 1,
            sampleType: 'unorm8',
            gpuFormat: 'r8unorm',
        })
    })

    it('keeps one feedback window of request continuity before cancellation', async() => {

        const fixture = await createGpuDemandFixture()
        const child = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 12,
            tileCol: 26,
        })
        const parent = fixture.model.addressSpace.parent(child)
        const firstFeedback = feedbackAt(
            7,
            fixture.acknowledgedSnapshotEpoch(),
            [
                gpuDemand(fixture, child, parent, 10),
                gpuDemand(fixture, child, parent, 90),
            ]
        )

        const first = fixture.adapter.reconcileFeedback(
            firstFeedback,
            viewAt(firstFeedback)
        )
        expect(first).to.deep.include({ requestedCount: 1, retainedCount: 0, retiredCount: 0 })
        expect(fixture.executor.requests.get(child.key).demand.priority).to.deep.equal({
            class: 'user-visible',
            score: 90,
        })
        expect(fixture.adapter.lease.facts().retainedPages.map(page => page.pageKey))
            .to.include.members(fixture.model.safetyCoverPages.map(page => page.key))

        const secondFeedback = feedbackAt(
            8,
            fixture.acknowledgedSnapshotEpoch(),
            []
        )
        const second = fixture.adapter.reconcileFeedback(
            secondFeedback,
            viewAt(secondFeedback)
        )
        expect(second.generation).to.be.greaterThan(first.generation)
        expect(fixture.scheduler.inspect().activeRequestCount).to.equal(1)
        expect(fixture.executor.requests.get(child.key).cancelled).to.equal(false)
        expect(fixture.adapter.facts()).to.deep.include({
            feedbackDemandGraceGenerations: 1,
            deferredDemandCount: 1,
        })

        const thirdFeedback = feedbackAt(
            9,
            fixture.acknowledgedSnapshotEpoch(),
            []
        )
        const third = fixture.adapter.reconcileFeedback(
            thirdFeedback,
            viewAt(thirdFeedback)
        )
        expect(fixture.scheduler.inspect().activeRequestCount).to.equal(0)
        expect(fixture.executor.requests.get(child.key).cancelled).to.equal(true)
        expect(fixture.adapter.facts().deferredDemandCount).to.equal(0)
        await Promise.all([ second.settlement, third.settlement ])

        let staleFailure
        try {
            fixture.adapter.reconcileFeedback(firstFeedback, viewAt(firstFeedback))
        } catch (error) {
            staleFailure = error
        }
        expect(staleFailure).to.be.instanceOf(GeoDiagnosticError)
        expect(staleFailure.diagnostic).to.include({
            code: 'GEO_GPU_TILE_FRONTIER_INVALID',
            phase: 'selection',
        })
        expect(fixture.scheduler.inspect().activeRequestCount).to.equal(0)
        await fixture.dispose()
    })

    it('coalesces alternating GPU feedback without restarting page requests', async() => {

        const fixture = await createGpuDemandFixture()
        const firstChild = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 12,
            tileCol: 26,
        })
        const secondChild = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 13,
            tileCol: 26,
        })
        const firstParent = fixture.model.addressSpace.parent(firstChild)
        const secondParent = fixture.model.addressSpace.parent(secondChild)

        const feedback = (frameEpoch, child, parent) => feedbackAt(
            frameEpoch,
            fixture.acknowledgedSnapshotEpoch(),
            [ gpuDemand(fixture, child, parent, 50) ]
        )
        fixture.adapter.reconcileFeedback(feedback(7, firstChild, firstParent), viewAt(
            feedback(7, firstChild, firstParent)
        ))
        const firstRequest = fixture.executor.requests.get(firstChild.key)
        fixture.adapter.reconcileFeedback(feedback(8, secondChild, secondParent), viewAt(
            feedback(8, secondChild, secondParent)
        ))
        const secondRequest = fixture.executor.requests.get(secondChild.key)
        fixture.adapter.reconcileFeedback(feedback(9, firstChild, firstParent), viewAt(
            feedback(9, firstChild, firstParent)
        ))
        fixture.adapter.reconcileFeedback(feedback(10, secondChild, secondParent), viewAt(
            feedback(10, secondChild, secondParent)
        ))

        expect(fixture.scheduler.inspect()).to.deep.include({
            activeRequestCount: 2,
            cancellationCount: 0,
        })
        expect(fixture.executor.requests.get(firstChild.key)).to.equal(firstRequest)
        expect(fixture.executor.requests.get(secondChild.key)).to.equal(secondRequest)
        expect(firstRequest.cancelled).to.equal(false)
        expect(secondRequest.cancelled).to.equal(false)

        const firstEmpty = feedbackAt(11, fixture.acknowledgedSnapshotEpoch(), [])
        fixture.adapter.reconcileFeedback(firstEmpty, viewAt(firstEmpty))
        expect(firstRequest.cancelled).to.equal(true)
        expect(secondRequest.cancelled).to.equal(false)
        const secondEmpty = feedbackAt(12, fixture.acknowledgedSnapshotEpoch(), [])
        fixture.adapter.reconcileFeedback(secondEmpty, viewAt(secondEmpty))
        expect(secondRequest.cancelled).to.equal(true)
        expect(fixture.scheduler.inspect().activeRequestCount).to.equal(0)

        await fixture.dispose()
    })

    it('never lets deferred feedback displace current demand under budget pressure', async() => {

        const fixture = await createGpuDemandFixture({ maxRequests: 2 })
        const deferredChild = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 12,
            tileCol: 26,
        })
        const currentChild = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 13,
            tileCol: 26,
        })
        const firstFeedback = feedbackAt(
            7,
            fixture.acknowledgedSnapshotEpoch(),
            [ gpuDemand(fixture, deferredChild, fixture.model.addressSpace.parent(deferredChild), 100) ]
        )
        fixture.adapter.reconcileFeedback(firstFeedback, viewAt(firstFeedback))
        const deferredRequest = fixture.executor.requests.get(deferredChild.key)

        const secondFeedback = feedbackAt(
            8,
            fixture.acknowledgedSnapshotEpoch(),
            [ gpuDemand(fixture, currentChild, fixture.model.addressSpace.parent(currentChild), 1) ]
        )
        fixture.adapter.reconcileFeedback(secondFeedback, viewAt(secondFeedback))

        expect(deferredRequest.cancelled).to.equal(true)
        expect(fixture.executor.requests.has(currentChild.key)).to.equal(true)
        expect(fixture.scheduler.inspect()).to.deep.include({
            activeRequestCount: 1,
            demandedPageCount: 2,
        })
        expect(fixture.adapter.facts()).to.deep.include({
            feedbackDemandGraceGenerations: 1,
            deferredDemandCount: 0,
            activeDemandCount: 2,
        })

        await fixture.dispose()
    })

    it('rejects GPU demand outside the configured virtual-raster coverage', async() => {

        const fixture = await createGpuDemandFixture()
        const child = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 12,
            tileCol: 26,
        })
        const parent = fixture.model.addressSpace.parent(child)
        const foreign = Object.freeze({ ...child, addressSpaceId: 'foreign.raster' })
        let failure
        try {
            const feedback = feedbackAt(
                3,
                fixture.acknowledgedSnapshotEpoch(),
                [ { ...gpuDemand(fixture, child, parent, 1), page: foreign } ]
            )
            fixture.adapter.reconcileFeedback(feedback, viewAt(feedback))
        } catch (error) {
            failure = error
        }

        expect(failure).to.be.instanceOf(GeoDiagnosticError)
        expect(failure.diagnostic).to.include({
            code: 'GEO_GPU_TILE_FRONTIER_INVALID',
            phase: 'selection',
        })
        expect(fixture.scheduler.inspect().generation).to.equal(1)
        await fixture.dispose()
    })

    it('holds transition parents and pending children until later acknowledged retirement', async() => {

        const fixture = await createGpuDemandFixture({ maxPhysicalPages: 4 })
        const parent = fixture.model.addressSpace.pageFromTile({
            matrixId: '5',
            tileRow: 12,
            tileCol: 26,
        })
        await fixture.installOutsideDemand(parent, 2)
        const child = fixture.model.addressSpace.pageFromTile({
            matrixId: '6',
            tileRow: 25,
            tileCol: 53,
        })
        const parentEntry = fixture.residency.currentSnapshot.resolve(parent)
        const demandedFeedback = feedbackAt(
            10,
            fixture.acknowledgedSnapshotEpoch(),
            [ gpuDemand(fixture, child, parent, 50) ]
        )
        const demanded = fixture.adapter.reconcileFeedback(
            demandedFeedback,
            viewAt(demandedFeedback)
        )
        expect(demanded.retainedCount).to.equal(1)
        expect(fixture.adapter.lease.facts().retainedPages).to.deep.include({
            pageKey: parent.key,
            generation: parentEntry.generation,
        })

        fixture.executor.requests.get(child.key).resolve(transfer(child, 31))
        await demanded.settlement
        const pendingPublication = fixture.scheduler.publish()
        fixture.adapter.retainPublication(pendingPublication)
        const pendingChild = pendingPublication.snapshot.resolve(child)
        expect(fixture.adapter.lease.facts().retainedPages).to.deep.include({
            pageKey: child.key,
            generation: pendingChild.generation,
        })

        const beforeAcknowledgementFeedback = feedbackAt(
            11,
            fixture.acknowledgedSnapshotEpoch(),
            [],
            [ gpuRetirement(parent, parentEntry, 11, fixture.acknowledgedSnapshotEpoch()) ]
        )
        const beforeAcknowledgement = fixture.adapter.reconcileFeedback(
            beforeAcknowledgementFeedback,
            viewAt(beforeAcknowledgementFeedback)
        )
        expect(beforeAcknowledgement.retiredCount).to.equal(0)
        expect(fixture.adapter.lease.facts().retainedPages).to.deep.include({
            pageKey: parent.key,
            generation: parentEntry.generation,
        })

        await pendingPublication.abandon()
        fixture.adapter.abandonPublication(pendingPublication)
        expect(fixture.adapter.lease.facts().retainedPages).not.to.deep.include({
            pageKey: child.key,
            generation: pendingChild.generation,
        })
        expect(fixture.adapter.lease.facts().retainedPages).to.deep.include({
            pageKey: parent.key,
            generation: parentEntry.generation,
        })

        const retriedFeedback = feedbackAt(
            12,
            fixture.acknowledgedSnapshotEpoch(),
            [ gpuDemand(fixture, child, parent, 60) ]
        )
        const retried = fixture.adapter.reconcileFeedback(
            retriedFeedback,
            viewAt(retriedFeedback)
        )
        fixture.executor.requests.get(child.key).resolve(transfer(child, 32))
        await retried.settlement
        const acknowledgedPublication = fixture.scheduler.publish()
        fixture.adapter.retainPublication(acknowledgedPublication)
        await acknowledgedPublication.acknowledge()
        fixture.adapter.acknowledgePublication(acknowledgedPublication)

        const retiredFeedback = feedbackAt(
            13,
            fixture.acknowledgedSnapshotEpoch(),
            [],
            [ gpuRetirement(parent, parentEntry, 13, fixture.acknowledgedSnapshotEpoch()) ]
        )
        const retired = fixture.adapter.reconcileFeedback(
            retiredFeedback,
            viewAt(retiredFeedback)
        )
        expect(retired.retiredCount).to.equal(1)
        expect(fixture.adapter.lease.facts().retainedPages).not.to.deep.include({
            pageKey: parent.key,
            generation: parentEntry.generation,
        })
        expect(fixture.adapter.lease.facts().retainedPages).to.deep.include({
            pageKey: child.key,
            generation: acknowledgedPublication.snapshot.resolve(child).generation,
        })
        await fixture.dispose()
    })

    it('rejects GPU feedback that does not belong to the supplied Geo view snapshot', async() => {

        const fixture = await createGpuDemandFixture()
        const feedback = feedbackAt(7, fixture.acknowledgedSnapshotEpoch(), [])
        const mismatchedView = createGeoViewSnapshot({
            ...viewDescriptorAt(feedback),
            frameEpoch: feedback.frameEpoch + 1,
        })

        expect(() => fixture.adapter.reconcileFeedback(feedback, mismatchedView))
            .to.throw(GeoDiagnosticError)
        expect(fixture.scheduler.inspect().generation).to.equal(1)
        await fixture.dispose()
    })

    it('constructs only the standard row/column endpoint with immutable content identity', () => {

        const source = createDemTileSource({
            manifest,
            tileServerUrl: 'http://127.0.0.1:8787/',
        })
        const { model } = source
        const page = model.addressSpace.pageFromTile({
            matrixId: '10',
            tileRow: 418,
            tileCol: 858,
        })

        expect(source.tileUrl(page)).to.equal(
            'http://127.0.0.1:8787/tiles/WebMercatorQuad/10/418/858.png' +
            '?v=dem-aa7a584830f19877-cog-wmq-v3'
        )
    })

    it('uses every covered minimum-matrix tile as the safety cover', () => {

        const expanded = structuredClone(manifest)
        expanded.tileMatrixSet.limits[0] = {
            matrixId: '4',
            minTileRow: 6,
            maxTileRow: 7,
            minTileCol: 12,
            maxTileCol: 13,
        }
        const { model } = createDemTileSource({
            manifest: expanded,
            tileServerUrl: 'http://127.0.0.1:8787',
        })

        expect(model.safetyCoverPages.map(page => page.key)).to.deep.equal([
            '4/6/12',
            '4/6/13',
            '4/7/12',
            '4/7/13',
        ])
    })

    it('bypasses stale browser cache when fetching the mutable manifest endpoint', async() => {

        const originalFetch = globalThis.fetch
        let requestedUrl
        let requestOptions
        globalThis.fetch = async(input, options) => {
            requestedUrl = String(input)
            requestOptions = options
            return { ok: true, json: async() => manifest }
        }
        let result
        try {
            result = await fetchDemTileSource(
                'http://127.0.0.1:8787/',
                new AbortController().signal
            )
        } finally {
            globalThis.fetch = originalFetch
        }

        expect(requestedUrl).to.equal('http://127.0.0.1:8787/manifest.json')
        expect(requestOptions.cache).to.equal('no-store')
        expect(result.manifest.contentVersion).to.equal(manifest.contentVersion)
        expect(result.model.addressSpace.levelCount).to.equal(7)
    })

    it('emits direct fixed-Mercator sampling without persistent per-node addresses', () => {

        const source = createDemTileSource({
            manifest,
            tileServerUrl: 'http://127.0.0.1:8787',
        })
        const { model } = source
        const wgsl = webMercatorVirtualRasterWgslModule(model, {
            namespace: 'DemHeight',
            addressNamespace: 'DemAddress',
            group: 2,
            pageTableBinding: 0,
            atlasBinding: 1,
            transitionTexels: 16,
        }).code
        const generic = webMercatorVirtualRasterField({
            id: 'test-height',
            addressSpaceId: 'test-height-address-space',
            sourceRevision: source.manifest.contentVersion,
            coverage: model.coverage,
            geographicBounds: source.manifest.source.geographicBounds,
            coordinateBits: DEM_WEB_MERCATOR_COORDINATE_BITS,
            fieldKind: 'scalar',
            channels: 1,
            sampleType: 'unorm8',
            gpuFormat: 'r8unorm',
            unit: 'm',
            interpolation: 'linear',
            scale: source.manifest.scale,
            offset: source.manifest.offset,
        })
        const genericWgsl = webMercatorVirtualRasterWgslModule(generic, {
            namespace: 'TestHeight',
            addressNamespace: 'TestAddress',
            group: 2,
            pageTableBinding: 0,
            atlasBinding: 1,
            transitionTexels: 16,
        })

        expect(model.addressCodec.bytesPerPosition).to.equal(16)
        expect(generic.kind).to.equal('web-mercator-virtual-raster-field')
        expect(genericWgsl.code).to.include('fn TestHeight_sample_vertex(')
        expect(genericWgsl.code).to.include('fn TestAddress_address(')
        expect(wgsl).to.include('fn DemAddress_address(')
        expect(wgsl).to.include('fn DemHeight_load_position(')
        expect(wgsl).to.include('fn DemHeight_sample_vertex(')
        expect(wgsl).to.include('fn DemHeight_resolution_global(')
        expect(wgsl).to.include('fn DemHeight_sample_level(')
        expect(wgsl).to.include('fn DemHeight_edge_blend_weight(')
        expect(wgsl).to.include('fn DemHeight_failed(level: u32)')
        expect(wgsl).to.include('if (status == 4u) { return DemHeight_failed(level); }')
        expect(wgsl).to.include('tl.status == 4u || tr.status == 4u')
        expect(wgsl).to.include('const DemHeight_transition_texels = 16.0f')
        expect(wgsl).to.include('iteration < DemHeight_level_count')
        expect(wgsl).to.include('DemHeight_matrix[sample_level]')
        expect(wgsl).to.include('DemAddress_compact_index')
        expect(wgsl).to.include('vec2u(3414u, 1662u)')
        expect(wgsl).to.include('vec2u(3435u, 1673u)')
        expect(wgsl).to.not.include('logicalTexel')
        expect(wgsl).to.not.include('canonicalNodes')
        expect(wgsl).to.not.include('DemCanonical')
        expect(wgsl).to.not.include('_mercator')
        expect(wgsl).to.not.include('f64')
    })
})

async function createGpuDemandFixture({ maxPhysicalPages = 6, maxRequests = 24 } = {}) {

    const { model } = createDemTileSource({
        manifest,
        tileServerUrl: 'http://127.0.0.1:8787',
    })
    const residency = new VirtualRasterResidency({
        addressSpace: model.addressSpace,
        plane: model.plane,
        maxPhysicalPages,
        maxStagingBytes: maxPhysicalPages * 256 * 256,
        maxHistory: 16,
    })
    const executor = new FakeExecutor()
    const scheduler = new VirtualRasterRequestScheduler({
        residency,
        executor,
        maxRequests,
        maxHistory: 16,
    })
    const viewDemandProducer = new ViewDemandProducer({
        id: 'dem-test-view-demand',
        maxDemands: scheduler.maxRequests,
    })
    const adapter = createVirtualRasterDemandController({
        model,
        residency,
        scheduler,
        viewDemandProducer,
        maxPhysicalPages,
        maxHistory: 16,
    })
    const initialization = adapter.initialize()
    for (const request of executor.requests.values()) {
        request.resolve(transfer(request.demand.page, 17))
    }
    await initialization.settled
    const publication = scheduler.publish()
    adapter.retainPublication(publication)
    await publication.acknowledge()
    adapter.acknowledgePublication(publication)
    return {
        model,
        residency,
        scheduler,
        executor,
        adapter,
        acknowledgedSnapshotEpoch: () => adapter.facts().acknowledgedSnapshotEpoch,
        async installOutsideDemand(page, generation) {
            residency.stage(ownedVirtualRasterPagePayload({
                page,
                width: 256,
                height: 256,
                channels: 1,
                data: new Uint8Array(256 * 256).fill(23),
                contentVersion: `outside-${generation}`,
            }), { generation })
            const outside = scheduler.publish()
            adapter.retainPublication(outside)
            await outside.acknowledge()
            adapter.acknowledgePublication(outside)
        },
        async dispose() {
            await scheduler.dispose()
            adapter.dispose()
            residency.dispose()
        },
    }
}

function viewAt(feedback) {

    return createGeoViewSnapshot(viewDescriptorAt(feedback))
}

function viewDescriptorAt(feedback) {

    return {
        id: 'dem-test-view',
        clipFromRelativeWorld: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ],
        cameraHigh: [ 0, 0, 1 ],
        cameraLow: [ 0, 0, 0 ],
        viewport: [ 1280, 800 ],
        verticalFovRadians: 1,
        cameraLatitudeRadians: 0,
        cameraPitchRadians: 0,
        zoomHint: 5,
        frameEpoch: feedback.frameEpoch,
        residencySnapshotEpoch: feedback.residencySnapshotEpoch,
    }
}

function feedbackAt(frameEpoch, residencySnapshotEpoch, demands, retirements = []) {

    return Object.freeze({
        kind: 'virtual-raster-gpu-feedback-batch',
        ringId: 'test-feedback-ring',
        frontierId: 'test-frontier',
        submissionId: `test-submission-${frameEpoch}`,
        frameEpoch,
        residencySnapshotEpoch,
        demands: Object.freeze(demands.map(demand => Object.freeze({
            ...demand,
            decisionFrameEpoch: frameEpoch,
            residencySnapshotEpoch,
        }))),
        retirements: Object.freeze(retirements.map(retirement => Object.freeze({
            ...retirement,
            decisionFrameEpoch: frameEpoch,
            residencySnapshotEpoch,
        }))),
        facts: Object.freeze({
            frameEpoch,
            residencySnapshotEpoch,
            activeFrontierCount: 1,
            visibleInstanceCount: 1,
            refineCandidateCount: demands.length > 0 ? 1 : 0,
            coarsenCandidateCount: retirements.length > 0 ? 1 : 0,
            demandCount: demands.length,
            fallbackCount: 0,
            staleGenerationCount: 0,
            budgetLimitedCount: 0,
            maximumObservedSse: 1,
            frontierOverflow: false,
            demandOverflow: false,
            visibleOverflow: false,
            convergenceState: demands.length > 0 ? 'transitioning' : 'converged',
        }),
        counters: Object.freeze({
            currentFrontierCount: 1,
            nextFrontierCount: 1,
            visibleInstanceCount: 1,
            refineCandidateCount: demands.length > 0 ? 1 : 0,
            coarsenCandidateCount: retirements.length > 0 ? 1 : 0,
            demandCount: demands.length,
            retirementCount: retirements.length,
            staleGenerationCount: 0,
            budgetLimitedCount: 0,
            lookupDuplicateCount: 0,
            balanceRejectedCount: 0,
            fallbackCount: 0,
            acceptedRefineCount: demands.length > 0 ? 1 : 0,
            acceptedCoarsenCount: retirements.length > 0 ? 1 : 0,
            discardedStaleRetirementCount: 0,
        }),
        diagnostics: Object.freeze([]),
    })
}

function gpuDemand(fixture, page, parent, priority) {

    const parentEntry = fixture.residency.currentSnapshot.resolve(parent)
    const tile = page.tile
    return {
        page,
        parent,
        parentCompactIndex: fixture.model.addressSpace.tableIndex(parent),
        parentPhysicalSlot: parentEntry.physicalSlot,
        parentGeneration: parentEntry.generation,
        priority,
        decisionFrameEpoch: 0,
        residencySnapshotEpoch: 0,
        childMask: 1 << ((tile.tileRow % 2) * 2 + tile.tileCol % 2),
    }
}

function gpuRetirement(page, entry, decisionFrameEpoch, residencySnapshotEpoch) {

    return {
        page,
        physicalSlot: entry.physicalSlot,
        generation: entry.generation,
        contentEpoch: entry.contentEpoch,
        decisionFrameEpoch,
        residencySnapshotEpoch,
    }
}

function transfer(page, value) {

    const prepared = prepareVirtualRasterPageTransfer({
        page,
        width: 256,
        height: 256,
        channels: 1,
        data: new Uint8Array(256 * 256).fill(value),
        contentVersion: `feedback-${value}`,
    })
    return structuredClone(prepared.value, { transfer: [ ...prepared.transferables ] })
}

class FakeExecutor {

    requests = new Map()

    request(demand) {

        const deferred = Promise.withResolvers()
        const request = {
            demand,
            result: deferred.promise,
            cancelled: false,
            cancel: () => {
                request.cancelled = true
                deferred.reject(new Error('cancelled'))
                return 'cooperative'
            },
            reprioritize: priority => {
                request.demand = { ...request.demand, priority }
                return true
            },
            accept: async() => {},
            discard: async() => {},
            resolve: value => deferred.resolve(value),
        }
        this.requests.set(demand.page.key, request)
        return request
    }
}
