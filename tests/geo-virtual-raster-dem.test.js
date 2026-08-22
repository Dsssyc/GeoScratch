import { expect } from 'chai'
import {
    GeoDiagnosticError,
    ViewDemandProducer,
    VirtualRasterRequestScheduler,
    VirtualRasterResidency,
    createGeoViewSnapshot,
    createVirtualRasterDemandController,
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
        expect(source.elevationBounds).to.deep.equal(manifest.tileElevationBounds)
        expect(Object.isFrozen(source.elevationBounds)).to.equal(true)
        expect(Object.isFrozen(source)).to.equal(true)
        expect(Object.isFrozen(model)).to.equal(true)
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
        expect(model.field).to.deep.include({
            kind: 'geo-field',
            fieldKind: 'scalar',
            channels: 1,
            sampleType: 'unorm8',
            unit: 'm',
            interpolation: 'linear',
        })
    })

    it('rejects incomplete or duplicate immutable elevation bounds', () => {

        const incomplete = structuredClone(manifest)
        incomplete.tileElevationBounds.pop()
        expect(() => createDemTileSource({
            manifest: incomplete,
            tileServerUrl: 'http://127.0.0.1:8787',
        })).to.throw(TypeError)

        const duplicate = structuredClone(manifest)
        duplicate.tileElevationBounds[1] = {
            ...duplicate.tileElevationBounds[0],
        }
        expect(() => createDemTileSource({
            manifest: duplicate,
            tileServerUrl: 'http://127.0.0.1:8787',
        })).to.throw(TypeError)
    })

    it('consumes explicit desired/source demand without acquiring LoD authority', async() => {

        const { model } = createDemTileSource({
            manifest,
            tileServerUrl: 'http://127.0.0.1:8787/',
        })
        const residency = new VirtualRasterResidency({
            addressSpace: model.addressSpace,
            plane: model.plane,
            maxPhysicalPages: 8,
            maxStagingBytes: 8 * 256 * 256,
            maxHistory: 32,
        })
        const executor = new FakeExecutor()
        const scheduler = new VirtualRasterRequestScheduler({
            residency,
            executor,
            maxRequests: 4,
            maxHistory: 32,
        })
        const producer = new ViewDemandProducer({
            id: 'dem-explicit-view-demand',
            maxDemands: 3,
        })
        const controller = createVirtualRasterDemandController({
            model,
            residency,
            scheduler,
            viewDemandProducer: producer,
            maxPhysicalPages: 8,
            maxHistory: 32,
        })
        const initialization = controller.initialize()
        for (const request of executor.requests.values()) {
            request.resolve(transfer(request.demand.page, 17))
        }
        await initialization.settled
        const safetyPublication = scheduler.publish()
        await safetyPublication.acknowledge()
        controller.acknowledgePublication(safetyPublication)

        const requestedPage = model.addressSpace.pageFromTile({
            matrixId: '10',
            tileRow: 416,
            tileCol: 855,
        })
        const view = createGeoViewSnapshot({
            id: 'dem-direct-demand-view',
            clipFromRelativeWorld: new Float32Array(16),
            cameraHigh: [ 0, 0, 1 ],
            cameraLow: [ 0, 0, 0 ],
            referenceViewport: [ 1280, 800 ],
            verticalFovRadians: 1,
            cameraLatitudeRadians: 0,
            cameraPitchRadians: 0,
            zoomHint: 14,
            frameEpoch: 7,
            residencySnapshotEpoch: safetyPublication.snapshot.epoch,
        })
        const demands = producer.produce({
            view,
            generation: 7,
            demands: [ {
                page: requestedPage,
                desiredSampleLevel: 14,
                sourceLevelCeiling: 10,
                priority: { class: 'user-visible', score: 14_000_000 },
                intent: 'refinement',
                reason: 'gpu-cover:7:desired-z14',
            } ],
        })
        const first = controller.reconcileViewDemands(demands)

        expect(first).to.deep.include({
            requestedCount: 1,
            retainedCount: 1,
            retiredCount: 0,
        })
        expect(executor.requests.get(requestedPage.key).demand).to.deep.include({
            page: requestedPage,
            reason: 'gpu-cover:7:desired-z14',
        })
        expect(executor.requests.get(requestedPage.key).demand)
            .not.to.have.any.keys('desiredSampleLevel', 'sourceLevelCeiling')

        executor.requests.get(requestedPage.key).resolve(transfer(requestedPage, 23))
        await first.settlement
        const publication = scheduler.publish()
        await publication.acknowledge()
        controller.acknowledgePublication(publication)
        const second = controller.reconcileViewDemands(demands)

        expect(second.requestedCount).to.equal(0)
        expect(scheduler.inspect().activeRequestCount).to.equal(0)
        expect(controller.facts()).to.deep.include({
            safetyDemandCount: 1,
            viewDemandCapacity: 3,
            lastDecisionFrameEpoch: 7,
            activeDemandCount: 2,
        })

        const foreignProducer = new ViewDemandProducer({
            id: 'foreign-view-demand',
            maxDemands: 3,
        })
        const foreignDemands = foreignProducer.produce({
            view,
            generation: 8,
            demands: [ {
                page: requestedPage,
                desiredSampleLevel: 14,
                sourceLevelCeiling: 10,
                priority: { class: 'user-visible', score: 14_000_000 },
                intent: 'refinement',
                reason: 'foreign-producer',
            } ],
        })
        expect(() => controller.reconcileViewDemands(foreignDemands))
            .to.throw(GeoDiagnosticError)

        await scheduler.dispose()
        controller.dispose()
        residency.dispose()
    })

    it('constructs only the standard row/column endpoint with immutable content identity', () => {

        const source = createDemTileSource({
            manifest,
            tileServerUrl: 'http://127.0.0.1:8787/',
        })
        const page = source.model.addressSpace.pageFromTile({
            matrixId: '10',
            tileRow: 418,
            tileCol: 858,
        })

        expect(source.tileUrl(page)).to.equal(
            'http://127.0.0.1:8787/tiles/WebMercatorQuad/10/418/858.png' +
            '?v=dem-aa7a584830f19877-cog-wmq-v4'
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
        expanded.tileElevationBounds.unshift(
            {
                ...expanded.tileElevationBounds[0],
                tileRow: 6,
                tileCol: 12,
            },
            {
                ...expanded.tileElevationBounds[0],
                tileRow: 7,
                tileCol: 12,
            },
            {
                ...expanded.tileElevationBounds[0],
                tileRow: 7,
                tileCol: 13,
            },
        )
        expanded.tileElevationBounds.sort((left, right) =>
            left.matrixLevel - right.matrixLevel ||
            left.tileRow - right.tileRow ||
            left.tileCol - right.tileCol
        )
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
        expect(wgsl).to.include('fn DemAddress_address(')
        expect(wgsl).to.include('fn DemHeight_sample_vertex(')
        expect(wgsl).to.include('fn DemHeight_resolution_global(')
        expect(wgsl).to.include('fn DemHeight_edge_blend_weight(')
        expect(wgsl).to.include('iteration < DemHeight_level_count')
        expect(wgsl).to.include('DemHeight_matrix[sample_level]')
        expect(wgsl).to.include('DemAddress_compact_index')
        expect(wgsl).not.to.include('canonicalNodes')
        expect(wgsl).not.to.include('f64')
    })
})

function transfer(page, value) {

    const prepared = prepareVirtualRasterPageTransfer({
        page,
        width: 256,
        height: 256,
        channels: 1,
        data: new Uint8Array(256 * 256).fill(value),
        contentVersion: `demand-${value}`,
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
