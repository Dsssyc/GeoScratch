import { snapshotWebMercatorCoverVerticalBounds } from './gpu-web-mercator-quad-cover-vertical-bounds.js'
import {
    GPURuntime,
    plane,
    type BindLayoutEntry,
    type BindVisibility,
    type BufferResource,
    type LayoutCodec,
    type Program,
    type ProgramBufferLayoutRequirement,
    type RenderPipeline,
    type SubmittedWork,
    type Surface,
    type SurfaceSize,
    type TextureResource,
} from '../scratch/index.js'
import {
    GpuWebMercatorQuadCover,
    gpuWebMercatorQuadCoverPolicy,
    type GpuWebMercatorQuadCoverFeedback,
    type GpuWebMercatorQuadCoverFrame,
    type WebMercatorTileVerticalBounds,
} from './gpu-web-mercator-quad-cover.js'
import {
    GpuWebMercatorQuadDemandProjection,
    type GpuWebMercatorQuadDemandProjectionFeedback,
    type GpuWebMercatorQuadDemandProjectionFrame,
} from './gpu-web-mercator-quad-demand.js'
import {
    GpuWebMercatorQuadPatchDraw,
    type GpuWebMercatorQuadPatchDrawFrame,
} from './gpu-web-mercator-quad-patch-draw.js'
import type {
    GeoViewSnapshot,
    GeoViewSourceCapture,
} from './geo-view.js'
import type {
    GeoFrameResult,
    GeoFrameSettlement,
} from './frame-controller.js'
import type { MapFieldLayer } from './map-field-layer.js'
import {
    WEB_MERCATOR_QUAD_HALF_WORLD,
    WEB_MERCATOR_QUAD_WORLD_WIDTH,
    WebMercatorQuad,
} from './web-mercator-quad.js'
import type { WebMercatorVirtualRasterField } from './web-mercator-virtual-raster-field.js'
import { webMercatorVirtualRasterWgslModule } from './web-mercator-virtual-raster-wgsl.js'
import {
    WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT,
    webMercatorTerrainConfigCodec,
    webMercatorTerrainWgslModule,
} from './web-mercator-terrain-wgsl.js'
import type {
    VirtualRasterFeedbackReconciliation,
    VirtualRasterRuntime,
    VirtualRasterRuntimeFacts,
    VirtualRasterRuntimePublication,
} from './virtual-raster-runtime.js'

export type WebMercatorTerrainPresentationDescriptor<Presentation extends string = string> =
    Readonly<{
        id: Presentation
        fragmentEntryPoint: string
        label?: string
    }>

export type WebMercatorTerrainSamplingWgslOptions = Readonly<{
    namespace: string
    addressNamespace: string
    transitionTexels?: number
}>

/** Immutable source elevation range for one standard terrain tile. */
export type WebMercatorTerrainElevationBounds = Readonly<{
    matrixLevel: number
    tileRow: number
    tileCol: number
    minimumElevationMeters: number
    maximumElevationMeters: number
}>

export type WebMercatorTerrainProvenanceFact = Readonly<{
    name: string
    resourceId: string
    declaredContentEpoch: 'current-at-step'
    producerContentEpoch: number
    readContentEpoch: number
    producerStepIndex: number
    consumerStepIndex: number
}>

export type WebMercatorTerrainResizeFacts = Readonly<{
    resizeGeneration: number
    staleBindSetCount: number
    preparedBindSetCount: number
    depthAllocationVersion: number
}>

export type WebMercatorTerrainSubmissionObservation = Readonly<{
    submissionId: string
    nativeStatus: 'observed-succeeded'
}>

export type WebMercatorTerrainInitialization = Readonly<{
    submitted: SubmittedWork
    observation: Promise<WebMercatorTerrainSubmissionObservation>
}>

/** Async cover observations and resource progress; superseded observations never certify the current view. */
export type WebMercatorTerrainFrameSettlement = GeoFrameSettlement & Readonly<{
    coverFeedback?: GpuWebMercatorQuadCoverFeedback
    demandFeedback?: GpuWebMercatorQuadDemandProjectionFeedback
    reconciliation?: VirtualRasterFeedbackReconciliation
    residencySettlement: Promise<unknown>
    residencyWorkCount: number
    superseded: boolean
}>

/** Immediate identity and provenance facts for one submitted terrain frame. */
export type WebMercatorTerrainFrame<Presentation extends string = string> = Readonly<{
    submitted: SubmittedWork
    provenance: readonly WebMercatorTerrainProvenanceFact[]
    terrainPresentation: Presentation
}>

/** Terrain frame value paired with the exact view used for submission. */
export type WebMercatorTerrainFrameValue<
    ViewInput,
    Presentation extends string = string,
> = Readonly<{
    frame: WebMercatorTerrainFrame<Presentation>
    view: ViewInput
}>

export type WebMercatorTerrainIdentityFacts = Readonly<{
    hash: string
    count: number
    resources: number
    uploads: number
    bindLayouts: number
    bindSets: number
    programs: number
    pipelines: number
    passes: number
    commands: number
}>

export type WebMercatorTerrainPersistentFacts = Readonly<{
    resources: number
    bindLayouts: number
    bindSets: number
    pipelines: number
    logicalFootprintBytes: number
}>

export type WebMercatorTerrainContractFacts = Readonly<{
    stageOrder: readonly string[]
    countPath: 'gpu-produced-indirect-arguments'
    selectionPath: 'gpu-camera-inverse-webmercatorquad-cover'
    sourceMaximumMatrixLevel: number
    coverMaximumMatrixLevel: number
    fieldLayer: Readonly<{
        id: string
        fieldId: string
        representationId: string
        spatialProfileId: string
        viewAdapterId: string
        demandProducerId: string
    }>
    terrainElementCount: number
    cover: ReturnType<GpuWebMercatorQuadCover['facts']>
    demandProjection: ReturnType<GpuWebMercatorQuadDemandProjection['facts']>
    patchDraw: ReturnType<GpuWebMercatorQuadPatchDraw['facts']>
    virtualRaster: Readonly<{
        sourceRevision: string
        pageSize: readonly number[]
        levelCount: number
        maxPhysicalPages: number
        completeImageUpload: false
        crossPageFiltering: 'logical-bilinear'
        coordinateEncoding: WebMercatorVirtualRasterField['addressCodec']['positionCodec']['facts']['encoding']
    }>
    persistentIdentityCount: number
    passIds: Readonly<{
        cover: string
        demandProjection: string
        patchDraw: string
        terrain: string
    }>
    commandIds: Readonly<{
        cover: readonly (readonly string[])[]
        demandProjection: readonly (readonly string[])[]
        patchDraw: readonly string[]
        drawTerrain: Readonly<Record<string, readonly string[]>>
    }>
}>

export type WebMercatorTerrainRendererState<Presentation extends string = string> = Readonly<{
    initialized: boolean
    disposed: boolean
    frame: number
    size: SurfaceSize
    resizeGeneration: number
    staleBindSetPreparationCount: number
    lastResizeFacts?: WebMercatorTerrainResizeFacts
    virtualSnapshotEpoch: number
    virtualRequestedPageCount: number
    readbackInFlightCount: number
    staleFeedbackCount: number
    supersededFeedbackCount: number
    coverCandidateCount: number
    coverPatchCount: number
    sourceDemandCount: number
    coverLevelRange: readonly [number | undefined, number | undefined]
    coverDescriptorOverflowCount: number
    coverLookupOverflowCount: number
    sourceDemandOverflowCount: number
    coverMaximumAdjacentLevelDelta: number
    coverFinestMatrixLevel?: number
    sourceLevelCeiling?: number
    coverFrameEpoch?: number
    coverFeedback?: GpuWebMercatorQuadCoverFeedback
    demandFeedback?: GpuWebMercatorQuadDemandProjectionFeedback
    convergenceState: 'converged' | 'transitioning'
    terrainPresentation: Presentation
}>

export type WebMercatorTerrainRenderer<
    ViewInput,
    Presentation extends string = string,
> = Readonly<{
    initialize(): Promise<WebMercatorTerrainInitialization>
    render(capture: GeoViewSourceCapture<ViewInput>): Promise<GeoFrameResult<
        WebMercatorTerrainFrameValue<ViewInput, Presentation>
    >>
    setPresentation(presentation: Presentation): Presentation
    dispose(): void
    stableIdentities: readonly string[]
    stableIdentityHash: string
    stableIdentityFacts: WebMercatorTerrainIdentityFacts
    currentIdentityFacts(): WebMercatorTerrainIdentityFacts
    persistentFacts(): WebMercatorTerrainPersistentFacts
    contractFacts(): WebMercatorTerrainContractFacts
    virtualRasterFacts(): VirtualRasterRuntimeFacts
    state(): WebMercatorTerrainRendererState<Presentation>
}>

export type WebMercatorTerrainRendererDescriptor<
    ViewInput,
    Presentation extends string = string,
> = Readonly<{
    runtime: GPURuntime
    surface: Surface
    fieldLayer: MapFieldLayer<ViewInput>
    virtualRaster: VirtualRasterRuntime<WebMercatorVirtualRasterField>
    size: SurfaceSize
    presentationShader: string
    fieldSampling: WebMercatorTerrainSamplingWgslOptions
    elevationRangeMeters: readonly [number, number]
    elevationBounds?: readonly WebMercatorTerrainElevationBounds[]
    exaggeration?: number
    presentations: readonly WebMercatorTerrainPresentationDescriptor<Presentation>[]
    initialPresentation: Presentation
    observeProvenance?: (facts: readonly WebMercatorTerrainProvenanceFact[]) => void
}>

type WebMercatorTerrainVirtualRaster = VirtualRasterRuntime<WebMercatorVirtualRasterField>
type WebMercatorTerrainMapField = Readonly<{
    id: string
    field: WebMercatorTerrainVirtualRaster['field']
    representation: WebMercatorTerrainVirtualRaster['representation']
    spatialProfile: WebMercatorTerrainVirtualRaster['spatialProfile']
    viewAdapter: Readonly<{ id: string }>
    demandProducer: WebMercatorTerrainVirtualRaster['viewDemandProducer']
}>
type TerrainGeometry = ReturnType<typeof createTerrainGeometry>
type Uniforms = Awaited<ReturnType<typeof createUniformResources>>
type Buffers = Awaited<ReturnType<typeof createBufferResources>>
type Textures = Awaited<ReturnType<typeof createTextures>>
type RenderTemplates = ReturnType<typeof createRenderTemplates>
type Layouts = Awaited<ReturnType<typeof createBindLayouts>>
type BindSets = Awaited<ReturnType<typeof createBindSets>>
type Programs = Awaited<ReturnType<typeof createPrograms>>
type Pipelines = Awaited<ReturnType<typeof createPipelines>>
type Passes = ReturnType<typeof createPasses>
type Commands = ReturnType<typeof createCommands>
type LayoutValues = Parameters<LayoutCodec['pack']>[0]
type BufferData = Uint32Array<ArrayBuffer>
type ContentResource = BufferResource | TextureResource

type WebMercatorTerrainGraph = {
    runtime: GPURuntime
    surface: Surface
    virtualRaster: WebMercatorTerrainVirtualRaster
    fieldLayer: WebMercatorTerrainMapField
    geometry: TerrainGeometry
    uniforms: Uniforms
    buffers: Buffers
    textures: Textures
    cover: GpuWebMercatorQuadCover
    demandProjection: GpuWebMercatorQuadDemandProjection
    patchDraw: GpuWebMercatorQuadPatchDraw
    renderTemplates: RenderTemplates
    layouts: Layouts
    bindSets: BindSets
    programs: Programs
    pipelines: Pipelines
    passes: Passes
    commands: Commands
}

type WebMercatorTerrainState<Presentation extends string = string> = {
    initialized: boolean
    disposed: boolean
    frame: number
    size: SurfaceSize
    resizeGeneration: number
    staleBindSetPreparationCount: number
    lastResizeFacts?: WebMercatorTerrainResizeFacts
    virtualSnapshotEpoch: number
    virtualRequestedPageCount: number
    staleFeedbackCount: number
    supersededFeedbackCount: number
    latestCoverFeedback?: GpuWebMercatorQuadCoverFeedback
    latestDemandFeedback?: GpuWebMercatorQuadDemandProjectionFeedback
    terrainPresentation: Presentation
}

type PersistentFacts = WebMercatorTerrainPersistentFacts

type PendingFeedback = Readonly<{
    coverFrame: GpuWebMercatorQuadCoverFrame
    demandFrame: GpuWebMercatorQuadDemandProjectionFrame
    view: GeoViewSnapshot
    submitted: SubmittedWork
    decisionKey: string
    decisionSerial: number
    settlement: Deferred<WebMercatorTerrainFrameSettlement>
}>

type ConsumedFeedback = Readonly<{
    decisionKey: string
    view: GeoViewSnapshot
    coverFeedback?: GpuWebMercatorQuadCoverFeedback
    demandFeedback?: GpuWebMercatorQuadDemandProjectionFeedback
}>

type Deferred<Value> = {
    promise: Promise<Value>
    resolve(value: Value): void
    reject(reason: unknown): void
    settled: boolean
}

type ActivePublication = Readonly<{
    publication: VirtualRasterRuntimePublication
    acknowledgment: Promise<void>
}>

const WEB_MERCATOR_TERRAIN_STAGE_ORDER = Object.freeze([
    'inverse-cover-compute',
    'source-demand-compute',
    'patch-draw-compute',
    'terrain',
])
const TERRAIN_SECTOR_SIZE = 128
const TERRAIN_COVER_MAXIMUM_MATRIX_LEVEL = 14
const TERRAIN_MAXIMUM_CELL_SPAN_REFERENCE_PIXELS = 5
const TERRAIN_REFINEMENT_TOLERANCE = 0.005
const BUFFER_COPY_DST = 0x08
const BUFFER_INDEX = 0x10
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80
const TEXTURE_RENDER_ATTACHMENT = 0x10

/**
 * Assembles a WebMercatorQuad Virtual Raster terrain renderer with GPU-driven
 * selection, conservative ancestor elevation envelopes, mesh stitching, and explicit lifetime.
 * Keeps current geometry certification separate from monotonic resource observations
 * and drives feedback/publication progress through bounded asynchronous settlement.
 */
export async function createWebMercatorTerrainRenderer<
    ViewInput,
    Presentation extends string,
>({
    runtime,
    surface,
    fieldLayer,
    virtualRaster,
    size,
    presentationShader,
    fieldSampling,
    elevationRangeMeters,
    elevationBounds,
    exaggeration = 1,
    presentations,
    initialPresentation,
    observeProvenance,
}: WebMercatorTerrainRendererDescriptor<ViewInput, Presentation>): Promise<
    WebMercatorTerrainRenderer<ViewInput, Presentation>
> {

    if (!(runtime instanceof GPURuntime)) {
        throw new TypeError('Web Mercator terrain renderer requires GPURuntime')
    }
    assertSize(size)
    assertVirtualRaster(virtualRaster)
    assertFieldLayer(fieldLayer, virtualRaster)
    assertPresentationShader(presentationShader)
    assertFieldSampling(fieldSampling)
    assertElevation(elevationRangeMeters, exaggeration)
    const presentationTable = normalizePresentations(presentations, initialPresentation)
    const terrainFieldLayer = fieldLayer as unknown as WebMercatorTerrainMapField
    if (observeProvenance !== undefined && typeof observeProvenance !== 'function') {
        throw new TypeError('Web Mercator terrain provenance observer must be a function')
    }

    const exaggeratedElevationRange = scaleElevationRange(elevationRangeMeters, exaggeration)
    const verticalBounds = snapshotWebMercatorCoverVerticalBounds(
        terrainCoverVerticalBounds(elevationBounds, exaggeration),
        terrainFieldLayer.spatialProfile.coverage.limits,
        exaggeratedElevationRange
    )
    const geometry = createTerrainGeometry()
    const buffers = await createBufferResources(runtime, geometry)
    const textures = await createTextures(runtime, size)
    const sourceMinimumMatrixLevel = Number(
        virtualRaster.coverage.limits[0]!.matrixId
    )
    const coverCapacity = terrainCoverCapacity(size)
    const cover = await GpuWebMercatorQuadCover.create(runtime, {
        spatialProfile: terrainFieldLayer.spatialProfile,
        policy: gpuWebMercatorQuadCoverPolicy({
            minimumMatrixLevel: sourceMinimumMatrixLevel,
            maximumMatrixLevel: TERRAIN_COVER_MAXIMUM_MATRIX_LEVEL,
            maximumPatches: coverCapacity,
            cellsPerPatchEdge: TERRAIN_SECTOR_SIZE,
            maximumCellSpanReferencePixels:
                TERRAIN_MAXIMUM_CELL_SPAN_REFERENCE_PIXELS,
            refinementTolerance: TERRAIN_REFINEMENT_TOLERANCE,
        }),
        verticalRangeMeters: exaggeratedElevationRange,
        ...(verticalBounds === undefined
            ? {}
            : { verticalBounds }),
    })
    const demandProjection = await GpuWebMercatorQuadDemandProjection.create(runtime, {
        cover,
        sourceCoverage: virtualRaster.coverage,
        maximumDemands: coverCapacity,
    })
    const patchDraw = await GpuWebMercatorQuadPatchDraw.create(runtime, {
        cover,
        elementCount: geometry.elementCount,
    })
    const renderTemplates = createRenderTemplates(cover, patchDraw)
    const uniforms = await createUniformResources(
        runtime,
        virtualRaster,
        cover.facts().lookupCapacity,
        elevationRangeMeters,
        exaggeration
    )
    const layouts = await createBindLayouts(
        runtime,
        renderTemplates.terrain[0].mapMeta.size
    )
    const bindSets = await createBindSets(
        runtime,
        layouts,
        uniforms,
        buffers,
        virtualRaster,
        renderTemplates
    )
    const programs = await createPrograms({
        runtime,
        presentationShader,
        fieldSampling,
        virtualRaster,
        presentations: presentationTable,
    })
    const pipelines = await createPipelines(
        runtime,
        surface,
        textures,
        layouts,
        programs,
        presentationTable
    )
    const passes = createPasses(runtime, surface, textures)
    const commands = createCommands(
        runtime,
        uniforms,
        buffers,
        virtualRaster,
        renderTemplates,
        bindSets,
        pipelines,
        presentationTable
    )
    const graph: WebMercatorTerrainGraph = {
        runtime,
        surface,
        virtualRaster,
        fieldLayer: terrainFieldLayer,
        geometry,
        uniforms,
        buffers,
        textures,
        cover,
        demandProjection,
        patchDraw,
        renderTemplates,
        layouts,
        bindSets,
        programs,
        pipelines,
        passes,
        commands,
    }
    const state = createState(size, initialPresentation)
    const pendingFeedback: PendingFeedback[] = []
    const feedbackByDecision = new Map<number, PendingFeedback>()
    const stableIdentities = Object.freeze(stableIdentitySnapshot(graph))
    const stableIdentityFacts = identityFactSnapshot(graph)
    const stableIdentityHash = stableIdentityFacts.hash
    const persistentBaseline = persistentFactSnapshot(runtime)
    let initialization: Promise<Readonly<{
        submitted: SubmittedWork
        observation: Promise<Readonly<{ submissionId: string; nativeStatus: 'observed-succeeded' }>>
    }>> | undefined
    let activePublication: ActivePublication | undefined
    let feedbackPump: Promise<void> | undefined
    let latestDecisionKey: string | undefined
    let latestDecisionSerial = 0
    let latestSettledDecisionKey: string | undefined
    let latestIssuedFrameEpoch = 0
    let latestResourceObservationFrameEpoch = 0
    let feedbackWaiter: Deferred<WebMercatorTerrainFrameSettlement> | undefined

    function initialize() {

        if (initialization !== undefined) return initialization
        initialization = initializeOnce()
        return initialization
    }

    async function initializeOnce() {

        const publication = await virtualRaster.initialize()
        const builder = runtime.createSubmission({ validation: 'throw' })
            .upload(uniforms.config.upload)
            .upload(buffers.positions.upload)
            .upload(buffers.indices.upload)
            .upload(buffers.wireframeIndices.upload)
        cover.initialize(builder)
        demandProjection.initialize(builder)
        patchDraw.initialize(builder)
        for (const upload of publication.update.commands) builder.upload(upload)
        const submitted = builder.submit()
        const observation = Promise.all([
            observeSubmittedWork(submitted),
            virtualRaster.acknowledge(publication, submitted),
        ]).then(([ result ]) => {
            state.initialized = true
            state.virtualSnapshotEpoch = publication.snapshotEpoch
            return result
        })
        return Object.freeze({ submitted, observation })
    }

    async function render(capture: GeoViewSourceCapture<ViewInput>) {

        assertSize(capture?.presentationSize)
        if (!sameSize(state.size, capture.presentationSize)) {
            await resize(capture.presentationSize)
        }
        const submitted = await submitFrame(capture.view)
        const frame = Object.freeze({
            submitted: submitted.submitted,
            provenance: submitted.provenance,
            terrainPresentation: submitted.terrainPresentation,
        }) satisfies WebMercatorTerrainFrame<Presentation>
        return Object.freeze({
            observation: submitted.observation,
            settlement: submitted.settlement,
            needsFollowUp: submitted.needsFollowUp,
            value: Object.freeze({ frame, view: capture.view }),
        }) satisfies GeoFrameResult<
            WebMercatorTerrainFrameValue<ViewInput, Presentation>
        >
    }

    async function submitFrame(input: ViewInput) {

        if (!state.initialized) throw new Error('Web Mercator terrain graph must be initialized before rendering')
        if (state.disposed) throw new Error('Web Mercator terrain graph is disposed')
        assertSameIdentities(stableIdentities, stableIdentitySnapshot(graph), 'frame')
        assertPersistentCounts(persistentBaseline, persistentFactSnapshot(runtime), 'frame')
        const frameTerrainPresentation = state.terrainPresentation

        const publication = activePublication === undefined
            ? virtualRaster.publish()
            : undefined
        const residencySnapshotEpoch = publication?.snapshotEpoch ??
            activePublication?.publication.snapshotEpoch ??
            virtualRaster.gpu.facts().snapshotEpoch
        const view = fieldLayer.viewAdapter.read(input, {
            frameEpoch: state.frame + 1,
            residencySnapshotEpoch,
        })
        const decisionKey = coverDecisionKey(view)
        if (latestDecisionKey !== decisionKey) {
            latestDecisionSerial++
            if (latestDecisionKey !== undefined) {
                latestSettledDecisionKey = undefined
                clearDecisionFeedback(state)
            }
        }
        latestDecisionKey = decisionKey
        const decisionSerial = latestDecisionSerial
        const viewToken = cover.writeView(view)
        let frame: GpuWebMercatorQuadCoverFrame
        let demandFrame: GpuWebMercatorQuadDemandProjectionFrame
        let patchDrawFrame: GpuWebMercatorQuadPatchDrawFrame
        let submitted: SubmittedWork
        let capturedFeedback = false
        let feedbackEntry = feedbackByDecision.get(decisionSerial)
        try {
            frame = cover.frame(viewToken)
            demandFrame = demandProjection.frame(frame)
            patchDrawFrame = patchDraw.frame(frame)
            const builder = runtime.createSubmission({ validation: 'throw' })
            if (publication !== undefined) virtualRaster.gpu.encode(builder, publication.update)
            cover.encode(builder, frame)
            demandProjection.encode(builder, demandFrame)
            patchDraw.encode(builder, patchDrawFrame)
            builder.render(passes.terrain, [
                commands.terrain[frameTerrainPresentation][frame.parity]!,
            ])
            capturedFeedback = latestSettledDecisionKey !== decisionKey &&
                feedbackEntry === undefined &&
                feedbackCaptureAvailable(graph, frame, demandFrame)
            if (capturedFeedback) {
                cover.capture(builder, frame)
                demandProjection.capture(builder, demandFrame)
            }
            submitted = builder.submit()
        } finally {
            viewToken.dispose()
        }
        let publicationAcknowledgment: Promise<void> | undefined
        if (publication !== undefined) {
            publicationAcknowledgment = virtualRaster.acknowledge(publication, submitted!)
                .then(() => {
                    if (activePublication?.publication === publication) {
                        activePublication = undefined
                    }
                    state.virtualSnapshotEpoch = virtualRaster.gpu.facts().snapshotEpoch
                })
            activePublication = Object.freeze({
                publication,
                acknowledgment: publicationAcknowledgment,
            })
        }

        let provenance: readonly WebMercatorTerrainProvenanceFact[] = Object.freeze([])
        let provenanceFailure: unknown
        try {
            provenance = verifyFrameProvenance(
                submitted!,
                graph,
                frame!,
                frameTerrainPresentation
            )
            observeProvenance?.(provenance)
        } catch (error) {
            provenanceFailure = error
        }
        const nativeObservation = observeSubmittedWork(submitted!)
        const observation = Promise.all([
            nativeObservation,
            ...(publicationAcknowledgment === undefined ? [] : [ publicationAcknowledgment ]),
        ]).then(([ result ]) => {
            if (provenanceFailure !== undefined) throw provenanceFailure
            return result!
        })

        if (capturedFeedback) {
            feedbackEntry = Object.freeze({
                coverFrame: frame!,
                demandFrame: demandFrame!,
                view,
                submitted: submitted!,
                decisionKey,
                decisionSerial,
                settlement: deferred<WebMercatorTerrainFrameSettlement>(),
            })
            pendingFeedback.push(feedbackEntry)
            feedbackByDecision.set(decisionSerial, feedbackEntry)
        }
        // Only the newest frame may wait for capture capacity. Replacing it releases
        // the older frame's host task without changing the owned GPU observations.
        if (feedbackWaiter !== undefined) {
            settleDeferred(feedbackWaiter, emptyFrameSettlement())
            feedbackWaiter = undefined
        }
        let settlement = feedbackEntry?.settlement.promise
        if (settlement === undefined && latestSettledDecisionKey !== decisionKey) {
            feedbackWaiter = deferred<WebMercatorTerrainFrameSettlement>()
            settlement = feedbackWaiter.promise
        }
        latestIssuedFrameEpoch = frame!.frameEpoch
        startFeedbackPump()

        state.frame++
        state.virtualSnapshotEpoch = residencySnapshotEpoch
        return Object.freeze({
            submitted: submitted!,
            observation,
            settlement: settlement ?? Promise.resolve(emptyFrameSettlement()),
            provenance,
            // Completion/capacity settlements drive the next frame. Rendering more
            // frames while a readback is pending cannot make that readback ready.
            needsFollowUp: false,
            terrainPresentation: frameTerrainPresentation,
        }) satisfies WebMercatorTerrainFrame<Presentation>
    }

    function startFeedbackPump(): void {

        const ready = pendingFeedback[0]
        if (feedbackPump !== undefined || state.disposed || ready === undefined ||
            ready.coverFrame.frameEpoch > latestIssuedFrameEpoch) return
        feedbackPump = drainReadyFeedback().finally(() => {
            feedbackPump = undefined
            startFeedbackPump()
        })
        void feedbackPump.catch(() => undefined)
    }

    async function drainReadyFeedback(): Promise<void> {

        while (!state.disposed) {
            const ready = pendingFeedback[0]
            if (ready === undefined ||
                ready.coverFrame.frameEpoch > latestIssuedFrameEpoch) return
            pendingFeedback.shift()
            try {
                const consumed = await consumeFeedback(graph, ready)
                if (state.disposed) {
                    settleDeferred(ready.settlement, emptyFrameSettlement())
                } else {
                    settleConsumedFeedback(ready, consumed)
                }
            } catch (error) {
                if (state.disposed) settleDeferred(ready.settlement, emptyFrameSettlement())
                else {
                    rejectDeferred(ready.settlement, error)
                    if (feedbackWaiter !== undefined) {
                        rejectDeferred(feedbackWaiter, error)
                        feedbackWaiter = undefined
                    }
                }
            } finally {
                if (feedbackByDecision.get(ready.decisionSerial) === ready) {
                    feedbackByDecision.delete(ready.decisionSerial)
                }
            }
        }
    }

    function settleConsumedFeedback(
        ready: PendingFeedback,
        consumed: ConsumedFeedback
    ): void {

        // Projection reads geometry and immutable source coverage, not atlas slots.
        // Its original view/residency provenance remains intact while the newest
        // complete observation advances the independent resource target.
        const observedDemand = consumed.demandFeedback
        const reconciliation = observedDemand !== undefined &&
            ready.coverFrame.frameEpoch > latestResourceObservationFrameEpoch
            ? virtualRaster.reconcileViewDemands(coverViewDemands(
                virtualRaster, terrainFieldLayer, observedDemand, consumed.view
            ))
            : undefined
        if (reconciliation !== undefined) {
            latestResourceObservationFrameEpoch = ready.coverFrame.frameEpoch
            state.virtualRequestedPageCount += reconciliation.requestedCount
        }
        const scheduler = virtualRaster.scheduler.inspect()
        const resourceProgress = Object.freeze({
            ...(reconciliation === undefined ? {} : { reconciliation }),
            residencySettlement: reconciliation?.settlement ?? Promise.resolve(undefined),
            // Retained active requests need the same completion wakeup as new ones.
            residencyWorkCount: reconciliation === undefined ? 0 : scheduler.activeRequestCount,
        })

        if (ready.decisionSerial !== latestDecisionSerial) {
            if (consumed.coverFeedback !== undefined ||
                consumed.demandFeedback !== undefined) {
                state.supersededFeedbackCount++
            }
            settleDeferred(ready.settlement, Object.freeze({
                ...(consumed.coverFeedback === undefined
                    ? {}
                    : { coverFeedback: consumed.coverFeedback }),
                ...(consumed.demandFeedback === undefined
                    ? {}
                    : { demandFeedback: consumed.demandFeedback }),
                ...resourceProgress,
                needsFollowUp: false,
                superseded: true,
            }))
            wakeFeedbackWaiter(resourceProgress)
            return
        }

        const feedback = consumed.coverFeedback
        const demandFeedback = consumed.demandFeedback
        if (feedback === undefined) delete state.latestCoverFeedback
        else state.latestCoverFeedback = feedback
        if (demandFeedback === undefined) delete state.latestDemandFeedback
        else state.latestDemandFeedback = demandFeedback
        // Geometry/source selection can settle while loading is still pending.
        // Real request completion drives later publication through its own promise.
        if (feedback !== undefined && demandFeedback !== undefined) {
            latestSettledDecisionKey = ready.decisionKey
        }
        settleDeferred(ready.settlement, Object.freeze({
            ...(feedback === undefined ? {} : { coverFeedback: feedback }),
            ...(demandFeedback === undefined ? {} : { demandFeedback }),
            ...resourceProgress,
            // One confirmation/publication frame sees the new observed state. If
            // the decision is unchanged it captures no further feedback.
            needsFollowUp: true,
            superseded: false,
        }))
        wakeFeedbackWaiter(resourceProgress)
    }

    function wakeFeedbackWaiter(
        progress: Pick<WebMercatorTerrainFrameSettlement,
            'residencySettlement' | 'residencyWorkCount' | 'reconciliation'>
    ): void {

        if (feedbackWaiter === undefined) return
        const waiter = feedbackWaiter
        feedbackWaiter = undefined
        // This signals available capture capacity and actual resource work only;
        // it supplies no old geometry/readiness certificate to the newest frame.
        settleDeferred(waiter, Object.freeze({
            ...progress,
            needsFollowUp: latestSettledDecisionKey !== latestDecisionKey,
            superseded: true,
        }))
    }

    function setPresentation(nextPresentation: Presentation) {

        if (!presentationTable.has(nextPresentation)) {
            throw new TypeError(`Unknown terrain presentation ${nextPresentation}`)
        }
        if (state.disposed) throw new Error('Web Mercator terrain graph is disposed')
        state.terrainPresentation = nextPresentation
        return state.terrainPresentation
    }

    async function resize(nextSize: SurfaceSize) {

        assertSize(nextSize)
        const identityBefore = stableIdentitySnapshot(graph)
        surface.resize(nextSize)
        await textures.depth.resize(nextSize)

        const staleBindSets = allBindSets(bindSets)
            .filter(bindSet => bindSet.preparationState === 'stale')
        let preparedBindSetCount = 0
        for (const bindSet of staleBindSets) {
            await bindSet.prepare()
            preparedBindSetCount++
        }

        const identityAfter = stableIdentitySnapshot(graph)
        assertSameIdentities(identityBefore, identityAfter, 'resize')
        assertPersistentCounts(persistentBaseline, persistentFactSnapshot(runtime), 'resize')
        state.size = { ...nextSize }
        state.resizeGeneration++
        state.staleBindSetPreparationCount += preparedBindSetCount
        state.lastResizeFacts = Object.freeze({
            resizeGeneration: state.resizeGeneration,
            staleBindSetCount: staleBindSets.length,
            preparedBindSetCount,
            depthAllocationVersion: textures.depth.allocationVersion,
        })
        return state.lastResizeFacts
    }

    function dispose() {

        if (state.disposed) return
        state.disposed = true
        if (feedbackWaiter !== undefined) {
            settleDeferred(feedbackWaiter, emptyFrameSettlement())
            feedbackWaiter = undefined
        }
        for (const entry of feedbackByDecision.values()) {
            settleDeferred(entry.settlement, emptyFrameSettlement())
        }
        pendingFeedback.length = 0
        feedbackByDecision.clear()
        patchDraw.dispose()
        demandProjection.dispose()
        cover.dispose()
    }

    return Object.freeze({
        initialize,
        render,
        setPresentation,
        dispose,
        stableIdentities,
        stableIdentityHash,
        stableIdentityFacts,
        currentIdentityFacts: () => identityFactSnapshot(graph),
        persistentFacts: () => persistentFactSnapshot(runtime),
        contractFacts: () => graphContractSnapshot(graph),
        virtualRasterFacts: virtualRaster.inspect,
        state: () => stateSnapshot(state, feedbackByDecision.size),
    })
}

async function createUniformResources(
    runtime: GPURuntime,
    virtualRaster: WebMercatorTerrainVirtualRaster,
    coverLookupCapacity: number,
    elevationRangeMeters: readonly [number, number],
    exaggeration: number
) {

    const [ westLongitude, southLatitude, eastLongitude, northLatitude ] =
        virtualRaster.model.geographicBounds
    const [ west, south ] = WebMercatorQuad.project([ westLongitude, southLatitude ])
    const [ east, north ] = WebMercatorQuad.project([ eastLongitude, northLatitude ])
    const sourceMercatorBox = [
        (west + WEB_MERCATOR_QUAD_HALF_WORLD) / WEB_MERCATOR_QUAD_WORLD_WIDTH,
        (WEB_MERCATOR_QUAD_HALF_WORLD - north) / WEB_MERCATOR_QUAD_WORLD_WIDTH,
        (east + WEB_MERCATOR_QUAD_HALF_WORLD) / WEB_MERCATOR_QUAD_WORLD_WIDTH,
        (WEB_MERCATOR_QUAD_HALF_WORLD - south) / WEB_MERCATOR_QUAD_WORLD_WIDTH,
    ]
    return {
        config: await createUniform(
            runtime,
            'Web Mercator terrain configuration',
            webMercatorTerrainConfigCodec,
            {
                sourceMercatorBox,
                elevationRange: elevationRangeMeters,
                coordinateBits: virtualRaster.addressCodec.coordinateBits,
                exaggeration,
                coverMaximumMatrixLevel: TERRAIN_COVER_MAXIMUM_MATRIX_LEVEL,
                coverLookupCapacity,
            }
        ),
    }
}

async function createUniform(
    runtime: GPURuntime,
    label: string,
    codec: LayoutCodec,
    values: LayoutValues
) {

    const bytes = codec.pack(values)
    const buffer = await runtime.createBuffer({
        label,
        size: bytes.byteLength,
        usage: BUFFER_COPY_DST | BUFFER_UNIFORM,
    })
    const region = buffer.region({ layout: codec.artifact })
    return Object.freeze({
        codec,
        bytes,
        buffer,
        region,
        upload: runtime.createUploadCommand({ label: `Upload ${label}`, target: region, data: bytes }),
    })
}

function createTerrainGeometry() {

    const generated = plane(Math.log2(TERRAIN_SECTOR_SIZE))
    const compactPositions: number[] = []
    const compactIndices = new Map<string, number>()
    const indices = Uint32Array.from(generated.indices, sourceIndex => {
        const x = Math.round(generated.positions[sourceIndex * 2] * TERRAIN_SECTOR_SIZE)
        const y = Math.round(
            generated.positions[sourceIndex * 2 + 1] * TERRAIN_SECTOR_SIZE
        )
        const key = `${x}/${y}`
        let index = compactIndices.get(key)
        if (index === undefined) {
            index = compactPositions.length / 2
            compactIndices.set(key, index)
            compactPositions.push(x, y)
        }
        return index
    })
    const positions = new Uint32Array(compactPositions)
    return Object.freeze({
        positions,
        indices,
        wireframeIndices: createWebMercatorTerrainWireframeIndices(
            positions,
            indices,
            TERRAIN_SECTOR_SIZE
        ),
        elementCount: indices.length,
    })
}

/** @internal */
export function createWebMercatorTerrainWireframeIndices(
    positions: Uint32Array<ArrayBuffer>,
    triangleIndices: Uint32Array<ArrayBuffer>,
    cellsPerEdge: number
): Uint32Array<ArrayBuffer> {

    if (!Number.isSafeInteger(cellsPerEdge) || cellsPerEdge < 1) {
        throw new TypeError('Terrain wireframe cellsPerEdge must be a positive integer')
    }
    const positionIndices = new Map<string, number>()
    for (const index of triangleIndices) {
        const key = `${positions[index * 2]}/${positions[index * 2 + 1]}`
        if (!positionIndices.has(key)) positionIndices.set(key, index)
    }
    const indexAt = (x: number, y: number) => {
        const index = positionIndices.get(`${x}/${y}`)
        if (index === undefined) throw new Error('Terrain plane is missing one grid vertex')
        return index
    }
    const output = new Uint32Array(triangleIndices.length)
    let offset = 0
    const line = (start: number, end: number) => {
        output[offset++] = start
        output[offset++] = end
    }
    for (let y = 0; y < cellsPerEdge; y++) {
        for (let x = 0; x < cellsPerEdge; x++) {
            line(indexAt(x, y), indexAt(x + 1, y))
            line(indexAt(x, y), indexAt(x, y + 1))
            if ((x + y) % 2 === 0) {
                line(indexAt(x, y), indexAt(x + 1, y + 1))
            } else {
                line(indexAt(x, y + 1), indexAt(x + 1, y))
            }
        }
    }
    if (offset !== output.length) {
        throw new Error('Terrain wireframe and triangle element counts differ')
    }
    return output
}

async function createBufferResources(runtime: GPURuntime, geometry: TerrainGeometry) {

    return {
        positions: await createBufferWithUpload(
            runtime,
            'Web Mercator terrain grid positions',
            geometry.positions,
            BUFFER_COPY_DST | BUFFER_STORAGE
        ),
        indices: await createBufferWithUpload(
            runtime,
            'Web Mercator terrain grid indices',
            geometry.indices,
            BUFFER_COPY_DST | BUFFER_INDEX
        ),
        wireframeIndices: await createBufferWithUpload(
            runtime,
            'Web Mercator terrain wireframe indices',
            geometry.wireframeIndices,
            BUFFER_COPY_DST | BUFFER_INDEX
        ),
    }
}

async function createBufferWithUpload<T extends BufferData>(
    runtime: GPURuntime,
    label: string,
    data: T,
    usage: number
) {

    const buffer = await runtime.createBuffer({ label, size: data.byteLength, usage })
    const region = buffer.region()
    return Object.freeze({
        data,
        buffer,
        region,
        upload: runtime.createUploadCommand({ label: `Upload ${label}`, target: region, data }),
    })
}

async function createTextures(runtime: GPURuntime, size: SurfaceSize) {

    const depth = await runtime.createTexture({
        label: 'Web Mercator terrain presentation depth',
        size,
        format: 'depth32float',
        usage: TEXTURE_RENDER_ATTACHMENT,
    })
    return {
        depth,
        views: {
            depth: depth.view(),
        },
    }
}

/** @internal Converts source sample ranges into enclosing geometry bounds without mutating source metadata. */
export function terrainCoverVerticalBounds(
    input: readonly WebMercatorTerrainElevationBounds[] | undefined,
    exaggeration: number
): readonly WebMercatorTileVerticalBounds[] | undefined {

    if (input === undefined) return undefined
    const bounds = input.map(entry => {
        const range = scaleElevationRange([
            entry.minimumElevationMeters, entry.maximumElevationMeters,
        ], exaggeration)
        return { matrixLevel: entry.matrixLevel, tileRow: entry.tileRow, tileCol: entry.tileCol,
            minimumVerticalMeters: range[0], maximumVerticalMeters: range[1] }
    })
    const byIdentity = new Map(bounds.map(entry =>
        [`${entry.matrixLevel}/${entry.tileRow}/${entry.tileCol}`, entry]))
    // Source min/max describe each sampled raster level. Geometry ancestors must
    // also contain every descendant range before they can conservatively prune it.
    for (const entry of bounds) {
        for (let level = 0; level < Math.min(24, entry.matrixLevel); level++) {
            const scale = 2 ** (entry.matrixLevel - level)
            const ancestor = byIdentity.get(`${level}/${Math.floor(entry.tileRow / scale)}/${Math.floor(entry.tileCol / scale)}`)
            if (ancestor === undefined) continue
            ancestor.minimumVerticalMeters = Math.min(ancestor.minimumVerticalMeters, entry.minimumVerticalMeters)
            ancestor.maximumVerticalMeters = Math.max(ancestor.maximumVerticalMeters, entry.maximumVerticalMeters)
        }
    }
    return Object.freeze(bounds.map(entry => Object.freeze(entry)))
}

function scaleElevationRange(
    range: readonly [number, number],
    exaggeration: number
): readonly [number, number] {

    return Object.freeze(range
        .map(value => value * exaggeration)
        .sort((left, right) => left - right) as [number, number])
}

function createRenderTemplates(
    cover: GpuWebMercatorQuadCover,
    patchDraw: GpuWebMercatorQuadPatchDraw
) {

    const coverTemplates = cover.templates()
    const drawTemplates = patchDraw.templates()
    return Object.freeze({
        terrain: Object.freeze(coverTemplates.map((template, parity) => Object.freeze({
            ...template,
            drawArgument: drawTemplates[parity]!.drawArgument,
        }))),
    })
}

async function createBindLayouts(runtime: GPURuntime, mapMetaBytes: number) {

    const uniform = (
        binding: number,
        name: string,
        minBindingSize: number,
        visibility: readonly BindVisibility[]
    ): BindLayoutEntry => ({
        binding,
        name,
        type: 'uniform',
        visibility,
        minBindingSize,
    })
    const readStorage = (binding: number, name: string): BindLayoutEntry => ({
        binding,
        name,
        type: 'read-storage',
        visibility: [ 'vertex' ],
    })

    return {
        scene: await runtime.createBindLayout({
            label: 'Web Mercator terrain cover scene layout',
            group: 0,
            entries: [
                uniform(0, 'mapMeta', mapMetaBytes, [ 'vertex' ]),
                uniform(
                    1,
                    'terrainConfig',
                    webMercatorTerrainConfigCodec.byteLength(),
                    [ 'vertex' ]
                ),
            ],
        }),
        terrainData: await runtime.createBindLayout({
            label: 'Web Mercator terrain cover data layout',
            group: 1,
            entries: [
                readStorage(1, 'gridPositions'),
                readStorage(2, 'coverPatches'),
                readStorage(3, 'coverLookupEntries'),
            ],
        }),
        terrainTextures: await runtime.createBindLayout({
            label: 'Web Mercator terrain texture layout',
            group: 2,
            entries: [
                readStorage(0, 'fieldPageTable'),
                {
                    binding: 1,
                    name: 'fieldAtlas',
                    type: 'texture',
                    sampleType: 'float',
                    viewDimension: '2d',
                    visibility: [ 'vertex' ],
                },
            ],
        }),
    }
}

async function createBindSets(
    runtime: GPURuntime,
    layouts: Layouts,
    uniforms: Uniforms,
    buffers: Buffers,
    virtualRaster: WebMercatorTerrainVirtualRaster,
    templates: RenderTemplates
) {

    const terrainData = []
    for (const [ parity, template ] of templates.terrain.entries()) {
        terrainData.push(await runtime.createBindSet(layouts.terrainData, {
            gridPositions: buffers.positions.region,
            coverPatches: template.patches.region(),
            coverLookupEntries: template.coverLookup.region(),
        }, { label: `Web Mercator terrain cover data ${parity}` }))
    }

    const scene = []
    for (const [ parity, template ] of templates.terrain.entries()) {
        scene.push(await runtime.createBindSet(layouts.scene, {
            mapMeta: template.mapMeta.region(),
            terrainConfig: uniforms.config.region,
        }, { label: `Web Mercator terrain cover scene ${parity}` }))
    }

    return {
        scene,
        terrainData,
        terrainTextures: await runtime.createBindSet(layouts.terrainTextures, {
            fieldPageTable: virtualRaster.gpu.pageTable.region(),
            fieldAtlas: virtualRaster.gpu.atlasView,
        }, { label: 'Web Mercator terrain textures' }),
    }
}

async function createPrograms({
    runtime,
    presentationShader,
    fieldSampling,
    virtualRaster,
    presentations,
}: Readonly<{
    runtime: GPURuntime
    presentationShader: string
    fieldSampling: WebMercatorTerrainSamplingWgslOptions
    virtualRaster: WebMercatorTerrainVirtualRaster
    presentations: ReadonlyMap<string, WebMercatorTerrainPresentationDescriptor>
}>): Promise<Readonly<Record<string, Program>>> {

    const configRequirement: ProgramBufferLayoutRequirement = {
        group: 0,
        binding: 1,
        type: 'uniform',
        hasDynamicOffset: false,
        layout: webMercatorTerrainConfigCodec.artifact,
    }
    const fieldWgsl = webMercatorVirtualRasterWgslModule(virtualRaster.model, {
        namespace: fieldSampling.namespace,
        addressNamespace: fieldSampling.addressNamespace,
        group: 2,
        pageTableBinding: 0,
        atlasBinding: 1,
        ...(fieldSampling.transitionTexels === undefined
            ? {}
            : { transitionTexels: fieldSampling.transitionTexels }),
    })
    const terrainWgsl = webMercatorTerrainWgslModule({
        fieldNamespace: fieldSampling.namespace,
        addressNamespace: fieldSampling.addressNamespace,
        cellsPerPatchEdge: TERRAIN_SECTOR_SIZE,
        sceneGroup: 0,
        mapMetaBinding: 0,
        configBinding: 1,
        dataGroup: 1,
        gridPositionsBinding: 1,
        patchesBinding: 2,
        lookupEntriesBinding: 3,
    })
    const terrainShader = await runtime.createShaderModule({
        label: 'Web Mercator terrain shader',
        sourceParts: [
            { code: fieldWgsl.code },
            {
                code: terrainWgsl.code,
                layoutDependencies: terrainWgsl.layoutDependencies,
            },
            { code: presentationShader },
        ],
    })
    const programs: Record<string, Program> = {}
    for (const presentation of presentations.values()) {
        programs[presentation.id] = runtime.createProgram({
            label: presentation.label ?? `Web Mercator terrain ${presentation.id} program`,
            vertex: { module: terrainShader, entryPoint: terrainWgsl.vertexEntryPoint },
            fragment: {
                module: terrainShader,
                entryPoint: presentation.fragmentEntryPoint,
            },
            layoutRequirements: [ configRequirement ],
        })
    }
    return Object.freeze(programs)
}

async function createPipelines(
    runtime: GPURuntime,
    surface: Surface,
    textures: Textures,
    layouts: Layouts,
    programs: Programs,
    presentations: ReadonlyMap<string, WebMercatorTerrainPresentationDescriptor>
): Promise<Readonly<Record<string, RenderPipeline>>> {

    const pipelines: Record<string, RenderPipeline> = {}
    for (const presentation of presentations.values()) {
        const wireframe = presentation.fragmentEntryPoint ===
            WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT
        pipelines[presentation.id] = await runtime.createRenderPipeline({
            label: presentation.label ?? `Web Mercator terrain ${presentation.id} pipeline`,
            program: programs[presentation.id]!,
            layout: {
                mode: 'explicit',
                bindLayouts: [ layouts.scene, layouts.terrainData, layouts.terrainTextures ],
            },
            targets: [ { format: surface.format } ],
            primitive: {
                topology: wireframe ? 'line-list' : 'triangle-list',
                cullMode: 'none',
            },
            depthStencil: {
                format: textures.depth.format,
                depthWriteEnabled: true,
                depthCompare: 'less',
            },
        })
    }
    return Object.freeze(pipelines)
}

function createPasses(runtime: GPURuntime, surface: Surface, textures: Textures) {

    return {
        terrain: runtime.createRenderPass({
            label: 'Web Mercator terrain stage',
            color: [ {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 0 ],
            } ],
            depth: {
                target: textures.views.depth,
                depthLoad: 'clear',
                depthStore: 'store',
                depthClear: 1,
            },
        }),
    }
}

function createCommands(
    runtime: GPURuntime,
    uniforms: Uniforms,
    buffers: Buffers,
    virtualRaster: WebMercatorTerrainVirtualRaster,
    templates: RenderTemplates,
    bindSets: BindSets,
    pipelines: Pipelines,
    presentations: ReadonlyMap<string, WebMercatorTerrainPresentationDescriptor>
) {

    const terrainCommands = (
        label: string,
        pipeline: RenderPipeline,
        indexBuffer: Buffers['indices']
    ) => templates.terrain.map((template, parity) => runtime.createDrawCommand({
        label: `${label} ${parity}`,
        pipeline,
        bindSets: [
            { set: bindSets.scene[parity]! },
            { set: bindSets.terrainData[parity]! },
            { set: bindSets.terrainTextures },
        ],
        indexBuffer: { region: indexBuffer.region, format: 'uint32' },
        count: { indirect: template.drawArgument.region },
        resources: {
            read: currentReads([
                template.mapMeta,
                uniforms.config.buffer,
                indexBuffer.buffer,
                buffers.positions.buffer,
                template.patches,
                template.coverLookup,
                virtualRaster.gpu.pageTable,
                virtualRaster.gpu.atlas,
                template.drawArgument.resource,
            ]),
            write: [],
        },
        whenMissing: 'throw',
    }))

    return Object.freeze({
        terrain: Object.freeze(Object.fromEntries(
            Object.entries(pipelines).map(([ id, pipeline ]) => {
                const presentation = presentations.get(id)!
                const indexBuffer = presentation.fragmentEntryPoint ===
                    WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT
                    ? buffers.wireframeIndices
                    : buffers.indices
                return [
                    id,
                    Object.freeze(terrainCommands(
                        `Draw Web Mercator terrain ${id}`,
                        pipeline,
                        indexBuffer
                    )),
                ]
            })
        )),
    })
}

function currentReads(resources: readonly ContentResource[]) {

    return resources.map(resource => ({ resource, contentEpoch: 'current-at-step' as const }))
}

async function consumeFeedback(
    graph: WebMercatorTerrainGraph,
    ready: PendingFeedback
): Promise<ConsumedFeedback> {

    const [ coverFeedback, demandFeedback ] = await Promise.all([
        graph.cover.feedback(ready.coverFrame, ready.submitted),
        graph.demandProjection.feedback(ready.demandFrame, ready.submitted),
    ])
    return Object.freeze({
        decisionKey: ready.decisionKey,
        view: ready.view,
        coverFeedback,
        demandFeedback,
    })
}

function feedbackCaptureAvailable(
    graph: WebMercatorTerrainGraph,
    frame: GpuWebMercatorQuadCoverFrame,
    demandFrame: GpuWebMercatorQuadDemandProjectionFrame
): boolean {

    const coverCommands = graph.cover.commandsFor(frame)
    const demandCommands = graph.demandProjection.commandsFor(demandFrame)
    return coverCommands.stateFeedback.state === 'idle' &&
        demandCommands.stateFeedback.state === 'idle' &&
        demandCommands.demandFeedback.state === 'idle'
}

function coverViewDemands(
    virtualRaster: WebMercatorTerrainVirtualRaster,
    fieldLayer: WebMercatorTerrainMapField,
    feedback: GpuWebMercatorQuadDemandProjectionFeedback,
    view: GeoViewSnapshot
) {

    return fieldLayer.demandProducer.produce({
        view,
        generation: feedback.frameEpoch,
        demands: feedback.demands.map(demand => ({
            page: virtualRaster.addressSpace.pageFromTile({
                matrixId: String(demand.requestMatrixLevel),
                tileRow: demand.tileRow,
                tileCol: demand.tileCol,
            }),
            desiredSampleLevel: demand.desiredSampleLevel,
            sourceLevelCeiling: demand.sourceLevelCeiling,
            priority: Object.freeze({
                class: 'user-visible' as const,
                score: demand.priority,
            }),
            intent: 'refinement' as const,
            reason: `gpu-demand:${feedback.frameEpoch}:desired-z${demand.desiredSampleLevel}`,
        })),
    })
}

function emptyFrameSettlement(): WebMercatorTerrainFrameSettlement {

    return Object.freeze({
        residencySettlement: Promise.resolve(undefined),
        residencyWorkCount: 0,
        needsFollowUp: false,
        superseded: false,
    })
}

function deferred<Value>(): Deferred<Value> {

    let resolvePromise!: (value: Value) => void
    let rejectPromise!: (reason: unknown) => void
    const value: Deferred<Value> = {
        promise: new Promise<Value>((resolve, reject) => {
            resolvePromise = resolve
            rejectPromise = reject
        }),
        resolve(result) {
            if (value.settled) return
            value.settled = true
            resolvePromise(result)
        },
        reject(reason) {
            if (value.settled) return
            value.settled = true
            rejectPromise(reason)
        },
        settled: false,
    }
    return value
}

function settleDeferred<Value>(value: Deferred<Value>, result: Value): void {

    value.resolve(result)
}

function rejectDeferred<Value>(value: Deferred<Value>, reason: unknown): void {

    value.reject(reason)
}

function coverDecisionKey(view: GeoViewSnapshot): string {

    return JSON.stringify([
        view.clipFromRelativeWorld,
        view.cameraHigh,
        view.cameraLow,
        view.referenceViewport,
        view.verticalFovRadians,
        view.cameraLatitudeRadians,
        view.cameraPitchRadians,
        view.zoomHint,
        view.residencySnapshotEpoch,
    ])
}

function verifyFrameProvenance(
    submitted: SubmittedWork,
    graph: WebMercatorTerrainGraph,
    frame: GpuWebMercatorQuadCoverFrame,
    terrainPresentation: string
) {

    const terrainCommand = graph.commands.terrain[terrainPresentation]![frame.parity]!
    const coverCommands = graph.cover.commandsFor(frame)
    const terrainTemplate = graph.renderTemplates.terrain[frame.parity]
    const pairs = [
        {
            name: 'cover-map-meta-to-cover-compute',
            resource: terrainTemplate.mapMeta,
            consumerCommandId: coverCommands.generate.id,
        },
        {
            name: 'cover-patches-to-terrain-draw',
            resource: terrainTemplate.patches,
            consumerCommandId: terrainCommand.id,
        },
        {
            name: 'cover-lookup-to-terrain-draw',
            resource: terrainTemplate.coverLookup,
            consumerCommandId: terrainCommand.id,
        },
        {
            name: 'patch-draw-indirect-to-terrain-draw',
            resource: terrainTemplate.drawArgument.resource,
            consumerCommandId: terrainCommand.id,
        },
    ]

    return Object.freeze(pairs.map(pair => {
        const read = submitted.resourceAccesses.find(access => (
            access.resourceId === pair.resource.id &&
            access.commandId === pair.consumerCommandId &&
            access.access === 'read'
        ))
        const producer = submitted.producerEpochs.find(epoch => (
            epoch.resourceId === pair.resource.id &&
            epoch.contentEpoch === read?.contentEpochBefore
        ))
        if (producer === undefined || read === undefined ||
            read.declaredContentEpoch !== 'current-at-step') {
            throw new Error(`Web Mercator terrain submission provenance mismatch for ${pair.name}`)
        }
        return Object.freeze({
            name: pair.name,
            resourceId: pair.resource.id,
            declaredContentEpoch: read.declaredContentEpoch,
            producerContentEpoch: producer.contentEpoch,
            readContentEpoch: read.contentEpochBefore,
            producerStepIndex: producer.producedBy.stepIndex,
            consumerStepIndex: read.stepIndex,
        })
    }))
}

function stableIdentitySnapshot(graph: WebMercatorTerrainGraph) {

    const objects = Object.values(identityObjectsByKind(graph)).flat()
    return [ ...new Set(objects.map(object => object.id)) ].sort()
}

function identityFactSnapshot(graph: WebMercatorTerrainGraph) {

    const objects = identityObjectsByKind(graph)
    const identities = stableIdentitySnapshot(graph)
    return Object.freeze({
        hash: hashStrings(identities),
        count: identities.length,
        resources: objects.resources.length,
        uploads: objects.uploads.length,
        bindLayouts: objects.bindLayouts.length,
        bindSets: objects.bindSets.length,
        programs: objects.programs.length,
        pipelines: objects.pipelines.length,
        passes: objects.passes.length,
        commands: objects.commands.length,
    })
}

function identityObjectsByKind(graph: WebMercatorTerrainGraph) {

    const coverIdentity = graph.cover.identityObjects()
    const demandIdentity = graph.demandProjection.identityObjects()
    const patchDrawIdentity = graph.patchDraw.identityObjects()
    const templateResources = graph.renderTemplates.terrain.flatMap(template => [
        template.mapMeta,
        template.patches,
        template.coverLookup,
        template.drawArgument.resource,
    ])
    return {
        resources: uniqueById([
            graph.uniforms.config.buffer,
            graph.buffers.positions.buffer,
            graph.buffers.indices.buffer,
            graph.buffers.wireframeIndices.buffer,
            graph.virtualRaster.gpu.atlas,
            graph.virtualRaster.gpu.pageTable,
            graph.virtualRaster.gpu.slotTable,
            graph.textures.depth,
            ...templateResources,
            ...coverIdentity.resources,
            ...demandIdentity.resources,
            ...patchDrawIdentity.resources,
        ]),
        uploads: [
            graph.uniforms.config.upload,
            graph.buffers.positions.upload,
            graph.buffers.indices.upload,
            graph.buffers.wireframeIndices.upload,
            ...coverIdentity.uploads,
            ...demandIdentity.uploads,
            ...patchDrawIdentity.uploads,
        ],
        bindLayouts: [
            ...Object.values(graph.layouts),
            ...coverIdentity.bindLayouts,
            ...demandIdentity.bindLayouts,
            ...patchDrawIdentity.bindLayouts,
        ],
        bindSets: [
            ...allBindSets(graph.bindSets),
            ...coverIdentity.bindSets,
            ...demandIdentity.bindSets,
            ...patchDrawIdentity.bindSets,
        ],
        programs: [
            ...Object.values(graph.programs),
            ...coverIdentity.programs,
            ...demandIdentity.programs,
            ...patchDrawIdentity.programs,
        ],
        pipelines: [
            ...Object.values(graph.pipelines),
            ...coverIdentity.pipelines,
            ...demandIdentity.pipelines,
            ...patchDrawIdentity.pipelines,
        ],
        passes: [
            ...Object.values(graph.passes),
            ...coverIdentity.passes,
            ...demandIdentity.passes,
            ...patchDrawIdentity.passes,
        ],
        commands: [
            ...coverIdentity.commands,
            ...demandIdentity.commands,
            ...patchDrawIdentity.commands,
            ...Object.values(graph.commands.terrain).flat(),
        ],
    }
}

function allBindSets(bindSets: BindSets) {

    return [
        ...bindSets.scene,
        ...bindSets.terrainData,
        bindSets.terrainTextures,
    ]
}

function uniqueById<Value extends { id: string }>(values: readonly Value[]): Value[] {

    return [ ...new Map(values.map(value => [ value.id, value ])).values() ]
}

function persistentFactSnapshot(runtime: GPURuntime): PersistentFacts {

    const facts = runtime.diagnostics.snapshot()
    return Object.freeze({
        resources: facts.resources.length,
        bindLayouts: facts.bindLayouts.length,
        bindSets: facts.bindSets.length,
        pipelines: facts.pipelines.length,
        logicalFootprintBytes: facts.pressure.currentScratchLogicalFootprintBytes,
    })
}

function graphContractSnapshot(graph: WebMercatorTerrainGraph): WebMercatorTerrainContractFacts {

    return Object.freeze({
        stageOrder: WEB_MERCATOR_TERRAIN_STAGE_ORDER,
        countPath: 'gpu-produced-indirect-arguments',
        selectionPath: 'gpu-camera-inverse-webmercatorquad-cover',
        sourceMaximumMatrixLevel:
            graph.demandProjection.facts().sourceMaximumMatrixLevel,
        coverMaximumMatrixLevel: graph.cover.descriptor.policy.maximumMatrixLevel,
        fieldLayer: Object.freeze({
            id: graph.fieldLayer.id,
            fieldId: graph.fieldLayer.field.id,
            representationId: graph.fieldLayer.representation.id,
            spatialProfileId: graph.fieldLayer.spatialProfile.id,
            viewAdapterId: graph.fieldLayer.viewAdapter.id,
            demandProducerId: graph.fieldLayer.demandProducer.id,
        }),
        terrainElementCount: graph.geometry.elementCount,
        cover: graph.cover.facts(),
        demandProjection: graph.demandProjection.facts(),
        patchDraw: graph.patchDraw.facts(),
        virtualRaster: Object.freeze({
            sourceRevision: graph.virtualRaster.model.sourceRevision,
            pageSize: graph.virtualRaster.addressSpace.pageSize,
            levelCount: graph.virtualRaster.addressSpace.levelCount,
            maxPhysicalPages: graph.virtualRaster.residency.maxPhysicalPages,
            completeImageUpload: false,
            crossPageFiltering: 'logical-bilinear',
            coordinateEncoding: graph.virtualRaster.addressCodec.positionCodec.facts.encoding,
        }),
        persistentIdentityCount: stableIdentitySnapshot(graph).length,
        passIds: Object.freeze({
            cover: graph.cover.identityObjects().passes[0]!.id,
            demandProjection: graph.demandProjection.identityObjects().passes[0]!.id,
            patchDraw: graph.patchDraw.identityObjects().passes[0]!.id,
            terrain: graph.passes.terrain.id,
        }),
        commandIds: Object.freeze({
            cover: Object.freeze(
                graph.cover.facts().parity.map(parity => parity.commandIds)
            ),
            demandProjection: Object.freeze(
                graph.demandProjection.facts().parity.map(parity => parity.commandIds)
            ),
            patchDraw: Object.freeze(
                graph.patchDraw.facts().parity.map(parity => parity.commandId)
            ),
            drawTerrain: Object.freeze(Object.fromEntries(
                Object.entries(graph.commands.terrain).map(([ id, commands ]) => [
                    id,
                    Object.freeze(commands.map(command => command.id)),
                ])
            )),
        }),
    })
}

function createState<Presentation extends string>(
    size: SurfaceSize,
    terrainPresentation: Presentation
): WebMercatorTerrainState<Presentation> {

    return {
        initialized: false,
        disposed: false,
        frame: 0,
        size: { ...size },
        resizeGeneration: 0,
        staleBindSetPreparationCount: 0,
        virtualSnapshotEpoch: 0,
        virtualRequestedPageCount: 0,
        staleFeedbackCount: 0,
        supersededFeedbackCount: 0,
        terrainPresentation,
    }
}

function clearDecisionFeedback<Presentation extends string>(
    state: WebMercatorTerrainState<Presentation>
): void {

    delete state.latestCoverFeedback
    delete state.latestDemandFeedback
}

function stateSnapshot<Presentation extends string>(
    state: WebMercatorTerrainState<Presentation>,
    pendingFeedbackCount: number
): WebMercatorTerrainRendererState<Presentation> {

    const cover = state.latestCoverFeedback
    const demand = state.latestDemandFeedback
    return Object.freeze({
        initialized: state.initialized,
        disposed: state.disposed,
        frame: state.frame,
        size: Object.freeze({ ...state.size }),
        resizeGeneration: state.resizeGeneration,
        staleBindSetPreparationCount: state.staleBindSetPreparationCount,
        ...(state.lastResizeFacts === undefined
            ? {}
            : { lastResizeFacts: state.lastResizeFacts }),
        virtualSnapshotEpoch: state.virtualSnapshotEpoch,
        virtualRequestedPageCount: state.virtualRequestedPageCount,
        readbackInFlightCount: pendingFeedbackCount,
        staleFeedbackCount: state.staleFeedbackCount,
        supersededFeedbackCount: state.supersededFeedbackCount,
        coverCandidateCount: cover?.candidateCount ?? 0,
        coverPatchCount: cover?.patchCount ?? 0,
        sourceDemandCount: demand?.demandCount ?? 0,
        coverLevelRange: Object.freeze([
            cover?.minimumMatrixLevel,
            cover?.maximumMatrixLevel,
        ] as const),
        coverDescriptorOverflowCount: cover?.descriptorOverflowCount ?? 0,
        coverLookupOverflowCount: cover?.lookupOverflowCount ?? 0,
        sourceDemandOverflowCount: demand?.overflowCount ?? 0,
        coverMaximumAdjacentLevelDelta: cover?.maximumAdjacentLevelDelta ?? 0,
        ...(cover === undefined ? {} : {
            coverFinestMatrixLevel: cover.finestMatrixLevel,
            ...(demand === undefined
                ? {}
                : {
                    sourceLevelCeiling: demand.sourceLevelCeiling,
                    demandFeedback: demand,
                }),
            coverFrameEpoch: cover.frameEpoch,
            coverFeedback: cover,
        }),
        convergenceState: cover === undefined || demand === undefined
            ? 'transitioning'
            : 'converged',
        terrainPresentation: state.terrainPresentation,
    })
}

async function observeSubmittedWork(submitted: SubmittedWork) {

    const [ nativeOutcome ] = await Promise.all([ submitted.nativeOutcome, submitted.done ])
    if (nativeOutcome.status !== 'observed-succeeded') {
        throw new Error(`Web Mercator terrain submission native outcome was ${nativeOutcome.status}`)
    }
    return Object.freeze({ submissionId: submitted.id, nativeStatus: nativeOutcome.status })
}

function assertSameIdentities(
    before: readonly string[],
    after: readonly string[],
    action: string
) {

    if (before.length !== after.length || before.some((id, index) => id !== after[index])) {
        throw new Error(`Persistent Web Mercator terrain graph identity changed during ${action}`)
    }
}

function assertPersistentCounts(before: PersistentFacts, after: PersistentFacts, action: string) {

    for (const name of [ 'resources', 'bindLayouts', 'bindSets', 'pipelines' ] as const) {
        if (before[name] !== after[name]) {
            throw new Error(`Persistent Web Mercator terrain ${name} count changed during ${action}`)
        }
    }
}

function hashStrings(values: readonly string[]) {

    let hash = 2166136261
    for (const value of values) {
        for (let index = 0; index < value.length; index++) {
            hash ^= value.charCodeAt(index)
            hash = Math.imul(hash, 16777619)
        }
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

function assertSize(value: SurfaceSize) {

    if (value === undefined || !Number.isInteger(value.width) ||
        !Number.isInteger(value.height) || value.width <= 0 || value.height <= 0) {
        throw new TypeError('Web Mercator terrain size must contain positive integer width and height')
    }
}

function sameSize(left: SurfaceSize, right: SurfaceSize): boolean {

    return left.width === right.width && left.height === right.height
}

function terrainCoverCapacity(size: SurfaceSize): number {

    const nominalPatchSpan = TERRAIN_SECTOR_SIZE *
        TERRAIN_MAXIMUM_CELL_SPAN_REFERENCE_PIXELS
    const viewportColumns = Math.ceil(size.width / nominalPatchSpan) + 1
    const viewportRows = Math.ceil(size.height / nominalPatchSpan) + 1
    const required = Math.max(
        16,
        viewportColumns * viewportRows * 24
    )
    let capacity = 1
    while (capacity < required) capacity *= 2
    return Math.min(4096, capacity)
}

function assertVirtualRaster(value: WebMercatorTerrainVirtualRaster) {

    if (value === undefined || value.kind !== 'virtual-raster-runtime' ||
        value.model?.kind !== 'web-mercator-virtual-raster-field' ||
        value.addressSpace?.dimensions !== 2 || value.gpu?.atlas === undefined ||
        value.gpu.pageTable === undefined || value.gpu.slotTable === undefined ||
        value.field?.kind !== 'geo-field' ||
        value.representation?.kind !== 'tiled-field-representation' ||
        value.spatialProfile?.kind !== 'tile-spatial-profile' ||
        value.viewDemandProducer?.kind !== 'view-demand-producer' ||
        typeof value.reconcileViewDemands !== 'function') {
        throw new TypeError(
            'Web Mercator terrain renderer requires a prepared WebMercator Virtual Raster runtime'
        )
    }
}

function assertFieldLayer<ViewInput>(
    value: MapFieldLayer<ViewInput>,
    virtualRaster: WebMercatorTerrainVirtualRaster
) {

    if (value?.field !== virtualRaster.field ||
        value.representation !== virtualRaster.representation ||
        value.spatialProfile !== virtualRaster.spatialProfile ||
        value.demandProducer !== virtualRaster.viewDemandProducer ||
        typeof value.viewAdapter?.read !== 'function') {
        throw new TypeError(
            'Web Mercator terrain renderer requires one coherent MapFieldLayer and Virtual Raster runtime'
        )
    }
}

function assertPresentationShader(value: string) {

    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError('Web Mercator terrain renderer requires presentation WGSL')
    }
}

function assertFieldSampling(value: WebMercatorTerrainSamplingWgslOptions) {

    if (typeof value?.namespace !== 'string' || value.namespace.length === 0 ||
        typeof value.addressNamespace !== 'string' || value.addressNamespace.length === 0) {
        throw new TypeError('Web Mercator terrain sampling requires WGSL namespaces')
    }
}

function assertElevation(range: readonly [number, number], exaggeration: number) {

    if (!Array.isArray(range) || range.length !== 2 ||
        range.some(value => !Number.isFinite(value)) || range[0] > range[1] ||
        !Number.isFinite(exaggeration) || exaggeration <= 0) {
        throw new TypeError('Web Mercator terrain elevation range and exaggeration are invalid')
    }
}

function normalizePresentations<Presentation extends string>(
    values: readonly WebMercatorTerrainPresentationDescriptor<Presentation>[],
    initial: Presentation
): ReadonlyMap<Presentation, WebMercatorTerrainPresentationDescriptor<Presentation>> {

    if (!Array.isArray(values) || values.length === 0) {
        throw new TypeError('Web Mercator terrain renderer requires at least one presentation')
    }
    const normalized = new Map<Presentation, WebMercatorTerrainPresentationDescriptor<Presentation>>()
    for (const value of values) {
        if (typeof value?.id !== 'string' || value.id.length === 0 ||
            typeof value.fragmentEntryPoint !== 'string' ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.fragmentEntryPoint) ||
            normalized.has(value.id)) {
            throw new TypeError('Web Mercator terrain presentations require unique ids and WGSL entry points')
        }
        normalized.set(value.id, Object.freeze({ ...value }))
    }
    if (!normalized.has(initial)) {
        throw new TypeError(`Unknown initial terrain presentation ${initial}`)
    }
    return normalized
}
