import { expect } from 'chai'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { GPURuntime } from 'geoscratch/scratch'
import {
    ViewDemandProducer,
    VirtualRasterResidency,
    WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT,
    createWebMercatorTerrainRenderer,
    createVirtualRasterGpuState,
    mapFieldLayer,
    ownedVirtualRasterPagePayload,
} from 'geoscratch/geo'
import {
    createDemTileSource,
} from '../examples/underwaterTerrain/dem-source.ts'
import {
    demCacheConfigurationForShard,
} from '../examples/underwaterTerrain/dem-tile-executor.ts'
import { underwaterTerrainViewAdapter } from '../examples/underwaterTerrain/map.ts'
import {
    createFakeCanvas,
    createFakeGpu,
} from './scratch-test-utils.js'
import { demWebMercatorManifest } from './fixtures/dem-webmercator-manifest.js'

const root = process.cwd()
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const demSource = createDemTileSource({
    manifest: demWebMercatorManifest,
    tileServerUrl: 'http://127.0.0.1:8787',
})
const demManifest = demSource.manifest

function sha256(value) {

    return crypto.createHash('sha256').update(value).digest('hex')
}

async function createTestVirtualRaster(runtime) {

    const model = demSource.model
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
        viewAdapter: underwaterTerrainViewAdapter,
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

    return createWebMercatorTerrainRenderer({
        runtime,
        surface,
        fieldLayer: createTestFieldLayer(virtualRaster),
        virtualRaster,
        size,
        presentationShader: read(
            'examples', 'underwaterTerrain', 'shaders', 'terrain-presentation.wgsl'
        ),
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
            {
                id: 'shaded',
                fragmentEntryPoint: 'fMain',
                label: 'Underwater Terrain pipeline',
            },
            {
                id: 'tile-wireframe',
                fragmentEntryPoint:
                    WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT,
                label: 'Underwater Terrain tile wireframe pipeline',
            },
        ],
        initialPresentation: 'shaded',
        ...(observeProvenance === undefined ? {} : { observeProvenance }),
    })
}

describe('Underwater Terrain clean cut', () => {

    it('keeps page bootstrap and explicit terrain application assembly context-bounded', () => {

        const applicationPath = path.join(
            root,
            'examples',
            'underwaterTerrain',
            'application.ts'
        )
        expect(fs.existsSync(applicationPath)).to.equal(true)
        const mainSource = read('examples', 'underwaterTerrain', 'main.ts')
        const applicationSource = fs.readFileSync(applicationPath, 'utf8')

        expect(mainSource.split('\n')).to.have.length.at.most(181)
        for (const forbidden of [
            'GPURuntime',
            'WorkerModuleCatalog',
            'createUnderwaterTerrainMap',
            'createDemVirtualRaster',
            'createWebMercatorTerrainRenderer',
            'createGeoFrameController',
            'mapLibreFrameDriver',
            'mapLibrePlanarViewSource',
        ]) expect(mainSource).not.to.include(forbidden)
        for (const required of [
            'GPURuntime.create(',
            'createUnderwaterTerrainMap(',
            'createDemVirtualRaster({',
            'createWebMercatorTerrainRenderer({',
            'mapLibrePlanarViewSource({',
            'mapLibreFrameDriver({',
            'createGeoFrameController({',
        ]) expect(applicationSource).to.include(required)
        expect(applicationSource).to.include('maximumInFlightFrames: 2')
        expect(applicationSource).not.to.match(/URLSearchParams|localStorage|tweakpane|Pane/)
        expect(`${mainSource}\n${applicationSource}`).not.to.include(
            "window.addEventListener('resize'"
        )
    })

    it('traverses Geo-owned render roots independently of the data frontier', () => {

        const layerSource = read(
            'packages', 'geoscratch', 'src', 'geo', 'web-mercator-terrain-renderer.ts'
        )
        const renderPatchSource = read(
            'packages', 'geoscratch', 'src', 'geo', 'gpu-render-patch-frontier.ts'
        )
        const renderPatchShader = read(
            'packages', 'geoscratch', 'src', 'geo', 'gpu-render-patch-frontier-wgsl.ts'
        )
        const terrainModule = read(
            'packages', 'geoscratch', 'src', 'geo', 'web-mercator-terrain-wgsl.ts'
        )
        const terrainShader = read(
            'examples', 'underwaterTerrain', 'shaders', 'terrain-presentation.wgsl'
        )

        expect(layerSource).to.include('createGpuRenderPatchFrontier(')
        expect(layerSource).to.include('renderPatchFrontier.encode(builder, frame)')
        expect(layerSource).to.include('renderPatchFrontier.capture(builder, frame)')
        expect(layerSource).to.include("'render-patch-compute'")
        expect(renderPatchSource).to.include('GPU_RENDER_PATCH_MAXIMUM_MATRIX_LEVEL = 14')
        expect(renderPatchSource).not.to.include('GPU_RENDER_PATCH_MAXIMUM_EXTRA_LEVELS')
        expect(renderPatchSource).not.to.include('dataMaximumMatrixLevel')
        expect(renderPatchSource).to.include('renderMaximumMatrixLevel')
        expect(renderPatchSource).to.include('renderRoots')
        expect(renderPatchSource).to.include('viewTemplates')
        expect(renderPatchSource).to.include('maximumCellSpanPixels')
        expect(renderPatchSource).to.include(
            'GPU_RENDER_PATCH_DEFAULT_MAXIMUM_CELL_SPAN_PIXELS = 8'
        )
        expect(renderPatchSource).to.include('decodeGpuRenderPatchState')
        expect(renderPatchSource).to.include('createReadbackCommand')
        expect(renderPatchSource).to.include('renderPatchLookupCapacity')
        expect(renderPatchSource).not.to.include('previousRenderPatchLookup')
        expect(renderPatchShader).not.to.include('sourceVisibleInstances')
        expect(renderPatchShader).not.to.include('sourceDrawArguments')
        expect(renderPatchShader).not.to.include('.samplingLevel')
        expect(renderPatchShader).to.include('projectedCellSpanPixels')
        expect(renderPatchShader).to.include('projectedAxisCellDeltaPixels')
        expect(renderPatchShader).to.include('projectedCellAreaScalePixels')
        expect(renderPatchShader).to.include('clipPolygonToPlane')
        expect(renderPatchShader).to.include('plane < 6u')
        expect(renderPatchShader).to.include(
            'startDistance / (startDistance - endDistance)'
        )
        expect(renderPatchShader).not.to.include('return 65535.0f')
        expect(renderPatchShader).not.to.include('historyAwareRefinementThreshold')
        expect(renderPatchShader).not.to.include('previousLookupContains')
        expect(renderPatchShader).to.include('cellSpanPixels > nominalThreshold')
        expect(renderPatchShader).to.include('var stack: array<GpuRenderPatch, 64>')
        expect(renderPatchShader).to.include('let nominalPatchSpan = max(')
        expect(renderPatchShader).to.include('countRenderPatchTrials')
        expect(renderPatchShader).to.include('selectRenderPatchBudget')
        expect(renderPatchShader).to.include('trialCounts')
        expect(renderPatchShader).to.include('step < finalStep &&')
        expect(renderPatchShader).to.include(
            'previousTrialCount >= renderPatchPolicy.maximumRenderPatches'
        )
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
        expect(terrainModule).to.include('gpuRenderPatchReadWgslModule(')
        expect(terrainModule).to.include('_sample_vertex')
        expect(terrainModule).to.include('_signed_difference_f32')
        expect(terrainModule).to.include('_snap_edge_coordinate')
        expect(terrainShader).not.to.match(/renderPatchLookup|neighboringPatch|snapEdgeCoordinate/)
        expect(fs.existsSync(path.join(
            root,
            'examples',
            'underwaterTerrain',
            'dem-render-patch-frontier.ts'
        ))).to.equal(false)
        expect(fs.existsSync(path.join(
            root,
            'examples',
            'underwaterTerrain',
            'shaders',
            'render-patch-frontier.wgsl'
        ))).to.equal(false)
        expect(fs.existsSync(path.join(
            root,
            'examples',
            'underwaterTerrain',
            'shaders',
            'lod-map.wgsl'
        ))).to.equal(false)
    })

    it('uses a rotation-invariant local projected-cell area scale', () => {

        const renderPatchShader = read(
            'packages', 'geoscratch', 'src', 'geo', 'gpu-render-patch-frontier-wgsl.ts'
        )
        const axisProductScale = (x, y) => Math.sqrt(Math.hypot(...x) * Math.hypot(...y))
        const areaScale = (x, y) => Math.sqrt(Math.abs(x[0] * y[1] - x[1] * y[0]))
        const x = [ 12, 0 ]
        const y = [ 0, 1 ]
        const cosine = Math.SQRT1_2
        const sine = Math.SQRT1_2
        const rotatedX = [
            cosine * x[0] + sine * y[0],
            cosine * x[1] + sine * y[1],
        ]
        const rotatedY = [
            -sine * x[0] + cosine * y[0],
            -sine * x[1] + cosine * y[1],
        ]
        const fartherRotatedX = rotatedX.map((value) => value * 0.5)
        const fartherRotatedY = rotatedY.map((value) => value * 0.5)

        expect(axisProductScale(rotatedX, rotatedY)).to.be.greaterThan(
            axisProductScale(x, y) * 2
        )
        expect(axisProductScale(fartherRotatedX, fartherRotatedY)).to.be.greaterThan(
            axisProductScale(x, y)
        )
        expect(areaScale(rotatedX, rotatedY)).to.be.closeTo(areaScale(x, y), 1e-12)
        expect(areaScale(fartherRotatedX, fartherRotatedY)).to.be.lessThan(
            areaScale(x, y)
        )
        expect(renderPatchShader).to.include('fn projectedCellAreaScalePixels(')
        expect(renderPatchShader).to.include(
            'xPixels.x * yPixels.y - xPixels.y * yPixels.x'
        )
        expect(renderPatchShader).to.include('let minimumCellW = clip.w - 0.5f * (')
        expect(renderPatchShader).to.include('if (minimumCellW <= 1e-5f)')
        expect(renderPatchShader).not.to.include('sqrt(xSpan * ySpan)')
    })

    it('uses a GPU-resident frontier without a CPU selection compatibility path', () => {

        const layerSource = read(
            'packages', 'geoscratch', 'src', 'geo', 'web-mercator-terrain-renderer.ts'
        )
        const virtualRasterSource = read('examples', 'underwaterTerrain', 'dem-source.ts')
        const mapSource = read('examples', 'underwaterTerrain', 'map.ts')
        const mapAdapterSource = read(
            'packages', 'geoscratch', 'src', 'geo', 'maplibre-planar-view.ts'
        )

        expect(layerSource).to.include('GpuTileFrontier.create(')
        expect(layerSource).to.include('fieldLayer.viewAdapter.read(input')
        expect(layerSource).to.include('spatialProfile: fieldLayer.spatialProfile')
        expect(layerSource).to.include('frontier.encode(builder, frame)')
        expect(layerSource).to.include('feedbackRing.encode(builder, frame)')
        expect(layerSource).to.include("feedback.facts.convergenceState === 'transitioning'")
        expect(layerSource).to.include('ready.decisionSerial !== latestDecisionSerial')
        expect(layerSource).to.include('latestSettledDecisionKey = undefined')
        expect(layerSource).to.include('clearDecisionFeedback(state)')
        expect(layerSource).to.include('feedbackCaptureAvailable(graph, frame)')
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
        const browserProofAdapter = read(
            'tests', 'browser', 'support', 'underwater-terrain-proof.ts'
        )
        expect(browserProofAdapter).to.include(
            'canvas.dataset.cpuSelectionUploadCount = \'0\''
        )
        expect(browserProofAdapter).to.include('canvas.dataset.frontier = JSON.stringify(')
        expect(browserProofAdapter).to.include('canvas.dataset.cameraView = JSON.stringify(')
        expect(mapSource).not.to.match(/\bcenter(?:High|Low)\b|\bcameraPos\b/)
    })

    it('separates application cache policy, pure control state, and browser panel ownership', () => {

        const policy = read('examples', 'underwaterTerrain', 'cache-policy.ts')
        const state = read('examples', 'underwaterTerrain', 'control-state.ts')
        const panel = read('examples', 'underwaterTerrain', 'control-panel.ts')
        const main = read('examples', 'underwaterTerrain', 'main.ts')

        expect(fs.existsSync(path.join(
            root,
            'examples',
            'underwaterTerrain',
            'cache-policy.ts'
        ))).to.equal(true)
        expect(fs.existsSync(path.join(
            root,
            'examples',
            'underwaterTerrain',
            'dem-cache-policy.ts'
        ))).to.equal(false)
        expect(fs.existsSync(path.join(
            root,
            'examples',
            'underwaterTerrain',
            'dem-controls.ts'
        ))).to.equal(false)
        expect(policy).not.to.match(/tweakpane|\b(?:window|document|Storage|HTMLElement|Location)\b/)
        expect(state).not.to.match(/tweakpane|\b(?:window|document|Storage|HTMLElement|Location)\b/)
        expect(panel).to.include("from 'tweakpane'")
        expect(panel).to.include("from './cache-policy.ts'")
        expect(panel).to.include("from './control-state.ts'")
        expect(main).to.include("from './cache-policy.ts'")
        expect(main).to.include("from './control-panel.ts'")
        expect(main).not.to.include("from './dem-controls.ts'")
    })

    it('keeps active browser proofs under the Underwater Terrain identity', () => {

        const browserProofs = [
            'scratch-underwater-terrain.mjs',
            'underwater-terrain-cache-panel.mjs',
            'underwater-terrain-streaming.mjs',
            'underwater-terrain-tile-wireframe.mjs',
        ]
        for (const proof of browserProofs) {
            expect(read('tests', 'browser', proof)).not.to.include('GEO_VIRTUAL_RASTER_DEM')
        }
        expect(fs.existsSync(path.join(
            root,
            'tests',
            'browser',
            'geo-virtual-raster-dem.mjs'
        ))).to.equal(false)
    })

    it('keeps application controls and generic Worker budgets out of the DEM data suite', () => {

        const demSuite = read('tests', 'geo-virtual-raster-dem.test.js')
        const controlSuite = read('tests', 'underwater-terrain-control-state.test.js')
        const budgetSuite = read('tests', 'scratch-task-phase-budget.test.js')

        expect(demSuite).not.to.include('control-state.ts')
        expect(demSuite).not.to.include('control-panel.ts')
        expect(demSuite).not.to.include('TaskPhaseBudget')
        expect(controlSuite).to.include("describe('Underwater Terrain control state'")
        expect(budgetSuite).to.include("describe('Scratch task phase budget'")
        expect(budgetSuite).not.to.match(/\bDEM\b|\bDem\b|\bdem\b/)
    })

    it('partitions the application cache budget exactly across Worker shards', () => {

        const policy = Object.freeze({
            mode: 'persistent',
            namespace: 'dem-test',
            maxPayloadBytes: 10_000,
            maxEntries: 2,
            requestPersistence: true,
            lifecycle: Object.freeze({ kind: 'session' }),
        })
        const configurations = Array.from({ length: 4 }, (_, shard) =>
            demCacheConfigurationForShard(policy, shard, 4)
        )

        expect(configurations.map(value => value.mode)).to.deep.equal([
            'persistent', 'persistent', 'none', 'none',
        ])
        expect(configurations
            .filter(value => value.mode === 'persistent')
            .reduce((sum, value) => sum + value.descriptor.maxEntries, 0)
        ).to.equal(2)
        expect(configurations
            .filter(value => value.mode === 'persistent')
            .reduce((sum, value) => sum + value.descriptor.maxPayloadBytes, 0)
        ).to.equal(10_000)
        expect(configurations[0].descriptor.requestPersistence).to.equal(true)
        expect(configurations[1].descriptor.requestPersistence).to.equal(false)
    })

    it('keeps one DEM source authority and delegates executor disposal to Geo', () => {

        const source = read('examples', 'underwaterTerrain', 'dem-source.ts')
        const tileUrlBody = source.slice(
            source.lastIndexOf('tileUrl(page: VirtualRasterPageIdentity)'),
            source.indexOf('/** Fetches the mutable manifest endpoint')
        )

        expect(fs.existsSync(path.join(
            root,
            'examples',
            'underwaterTerrain',
            'dem-virtual-raster.ts'
        ))).to.equal(false)
        expect((source.match(/parseDemVirtualRasterManifest\(/g) ?? [])).to.have.length(2)
        expect(tileUrlBody).not.to.include('parseDemVirtualRasterManifest')
        expect(tileUrlBody).not.to.include('structuredClone')
        expect(source).to.include("ownership: 'owned'")
        expect(source).not.to.include("ownership: 'borrowed'")
        expect(source).not.to.include('inspect: () =>')
        expect(source).not.to.include('let stopped')
    })

    it('uses the neutral route and removes every legacy DEM owner', () => {

        expect(fs.existsSync(path.join(root, 'examples', 'underwaterTerrain', 'index.html'))).to.equal(true)
        expect(fs.existsSync(path.join(root, 'examples', 'underwaterTerrain', 'terrain-selection.ts')))
            .to.equal(false)
        expect(fs.existsSync(path.join(root, 'examples', 'm_demLayer'))).to.equal(false)
        expect(fs.existsSync(path.join(root, 'examples', 'shared', 'scratchMap.js'))).to.equal(false)
        expect(fs.existsSync(path.join(root, 'packages', 'geoscratch', 'src', 'applications', 'terrain'))).to.equal(false)
    })

    it('uses only the current public Scratch graph and keeps persistent construction out of frames', () => {

        const layerSource = read(
            'packages', 'geoscratch', 'src', 'geo', 'web-mercator-terrain-renderer.ts'
        )
        const mainSource = read('examples', 'underwaterTerrain', 'main.ts')
        const applicationSource = read('examples', 'underwaterTerrain', 'application.ts')
        const frameSource = layerSource.slice(
            layerSource.indexOf('async function submitFrame(input: ViewInput)'),
            layerSource.indexOf('async function resize(nextSize: SurfaceSize)')
        )
        const submissionSource = frameSource.slice(0, frameSource.indexOf('function startFeedbackPump'))
        const allSources = [
            layerSource,
            mainSource,
            applicationSource,
            read('examples', 'underwaterTerrain', 'map.ts'),
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
        expect(frameSource).to.include('virtualRaster.reconcileFeedback(feedback, consumed.view)')
        expect(submissionSource).not.to.include('await consumeFeedback')
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

    it('delegates MapLibre frame authority through one public driver entry', () => {

        const mainSource = read('examples', 'underwaterTerrain', 'main.ts')
        const applicationSource = read('examples', 'underwaterTerrain', 'application.ts')

        expect(applicationSource).to.include('driver: mapLibreFrameDriver({')
        expect(applicationSource).to.include("id: 'underwater-terrain-maplibre-frames'")
        expect(applicationSource).to.include('mapLibrePlanarViewSource({')
        expect(applicationSource).to.include('return graph.render(captured)')
        const combined = `${mainSource}\n${applicationSource}`
        expect(combined).not.to.match(/\bhostViewRevision\b|\bcachedHostCapture\b/)
        expect(combined).not.to.include("map.on('render'")
        expect(combined).not.to.include("map.on('move'")
        expect(combined).not.to.include("map.on('resize'")
        expect(combined).not.to.include('frameController.invalidateNow()')
        expect(combined).not.to.include('graph.renderFrame(')
        expect(combined).not.to.include('graph.resize(')
        expect(combined).not.to.include('requestedPageCount')
    })

    it('locks the finite initialization faults and required migration documentation', () => {

        const mainSource = read('examples', 'underwaterTerrain', 'main.ts')
        const lifecycleCreation = mainSource.indexOf(
            "const pageLifetime = new LifetimeScope({ label: 'underwater-terrain-page' })"
        )
        const pageHideRegistration = mainSource.indexOf("window.addEventListener('pagehide'")
        const initializationStart = mainSource.indexOf(
            "pageLifetime.track(initializePage(), 'underwater-terrain-page-initialization')"
        )
        const applicationSource = read('examples', 'underwaterTerrain', 'application.ts')
        const proofAdapter = read('tests', 'browser', 'support', 'underwater-terrain-proof.ts')
        const frameController = read(
            'packages', 'geoscratch', 'src', 'geo', 'frame-controller.ts'
        )
        const faultNames = [ ...proofAdapter.matchAll(/'((?:after-map-acquisition|invalid-terrain-shader-wgsl))'/g) ]
            .map(match => match[1])

        expect(faultNames).to.deep.equal([
            'after-map-acquisition',
            'invalid-terrain-shader-wgsl',
        ])
        expect(lifecycleCreation).to.be.greaterThan(-1)
        expect(pageHideRegistration).to.be.greaterThan(lifecycleCreation)
        expect(initializationStart).to.be.greaterThan(pageHideRegistration)
        expect(proofAdapter).to.include('FAILURE_CAPTURE_BOUNDS')
        expect(proofAdapter).to.include('retainsWgslSource')
        expect(applicationSource).to.include("proof?.reach('after-map-acquisition')")
        expect(applicationSource).to.include('proof?.beforeTerrainShaderModule(runtime)')
        expect(mainSource).to.include("'underwater-terrain-page-initialization'")
        expect(applicationSource).to.include('const frameController = createGeoFrameController({')
        expect(applicationSource).to.include('track: (work, label) => lifetime.track(work, label)')
        expect(`${mainSource}\n${applicationSource}`).not.to.include('requestAnimationFrame(')
        expect(frameController).to.include('`geo-frame-${frameNumber}`')

        for (const documentation of [
            'docs/decisions/ADR-045-dem-layer-scratch-api-clean-cut.md',
            'docs/review/scratch-underwater-terrain-migration-audit.md',
            'tests/browser/scratch-underwater-terrain.mjs',
        ]) {
            expect(fs.existsSync(path.join(root, documentation)), documentation).to.equal(true)
        }
        const review = read('docs', 'review', 'scratch-api-intelligent-friendly-review.md')
        const audit = read('docs', 'review', 'scratch-underwater-terrain-migration-audit.md')
        expect(review).to.include('Underwater Terrain Persistent Graph And Application-Owned LoD')
        expect(audit).to.include('## One-To-One Source Matrix')
        expect(audit).to.include('## Managed Browser Evidence')

        for (const documentation of [
            'README.md',
            'README_zh.md',
            'packages/geoscratch/README.md',
            'packages/geoscratch/README_zh.md',
        ]) {
            const source = read(...documentation.split('/'))
            expect(source).to.include('| Underwater Terrain | `examples/underwaterTerrain/` |')
            expect(source).not.to.include('Underwater Terrain (legacy)')
            expect(source).not.to.include('m_demLayer')
        }
    })

    it('preserves the DEM payload and enumerates every reachable WGSL correction', () => {

        const demBytes = fs.readFileSync(path.join(root, 'examples', 'underwaterTerrain', 'assets', 'dem.png'))
        const terrainShader = read(
            'examples', 'underwaterTerrain', 'shaders', 'terrain-presentation.wgsl'
        )
        const terrainModule = read(
            'packages', 'geoscratch', 'src', 'geo', 'web-mercator-terrain-wgsl.ts'
        )
        const browserProof = read('tests', 'browser', 'scratch-underwater-terrain.mjs')

        expect(sha256(demBytes)).to.equal('aa7a584830f198772d242df1ce1ae47e21b2bdc85bfc1f97101af8be986c57e1')
        expect(terrainShader).not.to.include('var<storage')
        expect(terrainShader).not.to.match(/\b(lSampler|palette|colorMap)\b/)
        expect(terrainShader).not.to.include('demTexture')
        expect(terrainShader).not.to.match(/nodeBox|canonicalNodes|cameraCoordinate/)
        expect(terrainShader).to.include('WebMercatorTerrainVertexOutput')
        expect(terrainShader).to.include('@fragment\nfn fMain(')
        expect(terrainShader).not.to.match(/DemHeight|DemAddress|fixedAxis|relativeFixed/)
        expect(terrainShader).not.to.match(/grid\.x|barycentric|tileColor|fTileWireframe/)
        expect(terrainModule).to.include('_sample_vertex')
        expect(terrainModule).to.include('_tile_wireframe')
        expect(terrainModule).to.include('_logical_tile_color')
        expect(terrainModule).to.include('_barycentric_for_vertex')
        const layer = read(
            'packages', 'geoscratch', 'src', 'geo', 'web-mercator-terrain-renderer.ts'
        )
        const main = read('examples', 'underwaterTerrain', 'main.ts')
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
            label: 'Underwater Terrain provenance-failure surface',
            format: 'rgba8unorm',
            alphaMode: 'premultiplied',
            size: { width: 320, height: 180 },
        })
        const provenanceFailure = new Error('injected Underwater Terrain provenance mismatch')
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

        const result = await graph.render(terrainCapture(9, [ 320, 180 ]))
        const frame = result.value.frame
        expect(frame.provenance).to.have.length(4)
        let observedFailure
        try {
            await result.observation
        } catch (error) {
            observedFailure = error
        }

        expect(observedFailure).to.equal(provenanceFailure)
        expect(fake.calls.queueSubmissions.length).to.be.greaterThan(0)
        expect(fake.calls.submittedWorkDoneRegistrations.length).to.be.greaterThan(2)
        graph.dispose()
        await runtime.dispose()
    })

    it('keeps one persistent Underwater Terrain graph across camera changes and resize', async() => {

        const fake = createFakeGpu()
        const runtime = await GPURuntime.create({ gpu: fake.gpu })
        const fakeCanvas = createFakeCanvas()
        const surface = runtime.createSurface(fakeCanvas.canvas, {
            label: 'Underwater Terrain test surface',
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

        const firstResult = await graph.render(terrainCapture(9, [ 320, 180 ]))
        await firstResult.observation
        const first = firstResult.value.frame
        const shadedPipelineLabel = latestRenderPipelineLabel(fake.calls)
        graph.setPresentation('tile-wireframe')
        const secondResult = await graph.render(terrainCapture(10, [ 320, 180 ]))
        await secondResult.observation
        const second = secondResult.value.frame
        const wireframePipelineLabel = latestRenderPipelineLabel(fake.calls)
        graph.setPresentation('shaded')
        const thirdResult = await graph.render(terrainCapture(10, [ 320, 180 ]))
        await thirdResult.observation
        const restoredPipelineLabel = latestRenderPipelineLabel(fake.calls)

        expect(secondResult.needsFollowUp).to.equal(true)
        const secondSettlement = await secondResult.settlement
        expect(secondSettlement.residencyWorkCount).to.be.a('number')
        expect(secondSettlement).not.to.have.property('requestedPageCount')
        expect(shadedPipelineLabel).to.equal('Underwater Terrain pipeline')
        expect(wireframePipelineLabel).to.equal('Underwater Terrain tile wireframe pipeline')
        expect(restoredPipelineLabel).to.equal('Underwater Terrain pipeline')
        expect(graph.state().terrainPresentation).to.equal('shaded')
        expect(fake.calls.renderPipelines.map(pipeline => (
            logicalPipelineLabel(pipeline.descriptor.label)
        )))
            .to.deep.equal([
                'Underwater Terrain pipeline',
                'Underwater Terrain tile wireframe pipeline',
            ])

        expect(first.provenance.map(fact => fact.name)).to.deep.equal([
            'frontier-map-meta-to-render-patch',
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
            uploads: 5,
            bindLayouts: 12,
            bindSets: 22,
            programs: 11,
            pipelines: 11,
            passes: 2,
            commands: 36,
        })
        expect(graph.persistentFacts()).to.deep.equal(initialPersistentFacts)

        const resizedResult = await graph.render(terrainCapture(10, [ 640, 360 ]))
        await resizedResult.observation
        const resizeFacts = graph.state().lastResizeFacts
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
            frame: 4,
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
            selectionPath:
                'gpu-balanced-error-cohort-filled-render-root-local-cell-projection',
            maximumMatrixLevel: 14,
            renderRootCount: 1,
            minimumRootMatrixLevel: 4,
            maximumRootMatrixLevel: 4,
            maximumCellSpanPixels: 8,
            maximumPatchCountRatio: 3,
            biasStepsPerLevel: 4,
            biasStepCount: 17,
            balancePassCount: 14,
            balanceWorkgroupSize: 256,
            budgetFillWorkgroupSize: 1,
            nominalPatchSpanPixels: 512,
            cellsPerPatchEdge: 64,
        })
        expect(graph.contractFacts().renderPatches.renderPatchLookupCapacity)
            .to.be.greaterThan(graph.contractFacts().renderPatches.maximumRenderPatches)
        expect(fake.calls.maps).to.have.length(4)
        expect(fake.calls.maps.filter(mapping => (
            mapping.size === graph.contractFacts().frontier.feedbackOutput.layout.byteLength
        ))).to.have.length(2)
        expect(fake.calls.maps.filter(mapping => mapping.size === 148)).to.have.length(2)
        expect(graph).not.to.have.any.keys('renderFrame', 'resize')

        graph.dispose()
        expect(() => graph.setPresentation('tile-wireframe'))
            .to.throw('disposed')
        expect(() => graph.setPresentation('invalid'))
            .to.throw('presentation')
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
        cameraPitchRadians: 0,
        zoomHint,
    })
}

function terrainCapture(zoomHint, viewport) {

    return Object.freeze({
        view: cameraState(zoomHint, viewport),
        size: Object.freeze({ width: viewport[0], height: viewport[1] }),
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
