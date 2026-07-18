import { expect } from 'chai'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const exists = (...parts) => fs.existsSync(path.join(root, ...parts))

const shaderHashes = Object.freeze({
    'arrow.wgsl': '666bdcc55fd9f147f99b2437a2c489cf368a4d441da4aef421760d751149b6d5',
    'flowLayer.wgsl': '225a94b8fe79c052264a1fcb81f96a7d4ebf36d384bf695645984f551c32382a',
    'flowShow.wgsl': '9e515dcef0e7cff01e5a9f1828e3dff7561991abc3b54596f33c017b3544733a',
    'flowVoronoi.wgsl': '0b1cc4c6e88d57ecf4d6ca2582a485101c7116eafa64b6bad388dce766a2cb15',
    'particles.wgsl': '8105f49ba56bd1929a74b8c7528d5e5732b4c905ffb2cf76388396a383f8c78b',
    'simulation.compute.wgsl': '27be5467f1846e59b728f634fb0530f247592a99a9743f1d8dd4f2d7ff8a8671',
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

    it('leaves DEM as the only legacy catalog example', () => {

        const catalog = read('examples', 'index.html')
        const demStart = catalog.indexOf('data-id="m_demLayer"')
        const demLink = catalog.slice(demStart, demStart + 420)

        expect(demStart).to.be.greaterThan(-1)
        expect(demLink).to.include('(legacy)')
        expect(catalog.match(/\(legacy\)/g)).to.have.length(1)
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
        expect(main).to.include('createFlowMap(canvas, { proof: proofMode })')
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

    it('keeps six Flow shaders byte-identical and fixes the documented arrow stride defect', () => {

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
    })
})
