import { expect } from 'chai'
import {
    DEM_CANONICAL_NODE_BYTES,
    DEM_WEB_MERCATOR_COORDINATE_BITS,
    canonicalDemCoordinateQuanta,
    createDemVirtualRasterModel,
    demHeightSamplingLevel,
    demTileUrl,
    demVirtualRasterWgslModule,
    encodeDemCanonicalNodes,
    fetchDemVirtualRasterManifest,
    parseDemVirtualRasterManifest,
    planDemVirtualPages,
    resolveDemStitchedGrid,
} from '../examples/demLayer/dem-virtual-raster.ts'
import { selectTerrainNodes } from '../examples/demLayer/terrain-selection.ts'
import { DemPhaseBudget } from '../examples/demLayer/dem-phase-budget.ts'

const bounds = [ 120.04373606134682, 31.173901952209487, 121.96623240116922, 32.08401085804678 ]
const limits = [
    { matrixId: '4', minTileRow: 6, maxTileRow: 6, minTileCol: 13, maxTileCol: 13 },
    { matrixId: '5', minTileRow: 12, maxTileRow: 13, minTileCol: 26, maxTileCol: 26 },
    { matrixId: '6', minTileRow: 25, maxTileRow: 26, minTileCol: 53, maxTileCol: 53 },
    { matrixId: '7', minTileRow: 51, maxTileRow: 52, minTileCol: 106, maxTileCol: 107 },
    { matrixId: '8', minTileRow: 103, maxTileRow: 104, minTileCol: 213, maxTileCol: 214 },
    { matrixId: '9', minTileRow: 207, maxTileRow: 209, minTileCol: 426, maxTileCol: 429 },
    { matrixId: '10', minTileRow: 415, maxTileRow: 418, minTileCol: 853, maxTileCol: 858 },
]
const manifest = Object.freeze({
    schemaVersion: 2,
    sourceHash: 'aa7a584830f198772d242df1ce1ae47e21b2bdc85bfc1f97101af8be986c57e1',
    contentVersion: 'dem-aa7a584830f19877-cog-wmq-v3',
    source: {
        crs: 'EPSG:4326',
        geographicBounds: bounds,
        rasterDimensions: { width: 1024, height: 558 },
        sampleType: 'uint8',
        bitsPerSample: 8,
    },
    projectedBounds: {
        crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
        bounds: [ 13363275.903308092, 3654711.03675981, 13577289.36868858, 3773537.869423257 ],
    },
    tileMatrixSet: {
        id: 'WebMercatorQuad',
        uri: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
        crs: 'http://www.opengis.net/def/crs/EPSG/0/3857',
        cornerOfOrigin: 'topLeft',
        tileRowDirection: 'south',
        tileColDirection: 'east',
        tileWidth: 256,
        tileHeight: 256,
        minTileMatrix: '4',
        maxTileMatrix: '10',
        tileMatrixIds: [ '4', '5', '6', '7', '8', '9', '10' ],
        limits,
    },
    nativeResolution: {
        closestTileMatrix: '10',
        tileMatrixCellSizeMeters: 152.8740565703525,
        sourceProjectedPixelSizeMeters: [ 209.00924353563227, 212.95131283771864 ],
        tileMatrixCellsPerSourcePixel: [ 1.3672184320890406, 1.3930073120628352 ],
        resampling: 'nearest',
    },
    nodata: null,
    scale: 0.3311509803921568,
    offset: -80.06899999999999,
    overviewLevels: [ 2, 4, 8 ],
    pixelOrientation: {
        source: 'north-up-row-major',
        cog: 'north-up-row-major',
        tile: 'north-up-row-major',
    },
    outerBoundary: 'clamp',
    cacheValidators: {
        coherence: 'immutable',
        encodedRepresentation: 'image/png',
        decoderVersion: 'dem-png-unorm8-v1',
        etag: 'content-version-and-standard-tile',
    },
})

describe('DEM WebMercator virtual raster', () => {

    it('configures and enforces independent network and decode concurrency budgets', async() => {

        const budget = new DemPhaseBudget({
            maxNetworkRequests: 2,
            maxDecodeTasks: 1,
            maxQueuedTasks: 4,
        })
        const firstNetwork = budget.acquire('network', {
            class: 'user-visible',
            score: 0,
        })
        const secondNetwork = budget.acquire('network', {
            class: 'user-visible',
            score: 0,
        })
        const queuedNetwork = budget.acquire('network', {
            class: 'background',
            score: 0,
        })
        const firstDecode = budget.acquire('decode', {
            class: 'user-visible',
            score: 0,
        })
        const queuedDecode = budget.acquire('decode', {
            class: 'background',
            score: 0,
        })

        const [ firstNetworkPermit, secondNetworkPermit, firstDecodePermit ] = await Promise.all([
            firstNetwork.result,
            secondNetwork.result,
            firstDecode.result,
        ])
        expect(queuedNetwork.inspect().state).to.equal('queued')
        expect(queuedDecode.inspect().state).to.equal('queued')
        expect(budget.inspect()).to.deep.include({
            disposed: false,
            network: {
                limit: 2,
                activeCount: 2,
                queuedCount: 1,
                maxActiveCount: 2,
                maxQueuedCount: 1,
            },
            decode: {
                limit: 1,
                activeCount: 1,
                queuedCount: 1,
                maxActiveCount: 1,
                maxQueuedCount: 1,
            },
        })

        expect(queuedNetwork.cancel('obsolete')).to.equal(true)
        await expectRejectedName(queuedNetwork.result, 'AbortError')
        expect(queuedDecode.reprioritize({ class: 'critical', score: 9 })).to.equal(true)
        firstDecodePermit.release()
        const secondDecodePermit = await queuedDecode.result
        expect(queuedDecode.inspect().state).to.equal('active')

        firstNetworkPermit.release()
        secondNetworkPermit.release()
        secondDecodePermit.release()
        await budget.dispose()
        expect(budget.inspect()).to.deep.include({
            disposed: true,
            network: {
                limit: 2,
                activeCount: 0,
                queuedCount: 0,
                maxActiveCount: 2,
                maxQueuedCount: 1,
            },
            decode: {
                limit: 1,
                activeCount: 0,
                queuedCount: 0,
                maxActiveCount: 1,
                maxQueuedCount: 1,
            },
        })
    })

    it('validates standard manifest facts and builds a compact tile address space', () => {

        const parsed = parseDemVirtualRasterManifest(manifest)
        const model = createDemVirtualRasterModel(parsed)

        expect(parsed).to.deep.equal(manifest)
        expect(model.coverage.entryCount).to.equal(49)
        expect(model.addressSpace.pageTableEntryCount).to.equal(49)
        expect(model.addressSpace.pageSize).to.deep.equal([ 256, 256 ])
        expect(model.addressSpace.levelCount).to.equal(7)
        expect(model.addressSpace.matrixId(0)).to.equal('10')
        expect(model.addressSpace.matrixId(6)).to.equal('4')
        expect(model.rootPage).to.deep.include({ key: '4/6/13', level: 6 })
        expect(model.addressCodec.coordinateBits).to.equal(DEM_WEB_MERCATOR_COORDINATE_BITS)
        expect(model.addressCodec.quantumMeters).to.be.lessThan(0.001)
        expect(model.plane).to.deep.include({
            fieldKind: 'scalar',
            channels: 1,
            sampleType: 'unorm8',
            gpuFormat: 'r8unorm',
        })
    })

    it('constructs only the standard row/column endpoint with immutable content identity', () => {

        const parsed = parseDemVirtualRasterManifest(manifest)
        const model = createDemVirtualRasterModel(parsed)
        const page = model.addressSpace.pageFromTile({
            matrixId: '10',
            tileRow: 418,
            tileCol: 858,
        })

        expect(demTileUrl(parsed, 'http://127.0.0.1:8787/', page)).to.equal(
            'http://127.0.0.1:8787/tiles/WebMercatorQuad/10/418/858.png' +
            '?v=dem-aa7a584830f19877-cog-wmq-v3'
        )
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
            result = await fetchDemVirtualRasterManifest(
                'http://127.0.0.1:8787/',
                new AbortController().signal
            )
        } finally {
            globalThis.fetch = originalFetch
        }

        expect(requestedUrl).to.equal('http://127.0.0.1:8787/manifest.json')
        expect(requestOptions.cache).to.equal('no-store')
        expect(result.contentVersion).to.equal(manifest.contentVersion)
    })

    it('plans standard visible tiles plus covered parents without physical addresses', () => {

        const model = createDemVirtualRasterModel(parseDemVirtualRasterManifest(manifest))
        const selection = selectTerrainNodes({
            cameraPos: [ 120.980697, 31.684162 ],
            zoomLevel: 12,
            maxLevel: 14,
        })
        const plan = planDemVirtualPages(model, selection)

        expect(plan.pages[0].key).to.equal('4/6/13')
        expect(plan.pages.some(page => page.tile?.matrixId === '10')).to.equal(true)
        expect(plan.pages.every(page =>
            page.tile?.tileMatrixSetId === 'WebMercatorQuad' &&
            !('texel' in page) && !('physicalSlot' in page)
        )).to.equal(true)
        expect(plan.requestedLodRange).to.deep.equal([ 0, 6 ])
        expect(plan.pages.map(page => page.key)).to.deep.equal(
            [ ...new Set(plan.pages.map(page => page.key)) ]
        )
    })

    it('stitches first and then derives one shared wide-fixed canonical coordinate', () => {

        const model = createDemVirtualRasterModel(parseDemVirtualRasterManifest(manifest))
        const fineGrid = resolveDemStitchedGrid({
            x: 0,
            y: 31,
            ownLevel: 10,
            leftLevel: 9,
            rightLevel: 10,
            bottomLevel: 10,
            topLevel: 10,
        })
        expect(fineGrid).to.deep.equal({ x: 0, y: 32, heightSamplingLevel: 3 })

        const coarseBounds = [ 120.0, 31.0, 121.0, 32.0 ]
        const fineBounds = [ 121.0, 31.0, 121.5, 31.5 ]
        const coarseEdge = canonicalDemCoordinateQuanta(
            model.addressCodec,
            coarseBounds,
            { x: 64, y: 16 }
        )
        const fineEdge = canonicalDemCoordinateQuanta(
            model.addressCodec,
            fineBounds,
            { x: 0, y: 32 }
        )

        expect(coarseEdge).to.deep.equal(fineEdge)
        expect(coarseEdge.every(value => typeof value === 'bigint')).to.equal(true)
    })

    it('selects a common coarser height matrix on mixed-LoD edges', () => {

        expect(demHeightSamplingLevel(9)).to.equal(3)
        expect(demHeightSamplingLevel(10)).to.equal(2)
        expect(demHeightSamplingLevel(11)).to.equal(1)
        expect(demHeightSamplingLevel(12)).to.equal(0)
        expect(demHeightSamplingLevel(14)).to.equal(0)
        const stitched = resolveDemStitchedGrid({
            x: 64,
            y: 17,
            ownLevel: 11,
            leftLevel: 11,
            rightLevel: 9,
            bottomLevel: 11,
            topLevel: 11,
        })
        expect(stitched.heightSamplingLevel).to.equal(3)
    })

    it('packs only two wide-fixed endpoints per node and emits transient tile sampling WGSL', () => {

        const parsed = parseDemVirtualRasterManifest(manifest)
        const model = createDemVirtualRasterModel(parsed)
        const selection = selectTerrainNodes({
            cameraPos: [ 120.980697, 31.684162 ],
            zoomLevel: 10,
            maxLevel: 14,
        })
        const packed = encodeDemCanonicalNodes(selection, parsed)
        const wgsl = demVirtualRasterWgslModule(model)

        expect(packed.byteLength).to.equal(5000 * DEM_CANONICAL_NODE_BYTES)
        expect(DEM_CANONICAL_NODE_BYTES).to.equal(32)
        expect(model.addressCodec.bytesPerPosition).to.equal(16)
        expect(wgsl).to.include('fn DemAddress_address(')
        expect(wgsl).to.include('fn DemHeight_load_position(')
        expect(wgsl).to.include('fn DemHeight_sample_vertex(')
        expect(wgsl).to.include('fn DemHeight_resolution_global(')
        expect(wgsl).to.include('fn DemHeight_sample_level(')
        expect(wgsl).to.include('fn DemHeight_edge_blend_weight(')
        expect(wgsl).to.include('const DemHeight_transition_texels = 16.0f')
        expect(wgsl).to.include('iteration < DemHeight_level_count')
        expect(wgsl).to.include('DemHeight_matrix[sample_level]')
        expect(wgsl).to.include('DemAddress_compact_index')
        expect(wgsl).to.include('vec2u(3414u, 1662u)')
        expect(wgsl).to.include('vec2u(3435u, 1673u)')
        expect(wgsl).to.not.include('logicalTexel')
        expect(wgsl).to.not.include('f64')
    })
})

async function expectRejectedName(promise, name) {

    let failure
    try {
        await promise
    } catch (error) {
        failure = error
    }
    expect(failure).to.be.instanceOf(Error)
    expect(failure.name).to.equal(name)
}
