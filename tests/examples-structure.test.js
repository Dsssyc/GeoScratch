import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

describe('examples structure', () => {
    const examples = [
        '1_helloTriangle',
        '2_helloVertexBuffer',
        'm_helloMap',
        'm_demLayer',
        'm_flowLayer',
        'x_helloGAW',
    ]

    it('keeps the repository root free of demo html entrypoints', () => {
        expect(exists('index.html')).to.equal(false)
    })

    it('provides an examples browser under examples/', () => {
        const html = read('examples', 'index.html')

        expect(html).to.include('GeoScratch Examples')
        expect(html).to.include('type="search"')
        expect(html).to.include('examples-nav')
        for (const name of examples) {
            expect(html).to.include(`./${name}/`)
        }
    })

    it('gives each runnable example its own standalone html shell', () => {
        for (const name of examples) {
            const html = read('examples', name, 'index.html')

            expect(html).to.include('id="GPUFrame"')
            expect(html).to.include('src="./main.js"')
            expect(html).to.include('../shared/example.css')
        }
    })

    it('loads MapLibre only for the map-backed terrain examples', () => {
        const demHtml = read('examples', 'm_demLayer', 'index.html')
        const flowHtml = read('examples', 'm_flowLayer', 'index.html')

        expect(demHtml).to.include('maplibre-gl@4.7.1/dist/maplibre-gl.js')
        expect(demHtml).to.include('maplibre-gl@4.7.1/dist/maplibre-gl.css')
        expect(flowHtml).to.include('maplibre-gl@4.7.1/dist/maplibre-gl.js')
        expect(flowHtml).to.include('maplibre-gl@4.7.1/dist/maplibre-gl.css')
    })

    it('keeps the DEM layer example focused on terrain only', () => {
        const source = read('examples', 'm_demLayer', 'main.js')
        const mapRuntime = read('examples', 'shared', 'scratchMap.js')

        expect(source).to.include('TerrainLayer')
        expect(source).to.include('new TerrainLayer(14)')
        expect(source).to.include('startScratchMap')
        expect(mapRuntime).to.include('globalThis.maplibregl')
        expect(mapRuntime).to.include('darkMatterStyle')
        expect(mapRuntime).to.include('getCameraPosition()')
        expect(mapRuntime).to.include('underwaterTerrainMinElevation')
        expect(mapRuntime).to.include('getScratchMercatorMatrix(this.transform)')
        expect(mapRuntime).to.include('calculateFarZForTerrainPlane')
        expect(source).to.not.include('VITE_MAPBOX_ACCESS_TOKEN')
        expect(source).to.not.include('accessToken')
        expect(mapRuntime).to.not.include('_computeCameraPosition')
        expect(mapRuntime).to.not.include('_updateCameraState')
        expect(mapRuntime).to.not.include('this.transform._camera')
        expect(source).to.not.include('SteadyFlowLayer')
        expect(source).to.not.include('flowJson.worker')
    })

    it('provides a separate flow layer example on the same map runtime', () => {
        const source = read('examples', 'm_flowLayer', 'main.js')
        const mapRuntime = read('examples', 'shared', 'scratchMap.js')

        expect(source).to.include('SteadyFlowLayer')
        expect(source).to.include('new SteadyFlowLayer()')
        expect(source).to.include('startScratchMap')
        expect(mapRuntime).to.include('globalThis.maplibregl')
        expect(mapRuntime).to.include('getScratchMercatorMatrix(this.transform)')
        expect(source).to.not.include('VITE_MAPBOX_ACCESS_TOKEN')
        expect(source).to.not.include('accessToken')
        expect(mapRuntime).to.not.include('_computeCameraPosition')
        expect(mapRuntime).to.not.include('_updateCameraState')
        expect(mapRuntime).to.not.include('this.transform._camera')
        expect(source).to.not.include('TerrainLayer')
    })

    it('keeps filtered examples hidden in the examples browser', () => {
        const css = read('examples', 'shared', 'index.css')

        expect(css).to.include('.example-link[hidden]')
        expect(css).to.include('display: none')
    })
})
