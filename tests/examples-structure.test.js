import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

describe('examples structure', () => {
    const browserExamples = [
        'scratch_helloTriangle',
        'scratch_uniformTriangle',
        'scratch_computeReadback',
        'scratch_helloVertexBuffer',
        'scratch_textureSampling',
        'scratch_renderToTexture',
        'indirectExecution',
        'm_demLayer',
        'm_flowLayer',
        'x_helloGAW',
    ]
    const standaloneExamples = [
        '1_helloTriangle',
        '2_helloVertexBuffer',
        'scratch_helloTriangle',
        'scratch_uniformTriangle',
        'scratch_computeReadback',
        'scratch_helloVertexBuffer',
        'scratch_textureSampling',
        'scratch_renderToTexture',
        'indirectExecution',
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
        for (const name of browserExamples) {
            expect(html).to.include(`./${name}/`)
        }
    })

    it('does not expose replaced legacy demos in the examples browser', () => {
        const html = read('examples', 'index.html')

        expect(html).to.not.include('href="?sample=1_helloTriangle"')
        expect(html).to.not.include('data-id="1_helloTriangle"')
        expect(html).to.not.include('data-path="./1_helloTriangle/"')
        expect(html).to.not.include('href="?sample=2_helloVertexBuffer"')
        expect(html).to.not.include('data-id="2_helloVertexBuffer"')
        expect(html).to.not.include('data-path="./2_helloVertexBuffer/"')
        expect(html).to.not.include('Hello Vertex Buffer (legacy)')

        const removedMapId = [ 'm', 'helloMap' ].join('_')
        const removedMapTitle = [ 'Hello', 'Map' ].join(' ')
        expect(html).to.not.include(`href="?sample=${removedMapId}"`)
        expect(html).to.not.include(`data-id="${removedMapId}"`)
        expect(html).to.not.include(`data-path="./${removedMapId}/"`)
        expect(html).to.not.include(removedMapTitle)
    })

    it('defaults the examples browser to the replacement Hello Triangle entry', () => {
        const html = read('examples', 'index.html')

        expect(html).to.include('class="example-link is-active" href="?sample=scratch_helloTriangle"')
        expect(html).to.include('<h1 id="stage-title">Hello Triangle</h1>')
        expect(html).to.include('href="./scratch_helloTriangle/main.js"')
        expect(html).to.include('href="./scratch_helloTriangle/"')
        expect(html).to.include('src="./scratch_helloTriangle/"')
    })

    it('uses stable demo names for Scratch-backed browser entries', () => {
        const html = read('examples', 'index.html')
        const scratchBackedExamples = [
            [ 'scratch_helloTriangle', 'Hello Triangle' ],
            [ 'scratch_uniformTriangle', 'Uniform Triangle' ],
            [ 'scratch_computeReadback', 'Compute Readback' ],
            [ 'scratch_helloVertexBuffer', 'Hello Vertex Buffer' ],
            [ 'scratch_textureSampling', 'Texture Sampling' ],
            [ 'scratch_renderToTexture', 'Render To Texture' ],
            [ 'indirectExecution', 'Indirect Execution' ],
        ]

        for (const [ name, title ] of scratchBackedExamples) {
            const linkStart = html.indexOf(`data-id="${name}"`)
            const linkEnd = html.indexOf('</a>', linkStart)
            const linkHtml = html.slice(linkStart, linkEnd)

            expect(linkStart, `${name} link`).to.be.greaterThan(-1)
            expect(linkHtml, `${name} title`).to.include(`data-title="${title}"`)
            expect(linkHtml, `${name} visible title`).to.include(`<span class="example-title">${title}</span>`)
            expect(linkHtml, `${name} scratch flag`).to.not.include('Scratch ')
        }
    })

    it('marks only not-yet-replaced old API examples as legacy in the browser', () => {
        const html = read('examples', 'index.html')
        const legacyExamples = [
            'm_demLayer',
            'm_flowLayer',
            'x_helloGAW',
        ]

        for (const name of legacyExamples) {
            const linkStart = html.indexOf(`data-id="${name}"`)
            const linkEnd = html.indexOf('</a>', linkStart)
            const linkHtml = html.slice(linkStart, linkEnd)

            expect(linkStart, `${name} link`).to.be.greaterThan(-1)
            expect(linkHtml, `${name} legacy label`).to.include('(legacy)')
            expect(linkHtml, `${name} legacy wording`).to.not.include('Legacy API')
        }
    })

    it('gives each runnable example its own standalone html shell', () => {
        for (const name of standaloneExamples) {
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

    it('builds each runnable example as a Vite input page', () => {
        const config = read('examples', 'vite.config.js')

        for (const name of standaloneExamples) {
            expect(config).to.include(`${name}/index.html`)
        }
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

    it('keeps indirect execution GPU-side without readback or mapping', () => {
        const source = read('examples', 'indirectExecution', 'main.js')

        expect(source).to.include('count: { indirect: dispatchArguments')
        expect(source).to.include('count: { indirect: drawArguments')
        expect(source).to.include('count: { indirect: indexedArguments')
        expect(source).to.not.match(/readback|mapAsync|getMappedRange|toBytes|toArray/i)
    })
})
