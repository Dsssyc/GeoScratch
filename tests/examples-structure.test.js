import { expect } from 'chai'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

describe('examples structure', () => {
    const browserExamples = [
        'helloTriangle',
        'uniformTriangle',
        'computeReadback',
        'submissionOrder',
        'externalImageUpload',
        'textureResize',
        'helloVertexBuffer',
        'textureSampling',
        'renderToTexture',
        'renderPassFeatures',
        'immediateData',
        'indirectExecution',
        'readinessPolicies',
        'demLayer',
        'flowLayer',
        'helloGAW',
    ]
    const standaloneExamples = [
        'helloTriangle',
        'uniformTriangle',
        'computeReadback',
        'submissionOrder',
        'externalImageUpload',
        'textureResize',
        'helloVertexBuffer',
        'textureSampling',
        'renderToTexture',
        'renderPassFeatures',
        'immediateData',
        'indirectExecution',
        'readinessPolicies',
        'demLayer',
        'flowLayer',
        'helloGAW',
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

    it('removes replaced legacy demos and scratch-prefixed duplicate directories', () => {
        const html = read('examples', 'index.html')

        expect(html).to.not.include('href="?sample=1_helloTriangle"')
        expect(html).to.not.include('data-id="1_helloTriangle"')
        expect(html).to.not.include('data-path="./1_helloTriangle/"')
        expect(html).to.not.include('href="?sample=2_helloVertexBuffer"')
        expect(html).to.not.include('data-id="2_helloVertexBuffer"')
        expect(html).to.not.include('data-path="./2_helloVertexBuffer/"')
        expect(html).to.not.include('Hello Vertex Buffer (legacy)')

        for (const name of [
            '1_helloTriangle',
            '2_helloVertexBuffer',
            'scratch_helloTriangle',
            'scratch_uniformTriangle',
            'scratch_computeReadback',
            'scratch_helloVertexBuffer',
            'scratch_textureSampling',
            'scratch_renderToTexture',
        ]) {
            expect(exists('examples', name), name).to.equal(false)
        }

        const removedMapId = [ 'm', 'helloMap' ].join('_')
        const removedMapTitle = [ 'Hello', 'Map' ].join(' ')
        expect(html).to.not.include(`href="?sample=${removedMapId}"`)
        expect(html).to.not.include(`data-id="${removedMapId}"`)
        expect(html).to.not.include(`data-path="./${removedMapId}/"`)
        expect(html).to.not.include(removedMapTitle)
    })

    it('defaults the examples browser to the replacement Hello Triangle entry', () => {
        const html = read('examples', 'index.html')

        expect(html).to.include('class="example-link is-active" href="?sample=helloTriangle"')
        expect(html).to.include('<h1 id="stage-title">Hello Triangle</h1>')
        expect(html).to.include('href="./helloTriangle/main.ts"')
        expect(html).to.include('href="./helloTriangle/"')
        expect(html).to.include('src="about:blank"')
        expect(html).to.include('selectExample(currentLinkFromUrl(), false)')
    })

    it('uses stable demo names for Scratch-backed browser entries', () => {
        const html = read('examples', 'index.html')
        const scratchBackedExamples = [
            [ 'helloTriangle', 'Hello Triangle' ],
            [ 'uniformTriangle', 'Uniform Triangle' ],
            [ 'computeReadback', 'Compute Readback' ],
            [ 'submissionOrder', 'Submission Order' ],
            [ 'externalImageUpload', 'External Image Upload' ],
            [ 'textureResize', 'Texture Resize' ],
            [ 'helloVertexBuffer', 'Hello Vertex Buffer' ],
            [ 'textureSampling', 'Texture Sampling' ],
            [ 'renderToTexture', 'Render To Texture' ],
            [ 'renderPassFeatures', 'Render Pass Features' ],
            [ 'immediateData', 'Immediate Data' ],
            [ 'indirectExecution', 'Indirect Execution' ],
            [ 'readinessPolicies', 'Readiness Policies' ],
            [ 'demLayer', 'DEM Layer' ],
            [ 'helloGAW', 'Hello GAW' ],
            [ 'flowLayer', 'Flow Layer' ],
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

    it('contains no legacy example labels after the clean cuts', () => {
        const html = read('examples', 'index.html')

        expect(html).to.not.include('(legacy)')
        expect(html).to.not.include('data-tags="legacy')
        expect(html).to.not.include('m_demLayer')
    })

    it('gives each runnable example its own standalone html shell', () => {
        for (const name of standaloneExamples) {
            const html = read('examples', name, 'index.html')

            expect(html).to.include('id="GPUFrame"')
            expect(html).to.include('src="./main.ts"')
            expect(html).to.include('../shared/example.css')
        }
    })

    it('keeps async example startup compatible with the configured build target', () => {

        for (const name of standaloneExamples) {
            const source = read('examples', name, 'main.ts')

            expect(source, name).to.not.match(/^\s*await\s+main\(\)/m)
            expect(source, name).to.not.include('await await')
        }
    })

    it('loads MapLibre only for the map-backed terrain examples', () => {
        const demHtml = read('examples', 'demLayer', 'index.html')
        const flowHtml = read('examples', 'flowLayer', 'index.html')

        expect(demHtml).to.include('maplibre-gl@4.7.1/dist/maplibre-gl.js')
        expect(demHtml).to.include('maplibre-gl@4.7.1/dist/maplibre-gl.css')
        expect(flowHtml).to.include('maplibre-gl@4.7.1/dist/maplibre-gl.js')
        expect(flowHtml).to.include('maplibre-gl@4.7.1/dist/maplibre-gl.css')
    })

    it('builds each runnable example as a Vite input page', () => {
        const config = read('examples', 'vite.config.ts')

        for (const name of standaloneExamples) {
            expect(config).to.include(`${name}/index.html`)
        }

        expect(config).to.not.match(/scratch[A-Z]\w*\s*:/)
    })

    it('keeps the DEM layer example focused on terrain only', () => {
        const source = read('examples', 'demLayer', 'main.ts')
        const layer = read('examples', 'demLayer', 'dem-layer.ts')
        const mapRuntime = read('examples', 'demLayer', 'dem-map.ts')

        expect(source).to.include('ScratchRuntime')
        expect(source).to.include('createDemLayer')
        expect(source).to.include('createDemMap')
        expect(layer).to.include('runtime.createSubmission(')
        expect(layer).to.include("contentEpoch: 'current-at-step'")
        expect(layer).to.include('count: { indirect: buffers.lodArguments.region }')
        expect(layer).to.include('count: { indirect: buffers.terrainArguments.region }')
        expect(mapRuntime).to.include('globalThis.maplibregl')
        expect(mapRuntime).to.include('darkMatterStyle')
        expect(mapRuntime).to.include('getCameraPosition()')
        expect(mapRuntime).to.include('underwaterTerrainMinElevation')
        expect(mapRuntime).to.include('getScratchMercatorMatrix(transform)')
        expect(mapRuntime).to.include('calculateFarZForTerrainPlane')
        expect(source).to.not.include('VITE_MAPBOX_ACCESS_TOKEN')
        expect(source).to.not.include('accessToken')
        expect(mapRuntime).to.not.include('_computeCameraPosition')
        expect(mapRuntime).to.not.include('_updateCameraState')
        expect(mapRuntime).to.not.include('this.transform._camera')
        expect(source).to.not.include('../shared/scratchMap.js')
        expect(source).to.not.include('startScratchMap')
        expect(source).to.not.include('LocalTerrain')
        expect(`${source}\n${layer}`).to.not.match(/runtime\.(?:device|queue)\b/)
        expect(`${source}\n${layer}`).to.not.match(/mapAsync|getMappedRange|readback/i)
    })

    it('provides a separate current-API flow layer with its own map host', () => {
        const source = read('examples', 'flowLayer', 'main.ts')
        const layer = read('examples', 'flowLayer', 'flow-layer.ts')
        const mapRuntime = read('examples', 'flowLayer', 'flow-map.ts')

        expect(source).to.include('ScratchRuntime')
        expect(source).to.include('createFlowLayer')
        expect(source).to.include('createFlowMap')
        expect(layer).to.include('runtime.createSubmission(')
        expect(mapRuntime).to.include('globalThis.maplibregl')
        expect(mapRuntime).to.include('getScratchMercatorMatrix(transform)')
        expect(source).to.not.include('VITE_MAPBOX_ACCESS_TOKEN')
        expect(source).to.not.include('accessToken')
        expect(mapRuntime).to.not.include('_computeCameraPosition')
        expect(mapRuntime).to.not.include('_updateCameraState')
        expect(source).to.not.include('../shared/scratchMap.js')
        expect(source).to.not.include('startScratchMap')
        expect(source).to.not.include('TerrainLayer')
    })

    it('keeps filtered examples hidden in the examples browser', () => {
        const css = read('examples', 'shared', 'index.css')

        expect(css).to.include('.example-link[hidden]')
        expect(css).to.include('display: none')
    })

    it('hides the examples scrollbar without disabling navigation scrolling', () => {
        const css = read('examples', 'shared', 'index.css')
        const sidebarRule = css.match(/\.examples-sidebar\s*\{([^}]*)\}/)?.[1] ?? ''
        const navigationRule = css.match(/\.examples-nav\s*\{([^}]*)\}/)?.[1] ?? ''
        const webkitScrollbarRule = css.match(/\.examples-nav::-webkit-scrollbar\s*\{([^}]*)\}/)?.[1] ?? ''

        expect(sidebarRule).to.match(/min-height:\s*0/)
        expect(navigationRule).to.match(/min-height:\s*0/)
        expect(navigationRule).to.match(/overflow:\s*auto/)
        expect(navigationRule).to.match(/scrollbar-width:\s*none/)
        expect(navigationRule).to.match(/-ms-overflow-style:\s*none/)
        expect(webkitScrollbarRule).to.match(/display:\s*none/)
    })

    it('distinguishes normal and interactive example item surfaces', () => {
        const css = read('examples', 'shared', 'index.css')
        const linkRule = css.match(/\.example-link\s*\{([^}]*)\}/)?.[1] ?? ''
        const interactiveRule = css.match(/\.example-link:hover,\s*\.example-link:focus,\s*\.example-link\.is-active\s*\{([^}]*)\}/)?.[1] ?? ''

        expect(linkRule).to.match(/background:\s*#1a2028/)
        expect(interactiveRule).to.match(/background:\s*#202833/)
    })

    it('keeps indirect execution GPU-side without readback or mapping', () => {
        const source = read('examples', 'indirectExecution', 'main.ts')

        expect(source).to.include('count: { indirect: dispatchArguments')
        expect(source).to.include('count: { indirect: drawArguments')
        expect(source).to.include('count: { indirect: indexedArguments')
        expect(source).to.not.match(/readback|mapAsync|getMappedRange|toBytes|toArray/i)
    })

    it('publishes first-frame completion for continuous Scratch examples', () => {

        for (const name of [ 'textureSampling', 'renderToTexture' ]) {
            const source = read('examples', name, 'main.ts')

            expect(source, name).to.include("canvas.dataset.status = 'loading'")
            expect(source, name).to.include("canvas.dataset.status = 'ready'")
            expect(source, name).to.include("canvas.dataset.status = 'error'")
            expect(source, name).to.include('requireObservedSubmission(submitted).then')
            expect(source, name).to.include('submitted.nativeOutcome')
            expect(source, name).to.include('submitted.done')
            expect(source, name).to.include('observed-succeeded')
        }
    })

    it('demonstrates readiness policy execution without GPU readback', () => {
        const source = read('examples', 'readinessPolicies', 'main.ts')

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
        const source = read('examples', 'submissionOrder', 'main.ts')

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
        const source = read('examples', 'externalImageUpload', 'main.ts')

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
        const source = read('examples', 'textureResize', 'main.ts')

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
        expect(source).to.include('sameTextureViewSpecObject')
        expect(source).to.include('sameBindSetObject')
        expect(source).to.include('samePassSpecObject')
        expect(source).to.include('sameDrawCommandObject')
        expect(source).to.include('oldTextureDestroyed')
        expect(source).to.include("bindSetStateAfterResize === 'stale'")
        expect(source).to.include('await bindSet.prepare()')
        expect(source).to.include('explicitPreparationAdvancedOnce')
        expect(source).to.include('preparedSnapshotChanged')
        expect(source).to.include("bindSetStateAfterPrepare === 'prepared'")
        expect(source).to.include('bindSetPreparationDiagnosticsSucceeded')
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

    it('proves native render-pass features through the public package', () => {

        const html = read('examples', 'renderPassFeatures', 'index.html')
        const source = read('examples', 'renderPassFeatures', 'main.ts')

        expect(html).to.include('<title>Render Pass Features | GeoScratch Examples</title>')
        expect(html).to.include('id="GPUFrame"')
        expect(source).to.include("from 'geoscratch'")
        expect(source).to.include('sampleCount')
        expect(source).to.include('targets: [')
        expect(source).to.include('color: [')
        expect(source).to.include('resolveTarget: surface')
        expect(source).to.include("store: 'discard'")
        expect(source).to.include('maxDrawCount: 3')
        expect(source).to.include('fragmentConstants: { colorMode }')
        expect(source).to.include('renderState: {')
        expect(source).to.include('viewport: panels.left')
        expect(source).to.include('scissor: panels.left')
        expect(source).to.include('viewport: panels.right')
        expect(source).to.include('scissor: panels.right')
        expect(source).to.include('.render(pass, [ fullDraw ])')
        expect(source).to.include('.render(pass, [ fullDraw, leftDraw, rightDraw ])')
        expect(source).to.include('await multisampledColor.resize(size)')
        expect(source).to.include("canvas.dataset.fullAttachmentResized = String(")
        expect(source).to.not.match(/runtime\.(?:device|queue)\b/)
        expect(source).to.not.match(/packages\/geoscratch|src\/scratch|\.\.\/\.\.\//)
    })

    it('proves per-command immediate data through the public package', () => {

        const html = read('examples', 'immediateData', 'index.html')
        const source = read('examples', 'immediateData', 'main.ts')

        expect(html).to.include('<title>Immediate Data | GeoScratch Examples</title>')
        expect(html).to.include('id="GPUFrame"')
        expect(source).to.include("from 'geoscratch'")
        expect(source).to.include('requires immediate_address_space;')
        expect(source).to.include('var<immediate>')
        expect(source).to.include("usage: [ 'immediate' ]")
        expect(source).to.include('computeCodec.uploadView')
        expect(source).to.include('renderCodec.uploadView')
        expect(source).to.include('immediateSize: computeCodec.artifact.byteLength')
        expect(source).to.include('immediateSize: renderCodec.artifact.byteLength')
        expect(source).to.include('immediateData: computeImmediate')
        expect(source).to.include('immediateData: leftImmediate')
        expect(source).to.include('immediateData: rightImmediate')
        expect(source).to.include('.compute(computePass, [ dispatch ])')
        expect(source).to.include('.render(renderPass, [ leftDraw, rightDraw ])')
        expect(source).to.include("contentEpoch: 'current-at-step'")
        expect(source).to.include('canvas.dataset.computeImmediate')
        expect(source).to.include('canvas.dataset.renderImmediate')
        expect(source).to.include('canvas.dataset.stableCommandIdentity')
        expect(source).to.include('canvas.dataset.submissionCount')
        expect(source).to.include('canvas.dataset.resizeGeneration')
        expect(source).to.include('canvas.dataset.observedSubmissions')
        expect(source).to.include("canvas.dataset.status = 'ready'")
        expect(source).to.not.match(/runtime\.(?:device|queue)\b/)
        expect(source).to.not.match(/packages\/geoscratch|src\/scratch|\.\.\/\.\.\//)
    })
})
