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
        'submissionOrder',
        'externalImageUpload',
        'textureResize',
        'scratch_helloVertexBuffer',
        'scratch_textureSampling',
        'scratch_renderToTexture',
        'indirectExecution',
        'readinessPolicies',
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
        'submissionOrder',
        'externalImageUpload',
        'textureResize',
        'scratch_helloVertexBuffer',
        'scratch_textureSampling',
        'scratch_renderToTexture',
        'indirectExecution',
        'readinessPolicies',
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
        expect(html).to.include('src="about:blank"')
        expect(html).to.include('selectExample(currentLinkFromUrl(), false)')
    })

    it('uses stable demo names for Scratch-backed browser entries', () => {
        const html = read('examples', 'index.html')
        const scratchBackedExamples = [
            [ 'scratch_helloTriangle', 'Hello Triangle' ],
            [ 'scratch_uniformTriangle', 'Uniform Triangle' ],
            [ 'scratch_computeReadback', 'Compute Readback' ],
            [ 'submissionOrder', 'Submission Order' ],
            [ 'externalImageUpload', 'External Image Upload' ],
            [ 'textureResize', 'Texture Resize' ],
            [ 'scratch_helloVertexBuffer', 'Hello Vertex Buffer' ],
            [ 'scratch_textureSampling', 'Texture Sampling' ],
            [ 'scratch_renderToTexture', 'Render To Texture' ],
            [ 'indirectExecution', 'Indirect Execution' ],
            [ 'readinessPolicies', 'Readiness Policies' ],
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

    it('keeps async example startup compatible with the configured build target', () => {

        for (const name of standaloneExamples) {
            const source = read('examples', name, 'main.js')

            expect(source, name).to.not.match(/^\s*await\s+main\(\)/m)
            expect(source, name).to.not.include('await await')
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

    it('publishes first-frame completion for continuous Scratch examples', () => {

        for (const name of [ 'scratch_textureSampling', 'scratch_renderToTexture' ]) {
            const source = read('examples', name, 'main.js')

            expect(source, name).to.include("canvas.dataset.status = 'loading'")
            expect(source, name).to.include("canvas.dataset.status = 'ready'")
            expect(source, name).to.include("canvas.dataset.status = 'error'")
            expect(source, name).to.include('submitted.done.then')
        }
    })

    it('demonstrates readiness policy execution without GPU readback', () => {
        const source = read('examples', 'readinessPolicies', 'main.js')

        expect(source).to.include("from 'geoscratch'")
        expect(source).to.include("whenMissing: 'use-fallback'")
        expect(source).to.include("whenMissing: 'skip-command'")
        expect(source).to.include("whenMissing: 'skip-pass'")
        expect(source).to.include('executionOutcomes')
        expect(source).to.include("dataset.status = 'ready'")
        expect(source).to.not.match(/readback|mapAsync|getMappedRange|toBytes|toArray/i)
    })

    it('provides a deterministic ordered submission proof', () => {
        const html = read('examples', 'submissionOrder', 'index.html')
        const source = read('examples', 'submissionOrder', 'main.js')

        expect(html).to.include('<title>Submission Order | GeoScratch Examples</title>')
        expect(html).to.include('id="GPUFrame"')
        expect(source).to.include("from 'geoscratch'")
        expect(source).to.include('.upload(uploadZero)')
        expect(source).to.include('.compute(pass, [ incrementZero ])')
        expect(source).to.include('.upload(uploadTen)')
        expect(source).to.include('.compute(pass, [ incrementTen ])')
        expect(source).to.include('.readback(readback)')
        expect(source).to.include('result === 11')
        expect(source).to.include("dataset.status = passed ? 'passed' : 'failed'")
        expect(source).to.include('dataset.result = String(result)')
    })

    it('provides a deterministic native external image upload proof', () => {

        const html = read('examples', 'externalImageUpload', 'index.html')
        const source = read('examples', 'externalImageUpload', 'main.js')

        expect(html).to.include('<title>External Image Upload | GeoScratch Examples</title>')
        expect(html).to.include('<h1>External Image Upload</h1>')
        expect(html).to.include('data-status="pending"')
        expect(source).to.include("from 'geoscratch'")
        expect(source).to.include("document.createElement('canvas')")
        expect(source).to.include('createExternalImageUploadCommand')
        expect(source).to.include('sourceOrigin: { x: 1, y: 1 }')
        expect(source).to.include('flipY: true')
        expect(source).to.include("format: 'rgba8unorm'")
        expect(source).to.include('GPUTextureUsage.RENDER_ATTACHMENT')
        expect(source).to.include('GPUTextureUsage.COPY_DST')
        expect(source).to.include('GPUTextureUsage.COPY_SRC')
        expect(source).to.include('GPUTextureUsage.TEXTURE_BINDING')
        expect(source).to.include('createCopyCommand')
        expect(source).to.include('bytesPerRow: 256')
        expect(source).to.include('createReadbackCommand')
        expect(source).to.include('.upload(externalUpload)')
        expect(source).to.include('.copy(copyToReadback)')
        expect(source).to.include('.readback(readback)')
        expect(source).to.include('.render(surfacePass, [ draw ])')
        expect(source).to.include('expectedRows')
        expect(source).to.include("dataset.status = passed ? 'passed' : 'failed'")
        expect(source.indexOf('createExternalImageUploadCommand')).to.be.lessThan(source.indexOf('drawFinalSourcePattern'))
        expect(source).to.not.match(/getImageData|createTextureUploadCommand|writeTexture/)
        expect(source).to.not.match(/https?:\/\//)
    })

    it('provides a deterministic texture allocation replacement proof', () => {

        const html = read('examples', 'textureResize', 'index.html')
        const source = read('examples', 'textureResize', 'main.js')

        expect(html).to.include('<title>Texture Resize | GeoScratch Examples</title>')
        expect(html).to.include('<h1>Texture Resize</h1>')
        expect(html).to.include('data-status="pending"')
        expect(source).to.include("from 'geoscratch'")
        expect(source).to.include('surface.resize(resizedSurfaceSize)')
        expect(source).to.include('texture.resize(surface.size)')
        expect(source).to.include('createCopyCommand')
        expect(source).to.include('bytesPerRow: paddedBytesPerRow')
        expect(source).to.include('createReadbackCommand')
        expect(source).to.include('.render(texturePass, [])')
        expect(source).to.include('.copy(copyToReadback)')
        expect(source).to.include('.readback(readback)')
        expect(source).to.include('.render(surfacePass, [ draw ])')
        expect(source).to.include('sameBindSetObject')
        expect(source).to.include('samePassSpecObject')
        expect(source).to.include('sameDrawCommandObject')
        expect(source).to.include('oldTextureDestroyed')
        expect(source).to.include('exactReadbackBytesMatched')
        expect(source).to.include('runtime.diagnostics.exportEvidence()')
        expect(source).to.include('allocationDiagnosticsSucceeded')
        expect(source).to.include('diagnosticEvidenceSerializable')
        expect(source).to.include('diagnosticEvidenceCompact')
        expect(source).to.include('initialTextureSettlementMs')
        expect(source).to.include('replacementSettlementMs')
        expect(source).to.not.include('await await')
        expect(source).to.include('replacementTextureAccesses.length > 0')
        expect(source).to.include("dataset.status = failedChecks.length === 0 ? 'passed' : 'failed'")
        expect(source).to.not.match(/ResizeObserver|sizeProvider|getImageData|writeTexture/)
        expect(source).to.not.match(/https?:\/\//)
    })
})
