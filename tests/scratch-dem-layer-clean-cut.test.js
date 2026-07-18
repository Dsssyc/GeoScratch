import { expect } from 'chai'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { ScratchRuntime } from 'geoscratch'
import { createDemLayer } from '../examples/demLayer/dem-layer.js'
import { createDemLifecycle } from '../examples/demLayer/dem-lifecycle.js'
import { selectTerrainNodes } from '../examples/demLayer/terrain-selection.js'
import {
    createFakeCanvas,
    createFakeExternalImageSource,
    createFakeGpu,
} from './scratch-test-utils.js'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')

function sha256(value) {

    return crypto.createHash('sha256').update(value).digest('hex')
}

function selection(cameraPos, zoomLevel, options = {}) {

    return selectTerrainNodes({
        cameraPos,
        zoomLevel,
        maxLevel: 14,
        ...options,
    })
}

function leadingFacts(plan) {

    return {
        visibleNodeCount: plan.visibleNodeCount,
        tileBox: plan.tileBox,
        levelRange: plan.levelRange,
        sectorRange: plan.sectorRange,
        nodeLevels: plan.nodeLevels.slice(0, 16),
        nodeBoxes: plan.nodeBoxes.slice(0, 12),
    }
}

describe('DEM Layer clean cut', () => {

    it('preserves the reachable CPU terrain selection facts', () => {

        expect(leadingFacts(selection([ 120.980697, 31.684162 ], 9))).to.deep.equal({
            visibleNodeCount: 24,
            tileBox: [ 119.8828125, 30.9375, 121.9921875, 32.34375 ],
            levelRange: [ 9, 9 ],
            sectorRange: [ 0.3515625, 0.3515625 ],
            nodeLevels: Array(16).fill(9),
            nodeBoxes: [
                121.640625, 31.9921875, 121.9921875, 32.34375,
                121.640625, 31.640625, 121.9921875, 31.9921875,
                121.2890625, 31.9921875, 121.640625, 32.34375,
            ],
        })
        expect(leadingFacts(selection([ 120.980697, 31.684162 ], 10))).to.deep.equal({
            visibleNodeCount: 56,
            tileBox: [ 119.8828125, 30.9375, 121.9921875, 32.34375 ],
            levelRange: [ 9, 10 ],
            sectorRange: [ 0.17578125, 0.17578125 ],
            nodeLevels: [ 9, 9, ...Array(12).fill(10), 9, 9 ],
            nodeBoxes: [
                121.640625, 31.9921875, 121.9921875, 32.34375,
                121.640625, 31.640625, 121.9921875, 31.9921875,
                121.46484375, 31.9921875, 121.640625, 32.16796875,
            ],
        })
        expect(leadingFacts(selection([ 121.4, 31.9 ], 12))).to.deep.equal({
            visibleNodeCount: 146,
            tileBox: [ 119.53125, 30.9375, 121.9921875, 32.34375 ],
            levelRange: [ 8, 12 ],
            sectorRange: [ 0.0439453125, 0.0439453125 ],
            nodeLevels: [ 10, 11, 11, 11, 11, 10, 11, 11, 11, 11, 10, 11, 11, 11, 11, 11 ],
            nodeBoxes: [
                121.81640625, 31.9921875, 121.9921875, 32.16796875,
                121.728515625, 32.080078125, 121.81640625, 32.16796875,
                121.640625, 32.080078125, 121.728515625, 32.16796875,
            ],
        })
        expect(leadingFacts(selection([ 0, 0 ], 2))).to.deep.equal({
            visibleNodeCount: 1,
            tileBox: [ 90, 0, 135, 45 ],
            levelRange: [ 2, 2 ],
            sectorRange: [ 45, 45 ],
            nodeLevels: [ 2 ],
            nodeBoxes: [ 90, 0, 135, 45 ],
        })
    })

    it('returns detached serializable facts and applies the node cap after LoD filtering', () => {

        const plan = selection([ 120.980697, 31.684162 ], 12, { maxNodes: 5 })
        const roundTrip = JSON.parse(JSON.stringify(plan))

        expect(plan.selectedCount).to.be.greaterThan(5)
        expect(plan.cappedCount).to.equal(5)
        expect(plan.visibleNodeCount).to.equal(5)
        expect(plan.droppedCount).to.equal(plan.selectedCount - plan.cappedCount)
        expect(plan.nodeLevels).to.have.length(5)
        expect(plan.nodeBoxes).to.have.length(20)
        expect(roundTrip).to.deep.equal(plan)
        expect(Object.isFrozen(plan)).to.equal(true)
        expect(Object.isFrozen(plan.nodeLevels)).to.equal(true)
        expect(Object.isFrozen(plan.nodeBoxes)).to.equal(true)
    })

    it('uses the neutral route and removes every legacy DEM owner', () => {

        expect(fs.existsSync(path.join(root, 'examples', 'demLayer', 'index.html'))).to.equal(true)
        expect(fs.existsSync(path.join(root, 'examples', 'm_demLayer'))).to.equal(false)
        expect(fs.existsSync(path.join(root, 'examples', 'shared', 'scratchMap.js'))).to.equal(false)
        expect(fs.existsSync(path.join(root, 'packages', 'geoscratch', 'src', 'applications', 'terrain'))).to.equal(false)
    })

    it('uses only the current public Scratch graph and keeps persistent construction out of frames', () => {

        const layerSource = read('examples', 'demLayer', 'dem-layer.js')
        const mainSource = read('examples', 'demLayer', 'main.js')
        const frameSource = layerSource.slice(
            layerSource.indexOf('function renderFrame(camera)'),
            layerSource.indexOf('async function resize(nextSize)')
        )
        const allSources = [
            layerSource,
            mainSource,
            read('examples', 'demLayer', 'dem-map.js'),
            read('examples', 'demLayer', 'dem-lifecycle.js'),
            read('examples', 'demLayer', 'terrain-selection.js'),
        ].join('\n')

        for (const call of [
            'createBuffer',
            'createTexture',
            'createBindLayout',
            'createBindSet',
            'createProgram',
            'createRenderPipeline',
            'createRenderPass',
            'createDrawCommand',
            'createUploadCommand',
        ]) {
            expect(layerSource).to.include(call)
            expect(frameSource).not.to.include(call)
        }
        expect(frameSource).to.include("runtime.createSubmission({ validation: 'throw' })")
        expect(frameSource).to.include('.upload(uniforms.dynamic.upload)')
        expect(frameSource).to.include('.render(passes.lodMap')
        expect(frameSource).to.include('.render(passes.terrain')
        expect(layerSource).to.include("contentEpoch: 'current-at-step'")
        expect(layerSource.match(/count: \{ indirect:/g)).to.have.length(2)
        expect(layerSource).to.include('depthWriteEnabled: true')
        expect(layerSource).to.include("depthCompare: 'less'")
        expect(allSources).not.to.match(/runtime\.(device|queue)\b/)
        expect(allSources).not.to.match(/\b(LocalTerrain|StartDash|director)\b/)
        expect(allSources).not.to.match(/\b(mapAsync|ReadbackOperation|createReadback)\b/)
    })

    it('locks the finite initialization faults and required migration documentation', () => {

        const mainSource = read('examples', 'demLayer', 'main.js')
        const lifecycleCreation = mainSource.indexOf('const pageLifetime = createDemLifecycle()')
        const pageHideRegistration = mainSource.indexOf("window.addEventListener('pagehide'")
        const initializationStart = mainSource.indexOf(
            'Promise.resolve().then(() => main(pageLifetime, failureProof))'
        )
        const faultNames = [ ...mainSource.matchAll(/'((?:after-map-acquisition|invalid-terrain-pipeline-wgsl))'/g) ]
            .map(match => match[1])

        expect(faultNames).to.deep.equal([
            'after-map-acquisition',
            'invalid-terrain-pipeline-wgsl',
        ])
        expect(lifecycleCreation).to.be.greaterThan(-1)
        expect(pageHideRegistration).to.be.greaterThan(lifecycleCreation)
        expect(initializationStart).to.be.greaterThan(pageHideRegistration)
        expect(mainSource).to.include('FAILURE_CAPTURE_BOUNDS')
        expect(mainSource).to.include('retainsWgslSource')
        expect(mainSource).to.include("'dem-page-initialization'")
        expect(mainSource).to.include('`dem-render-task-${frameWorkCompleted}`')

        for (const documentation of [
            'docs/decisions/ADR-045-dem-layer-scratch-api-clean-cut.md',
            'docs/review/scratch-dem-layer-migration-audit.md',
            'tests/browser/scratch-dem-layer.mjs',
        ]) {
            expect(fs.existsSync(path.join(root, documentation)), documentation).to.equal(true)
        }
        const review = read('docs', 'review', 'scratch-api-intelligent-friendly-review.md')
        const audit = read('docs', 'review', 'scratch-dem-layer-migration-audit.md')
        expect(review).to.include('DEM Layer Persistent Graph And Application-Owned LoD')
        expect(audit).to.include('## One-To-One Source Matrix')
        expect(audit).to.include('## Managed Browser Evidence')

        for (const documentation of [
            'README.md',
            'README_zh.md',
            'packages/geoscratch/README.md',
            'packages/geoscratch/README_zh.md',
        ]) {
            const source = read(...documentation.split('/'))
            expect(source).to.include('| DEM Layer | `examples/demLayer/` |')
            expect(source).not.to.include('DEM Layer (legacy)')
            expect(source).not.to.include('m_demLayer')
        }
    })

    it('settles work and releases page-owned resources in explicit order at most once', async() => {

        const actions = []
        const lifecycle = createDemLifecycle()
        let settleObservation
        const observation = new Promise(resolve => { settleObservation = resolve })
        const map = { remove: () => { actions.push('map') } }
        const runtime = { dispose: () => { actions.push('runtime') } }
        const bitmap = { close: () => { actions.push('bitmap') } }

        lifecycle.deferStop({ label: 'scheduler', run: () => { actions.push('stop') } })
        lifecycle.ownMap(map)
        lifecycle.ownRuntime(runtime)
        lifecycle.ownBitmap('DEM', bitmap)
        lifecycle.track(observation.then(() => { actions.push('settled') }), 'frame')

        const firstDisposal = lifecycle.dispose()
        const secondDisposal = lifecycle.dispose()
        expect(secondDisposal).to.equal(firstDisposal)
        settleObservation()
        const report = await firstDisposal

        expect(actions).to.deep.equal([ 'stop', 'settled', 'bitmap', 'map', 'runtime' ])
        expect(report).to.include({
            cleanupInvocationCount: 1,
            pendingObservationsBefore: 1,
            pendingObservationsAfter: 0,
            retainedActionCount: 0,
        })
        expect(report.cleanupFailures).to.deep.equal([])
        expect(lifecycle.snapshot()).to.deep.include({
            state: 'disposed',
            pendingObservationCount: 0,
            ownedBitmapCount: 0,
            ownsMap: false,
            ownsRuntime: false,
        })
    })

    it('releases a runtime that settles after disposal and preserves the primary failure', async() => {

        const lifecycle = createDemLifecycle()
        let resolveRuntime
        let lateRuntimeDisposals = 0
        const acquisition = new Promise(resolve => { resolveRuntime = resolve })
        const primaryFailure = new Error('primary DEM failure')
        const guarded = lifecycle.acquireRuntime(acquisition)

        const disposal = lifecycle.dispose(primaryFailure)
        resolveRuntime({ dispose: () => { lateRuntimeDisposals++ } })

        let guardedFailure
        try {
            await guarded
        } catch (error) {
            guardedFailure = error
        }
        const report = await disposal

        expect(guardedFailure).to.be.instanceOf(Error)
        expect(guardedFailure.message).to.equal('DEM lifecycle disposal has started')
        expect(lateRuntimeDisposals).to.equal(1)
        expect(report.primaryFailure).to.equal(primaryFailure)
        expect(report.cleanupActions).to.deep.include({
            phase: 'release',
            label: 'late-scratch-runtime',
            status: 'fulfilled',
        })
        expect(report.cleanupInvocationCount).to.equal(1)
    })

    it('releases a decoded image that settles after disposal', async() => {

        const lifecycle = createDemLifecycle()
        let resolveBitmap
        let lateBitmapCloses = 0
        const acquisition = new Promise(resolve => { resolveBitmap = resolve })
        const guarded = lifecycle.acquireBitmap('DEM', acquisition)

        const disposal = lifecycle.dispose()
        resolveBitmap({ close: () => { lateBitmapCloses++ } })

        let guardedFailure
        try {
            await guarded
        } catch (error) {
            guardedFailure = error
        }
        const report = await disposal

        expect(guardedFailure).to.be.instanceOf(Error)
        expect(guardedFailure.message).to.equal('DEM lifecycle disposal has started')
        expect(lateBitmapCloses).to.equal(1)
        expect(report.cleanupActions).to.deep.include({
            phase: 'release',
            label: 'late-external-image:DEM',
            status: 'fulfilled',
        })
        expect(report.cleanupInvocationCount).to.equal(1)
        expect(lifecycle.snapshot()).to.deep.include({
            state: 'disposed',
            ownedBitmapCount: 0,
        })
    })

    it('settles tracked initialization and resize work before releasing page owners', async() => {

        const actions = []
        const lifecycle = createDemLifecycle()
        let resolveInitialization
        let resolveResize
        const initialization = new Promise(resolve => { resolveInitialization = resolve })
        const resize = new Promise(resolve => { resolveResize = resolve })
        lifecycle.track(
            initialization.then(() => { actions.push('initialization') }),
            'dem-page-initialization'
        )
        lifecycle.track(
            resize.then(() => { actions.push('resize') }),
            'dem-render-task-1'
        )
        lifecycle.ownBitmap('DEM', { close: () => { actions.push('bitmap') } })
        lifecycle.ownMap({ remove: () => { actions.push('map') } })
        lifecycle.ownRuntime({ dispose: () => { actions.push('runtime') } })

        const disposal = lifecycle.dispose()
        await Promise.resolve()
        expect(actions).to.deep.equal([])
        resolveInitialization()
        await Promise.resolve()
        expect(actions).to.deep.equal([ 'initialization' ])
        resolveResize()
        const report = await disposal

        expect(actions).to.deep.equal([
            'initialization',
            'resize',
            'bitmap',
            'map',
            'runtime',
        ])
        expect(report).to.include({
            pendingObservationsBefore: 2,
            pendingObservationsAfter: 0,
            cleanupInvocationCount: 1,
        })
        expect(report.cleanupFailures).to.deep.equal([])
    })

    it('does not duplicate a tracked primary failure as a cleanup failure', async() => {

        const lifecycle = createDemLifecycle()
        const primaryFailure = new Error('tracked initialization failed')
        let rejectInitialization
        const initialization = new Promise((resolve, reject) => {
            rejectInitialization = reject
        })
        lifecycle.track(initialization, 'dem-page-initialization')

        const disposal = lifecycle.dispose(primaryFailure)
        rejectInitialization(primaryFailure)
        const report = await disposal

        expect(report.primaryFailure).to.equal(primaryFailure)
        expect(report.cleanupFailures).to.deep.equal([])
    })

    it('reports cleanup failures without replacing the primary failure', async() => {

        const lifecycle = createDemLifecycle()
        const primaryFailure = new Error('terrain pipeline failed')
        const cleanupFailure = new Error('map cleanup failed')
        lifecycle.ownMap({ remove: () => { throw cleanupFailure } })

        const report = await lifecycle.dispose(primaryFailure)

        expect(report.primaryFailure).to.equal(primaryFailure)
        expect(report.cleanupFailures).to.have.length(1)
        expect(report.cleanupFailures[0]).to.include({
            phase: 'release',
            label: 'maplibre-map',
            error: cleanupFailure,
        })
    })

    it('preserves the DEM payload and enumerates every reachable WGSL correction', () => {

        const demBytes = fs.readFileSync(path.join(root, 'examples', 'demLayer', 'assets', 'dem.png'))
        const lodShader = read('examples', 'demLayer', 'shaders', 'lod-map.wgsl')
        const terrainShader = read('examples', 'demLayer', 'shaders', 'terrain-mesh.wgsl')

        expect(sha256(demBytes)).to.equal('aa7a584830f198772d242df1ce1ae47e21b2bdc85bfc1f97101af8be986c57e1')
        expect(sha256(lodShader.replaceAll('var<storage, read>', 'var<storage>')))
            .to.equal('ba2a35ab1aac1d9cc08f30be3eaaf88fba856629859cc4ce316c626619540bdc')
        expect(sha256(terrainShader.replaceAll('var<storage, read>', 'var<storage>')))
            .to.equal('248ae79a861bba63981176927b598f8a9b37516b8732b6311168625c6ae34b46')
        expect(lodShader.match(/var<storage, read>/g)).to.have.length(2)
        expect(terrainShader.match(/var<storage, read>/g)).to.have.length(4)
        expect(terrainShader).not.to.match(/\b(lSampler|palette|colorMap)\b/)
    })

    it('observes issued native work before surfacing a provenance failure', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const fakeCanvas = createFakeCanvas()
        const surface = runtime.createSurface(fakeCanvas.canvas, {
            label: 'DEM provenance-failure surface',
            format: 'rgba8unorm',
            alphaMode: 'premultiplied',
            size: { width: 320, height: 180 },
        })
        const provenanceFailure = new Error('injected DEM provenance mismatch')
        const graph = await createDemLayer({
            runtime,
            surface,
            demImage: createFakeExternalImageSource('ImageBitmap', {
                width: 1024,
                height: 558,
                close() {},
            }),
            size: { width: 320, height: 180 },
            shaders: {
                lodMap: read('examples', 'demLayer', 'shaders', 'lod-map.wgsl'),
                terrain: read('examples', 'demLayer', 'shaders', 'terrain-mesh.wgsl'),
            },
            provenanceVerifier() {
                throw provenanceFailure
            },
        })
        await graph.initialize().observation

        const frame = graph.renderFrame(cameraState(9, [ 120.980697, 31.684162 ], [ 320, 180 ]))
        expect(frame.provenance).to.deep.equal([])
        let observedFailure
        try {
            await frame.observation
        } catch (error) {
            observedFailure = error
        }

        expect(observedFailure).to.equal(provenanceFailure)
        expect(fake.calls.queueSubmissions).to.have.length(1)
        expect(fake.calls.submittedWorkDoneRegistrations).to.have.length(2)
        await runtime.dispose()
    })

    it('keeps one persistent DEM graph across camera changes and resize', async() => {

        const fake = createFakeGpu()
        const runtime = await ScratchRuntime.create({ gpu: fake.gpu })
        const fakeCanvas = createFakeCanvas()
        const surface = runtime.createSurface(fakeCanvas.canvas, {
            label: 'DEM test surface',
            format: 'rgba8unorm',
            alphaMode: 'premultiplied',
            size: { width: 320, height: 180 },
        })
        const demImage = createFakeExternalImageSource('ImageBitmap', {
            width: 1024,
            height: 558,
            close() {},
        })
        const graph = await createDemLayer({
            runtime,
            surface,
            demImage,
            size: { width: 320, height: 180 },
            shaders: {
                lodMap: read('examples', 'demLayer', 'shaders', 'lod-map.wgsl'),
                terrain: read('examples', 'demLayer', 'shaders', 'terrain-mesh.wgsl'),
            },
        })
        const initialIdentityHash = graph.stableIdentityHash
        const initialIdentities = graph.stableIdentities
        const initialIdentityFacts = graph.stableIdentityFacts
        const initialPersistentFacts = graph.persistentFacts()
        const initialized = graph.initialize()
        await initialized.observation

        const first = graph.renderFrame(cameraState(9, [ 120.980697, 31.684162 ], [ 320, 180 ]))
        await first.observation
        const second = graph.renderFrame(cameraState(10, [ 120.980697, 31.684162 ], [ 320, 180 ]))
        await second.observation

        expect(first.selection.visibleNodeCount).to.equal(24)
        expect(second.selection.visibleNodeCount).to.equal(56)
        expect(first.provenance.map(fact => fact.name)).to.deep.equal([
            'node-level-upload-to-lod-draw',
            'lod-arguments-upload-to-lod-draw',
            'node-box-upload-to-terrain-draw',
            'terrain-arguments-upload-to-terrain-draw',
            'lod-map-pass-to-terrain-draw',
        ])
        expect(second.provenance.every(fact => (
            fact.declaredContentEpoch === 'current-at-step' &&
            fact.producerContentEpoch === fact.readContentEpoch
        ))).to.equal(true)
        expect(graph.stableIdentities).to.equal(initialIdentities)
        expect(graph.stableIdentityHash).to.equal(initialIdentityHash)
        expect(graph.currentIdentityFacts()).to.deep.equal(initialIdentityFacts)
        expect(graph.currentIdentityFacts()).not.to.equal(graph.currentIdentityFacts())
        expect(initialIdentityFacts).to.deep.equal({
            hash: initialIdentityHash,
            count: 42,
            resources: 13,
            uploads: 11,
            bindLayouts: 5,
            bindSets: 5,
            programs: 2,
            pipelines: 2,
            passes: 2,
            commands: 2,
        })
        expect(graph.persistentFacts()).to.deep.equal(initialPersistentFacts)

        const resizeFacts = await graph.resize({ width: 640, height: 360 })
        expect(resizeFacts).to.deep.include({
            resizeGeneration: 1,
            staleBindSetCount: 0,
            preparedBindSetCount: 0,
        })
        expect(graph.stableIdentities).to.equal(initialIdentities)
        expect(graph.stableIdentityHash).to.equal(initialIdentityHash)
        expect(graph.currentIdentityFacts()).to.deep.equal(initialIdentityFacts)
        const resizedPersistentFacts = graph.persistentFacts()
        expect(resizedPersistentFacts).to.deep.include({
            resources: initialPersistentFacts.resources,
            bindLayouts: initialPersistentFacts.bindLayouts,
            bindSets: initialPersistentFacts.bindSets,
            pipelines: initialPersistentFacts.pipelines,
        })
        expect(resizedPersistentFacts.logicalFootprintBytes)
            .to.be.greaterThan(initialPersistentFacts.logicalFootprintBytes)
        expect(graph.state()).to.deep.include({
            frame: 2,
            resizeGeneration: 1,
            visibleNodeCount: 56,
            lastResizeFacts: resizeFacts,
        })
        expect(fake.calls.maps).to.deep.equal([])

        await runtime.dispose()
    })
})

function cameraState(zoom, cameraPos, viewport) {

    return Object.freeze({
        far: 1000,
        near: 1,
        matrix: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ],
        centerLow: [ 0, 0, 0 ],
        centerHigh: [ 0, 0, 0 ],
        cameraPos,
        zoom,
        viewport,
    })
}
