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
    type GpuWebMercatorQuadCoverSelectionFacts,
} from './gpu-web-mercator-quad-cover.js'
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

/** Delayed inverse-cover feedback, residency work, and convergence state for one terrain frame. */
export type WebMercatorTerrainFrameSettlement = GeoFrameSettlement & Readonly<{
    coverFeedback?: GpuWebMercatorQuadCoverFeedback
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
    terrainVertexCount: number
    cover: ReturnType<GpuWebMercatorQuadCover['facts']>
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
    passIds: Readonly<{ cover: string, terrain: string }>
    commandIds: Readonly<{
        cover: readonly (readonly string[])[]
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
    coverDemandCount: number
    coverLevelRange: readonly [number | undefined, number | undefined]
    coverDescriptorOverflowCount: number
    coverLookupOverflowCount: number
    coverDemandOverflowCount: number
    coverMaximumAdjacentLevelDelta: number
    coverFinestMatrixLevel?: number
    sourceLevelCeiling?: number
    coverFrameEpoch?: number
    coverFeedback?: GpuWebMercatorQuadCoverFeedback
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
    renderTemplates: RenderTemplates
    layouts: Layouts
    bindSets: BindSets
    programs: Programs
    pipelines: Pipelines
    passes: Passes
    commands: Commands
}

type ProvenanceVerifier = (
    submitted: SubmittedWork,
    graph: WebMercatorTerrainGraph,
    frame: GpuWebMercatorQuadCoverFrame,
    terrainPresentation: string
) => readonly WebMercatorTerrainProvenanceFact[]

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
    terrainPresentation: Presentation
}

type PersistentFacts = WebMercatorTerrainPersistentFacts

type PendingFeedback = Readonly<{
    frame: GpuWebMercatorQuadCoverFrame
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
    'terrain',
])
const TERRAIN_SECTOR_SIZE = 64
const TERRAIN_COVER_MAXIMUM_MATRIX_LEVEL = 14
const BUFFER_COPY_DST = 0x08
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80
const TEXTURE_RENDER_ATTACHMENT = 0x10

/**
 * Assembles a WebMercatorQuad Virtual Raster terrain renderer with GPU-driven
 * selection, precision-aware vertex generation, mesh stitching, and explicit lifetime.
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

    const geometry = createTerrainGeometry()
    const buffers = await createBufferResources(runtime, geometry)
    const textures = await createTextures(runtime, size)
    const exaggeratedElevationRange = scaleElevationRange(
        elevationRangeMeters,
        exaggeration
    )
    const sourceMatrixLevels = virtualRaster.coverage.limits.map(limit =>
        Number(limit.matrixId)
    )
    const sourceMinimumMatrixLevel = sourceMatrixLevels[0]!
    const sourceMaximumMatrixLevel = sourceMatrixLevels.at(-1)!
    const coverCapacity = terrainCoverCapacity(size)
    const cover = await GpuWebMercatorQuadCover.create(runtime, {
        spatialProfile: terrainFieldLayer.spatialProfile,
        policy: gpuWebMercatorQuadCoverPolicy({
            minimumMatrixLevel: sourceMinimumMatrixLevel,
            maximumMatrixLevel: TERRAIN_COVER_MAXIMUM_MATRIX_LEVEL,
            sourceMaximumMatrixLevel,
            maximumPatches: coverCapacity,
        }),
        elevationRangeMeters: exaggeratedElevationRange,
        vertexCount: geometry.vertexCount,
    })
    const renderTemplates = createRenderTemplates(cover)
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
        pipelines
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
        cover.initialize(builder)
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

        assertSize(capture?.size)
        if (!sameSize(state.size, capture.size)) await resize(capture.size)
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
        let submitted: SubmittedWork
        let capturedFeedback = false
        let feedbackEntry = feedbackByDecision.get(decisionSerial)
        try {
            frame = cover.frame(viewToken)
            const builder = runtime.createSubmission({ validation: 'throw' })
            if (publication !== undefined) virtualRaster.gpu.encode(builder, publication.update)
            cover.encode(builder, frame)
            builder.render(passes.terrain, [
                commands.terrain[frameTerrainPresentation][frame.parity]!,
            ])
            capturedFeedback = latestSettledDecisionKey !== decisionKey &&
                feedbackEntry === undefined && feedbackCaptureAvailable(graph, frame)
            if (capturedFeedback) {
                cover.capture(builder, frame)
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
                frame: frame!,
                view,
                submitted: submitted!,
                decisionKey,
                decisionSerial,
                settlement: deferred<WebMercatorTerrainFrameSettlement>(),
            })
            pendingFeedback.push(feedbackEntry)
            feedbackByDecision.set(decisionSerial, feedbackEntry)
        }
        latestIssuedFrameEpoch = frame!.frameEpoch
        startFeedbackPump()

        state.frame++
        state.virtualSnapshotEpoch = residencySnapshotEpoch
        const decisionNeedsFeedback = latestSettledDecisionKey !== decisionKey
        const needsFollowUp = decisionNeedsFeedback && (
            feedbackEntry === undefined || feedbackEntry.frame.frameEpoch === frame!.frameEpoch
        )

        return Object.freeze({
            submitted: submitted!,
            observation,
            settlement: feedbackEntry?.settlement.promise ??
                Promise.resolve(emptyFrameSettlement()),
            provenance,
            needsFollowUp,
            terrainPresentation: frameTerrainPresentation,
        }) satisfies WebMercatorTerrainFrame<Presentation>
    }

    function startFeedbackPump(): void {

        const ready = pendingFeedback[0]
        if (feedbackPump !== undefined || state.disposed || ready === undefined ||
            ready.frame.frameEpoch >= latestIssuedFrameEpoch) return
        feedbackPump = drainReadyFeedback().finally(() => {
            feedbackPump = undefined
            startFeedbackPump()
        })
        void feedbackPump.catch(() => undefined)
    }

    async function drainReadyFeedback(): Promise<void> {

        while (!state.disposed) {
            const ready = pendingFeedback[0]
            if (ready === undefined || ready.frame.frameEpoch >= latestIssuedFrameEpoch) return
            pendingFeedback.shift()
            try {
                const consumed = await consumeFeedback(graph, ready, state)
                if (state.disposed) {
                    settleDeferred(ready.settlement, emptyFrameSettlement())
                } else {
                    settleConsumedFeedback(ready, consumed)
                }
            } catch (error) {
                if (state.disposed) settleDeferred(ready.settlement, emptyFrameSettlement())
                else rejectDeferred(ready.settlement, error)
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

        if (ready.decisionSerial !== latestDecisionSerial) {
            if (consumed.coverFeedback !== undefined) {
                state.supersededFeedbackCount++
            }
            settleDeferred(ready.settlement, Object.freeze({
                ...(consumed.coverFeedback === undefined
                    ? {}
                    : { coverFeedback: consumed.coverFeedback }),
                residencySettlement: Promise.resolve(undefined),
                residencyWorkCount: 0,
                needsFollowUp: false,
                superseded: true,
            }))
            return
        }

        const feedback = consumed.coverFeedback
        if (feedback === undefined) delete state.latestCoverFeedback
        else state.latestCoverFeedback = feedback
        const reconciliation = feedback === undefined
            ? undefined
            : virtualRaster.reconcileViewDemands(coverViewDemands(
                virtualRaster,
                terrainFieldLayer,
                feedback,
                consumed.view
            ))
        if (reconciliation !== undefined) {
            state.virtualRequestedPageCount += reconciliation.requestedCount
        }
        const scheduler = virtualRaster.scheduler.inspect()
        const needsFollowUp = feedback === undefined ||
            (reconciliation?.requestedCount ?? 0) > 0 ||
            scheduler.activeRequestCount > 0 ||
            scheduler.queuedRequestCount > 0
        if (!needsFollowUp) latestSettledDecisionKey = ready.decisionKey
        settleDeferred(ready.settlement, Object.freeze({
            ...(feedback === undefined ? {} : { coverFeedback: feedback }),
            ...(reconciliation === undefined ? {} : { reconciliation }),
            residencySettlement: reconciliation?.settlement ?? Promise.resolve(undefined),
            residencyWorkCount: reconciliation?.requestedCount ?? 0,
            needsFollowUp,
            superseded: false,
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
        for (const entry of feedbackByDecision.values()) {
            settleDeferred(entry.settlement, emptyFrameSettlement())
        }
        pendingFeedback.length = 0
        feedbackByDecision.clear()
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
    return Object.freeze({
        positions: Uint32Array.from(generated.positions, value =>
            Math.round(value * TERRAIN_SECTOR_SIZE)
        ),
        indices: new Uint32Array(generated.indices),
        vertexCount: generated.indices.length,
    })
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
            BUFFER_COPY_DST | BUFFER_STORAGE
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

function scaleElevationRange(
    range: readonly [number, number],
    exaggeration: number
): readonly [number, number] {

    return Object.freeze(range
        .map(value => value * exaggeration)
        .sort((left, right) => left - right) as [number, number])
}

function createRenderTemplates(cover: GpuWebMercatorQuadCover) {

    return Object.freeze({
        terrain: cover.renderTemplates(),
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
                readStorage(0, 'indices'),
                readStorage(1, 'gridPositions'),
                readStorage(2, 'visibleInstances'),
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
            indices: buffers.indices.region,
            gridPositions: buffers.positions.region,
            visibleInstances: template.visibleInstances.region(),
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
        indicesBinding: 0,
        gridPositionsBinding: 1,
        visibleInstancesBinding: 2,
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
        pipelines[presentation.id] = await runtime.createRenderPipeline({
            label: presentation.label ?? `Web Mercator terrain ${presentation.id} pipeline`,
            program: programs[presentation.id]!,
            layout: {
                mode: 'explicit',
                bindLayouts: [ layouts.scene, layouts.terrainData, layouts.terrainTextures ],
            },
            targets: [ { format: surface.format } ],
            primitive: { topology: 'triangle-list', cullMode: 'none' },
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
    pipelines: Pipelines
) {

    const terrainCommands = (
        label: string,
        pipeline: RenderPipeline
    ) => templates.terrain.map((template, parity) => runtime.createDrawCommand({
        label: `${label} ${parity}`,
        pipeline,
        bindSets: [
            { set: bindSets.scene[parity]! },
            { set: bindSets.terrainData[parity]! },
            { set: bindSets.terrainTextures },
        ],
        count: { indirect: template.drawArgument.region },
        resources: {
            read: currentReads([
                template.mapMeta,
                uniforms.config.buffer,
                buffers.indices.buffer,
                buffers.positions.buffer,
                template.visibleInstances,
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
            Object.entries(pipelines).map(([ id, pipeline ]) => [
                id,
                Object.freeze(terrainCommands(`Draw Web Mercator terrain ${id}`, pipeline)),
            ])
        )),
    })
}

function currentReads(resources: readonly ContentResource[]) {

    return resources.map(resource => ({ resource, contentEpoch: 'current-at-step' as const }))
}

async function consumeFeedback(
    graph: WebMercatorTerrainGraph,
    ready: PendingFeedback,
    state: WebMercatorTerrainState
): Promise<ConsumedFeedback> {

    const coverFeedback = await graph.cover.feedback(ready.frame, ready.submitted)
    return Object.freeze({
        decisionKey: ready.decisionKey,
        view: ready.view,
        coverFeedback,
    })
}

function feedbackCaptureAvailable(
    graph: WebMercatorTerrainGraph,
    frame: GpuWebMercatorQuadCoverFrame
): boolean {

    const commands = graph.cover.commandsFor(frame)
    return commands.stateFeedback.state === 'idle' &&
        commands.demandFeedback.state === 'idle'
}

function coverViewDemands(
    virtualRaster: WebMercatorTerrainVirtualRaster,
    fieldLayer: WebMercatorTerrainMapField,
    feedback: GpuWebMercatorQuadCoverFeedback,
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
            reason: `gpu-cover:${feedback.frameEpoch}:desired-z${demand.desiredSampleLevel}`,
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
        view.viewport,
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
            name: 'cover-visible-to-terrain-draw',
            resource: terrainTemplate.visibleInstances,
            consumerCommandId: terrainCommand.id,
        },
        {
            name: 'cover-lookup-to-terrain-draw',
            resource: terrainTemplate.coverLookup,
            consumerCommandId: terrainCommand.id,
        },
        {
            name: 'cover-indirect-to-terrain-draw',
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
    const templateResources = graph.renderTemplates.terrain.flatMap(template => [
        template.mapMeta,
        template.visibleInstances,
        template.coverLookup,
        template.drawArgument.resource,
    ])
    return {
        resources: uniqueById([
            graph.uniforms.config.buffer,
            graph.buffers.positions.buffer,
            graph.buffers.indices.buffer,
            graph.virtualRaster.gpu.atlas,
            graph.virtualRaster.gpu.pageTable,
            graph.virtualRaster.gpu.slotTable,
            graph.textures.depth,
            ...templateResources,
            ...coverIdentity.resources,
        ]),
        uploads: [
            graph.uniforms.config.upload,
            graph.buffers.positions.upload,
            graph.buffers.indices.upload,
            ...coverIdentity.uploads,
        ],
        bindLayouts: [ ...Object.values(graph.layouts), ...coverIdentity.bindLayouts ],
        bindSets: [ ...allBindSets(graph.bindSets), ...coverIdentity.bindSets ],
        programs: [ ...Object.values(graph.programs), ...coverIdentity.programs ],
        pipelines: [ ...Object.values(graph.pipelines), ...coverIdentity.pipelines ],
        passes: [ ...Object.values(graph.passes), ...coverIdentity.passes ],
        commands: [
            ...coverIdentity.commands,
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
        sourceMaximumMatrixLevel: graph.cover.descriptor.policy.sourceMaximumMatrixLevel,
        coverMaximumMatrixLevel: graph.cover.descriptor.policy.maximumMatrixLevel,
        fieldLayer: Object.freeze({
            id: graph.fieldLayer.id,
            fieldId: graph.fieldLayer.field.id,
            representationId: graph.fieldLayer.representation.id,
            spatialProfileId: graph.fieldLayer.spatialProfile.id,
            viewAdapterId: graph.fieldLayer.viewAdapter.id,
            demandProducerId: graph.fieldLayer.demandProducer.id,
        }),
        terrainVertexCount: graph.geometry.vertexCount,
        cover: graph.cover.facts(),
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
            terrain: graph.passes.terrain.id,
        }),
        commandIds: Object.freeze({
            cover: Object.freeze(
                graph.cover.facts().parity.map(parity => parity.commandIds)
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
}

function stateSnapshot<Presentation extends string>(
    state: WebMercatorTerrainState<Presentation>,
    pendingFeedbackCount: number
): WebMercatorTerrainRendererState<Presentation> {

    const cover = state.latestCoverFeedback
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
        coverDemandCount: cover?.demandCount ?? 0,
        coverLevelRange: Object.freeze([
            cover?.minimumMatrixLevel,
            cover?.maximumMatrixLevel,
        ] as const),
        coverDescriptorOverflowCount: cover?.descriptorOverflowCount ?? 0,
        coverLookupOverflowCount: cover?.lookupOverflowCount ?? 0,
        coverDemandOverflowCount: cover?.demandOverflowCount ?? 0,
        coverMaximumAdjacentLevelDelta: cover?.maximumAdjacentLevelDelta ?? 0,
        ...(cover === undefined ? {} : {
            coverFinestMatrixLevel: cover.finestMatrixLevel,
            sourceLevelCeiling: cover.sourceLevelCeiling,
            coverFrameEpoch: cover.frameEpoch,
            coverFeedback: cover,
        }),
        convergenceState: cover === undefined ? 'transitioning' : 'converged',
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

    const nominalPatchSpan = TERRAIN_SECTOR_SIZE * 8
    const viewportColumns = Math.ceil(size.width / nominalPatchSpan) + 1
    const viewportRows = Math.ceil(size.height / nominalPatchSpan) + 1
    const required = Math.max(16, viewportColumns * viewportRows * 12)
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
