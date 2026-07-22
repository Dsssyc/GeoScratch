import { expect } from 'chai'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

const shaderHashes = Object.freeze({
    'arrow.wgsl': 'ffce4cf43b21f44ed6ff65c21b6d3694a0b98faf33d9ebe961649a26cd988547',
    'flowLayer.wgsl': '225a94b8fe79c052264a1fcb81f96a7d4ebf36d384bf695645984f551c32382a',
    'flowShow.wgsl': '9e515dcef0e7cff01e5a9f1828e3dff7561991abc3b54596f33c017b3544733a',
    'flowVoronoi.wgsl': 'f8fae35c1a5fa35fdbddd8b5cc24f40a53d54877943efa63c7bd8f6e99e7826e',
    'particles.wgsl': '315d1f806fe4326b28b524a78b4520a43ba5358a5210ff0aed6ad2291c85b715',
    'simulation.compute.wgsl': 'aedf78a69868f2a3df565ee6f6f39851c975570bfb87449bedc9af5dd0a84748',
    'swap.wgsl': 'a9f08a0a027e059076f11b3f68969241d74d34e56ac464b608bb931aa5220897',
})

describe('Flow Layer Scratch clean cut', () => {

    it('replaces the legacy route with one neutral Flow Layer example', () => {

        expect(exists('examples', 'flowLayer')).to.equal(true)
        expect(exists('examples', 'm_flowLayer')).to.equal(false)

        const catalog = read('examples', 'index.html')
        const vite = read('examples', 'vite.config.js')
        const neutralLinkStart = catalog.indexOf('data-id="flowLayer"')
        const neutralLink = catalog.slice(neutralLinkStart, neutralLinkStart + 420)

        expect(neutralLinkStart).to.be.greaterThan(-1)
        expect(neutralLink).to.include('data-path="./flowLayer/"')
        expect(neutralLink).to.include('data-title="Flow Layer"')
        expect(neutralLink).to.include('<span class="example-title">Flow Layer</span>')
        expect(neutralLink).to.not.match(/legacy|scratch/i)
        expect(catalog).to.not.include('m_flowLayer')
        expect(vite).to.include("flowLayer: path.resolve(examplesRoot, 'flowLayer/index.html')")
        expect(vite).to.not.include('m_flowLayer')

        for (const file of [
            [ 'README.md' ],
            [ 'README_zh.md' ],
            [ 'packages', 'geoscratch', 'README.md' ],
            [ 'packages', 'geoscratch', 'README_zh.md' ],
        ]) {
            const documentation = read(...file)
            expect(documentation, file.join('/')).to.include('| Flow Layer | `examples/flowLayer/` |')
            expect(documentation, file.join('/')).to.not.include('examples/m_flowLayer/')
        }
    })

    it('coexists with the neutral DEM replacement and no legacy catalog entry', () => {

        const catalog = read('examples', 'index.html')
        const demStart = catalog.indexOf('data-id="demLayer"')
        const demLink = catalog.slice(demStart, demStart + 420)

        expect(demStart).to.be.greaterThan(-1)
        expect(demLink).to.include('data-path="./demLayer/"')
        expect(demLink).to.not.match(/legacy|scratch/i)
        expect(catalog).to.not.include('(legacy)')
    })

    it('preserves the legacy normal presentation and display-paced frame loop', () => {

        const main = read('examples', 'flowLayer', 'main.js')
        const layer = read('examples', 'flowLayer', 'flow-layer.js')

        expect(main).to.include("showVoronoi: parameters.get('field') === '1'")
        expect(layer).to.include('showVoronoi: options.showVoronoi ?? false')
        expect(main).to.match(/function scheduleFrame\(\)[\s\S]*?animationFrame = requestAnimationFrame\(render\)/)
        expect(main).to.not.include('animationTimer')
        expect(main).to.not.include('1000 / 45')
        expect(main).to.include('canvas.dataset.fieldVisualization = String(graph.settings.showVoronoi)')
        expect(main).to.include("canvas.dataset.frameScheduler = 'requestAnimationFrame'")
    })

    it('uses only the public current Scratch GPU execution model', () => {

        const main = read('examples', 'flowLayer', 'main.js')
        const layer = read('examples', 'flowLayer', 'flow-layer.js')
        const map = read('examples', 'flowLayer', 'flow-map.js')
        const source = `${main}\n${layer}\n${map}`

        for (const required of [
            'ScratchRuntime',
            'layoutCodec',
            'runtime.createSurface(',
            'runtime.createBuffer(',
            'runtime.createTexture(',
            'runtime.createBindLayout(',
            'runtime.createBindSet(',
            'runtime.createProgram(',
            'runtime.createRenderPipeline(',
            'runtime.createComputePipeline(',
            'runtime.createDrawCommand(',
            'runtime.createDispatchCommand(',
            'runtime.createRenderPass(',
            'runtime.createComputePass(',
            'runtime.createSubmission(',
            'submitted.nativeOutcome',
            'submitted.done',
        ]) {
            expect(source, required).to.include(required)
        }

        expect(source).to.not.match(/\b(?:StartDash|director|screen|storageBuffer|uniformBuffer|vertexBuffer|renderPass|computePass|renderPipeline|computePipeline|aRef|bRef|asF32|asU32|asVec2u)\b/)
        expect(source).to.not.match(/\.executable\b|runtime\.device\b|runtime\.queue\b|mapAsync\b|getMappedRange\b|readback\b/i)
        expect(source).to.not.include('../shared/scratchMap.js')
        expect(main).to.include("parameters.get('boundary') === '1'")
        expect(main).to.include('createFlowMap(canvas, { proof: proofMode, ...boundaryMapOptions })')
        expect(main).to.include('project: lngLat => map.project(lngLat)')
        expect(map).to.include('style: proof ? flowProofStyle : darkMatterStyle')
    })

    it('keeps the long-lived Flow graph explicit and frame-local only at submission', () => {

        const source = read('examples', 'flowLayer', 'flow-layer.js')

        expect(source).to.include('const PARTICLE_COUNT = 262_144')
        expect(source).to.include('const PARTICLE_BLOCK_SIZE = 16')
        expect(source).to.include('const FRAMES_PER_FIELD = 300')
        expect(source).to.include('const FIELD_COUNT = 27')
        expect(source).to.include("const STAGE_ORDER = Object.freeze([")
        expect(source).to.include("'voronoi-field'")
        expect(source).to.include("'particle-simulation'")
        expect(source).to.include("'history-particles'")
        expect(source).to.include("'flow-visualization'")
        expect(source).to.include("'history-presentation'")
        expect(source).to.include("contentEpoch: 'current-at-step'")
        expect(source).to.include('historyDirections')
        expect(source).to.include("label: 'Flow history B to A'")
        expect(source).to.include("label: 'Flow history A to B'")
        expect(source).to.include('if (bindSet.preparationState === \'stale\') await bindSet.prepare()')

        const renderBodyStart = source.indexOf('async function renderFrame(')
        const renderBody = source.slice(renderBodyStart, source.indexOf('\n}', renderBodyStart) + 2)
        expect(renderBodyStart).to.be.greaterThan(-1)
        expect(renderBody).to.include('runtime.createSubmission(')
        expect(renderBody).to.not.match(/create(?:Buffer|Texture|BindLayout|BindSet|Program|RenderPipeline|ComputePipeline|DrawCommand|DispatchCommand|RenderPass|ComputePass)\(/)
    })

    it('defines bounded diagnostics and exactly two deterministic failure scenarios', () => {

        const source = read('examples', 'flowLayer', 'main.js')

        expect(source).to.include("'after-worker-acquisition'")
        expect(source).to.include("'invalid-simulation-pipeline-wgsl'")
        expect(source.match(/'after-worker-acquisition'/g)).to.have.length(1)
        expect(source.match(/'invalid-simulation-pipeline-wgsl'/g)).to.have.length(1)
        expect(source).to.include('maxOperations: 1')
        expect(source).to.include('maxDurationMs: 2_000')
        expect(source).to.include('maxEvidenceBytes: 64 * 1024')
        expect(source).to.include('runtime.diagnostics.capture(FAILURE_CAPTURE_BOUNDS)')
        expect(source).to.not.match(/OOM causality|physical VRAM|device-loss recovery/i)
    })

    it('covers asynchronous initialization with the Flow lifecycle authority', () => {

        const main = read('examples', 'flowLayer', 'main.js')
        const layer = read('examples', 'flowLayer', 'flow-layer.js')
        const pagehideRegistration = main.indexOf("window.addEventListener('pagehide'")
        const firstInitializationAwait = main.indexOf('ScratchRuntime.create({')

        expect(pagehideRegistration).to.be.greaterThan(-1)
        expect(pagehideRegistration).to.be.lessThan(firstInitializationAwait)
        expect(main).to.include('lifetime.acquireRuntime(ScratchRuntime.create({')
        expect(main).to.include('waitForFlowMap(map, lifetime.signal)')
        expect(main).to.include("lifetime.assertActive('request Flow field')")
        expect(layer).to.include('createStationGeometry(settings.flowDomainMaxEdge, lifetime.signal)')
        expect(layer).to.include('fetch(url, { signal })')
        expect(layer).to.include("lifetime.assertActive('continue Flow graph initialization')")
    })

    it('clips the generated velocity field and mask at the legacy estuary display boundary', () => {

        const layer = read('examples', 'flowLayer', 'flow-layer.js')
        const shader = read('examples', 'flowLayer', 'shaders', 'flow', 'flowVoronoi.wgsl')

        expect(layer).to.include('export const FLOW_DISPLAY_EXTENT = Object.freeze([')
        expect(layer).to.include('121.96623240116922')
        expect(layer).to.not.include('const FLOW_EXTENT')
        expect(layer).to.include("{ name: 'displayExtent', type: 'vec4f' }")
        expect(layer).to.include("uniform(1, 'staticUniform', codecs.static, [ 'vertex', 'fragment' ])")
        expect(layer).to.include('resourceExtent: graph.resourceExtent')
        expect(layer).to.include('displayExtent: FLOW_DISPLAY_EXTENT')
        expect(shader).to.include('@location(1) mercatorPosition: vec2f')
        expect(shader).to.include('output.mercatorPosition = input.position.xy + input.position.zw')
        expect(shader).to.include('let displaySouthWest = calcWebMercatorCoord(staticUniform.displayExtent.xy)')
        expect(shader).to.include('let displayNorthEast = calcWebMercatorCoord(staticUniform.displayExtent.zw)')
        expect(shader).to.include('let displaySupport = select(0.0, 1.0,')
        expect(shader).to.include('let fieldSupport = input.domainSupport * displaySupport')
        expect(shader).to.include('output.velocity = input.velocity * speedMask * fieldSupport')
        expect(shader).to.include('output.mask = fieldSupport')
    })

    it('locks the reviewed Flow shader set and retains the documented arrow stride correction', () => {

        for (const [ name, expected ] of Object.entries(shaderHashes)) {
            const bytes = fs.readFileSync(path.join(root, 'examples', 'flowLayer', 'shaders', 'flow', name))
            const actual = crypto.createHash('sha256').update(bytes).digest('hex')

            expect(actual, name).to.equal(expected)
            if (name === 'arrow.wgsl') {
                expect(actual).to.not.equal('f11b55d300655f5cab0376ffcda67145180e4840db2fef4085f0fa9ef0b8bf7b')
            }
        }

        const arrow = read('examples', 'flowLayer', 'shaders', 'flow', 'arrow.wgsl')
        expect(arrow).to.include('particles[input.instanceIndex * 6 + 0]')
        expect(arrow).to.include('particles[input.instanceIndex * 6 + 1]')
        expect(arrow).to.include('particles[input.instanceIndex * 6 + 4]')
        expect(arrow).to.include('particles[input.instanceIndex * 6 + 5]')
        expect(arrow).to.not.include('particles[input.instanceIndex * 4')
        expect(arrow).to.include('let mercatorPos = calcWebMercatorCoord(position)')
        expect(arrow).to.not.include('mix(cExtent.x, cExtent.z, position.x)')
        expect(arrow).to.not.include('mix(cExtent.y, cExtent.w, position.y)')
    })

    it('provides the required decision, audit, and headed browser verifier', () => {

        expect(exists('docs', 'decisions', 'ADR-044-flow-layer-scratch-api-clean-cut.md')).to.equal(true)
        expect(exists('docs', 'review', 'scratch-flow-layer-migration-audit.md')).to.equal(true)
        expect(exists('tests', 'browser', 'scratch-flow-layer.mjs')).to.equal(true)

        const browser = read('tests', 'browser', 'scratch-flow-layer.mjs')
        expect(browser).to.include('FLOW_LAYER_PROOF_FRAMES')
        expect(browser).to.include('headless: false')
        expect(browser).to.include('660')
        expect(browser).to.include('workerTransitions')
        expect(browser).to.include('stableIdentityHash')
        expect(browser).to.include('pendingObservationCount')
        expect(browser).to.include('serverClosed')
        expect(browser).to.include('const expectedFramesPerField = 300')
        expect(browser).to.include('const expectedFieldCount = 27')
        expect(browser).to.include('validateTemporalFieldFacts')
        expect(browser).to.include('validateMrtFacts')
        expect(browser).to.include('verifyBoundaryFlow')
        expect(browser).to.include('flow-estuary-boundary.png')
        expect(browser).to.include('validateBoundaryProof')
        expect(browser).to.include("velocityFormat !== 'rg32float'")
        expect(browser).to.include("maskFormat !== 'r8unorm'")
    })
})
