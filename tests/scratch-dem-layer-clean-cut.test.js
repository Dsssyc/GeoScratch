import { expect } from 'chai'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { GPURuntime } from 'geoscratch/scratch'
import {
    ViewDemandProducer,
    VirtualRasterResidency,
    createTerrainFieldRenderer,
    createVirtualRasterGpuState,
    mapFieldLayer,
    ownedVirtualRasterPagePayload,
} from 'geoscratch/geo'
import {
    createDemVirtualRasterModel,
    parseDemVirtualRasterManifest,
} from '../examples/demLayer/dem-virtual-raster.ts'
import { createDemLifecycle } from '../examples/demLayer/dem-lifecycle.ts'
import { demMapViewAdapter } from '../examples/demLayer/dem-map.ts'
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
    expect(model.safetyCoverPages).to.have.length(1)
    const safetyPage = model.safetyCoverPages[0]
    residency.pin(safetyPage)
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
        kind: 'virtual-raster-runtime',
        model,
        manifest: demManifest,
        residency,
        gpu,
        scheduler: Object.freeze({ maxRequests: 18 }),
        viewDemandProducer: new ViewDemandProducer({
            id: 'test-dem-view-demand',
            maxDemands: 18,
        }),
        async initialize() {

            generation++
            residency.reconcileGeneration(generation, [ safetyPage ])
            residency.stage(ownedVirtualRasterPagePayload({
                page: safetyPage,
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
            residency.reconcileGeneration(generation, [ safetyPage ])
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

function createTestFieldLayer(virtualRaster) {

    return mapFieldLayer({
        id: 'test-dem-height-layer',
        field: virtualRaster.field,
        representation: virtualRaster.representation,
        spatialProfile: virtualRaster.spatialProfile,
        viewAdapter: demMapViewAdapter,
        demandProducer: virtualRaster.viewDemandProducer,
    })
}

function createTestTerrainRenderer({
    runtime,
    surface,
    virtualRaster,
    size,
    observeProvenance,
}) {

    return createTerrainFieldRenderer({
        runtime,
        surface,
        fieldLayer: createTestFieldLayer(virtualRaster),
        virtualRaster,
        size,
        shader: read('examples', 'demLayer', 'shaders', 'terrain-mesh.wgsl'),
        fieldSampling: {
            namespace: 'DemHeight',
            addressNamespace: 'DemAddress',
            transitionTexels: 16,
        },
        elevationRangeMeters: [
            demManifest.offset,
            demManifest.offset + demManifest.scale * 255,
        ].sort((left, right) => left - right),
        exaggeration: 50,
        presentations: [
            { id: 'shaded', fragmentEntryPoint: 'fMain', label: 'DEM terrain pipeline' },
            {
                id: 'tile-wireframe',
                fragmentEntryPoint: 'fTileWireframe',
                label: 'DEM tile wireframe pipeline',
            },
        ],
        initialPresentation: 'shaded',
        ...(observeProvenance === undefined ? {} : { observeProvenance }),
    })
}

describe('DEM Layer clean cut', () => {

    it('consumes Geo-owned projected-grid render patches after the data frontier', () => {

        const layerSource = read(
            'packages', 'geoscratch', 'src', 'geo', 'terrain-field-renderer.ts'
        )
        const renderPatchSource = read(
            'packages', 'geoscratch', 'src', 'geo', 'gpu-render-patch-frontier.ts'
        )
        const renderPatchShader = read(
            'packages', 'geoscratch', 'src', 'geo', 'gpu-render-patch-frontier-wgsl.ts'
        )
        const terrainShader = read('examples', 'demLayer', 'shaders', 'terrain-mesh.wgsl')

        expect(layerSource).to.include('createGpuRenderPatchFrontier(')
        expect(layerSource).to.include('renderPatchFrontier.encode(builder, frame)')
        expect(layerSource).to.include('renderPatchFrontier.capture(builder, frame)')
        expect(layerSource).to.include("'render-patch-compute'")
        expect(renderPatchSource).to.include('GPU_RENDER_PATCH_MAXIMUM_MATRIX_LEVEL = 14')
        expect(renderPatchSource).to.include('GPU_RENDER_PATCH_MAXIMUM_EXTRA_LEVELS = 4')
        expect(renderPatchSource).to.include('dataMaximumMatrixLevel')
        expect(renderPatchSource).to.include('renderMaximumMatrixLevel')
        expect(renderPatchSource).to.include('maximumCellSpanPixels')
        expect(renderPatchSource).to.include(
            'GPU_RENDER_PATCH_DEFAULT_MAXIMUM_CELL_SPAN_PIXELS = 8'
        )
        expect(renderPatchSource).to.include('decodeGpuRenderPatchState')
        expect(renderPatchSource).to.include('createReadbackCommand')
        expect(renderPatchSource).to.include('renderPatchLookupCapacity')
        expect(renderPatchSource).to.include('previousRenderPatchLookup')
        expect(renderPatchShader).to.include('source.samplingLevel')
        expect(renderPatchShader).to.include('projectedCellSpanPixels')
        expect(renderPatchShader).to.include('start.z / (start.z - end.z)')
        expect(renderPatchShader).not.to.include('return 65535.0f')
        expect(renderPatchShader).to.include('historyAwareRefinementThreshold')
        expect(renderPatchShader).to.include('previousLookupContains')
        expect(renderPatchShader).to.include('let nominalPatchSpan = max(')
        expect(renderPatchShader).to.include('countRenderPatchTrials')
        expect(renderPatchShader).to.include('selectRenderPatchBudget')
        expect(renderPatchShader).to.include('trialCounts')
        expect(renderPatchShader).to.include('step < finalStep &&')
        expect(renderPatchShader).to.include('clipFromRelativeWorld')
        expect(renderPatchShader).to.include('minimumCellSpanQ8')
        expect(renderPatchShader).to.include('frameEpoch')
        expect(renderPatchShader).not.to.include('screenSpaceError')
        expect(renderPatchShader).not.to.include('distanceToAabb')
        expect(renderPatchShader).not.to.include('geometricErrorMeters')
        expect(renderPatchShader).to.include('insertRenderPatchLookup')
        expect(renderPatchShader).to.include('balanceRenderPatches')
        expect(renderPatchShader).to.include('storageBarrier()')
        expect(renderPatchShader).to.include('maximumFinerNeighborDelta')
        expect(renderPatchShader).to.include('validateFinalRenderPatchCut')
        expect(renderPatchShader).to.include('maximumAdjacentLevelDelta')
        expect(renderPatchShader).not.to.include('targetMatrixLevel')
        expect(renderPatchShader).not.to.include('mapMeta.zoomHint')
        expect(renderPatchShader).to.include('atomicAdd(&renderPatchState.count')
        expect(renderPatchShader).to.include('drawArguments[1] = renderPatchCount')
        expect(layerSource).to.include('geometricErrorMeters: matrix.cellSize,')
        expect(layerSource).not.to.include(
            'geometricErrorMeters: matrix.cellSize * matrix.tileWidth'
        )
        expect(layerSource).to.include('latestRenderPatchFeedback')
        expect(layerSource).to.include('renderPatchCellSpanRange')
        expect(terrainShader).to.include('fn renderPatchLookup(')
        expect(terrainShader).to.include('fn neighboringPatch(')
        expect(terrainShader).to.include('fn snapEdgeCoordinate(')
        expect(terrainShader).not.to.include('fn coarserSamplingLevel(')
        expect(fs.existsSync(path.join(
            root,
            'examples',
            'demLayer',
            'dem-render-patch-frontier.ts'
        ))).to.equal(false)
        expect(fs.existsSync(path.join(
            root,
            'examples',
            'demLayer',
            'shaders',
            'render-patch-frontier.wgsl'
        ))).to.equal(false)
        expect(fs.existsSync(path.join(
            root,
            'examples',
            'demLayer',
            'shaders',
            'lod-map.wgsl'
        ))).to.equal(false)
    })

    it('uses a GPU-resident frontier without a CPU selection compatibility path', () => {

        const layerSource = read(
            'packages', 'geoscratch', 'src', 'geo', 'terrain-field-renderer.ts'
        )
        const virtualRasterSource = read('examples', 'demLayer', 'dem-virtual-raster.ts')
        const mapSource = read('examples', 'demLayer', 'dem-map.ts')
        const mapAdapterSource = read(
            'packages', 'geoscratch', 'src', 'geo', 'maplibre-planar-view.ts'
        )

        expect(layerSource).to.include('GpuTileFrontier.create(')
        expect(layerSource).to.include('fieldLayer.viewAdapter.read(input')
        expect(layerSource).to.include('spatialProfile: fieldLayer.spatialProfile')
        expect(layerSource).to.include('frontier.encode(builder, frame)')
        expect(layerSource).to.include('feedbackRing.encode(builder, frame)')
        expect(layerSource).to.include("feedback.facts.convergenceState === 'transitioning'")
        expect(layerSource).to.include('consumed?.decisionKey === decisionKey')
        expect(layerSource).to.include('state.supersededFeedbackCount++')
        expect(layerSource).not.to.match(/selectTerrainNodes|nodeLevels|nodeBoxes|canonicalNodes/)
        expect(layerSource).not.to.match(/lodArguments\.upload|terrainArguments\.upload/)
        expect(virtualRasterSource).not.to.match(/\bprepare\(selection\)|planDemVirtualPages/)
        expect(mapSource).to.include('mapLibrePlanarViewAdapter')
        expect(mapAdapterSource).to.include('clipFromRelativeWorld')
        expect(mapAdapterSource).to.include('verticalFovRadians')
        expect(mapAdapterSource).to.include('cameraLatitudeRadians')
        expect(mapAdapterSource).to.include('zoomHint')
        expect(mapAdapterSource).to.include('minimumElevationMeters')
        expect(mainSourceFacts()).to.include('canvas.dataset.cpuSelectionUploadCount = \'0\'')
        expect(mainSourceFacts()).to.include('canvas.dataset.frontier = JSON.stringify(')
        expect(mainSourceFacts()).to.include('canvas.dataset.cameraView = JSON.stringify(')
        expect(mapSource).not.to.match(/\bcenter(?:High|Low)\b|\bcameraPos\b/)
    })

    it('uses the neutral route and removes every legacy DEM owner', () => {

        expect(fs.existsSync(path.join(root, 'examples', 'demLayer', 'index.html'))).to.equal(true)
        expect(fs.existsSync(path.join(root, 'examples', 'demLayer', 'terrain-selection.ts')))
            .to.equal(false)
        expect(fs.existsSync(path.join(root, 'examples', 'm_demLayer'))).to.equal(false)
        expect(fs.existsSync(path.join(root, 'examples', 'shared', 'scratchMap.js'))).to.equal(false)
        expect(fs.existsSync(path.join(root, 'packages', 'geoscratch', 'src', 'applications', 'terrain'))).to.equal(false)
    })

    it('uses only the current public Scratch graph and keeps persistent construction out of frames', () => {

        const layerSource = read(
            'packages', 'geoscratch', 'src', 'geo', 'terrain-field-renderer.ts'
        )
        const mainSource = read('examples', 'demLayer', 'main.ts')
        const frameSource = layerSource.slice(
            layerSource.indexOf('async function renderFrame(input: ViewInput)'),
            layerSource.indexOf('async function resize(nextSize: SurfaceSize)')
        )
        const allSources = [
            layerSource,
            mainSource,
            read('examples', 'demLayer', 'dem-map.ts'),
            read('examples', 'demLayer', 'dem-lifecycle.ts'),
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
        expect(frameSource).to.include('frontier.writeView(view)')
        expect(frameSource).to.include('virtualRaster.reconcileFeedback(feedback, consumed!.view)')
        expect(frameSource).to.include('frontier.encode(builder, frame)')
        expect(frameSource).to.include('feedbackRing.encode(builder, frame)')
        expect(frameSource).to.include('.render(passes.terrain')
        expect(frameSource).not.to.include('passes.lodMap')
        expect(layerSource).to.include("contentEpoch: 'current-at-step'")
        expect(layerSource.match(/count: \{ indirect:/g)).to.have.length(1)
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

    it('drains child work registered by a tracked task during disposal', async() => {

        const lifecycle = createDemLifecycle()
        const actions = []
        let resumeParent
        let resolveChild
        const parentGate = new Promise(resolve => { resumeParent = resolve })
        const child = new Promise(resolve => { resolveChild = resolve })
        lifecycle.deferRelease({
            label: 'runtime',
            run: () => { actions.push('release') },
        })
        lifecycle.track((async() => {
            await parentGate
            await lifecycle.track(child, 'late-child')
            actions.push('child-settled')
        })(), 'parent')

        let disposalSettled = false
        const disposal = lifecycle.dispose().then(report => {
            disposalSettled = true
            return report
        })
        resumeParent()
        await new Promise(resolve => setImmediate(resolve))

        expect(disposalSettled).to.equal(false)
        expect(actions).to.deep.equal([])
        resolveChild()
        const report = await disposal

        expect(actions).to.deep.equal([ 'child-settled', 'release' ])
        expect(report).to.include({
            pendingObservationsBefore: 1,
            pendingObservationsAfter: 0,
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
        const terrainShader = read('examples', 'demLayer', 'shaders', 'terrain-mesh.wgsl')
        const browserProof = read('tests', 'browser', 'scratch-dem-layer.mjs')

        expect(sha256(demBytes)).to.equal('aa7a584830f198772d242df1ce1ae47e21b2bdc85bfc1f97101af8be986c57e1')
        expect(terrainShader.match(/var<storage, read>/g)).to.have.length(4)
        expect(terrainShader).not.to.match(/\b(lSampler|palette|colorMap)\b/)
        expect(terrainShader).not.to.include('demTexture')
        expect(terrainShader).not.to.match(/nodeBox|canonicalNodes|cameraCoordinate/)
        expect(terrainShader).to.include('DemHeight_sample_vertex')
        expect(terrainShader).not.to.include('DemHeight_sample_vertex_mercator')
        expect(terrainShader).to.include('fixedAxisFromShiftedNumerator')
        expect(terrainShader).to.include('relativeFixedMeters')
        expect(terrainShader).to.include('grid.x == 0u')
        expect(terrainShader).to.include('@location(5) barycentric: vec3f')
        expect(terrainShader).to.include(
            '@location(6) @interpolate(flat) tileColor: vec3f'
        )
        expect(terrainShader).to.include('fn logicalTileColor(')
        expect(terrainShader).to.include('fn barycentricForVertex(')
        expect(terrainShader).to.include('@fragment\nfn fTileWireframe(')
        expect(terrainShader).to.include('fwidth(input.barycentric)')
        expect(terrainShader).to.include('discard;')
        const tileColorFunction = terrainShader.slice(
            terrainShader.indexOf('fn logicalTileColor('),
            terrainShader.indexOf('fn barycentricForVertex(')
        )
        expect(tileColorFunction).to.include('instance.matrixLevel')
        expect(tileColorFunction).to.include('instance.tileRow')
        expect(tileColorFunction).to.include('instance.tileCol')
        expect(tileColorFunction).not.to.include('physicalSlot')
        const layer = read(
            'packages', 'geoscratch', 'src', 'geo', 'terrain-field-renderer.ts'
        )
        const main = read('examples', 'demLayer', 'main.ts')
        expect(layer).not.to.include('createExternalImageUploadCommand')
        expect(layer).not.to.include('DEM elevation texture')
        expect(main).not.to.include("./assets/dem.png")
        expect(browserProof).to.include('visibleNodeCount')
        expect(browserProof).to.include("scenario('mobile-pitch70-bearing90-z10', 10, 70, 90, {")
        expect(browserProof).to.include('width: 390, height: 844')
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
        const graph = await createTestTerrainRenderer({
            runtime,
            surface,
            virtualRaster,
            size: { width: 320, height: 180 },
            observeProvenance() {
                throw provenanceFailure
            },
        })
        const initialized = await graph.initialize()
        await initialized.observation

        const frame = await graph.renderFrame(cameraState(9, [ 320, 180 ]))
        expect(frame.provenance).to.have.length(6)
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
        const graph = await createTestTerrainRenderer({
            runtime,
            surface,
            virtualRaster,
            size: { width: 320, height: 180 },
        })
        const initialIdentityHash = graph.stableIdentityHash
        const initialIdentities = graph.stableIdentities
        const initialIdentityFacts = graph.stableIdentityFacts
        const initialPersistentFacts = graph.persistentFacts()
        expect(graph.state().terrainPresentation).to.equal('shaded')
        const initialized = await graph.initialize()
        await initialized.observation

        const first = await graph.renderFrame(cameraState(9, [ 320, 180 ]))
        await first.observation
        const shadedPipelineLabel = latestRenderPipelineLabel(fake.calls)
        graph.setPresentation('tile-wireframe')
        const second = await graph.renderFrame(cameraState(10, [ 320, 180 ]))
        await second.observation
        const wireframePipelineLabel = latestRenderPipelineLabel(fake.calls)
        graph.setPresentation('shaded')
        const third = await graph.renderFrame(cameraState(10, [ 320, 180 ]))
        await third.observation
        const restoredPipelineLabel = latestRenderPipelineLabel(fake.calls)

        expect(second.needsFollowUp).to.equal(true)
        expect(second.feedback).to.equal(undefined)
        expect(shadedPipelineLabel).to.equal('DEM terrain pipeline')
        expect(wireframePipelineLabel).to.equal('DEM tile wireframe pipeline')
        expect(restoredPipelineLabel).to.equal('DEM terrain pipeline')
        expect(graph.state().terrainPresentation).to.equal('shaded')
        expect(fake.calls.renderPipelines.map(pipeline => (
            logicalPipelineLabel(pipeline.descriptor.label)
        )))
            .to.deep.equal([
                'DEM terrain pipeline',
                'DEM tile wireframe pipeline',
            ])

        expect(first.provenance.map(fact => fact.name)).to.deep.equal([
            'frontier-map-meta-to-render-patch',
            'frontier-visible-to-render-patch',
            'frontier-indirect-to-render-patch',
            'render-patch-visible-to-terrain-draw',
            'render-patch-lookup-to-terrain-draw',
            'render-patch-indirect-to-terrain-draw',
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
            uploads: 4,
            bindLayouts: 11,
            bindSets: 20,
            programs: 10,
            pipelines: 10,
            passes: 2,
            commands: 34,
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
            frame: 3,
            resizeGeneration: 1,
            lastResizeFacts: resizeFacts,
            terrainPresentation: 'shaded',
        })
        expect(graph.contractFacts()).to.deep.include({
            countPath: 'gpu-produced-indirect-arguments',
            selectionPath: 'gpu-resident-active-frontier',
            dataMaximumMatrixLevel: 10,
            renderMaximumMatrixLevel: 14,
        })
        expect(graph.contractFacts().renderPatches).to.deep.include({
            selectionPath: 'gpu-balanced-normalized-projected-grid-render-patches',
            maximumExtraLevels: 4,
            maximumMatrixLevel: 14,
            dataMaximumMatrixLevel: 10,
            maximumCellSpanPixels: 8,
            maximumPatchCountRatio: 3,
            biasStepsPerLevel: 4,
            biasStepCount: 17,
            refinementHysteresisLevels: 0.25,
            budgetHysteresisRatio: 0.75,
            balancePassCount: 14,
            balanceWorkgroupSize: 256,
            nominalPatchSpanPixels: 512,
            cellsPerPatchEdge: 64,
        })
        expect(graph.contractFacts().renderPatches.renderPatchLookupCapacity)
            .to.be.greaterThan(graph.contractFacts().renderPatches.maximumRenderPatches)
        expect(fake.calls.maps).to.have.length(4)
        expect(fake.calls.maps.filter(mapping => (
            mapping.size === graph.contractFacts().frontier.feedbackOutput.layout.byteLength
        ))).to.have.length(2)
        expect(fake.calls.maps.filter(mapping => mapping.size === 140)).to.have.length(2)

        graph.dispose()
        expect(() => graph.setPresentation('tile-wireframe'))
            .to.throw('disposed')
        expect(() => graph.setPresentation('invalid'))
            .to.throw('presentation')
        await runtime.dispose()
    })
})

function mainSourceFacts() {

    return read('examples', 'demLayer', 'main.ts')
}

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
        cameraPitchRadians: 0,
        zoomHint,
    })
}

function latestRenderPipelineLabel(calls) {

    const pass = calls.renderPasses.at(-1)
    const pipelineAction = pass?.actions.find(action => action.type === 'setPipeline')
    return logicalPipelineLabel(pipelineAction?.pipeline.descriptor.label)
}

function logicalPipelineLabel(label) {

    return label?.split(' [scratch:')[0]
}
