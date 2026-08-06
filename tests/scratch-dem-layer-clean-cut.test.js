import { expect } from 'chai'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { GPURuntime } from 'geoscratch/scratch'
import {
    VirtualRasterResidency,
    createVirtualRasterGpuState,
    ownedVirtualRasterPagePayload,
} from 'geoscratch/geo'
import { createDemLayer } from '../examples/demLayer/dem-layer.ts'
import {
    createDemVirtualRasterModel,
    parseDemVirtualRasterManifest,
} from '../examples/demLayer/dem-virtual-raster.ts'
import { createDemLifecycle } from '../examples/demLayer/dem-lifecycle.ts'
import {
    createFakeCanvas,
    createFakeGpu,
} from './scratch-test-utils.js'
import { demWebMercatorManifest } from './fixtures/dem-webmercator-manifest.js'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const demManifest = parseDemVirtualRasterManifest(demWebMercatorManifest)

function sha256(value) {

    return crypto.createHash('sha256').update(value).digest('hex')
}

async function createTestVirtualRaster(runtime) {

    const model = createDemVirtualRasterModel(demManifest)
    const residency = new VirtualRasterResidency({
        addressSpace: model.addressSpace,
        plane: model.plane,
        maxPhysicalPages: 18,
        maxStagingBytes: 18 * 256 * 256,
        maxHistory: 8,
    })
    residency.pin(model.rootPage)
    const gpu = await createVirtualRasterGpuState(runtime, {
        addressSpace: model.addressSpace,
        plane: model.plane,
        maxPhysicalPages: 18,
    })
    let generation = 0
    let activePublication
    let stopped = false

    function publish() {

        const publication = residency.publish()
        const update = gpu.stage(publication)
        activePublication = publication
        return Object.freeze({
            snapshotEpoch: publication.snapshot.epoch,
            changed: update.commands.length > 0,
            update,
            publication,
        })
    }

    expect(model.addressSpace.levelCount).to.equal(7)
    return Object.freeze({
        ...model,
        model,
        manifest: demManifest,
        residency,
        gpu,
        scheduler: Object.freeze({ maxRequests: 18 }),
        async initialize() {

            generation++
            residency.reconcileGeneration(generation, [ model.rootPage ])
            residency.stage(ownedVirtualRasterPagePayload({
                page: model.rootPage,
                width: 256,
                height: 256,
                channels: 1,
                data: new Uint8Array(256 * 256).fill(128),
                contentVersion: demManifest.contentVersion,
            }), { generation })
            return publish()
        },
        reconcileFeedback() {

            generation++
            residency.reconcileGeneration(generation, [ model.rootPage ])
            return Object.freeze({
                requestedCount: 0,
                settlement: Promise.resolve(Object.freeze({
                    generation,
                    stagedCount: 0,
                    residentCount: 1,
                    staleCount: 0,
                    failedCount: 0,
                })),
                generation,
                retainedCount: 0,
                retiredCount: 0,
            })
        },
        publish,
        async acknowledge(wrapped, submitted) {

            if (activePublication !== wrapped.publication) {
                throw new Error('Test DEM publication authority mismatch')
            }
            await gpu.acknowledge(wrapped.publication, submitted)
            activePublication = undefined
        },
        async stopStreaming() {

            if (stopped) return
            stopped = true
            if (activePublication !== undefined) {
                await gpu.abandon(activePublication.publication)
                activePublication = undefined
            }
            residency.dispose()
            gpu.dispose()
        },
        inspect: () => Object.freeze({
            contentVersion: demManifest.contentVersion,
            tileMatrixSetId: demManifest.tileMatrixSet.id,
            stopped,
            residency: residency.inspect(),
            gpu: gpu.facts(),
        }),
    })
}

describe('DEM Layer clean cut', () => {

    it('uses a GPU-resident frontier without a CPU selection compatibility path', () => {

        const layerSource = read('examples', 'demLayer', 'dem-layer.ts')
        const virtualRasterSource = read('examples', 'demLayer', 'dem-virtual-raster.ts')
        const mapSource = read('examples', 'demLayer', 'dem-map.ts')

        expect(layerSource).to.include('GpuTileFrontier.create(')
        expect(layerSource).to.include('frontier.encode(builder, frame)')
        expect(layerSource).to.include('feedbackRing.encode(builder, frame)')
        expect(layerSource).not.to.match(/selectTerrainNodes|nodeLevels|nodeBoxes|canonicalNodes/)
        expect(layerSource).not.to.match(/lodArguments\.upload|terrainArguments\.upload/)
        expect(virtualRasterSource).not.to.match(/\bprepare\(selection\)|planDemVirtualPages/)
        expect(mapSource).to.include('clipFromRelativeWorld')
        expect(mapSource).to.include('verticalFovRadians')
        expect(mapSource).to.include('cameraLatitudeRadians')
        expect(mapSource).to.include('zoomHint')
        expect(mapSource).not.to.match(/\bcenter(?:High|Low)\b|\bcameraPos\b/)
    })

    it('uses the neutral route and removes every legacy DEM owner', () => {

        expect(fs.existsSync(path.join(root, 'examples', 'demLayer', 'index.html'))).to.equal(true)
        expect(fs.existsSync(path.join(root, 'examples', 'm_demLayer'))).to.equal(false)
        expect(fs.existsSync(path.join(root, 'examples', 'shared', 'scratchMap.js'))).to.equal(false)
        expect(fs.existsSync(path.join(root, 'packages', 'geoscratch', 'src', 'applications', 'terrain'))).to.equal(false)
    })

    it('uses only the current public Scratch graph and keeps persistent construction out of frames', () => {

        const layerSource = read('examples', 'demLayer', 'dem-layer.ts')
        const mainSource = read('examples', 'demLayer', 'main.ts')
        const frameSource = layerSource.slice(
            layerSource.indexOf('async function renderFrame(camera: DemCameraState)'),
            layerSource.indexOf('async function resize(nextSize: SurfaceSize)')
        )
        const allSources = [
            layerSource,
            mainSource,
            read('examples', 'demLayer', 'dem-map.ts'),
            read('examples', 'demLayer', 'dem-lifecycle.ts'),
            read('examples', 'demLayer', 'terrain-selection.ts'),
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
        expect(frameSource).to.include('frontier.writeView({')
        expect(frameSource).to.include('frontier.encode(builder, frame)')
        expect(frameSource).to.include('feedbackRing.encode(builder, frame)')
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

        const mainSource = read('examples', 'demLayer', 'main.ts')
        const lifecycleCreation = mainSource.indexOf('const pageLifetime = createDemLifecycle()')
        const pageHideRegistration = mainSource.indexOf("window.addEventListener('pagehide'")
        const initializationStart = mainSource.indexOf(
            'Promise.resolve().then(() => main(pageLifetime, failureProof))'
        )
        const faultNames = [ ...mainSource.matchAll(/'((?:after-map-acquisition|invalid-terrain-shader-wgsl))'/g) ]
            .map(match => match[1])

        expect(faultNames).to.deep.equal([
            'after-map-acquisition',
            'invalid-terrain-shader-wgsl',
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

        lifecycle.deferStop({ label: 'scheduler', run: () => { actions.push('stop') } })
        lifecycle.ownMap(map)
        lifecycle.ownRuntime(runtime)
        lifecycle.track(observation.then(() => { actions.push('settled') }), 'frame')

        const firstDisposal = lifecycle.dispose()
        const secondDisposal = lifecycle.dispose()
        expect(secondDisposal).to.equal(firstDisposal)
        settleObservation()
        const report = await firstDisposal

        expect(actions).to.deep.equal([ 'stop', 'settled', 'map', 'runtime' ])
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
        const browserProof = read('tests', 'browser', 'scratch-dem-layer.mjs')

        expect(sha256(demBytes)).to.equal('aa7a584830f198772d242df1ce1ae47e21b2bdc85bfc1f97101af8be986c57e1')
        expect(lodShader.match(/var<storage, read>/g)).to.have.length(1)
        expect(terrainShader.match(/var<storage, read>/g)).to.have.length(3)
        expect(terrainShader).not.to.match(/\b(lSampler|palette|colorMap)\b/)
        expect(terrainShader).not.to.include('demTexture')
        expect(terrainShader).not.to.match(/nodeBox|canonicalNodes|cameraCoordinate/)
        expect(terrainShader).to.include('DemHeight_sample_vertex_mercator')
        expect(terrainShader).to.include('fixedAxisFromShiftedNumerator')
        expect(terrainShader).to.include('relativeFixedMeters')
        expect(terrainShader).to.include('grid.x == 0u')
        const layer = read('examples', 'demLayer', 'dem-layer.ts')
        const main = read('examples', 'demLayer', 'main.ts')
        expect(layer).not.to.include('createExternalImageUploadCommand')
        expect(layer).not.to.include('DEM elevation texture')
        expect(main).not.to.include("./assets/dem.png")
        expect(browserProof).to.include('visibleNodeCount')
    })

    it('observes issued native work before surfacing a provenance failure', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const fakeCanvas = createFakeCanvas()
        const surface = runtime.createSurface(fakeCanvas.canvas, {
            label: 'DEM provenance-failure surface',
            format: 'rgba8unorm',
            alphaMode: 'premultiplied',
            size: { width: 320, height: 180 },
        })
        const provenanceFailure = new Error('injected DEM provenance mismatch')
        const virtualRaster = await createTestVirtualRaster(runtime)
        const graph = await createDemLayer({
            runtime,
            surface,
            virtualRaster,
            size: { width: 320, height: 180 },
            shaders: {
                lodMap: read('examples', 'demLayer', 'shaders', 'lod-map.wgsl'),
                terrain: read('examples', 'demLayer', 'shaders', 'terrain-mesh.wgsl'),
            },
            provenanceVerifier() {
                throw provenanceFailure
            },
        })
        const initialized = await graph.initialize()
        await initialized.observation

        const frame = await graph.renderFrame(cameraState(9, [ 320, 180 ]))
        expect(frame.provenance).to.deep.equal([])
        let observedFailure
        try {
            await frame.observation
        } catch (error) {
            observedFailure = error
        }

        expect(observedFailure).to.equal(provenanceFailure)
        expect(fake.calls.queueSubmissions.length).to.be.greaterThan(0)
        expect(fake.calls.submittedWorkDoneRegistrations.length).to.be.greaterThan(2)
        graph.dispose()
        await runtime.dispose()
    })

    it('keeps one persistent DEM graph across camera changes and resize', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const fakeCanvas = createFakeCanvas()
        const surface = runtime.createSurface(fakeCanvas.canvas, {
            label: 'DEM test surface',
            format: 'rgba8unorm',
            alphaMode: 'premultiplied',
            size: { width: 320, height: 180 },
        })
        const virtualRaster = await createTestVirtualRaster(runtime)
        const graph = await createDemLayer({
            runtime,
            surface,
            virtualRaster,
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
        const initialized = await graph.initialize()
        await initialized.observation

        const first = await graph.renderFrame(cameraState(9, [ 320, 180 ]))
        await first.observation
        const second = await graph.renderFrame(cameraState(10, [ 320, 180 ]))
        await second.observation

        expect(first.provenance.map(fact => fact.name)).to.deep.equal([
            'frontier-map-meta-to-lod-draw',
            'frontier-visible-to-lod-draw',
            'frontier-indirect-to-lod-draw',
            'frontier-visible-to-terrain-draw',
            'frontier-indirect-to-terrain-draw',
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
        expect(initialIdentityFacts).to.deep.include({
            hash: initialIdentityHash,
            uploads: 3,
            bindLayouts: 4,
            bindSets: 6,
            programs: 2,
            pipelines: 2,
            passes: 2,
            commands: 4,
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
            lastResizeFacts: resizeFacts,
        })
        expect(graph.contractFacts()).to.deep.include({
            countPath: 'gpu-produced-indirect-arguments',
            selectionPath: 'gpu-resident-active-frontier',
        })
        expect(fake.calls.maps).to.have.length(1)
        expect(fake.calls.maps[0].size).to.equal(
            graph.contractFacts().frontier.feedbackOutput.layout.byteLength
        )

        graph.dispose()
        await runtime.dispose()
    })
})

function cameraState(zoomHint, viewport) {

    return Object.freeze({
        far: 1000,
        near: 1,
        clipFromRelativeWorld: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ],
        cameraLow: [ 0, 0, 0 ],
        cameraHigh: [ 0, 0, 100 ],
        viewport,
        verticalFovRadians: Math.PI / 3,
        cameraLatitudeRadians: 31.684162 * Math.PI / 180,
        zoomHint,
    })
}
