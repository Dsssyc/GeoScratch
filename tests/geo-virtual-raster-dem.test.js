import { expect } from 'chai'
import {
    DEM_COORDINATE_CODEC,
    DEM_COORDINATE_QUANTUM,
    canonicalDemCoordinateCells,
    createDemVirtualRasterModel,
    demHeightSamplingLevel,
    encodeDemCoordinate,
    encodeDemCanonicalNodes,
    parseDemVirtualRasterManifest,
    planDemVirtualPages,
    resolveDemStitchedGrid,
} from '../examples/demLayer/dem-virtual-raster.ts'
import { selectTerrainNodes } from '../examples/demLayer/terrain-selection.ts'

const manifest = Object.freeze({
    schemaVersion: 1,
    sourceHash: 'aa7a584830f198772d242df1ce1ae47e21b2bdc85bfc1f97101af8be986c57e1',
    contentVersion: 'dem-aa7a584830f19877-cog-v1',
    crs: 'EPSG:4326',
    bounds: [ 120.04373606134682, 31.173901952209487, 121.96623240116922, 32.08401085804678 ],
    rasterDimensions: { width: 1024, height: 558 },
    tileMatrixSet: {
        id: 'GeoScratchLocalRasterQuad',
        origin: 'southwest',
        axisOrder: [ 'east', 'north' ],
    },
    tileSize: 256,
    minZoom: 0,
    maxZoom: 3,
    nodata: null,
    sampleType: 'uint8',
    scale: 0.3311509803921568,
    offset: -80.06899999999999,
    overviewLevels: [ 2, 4, 8 ],
    pixelOrientation: {
        source: 'south-up-row-major',
        cog: 'north-up-row-major',
        tile: 'south-up-row-major',
    },
    outerBoundary: 'clamp',
    levels: [
        { zoom: 0, decimation: 8, width: 128, height: 70, pagesX: 1, pagesY: 1 },
        { zoom: 1, decimation: 4, width: 256, height: 140, pagesX: 1, pagesY: 1 },
        { zoom: 2, decimation: 2, width: 512, height: 279, pagesX: 2, pagesY: 2 },
        { zoom: 3, decimation: 1, width: 1024, height: 558, pagesX: 4, pagesY: 3 },
    ],
})

describe('DEM high precision virtual raster', () => {

    it('validates the COG manifest and maps backend zoom to Geo finest-first levels', () => {

        const parsed = parseDemVirtualRasterManifest(manifest)
        const model = createDemVirtualRasterModel(parsed)

        expect(parsed).to.deep.equal(manifest)
        expect(model.addressSpace.extent).to.deep.equal([ 1024, 558 ])
        expect(model.addressSpace.pageSize).to.deep.equal([ 256, 256 ])
        expect(model.addressSpace.levelCount).to.equal(4)
        expect(model.httpZoom(model.addressSpace.page({ level: 0, x: 3, y: 2 }))).to.equal(3)
        expect(model.httpZoom(model.addressSpace.page({ level: 3, x: 0, y: 0 }))).to.equal(0)
        expect(model.plane).to.deep.include({
            fieldKind: 'scalar',
            channels: 1,
            sampleType: 'unorm8',
            gpuFormat: 'r8unorm',
        })
        expect(model.plane).not.to.have.property('noData')
    })

    it('plans visible detail plus every parent without attaching pages to positions', () => {

        const model = createDemVirtualRasterModel(parseDemVirtualRasterManifest(manifest))
        const selection = selectTerrainNodes({
            cameraPos: [ 120.980697, 31.684162 ],
            zoomLevel: 12,
            maxLevel: 14,
        })
        const plan = planDemVirtualPages(model.addressSpace, selection, manifest.bounds)

        expect(plan.pages[0].key).to.equal('3/0/0')
        expect(plan.pages.some(page => page.level === 0)).to.equal(true)
        expect(plan.pages.every(page => !('texel' in page) && !('physicalSlot' in page))).to.equal(true)
        expect(plan.requestedLodRange).to.deep.equal([ 0, 3 ])
        expect(plan.pages.map(page => page.key)).to.deep.equal(
            [ ...new Set(plan.pages.map(page => page.key)) ]
        )
    })

    it('stitches by integer edge identity before deriving one shared canonical coordinate', () => {

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
        const coarseEdge = canonicalDemCoordinateCells(coarseBounds, { x: 64, y: 16 })
        const fineEdge = canonicalDemCoordinateCells(fineBounds, { x: 0, y: 32 })

        expect(coarseEdge).to.deep.equal(fineEdge)
        expect(coarseEdge.every(value => Number.isSafeInteger(value))).to.equal(true)
        expect(DEM_COORDINATE_QUANTUM).to.equal(180 / 2 ** 30)
    })

    it('selects a common coarser height level on mixed-LoD edges', () => {

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

    it('packs cell-local geographic nodes and preserves camera-relative precision', () => {

        const selection = selectTerrainNodes({
            cameraPos: [ 120.980697, 31.684162 ],
            zoomLevel: 10,
            maxLevel: 14,
        })
        const packed = encodeDemCanonicalNodes(selection, manifest)
        const position = encodeDemCoordinate([ 120.980697, 31.684162 ])
        const cameraAcrossCell = encodeDemCoordinate([
            120.980697 + DEM_COORDINATE_QUANTUM,
            31.684162,
        ])

        expect(packed.byteLength).to.equal(5000 * 32)
        expect(DEM_COORDINATE_CODEC.facts).to.deep.include({
            encoding: 'cell-local-f32',
            bytesPerPosition: 16,
        })
        expect(DEM_COORDINATE_CODEC.facts.cellExtent[0]).to.equal(DEM_COORDINATE_QUANTUM)
        expect(DEM_COORDINATE_CODEC.difference(position, cameraAcrossCell)[0])
            .to.be.closeTo(-DEM_COORDINATE_QUANTUM, DEM_COORDINATE_QUANTUM / 4)
    })
})
