import {
    GPURuntime,
    layoutCodec,
    plane,
    type BindLayoutEntry,
    type BindVisibility,
    type BufferResource,
    type LayoutCodec,
    type LayoutFixedFieldDescriptor,
    type Program,
    type ProgramBufferLayoutRequirement,
    type RenderPipeline,
    type SubmittedWork,
    type Surface,
    type SurfaceSize,
    type TextureResource,
} from '../scratch/index.js'
import {
    GPU_RENDER_PATCH_DEFAULT_CELLS_PER_EDGE,
    GPU_RENDER_PATCH_DEFAULT_MAXIMUM_CELL_SPAN_PIXELS,
    GPU_RENDER_PATCH_MAXIMUM_EXTRA_LEVELS,
    GPU_RENDER_PATCH_MAXIMUM_MATRIX_LEVEL,
    GpuRenderPatchFeedbackStaleError,
    createGpuRenderPatchFrontier,
    gpuRenderPatchWgslModule,
    type GpuRenderPatchFeedback,
    type GpuRenderPatchFrontier,
    type GpuRenderPatchFrontierFacts,
} from './gpu-render-patch-frontier.js'
import { GeoDiagnosticError } from './diagnostics.js'
import { GpuTileFrontier } from './gpu-tile-frontier.js'
import type { GpuTileFrontierFrame } from './gpu-tile-frontier.js'
import { gpuTileFrontierPolicy } from './gpu-tile-frontier-layout.js'
import type { GpuTileFrontierFacts } from './gpu-tile-frontier-layout.js'
import type { GeoViewSnapshot } from './geo-view.js'
import type { MapFieldLayer } from './map-field-layer.js'
import {
    WEB_MERCATOR_QUAD_HALF_WORLD,
    WEB_MERCATOR_QUAD_WORLD_WIDTH,
    WebMercatorQuad,
} from './web-mercator-quad.js'
import type { WebMercatorVirtualRasterField } from './web-mercator-virtual-raster-field.js'
import { webMercatorVirtualRasterWgslModule } from './web-mercator-virtual-raster-wgsl.js'
import { VirtualRasterGpuFeedbackRing } from './virtual-raster-gpu-feedback.js'
import type {
    VirtualRasterGpuFeedbackBatch,
    VirtualRasterGpuFeedbackRingFacts,
} from './virtual-raster-gpu-feedback.js'
import type {
    VirtualRasterFeedbackReconciliation,
    VirtualRasterRuntime,
    VirtualRasterRuntimeFacts,
} from './virtual-raster-runtime.js'

export type TerrainFieldPresentationDescriptor<Presentation extends string = string> =
    Readonly<{
        id: Presentation
        fragmentEntryPoint: string
        label?: string
    }>

export type TerrainFieldSamplingWgslOptions = Readonly<{
    namespace: string
    addressNamespace: string
    transitionTexels?: number
}>

export type TerrainFieldProvenanceFact = Readonly<{
    name: string
    resourceId: string
    declaredContentEpoch: 'current-at-step'
    producerContentEpoch: number
    readContentEpoch: number
    producerStepIndex: number
    consumerStepIndex: number
}>

export type TerrainFieldResizeFacts = Readonly<{
    resizeGeneration: number
    staleBindSetCount: number
    preparedBindSetCount: number
    depthAllocationVersion: number
}>

export type TerrainFieldSubmissionObservation = Readonly<{
    submissionId: string
    nativeStatus: 'observed-succeeded'
}>

export type TerrainFieldInitialization = Readonly<{
    submitted: SubmittedWork
    observation: Promise<TerrainFieldSubmissionObservation>
}>

export type TerrainFieldFrame<Presentation extends string = string> = Readonly<{
    submitted: SubmittedWork
    observation: Promise<TerrainFieldSubmissionObservation>
    provenance: readonly TerrainFieldProvenanceFact[]
    feedback?: VirtualRasterGpuFeedbackBatch
    renderPatchFeedback?: GpuRenderPatchFeedback
    reconciliation?: VirtualRasterFeedbackReconciliation
    residencySettlement: Promise<unknown>
    requestedPageCount: number
    needsFollowUp: boolean
    terrainPresentation: Presentation
}>

export type TerrainFieldIdentityFacts = Readonly<{
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

export type TerrainFieldPersistentFacts = Readonly<{
    resources: number
    bindLayouts: number
    bindSets: number
    pipelines: number
    logicalFootprintBytes: number
}>

export type TerrainFieldContractFacts = Readonly<{
    stageOrder: readonly string[]
    countPath: 'gpu-produced-indirect-arguments'
    selectionPath: 'gpu-resident-active-frontier'
    dataMaximumMatrixLevel: number
    renderMaximumMatrixLevel: number
    fieldLayer: Readonly<{
        id: string
        fieldId: string
        representationId: string
        spatialProfileId: string
        viewAdapterId: string
        demandProducerId: string
    }>
    terrainVertexCount: number
    frontier: ReturnType<GpuTileFrontier['facts']>
    renderPatches: GpuRenderPatchFrontierFacts
    feedback: VirtualRasterGpuFeedbackRingFacts
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
    passIds: Readonly<{ renderPatches: string, terrain: string }>
    commandIds: Readonly<{
        renderPatches: readonly (readonly string[])[]
        drawTerrain: Readonly<Record<string, readonly string[]>>
    }>
}>

export type TerrainFieldRendererState<Presentation extends string = string> = Readonly<{
    initialized: boolean
    disposed: boolean
    frame: number
    size: SurfaceSize
    resizeGeneration: number
    staleBindSetPreparationCount: number
    lastResizeFacts?: TerrainFieldResizeFacts
    virtualSnapshotEpoch: number
    virtualRequestedPageCount: number
    readbackInFlightCount: number
    staleFeedbackCount: number
    supersededFeedbackCount: number
    frontierCount: number
    visibleNodeCount: number
    demandCount: number
    fallbackCount: number
    staleGenerationCount: number
    budgetLimitedCount: number
    levelRange: readonly [number | undefined, number | undefined]
    maximumObservedSse: number
    renderPatchCount: number
    renderPatchLevelRange: readonly [number | undefined, number | undefined]
    renderPatchCellSpanRange: readonly [number | undefined, number | undefined]
    renderPatchDescriptorOverflowCount: number
    renderPatchLookupOverflowCount: number
    renderPatchFrameEpoch?: number
    renderPatchBaselineBudget: number
    renderPatchFrameBudget: number
    renderPatchRequestedCount: number
    renderPatchMinimumTrialCount: number
    renderPatchSourceRootCount: number
    renderPatchSelectedBiasLevels: number
    renderPatchBudgetLimitedByMinimumTrial: boolean
    renderPatchFeedback?: GpuRenderPatchFeedback
    convergenceState: GpuTileFrontierFacts['convergenceState']
    frontierFacts?: GpuTileFrontierFacts
    latestFeedbackDiagnostics: readonly unknown[]
    terrainPresentation: Presentation
    feedback: VirtualRasterGpuFeedbackRingFacts
}>

export type TerrainFieldRenderer<
    ViewInput,
    Presentation extends string = string,
> = Readonly<{
    initialize(): Promise<TerrainFieldInitialization>
    renderFrame(input: ViewInput): Promise<TerrainFieldFrame<Presentation>>
    setPresentation(presentation: Presentation): Presentation
    resize(size: SurfaceSize): Promise<TerrainFieldResizeFacts>
    dispose(): void
    stableIdentities: readonly string[]
    stableIdentityHash: string
    stableIdentityFacts: TerrainFieldIdentityFacts
    currentIdentityFacts(): TerrainFieldIdentityFacts
    persistentFacts(): TerrainFieldPersistentFacts
    contractFacts(): TerrainFieldContractFacts
    virtualRasterFacts(): VirtualRasterRuntimeFacts
    state(): TerrainFieldRendererState<Presentation>
}>

export type TerrainFieldRendererDescriptor<
    ViewInput,
    Presentation extends string = string,
> = Readonly<{
    runtime: GPURuntime
    surface: Surface
    fieldLayer: MapFieldLayer<ViewInput>
    virtualRaster: VirtualRasterRuntime<WebMercatorVirtualRasterField>
    size: SurfaceSize
    shader: string
    fieldSampling: TerrainFieldSamplingWgslOptions
    elevationRangeMeters: readonly [number, number]
    exaggeration?: number
    presentations: readonly TerrainFieldPresentationDescriptor<Presentation>[]
    initialPresentation: Presentation
    observeProvenance?: (facts: readonly TerrainFieldProvenanceFact[]) => void
}>

type TerrainVirtualRaster = VirtualRasterRuntime<WebMercatorVirtualRasterField>
type TerrainMapField = Readonly<{
    id: string
    field: TerrainVirtualRaster['field']
    representation: TerrainVirtualRaster['representation']
    spatialProfile: TerrainVirtualRaster['spatialProfile']
    viewAdapter: Readonly<{ id: string }>
    demandProducer: TerrainVirtualRaster['viewDemandProducer']
}>
type Codecs = ReturnType<typeof createCodecs>
type TerrainGeometry = ReturnType<typeof createTerrainGeometry>
type Uniforms = Awaited<ReturnType<typeof createUniformResources>>
type Buffers = Awaited<ReturnType<typeof createBufferResources>>
type Textures = Awaited<ReturnType<typeof createTextures>>
type Frontier = Awaited<ReturnType<typeof createFrontier>>
type FrontierRenderTemplates = ReturnType<typeof createFrontierRenderTemplates>
type RenderPatchFrontier = GpuRenderPatchFrontier
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

type TerrainFieldGraph = {
    runtime: GPURuntime
    surface: Surface
    virtualRaster: TerrainVirtualRaster
    fieldLayer: TerrainMapField
    codecs: Codecs
    geometry: TerrainGeometry
    uniforms: Uniforms
    buffers: Buffers
    textures: Textures
    frontier: Frontier
    frontierRenderTemplates: FrontierRenderTemplates
    renderPatchFrontier: RenderPatchFrontier
    feedbackRing: VirtualRasterGpuFeedbackRing
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
    graph: TerrainFieldGraph,
    frame: GpuTileFrontierFrame,
    terrainPresentation: string
) => readonly TerrainFieldProvenanceFact[]

type TerrainFieldState<Presentation extends string = string> = {
    initialized: boolean
    disposed: boolean
    frame: number
    size: SurfaceSize
    resizeGeneration: number
    staleBindSetPreparationCount: number
    lastResizeFacts?: TerrainFieldResizeFacts
    virtualSnapshotEpoch: number
    virtualRequestedPageCount: number
    staleFeedbackCount: number
    supersededFeedbackCount: number
    latestFrontierFacts?: GpuTileFrontierFacts
    latestRenderPatchFeedback?: GpuRenderPatchFeedback
    latestFeedbackDiagnostics: readonly unknown[]
    terrainPresentation: Presentation
}

type PersistentFacts = TerrainFieldPersistentFacts

type PendingFeedback = Readonly<{
    frame: GpuTileFrontierFrame
    view: GeoViewSnapshot
    submitted: SubmittedWork
    decisionKey: string
}>

type ConsumedFeedback = Readonly<{
    decisionKey: string
    view: GeoViewSnapshot
    feedback?: VirtualRasterGpuFeedbackBatch
    renderPatchFeedback?: GpuRenderPatchFeedback
}>

export const TERRAIN_FIELD_STAGE_ORDER = Object.freeze([
    'frontier-compute',
    'render-patch-compute',
    'terrain',
])
const TERRAIN_SECTOR_SIZE = GPU_RENDER_PATCH_DEFAULT_CELLS_PER_EDGE
const BUFFER_COPY_DST = 0x08
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80
const TEXTURE_RENDER_ATTACHMENT = 0x10

export async function createTerrainFieldRenderer<
    ViewInput,
    Presentation extends string,
>({
    runtime,
    surface,
    fieldLayer,
    virtualRaster,
    size,
    shader,
    fieldSampling,
    elevationRangeMeters,
    exaggeration = 1,
    presentations,
    initialPresentation,
    observeProvenance,
}: TerrainFieldRendererDescriptor<ViewInput, Presentation>): Promise<
    TerrainFieldRenderer<ViewInput, Presentation>
> {

    if (!(runtime instanceof GPURuntime)) {
        throw new TypeError('Terrain field renderer requires GPURuntime')
    }
    assertSize(size)
    assertVirtualRaster(virtualRaster)
    assertFieldLayer(fieldLayer, virtualRaster)
    assertShader(shader)
    assertFieldSampling(fieldSampling)
    assertElevation(elevationRangeMeters, exaggeration)
    const presentationTable = normalizePresentations(presentations, initialPresentation)
    const terrainFieldLayer = fieldLayer as unknown as TerrainMapField
    if (observeProvenance !== undefined && typeof observeProvenance !== 'function') {
        throw new TypeError('Terrain field provenance observer must be a function')
    }

    const codecs = createCodecs()
    const geometry = createTerrainGeometry()
    const buffers = await createBufferResources(runtime, geometry)
    const textures = await createTextures(runtime, size)
    const exaggeratedElevationRange = scaleElevationRange(
        elevationRangeMeters,
        exaggeration
    )
    const frontier = await createFrontier(
        runtime,
        virtualRaster,
        terrainFieldLayer,
        exaggeratedElevationRange
    )
    const feedbackRing = await VirtualRasterGpuFeedbackRing.create(frontier)
    const frontierRenderTemplates = createFrontierRenderTemplates(frontier)
    const renderPatchFrontier = await createGpuRenderPatchFrontier(runtime, {
        sourceTemplates: frontierRenderTemplates.renderPatch,
        maximumSourceTiles: frontier.descriptor.policy.maximumActiveTiles,
        dataMaximumMatrixLevel: frontier.descriptor.policy.maximumMatrixLevel,
        renderMaximumMatrixLevel: GPU_RENDER_PATCH_MAXIMUM_MATRIX_LEVEL,
        maximumExtraLevels: GPU_RENDER_PATCH_MAXIMUM_EXTRA_LEVELS,
        coordinateBits: virtualRaster.addressCodec.coordinateBits,
        elevationRangeMeters: exaggeratedElevationRange,
        vertexCount: geometry.vertexCount,
        cellsPerPatchEdge: TERRAIN_SECTOR_SIZE,
        maximumCellSpanPixels: GPU_RENDER_PATCH_DEFAULT_MAXIMUM_CELL_SPAN_PIXELS,
    })
    const renderTemplates = createRenderTemplates(renderPatchFrontier)
    const uniforms = await createUniformResources(
        runtime,
        codecs,
        virtualRaster,
        renderPatchFrontier.facts().renderPatchLookupCapacity,
        elevationRangeMeters,
        exaggeration
    )
    const layouts = await createBindLayouts(
        runtime,
        codecs,
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
        codecs,
        shader,
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
    const graph: TerrainFieldGraph = {
        runtime,
        surface,
        virtualRaster,
        fieldLayer: terrainFieldLayer,
        codecs,
        geometry,
        uniforms,
        buffers,
        textures,
        frontier,
        frontierRenderTemplates,
        renderPatchFrontier,
        feedbackRing,
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
    const stableIdentities = Object.freeze(stableIdentitySnapshot(graph))
    const stableIdentityFacts = identityFactSnapshot(graph)
    const stableIdentityHash = stableIdentityFacts.hash
    const persistentBaseline = persistentFactSnapshot(runtime)
    let initialization: Promise<Readonly<{
        submitted: SubmittedWork
        observation: Promise<Readonly<{ submissionId: string; nativeStatus: 'observed-succeeded' }>>
    }>> | undefined

    function initialize() {

        if (initialization !== undefined) return initialization
        initialization = initializeOnce()
        return initialization
    }

    async function initializeOnce() {

        const publication = await virtualRaster.initialize()
        const uploadBuilder = runtime.createSubmission({ validation: 'throw' })
            .upload(uniforms.config.upload)
            .upload(buffers.positions.upload)
            .upload(buffers.indices.upload)
        renderPatchFrontier.initialize(uploadBuilder)
        for (const upload of publication.update.commands) uploadBuilder.upload(upload)
        const residencySubmitted = uploadBuilder.submit()
        await Promise.all([
            observeSubmittedWork(residencySubmitted),
            virtualRaster.acknowledge(publication, residencySubmitted),
        ])

        const seed = frontier.stageSeed(publication.publication.snapshot)
        const seedBuilder = runtime.createSubmission({ validation: 'throw' })
        for (const command of seed.commands) {
            if (command.commandKind === 'clear') seedBuilder.clear(command)
            else seedBuilder.upload(command)
        }
        const submitted = seedBuilder.submit()
        const observation = observeSubmittedWork(submitted).then(result => {
            state.initialized = true
            state.virtualSnapshotEpoch = publication.snapshotEpoch
            return result
        })
        return Object.freeze({ submitted, observation })
    }

    async function renderFrame(input: ViewInput) {

        if (!state.initialized) throw new Error('Terrain field graph must be initialized before rendering')
        if (state.disposed) throw new Error('Terrain field graph is disposed')
        assertSameIdentities(stableIdentities, stableIdentitySnapshot(graph), 'frame')
        assertPersistentCounts(persistentBaseline, persistentFactSnapshot(runtime), 'frame')
        const frameTerrainPresentation = state.terrainPresentation

        const noOpPublication = await publishChangedResidency(graph, state)
        const residencySnapshotEpoch = virtualRaster.gpu.facts().snapshotEpoch
        const view = fieldLayer.viewAdapter.read(input, {
            frameEpoch: state.frame + 1,
            residencySnapshotEpoch,
        })
        const decisionKey = frontierDecisionKey(view)
        const viewToken = frontier.writeView(view)
        let frame: GpuTileFrontierFrame
        let submitted: SubmittedWork
        try {
            frame = frontier.frame(viewToken)
            const builder = runtime.createSubmission({ validation: 'throw' })
            frontier.encode(builder, frame)
            renderPatchFrontier.encode(builder, frame)
            builder.render(passes.terrain, [
                commands.terrain[frameTerrainPresentation][frame.parity]!,
            ])
            renderPatchFrontier.capture(builder, frame)
            feedbackRing.encode(builder, frame)
            submitted = builder.submit()
        } finally {
            viewToken.dispose()
        }
        if (noOpPublication !== undefined) {
            await virtualRaster.acknowledge(noOpPublication, submitted!)
        }

        let provenance: readonly TerrainFieldProvenanceFact[] = Object.freeze([])
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
        const observation = provenanceFailure === undefined
            ? nativeObservation
            : nativeObservation.then(() => { throw provenanceFailure })

        pendingFeedback.push(Object.freeze({
            frame: frame!,
            view,
            submitted: submitted!,
            decisionKey,
        }))
        const consumed = await consumeReadyFeedback(graph, pendingFeedback, state)
        if (consumed?.renderPatchFeedback !== undefined) {
            state.latestRenderPatchFeedback = consumed.renderPatchFeedback
        }
        const feedback = consumed?.decisionKey === decisionKey
            ? consumed.feedback
            : undefined
        if (consumed?.feedback !== undefined && consumed.decisionKey !== decisionKey) {
            state.supersededFeedbackCount++
        }
        if (feedback === undefined) {
            delete state.latestFrontierFacts
            state.latestFeedbackDiagnostics = Object.freeze([])
        } else {
            state.latestFrontierFacts = feedback.facts
            state.latestFeedbackDiagnostics = feedback.diagnostics
        }
        const reconciliation = feedback === undefined
            ? undefined
            : virtualRaster.reconcileFeedback(feedback, consumed!.view)
        if (reconciliation !== undefined) {
            state.virtualRequestedPageCount += reconciliation.requestedCount
        }

        state.frame++
        state.virtualSnapshotEpoch = virtualRaster.gpu.facts().snapshotEpoch
        const needsFollowUp = feedback === undefined ||
            feedback.facts.convergenceState === 'transitioning' ||
            (reconciliation?.requestedCount ?? 0) > 0

        return Object.freeze({
            submitted: submitted!,
            observation,
            provenance,
            ...(feedback === undefined ? {} : { feedback }),
            ...(consumed?.renderPatchFeedback === undefined
                ? {}
                : { renderPatchFeedback: consumed.renderPatchFeedback }),
            ...(reconciliation === undefined ? {} : { reconciliation }),
            residencySettlement: reconciliation?.settlement ?? Promise.resolve(undefined),
            requestedPageCount: reconciliation?.requestedCount ?? 0,
            needsFollowUp,
            terrainPresentation: frameTerrainPresentation,
        }) satisfies TerrainFieldFrame<Presentation>
    }

    function setPresentation(nextPresentation: Presentation) {

        if (!presentationTable.has(nextPresentation)) {
            throw new TypeError(`Unknown terrain presentation ${nextPresentation}`)
        }
        if (state.disposed) throw new Error('Terrain field graph is disposed')
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
        pendingFeedback.length = 0
        feedbackRing.dispose()
        renderPatchFrontier.dispose()
        frontier.dispose()
    }

    return Object.freeze({
        initialize,
        renderFrame,
        setPresentation,
        resize,
        dispose,
        stableIdentities,
        stableIdentityHash,
        stableIdentityFacts,
        currentIdentityFacts: () => identityFactSnapshot(graph),
        persistentFacts: () => persistentFactSnapshot(runtime),
        contractFacts: () => graphContractSnapshot(graph),
        virtualRasterFacts: virtualRaster.inspect,
        state: () => stateSnapshot(state, pendingFeedback.length, feedbackRing),
    })
}

function createCodecs() {

    const uniform = (name: string, fields: LayoutFixedFieldDescriptor[]) =>
        layoutCodec({ name, fields }, { usage: [ 'uniform' ] })
    return Object.freeze({
        config: uniform('TerrainFieldConfig', [
            { name: 'sourceMercatorBox', type: 'vec4f' },
            { name: 'elevationRange', type: 'vec2f' },
            { name: 'coordinateBits', type: 'u32' },
            { name: 'exaggeration', type: 'f32' },
            { name: 'renderMaximumMatrixLevel', type: 'u32' },
            { name: 'renderPatchLookupCapacity', type: 'u32' },
        ]),
    })
}

async function createUniformResources(
    runtime: GPURuntime,
    codecs: Codecs,
    virtualRaster: TerrainVirtualRaster,
    renderPatchLookupCapacity: number,
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
        config: await createUniform(runtime, 'Terrain field terrain configuration', codecs.config, {
            sourceMercatorBox,
            elevationRange: elevationRangeMeters,
            coordinateBits: virtualRaster.addressCodec.coordinateBits,
            exaggeration,
            renderMaximumMatrixLevel: GPU_RENDER_PATCH_MAXIMUM_MATRIX_LEVEL,
            renderPatchLookupCapacity,
        }),
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
            'Terrain field terrain positions',
            geometry.positions,
            BUFFER_COPY_DST | BUFFER_STORAGE
        ),
        indices: await createBufferWithUpload(
            runtime,
            'Terrain field terrain indices',
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
        label: 'Terrain field presentation depth',
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

async function createFrontier(
    runtime: GPURuntime,
    virtualRaster: TerrainVirtualRaster,
    fieldLayer: TerrainMapField,
    elevationRangeMeters: readonly [number, number]
) {

    const matrixIds = virtualRaster.coverage.limits.map(limit => limit.matrixId)
    const minimumMatrixLevel = Number(matrixIds[0])
    const maximumMatrixLevel = Number(matrixIds.at(-1))
    const rootCount = virtualRaster.safetyCoverPages.length
    const maxPhysicalPages = virtualRaster.gpu.maxPhysicalPages
    if (maxPhysicalPages <= rootCount) {
        throw new Error('Terrain field GPU frontier requires transition capacity beyond its safety cover')
    }
    const transitionReservePages = Math.min(5, maxPhysicalPages - rootCount)
    const maximumActiveTiles = Math.max(rootCount, Math.min(
        virtualRaster.coverage.entryCount,
        maxPhysicalPages - transitionReservePages
    ))
    const maximumDemands = Math.max(1, Math.min(
        maximumActiveTiles * 4,
        virtualRaster.scheduler.maxRequests
    ))
    return GpuTileFrontier.create(runtime, {
        gpuState: virtualRaster.gpu,
        spatialProfile: fieldLayer.spatialProfile,
        policy: gpuTileFrontierPolicy({
            refineErrorPixels: 2,
            coarsenErrorPixels: 1,
            minimumMatrixLevel,
            maximumMatrixLevel,
            maximumActiveTiles,
            maximumDemands,
            transitionReservePages,
            invisibleGraceFrames: 2,
        }),
        levelMetrics: matrixIds.map(matrixId => {
            const matrix = WebMercatorQuad.matrix(matrixId)
            return Object.freeze({
                matrixLevel: Number(matrixId),
                minimumElevationMeters: elevationRangeMeters[0],
                maximumElevationMeters: elevationRangeMeters[1],
                geometricErrorMeters: matrix.cellSize,
            })
        }),
        roots: virtualRaster.safetyCoverPages,
        drawTemplates: [
            { id: 'render-patch-source', vertexCount: 1 },
        ],
    })
}

function scaleElevationRange(
    range: readonly [number, number],
    exaggeration: number
): readonly [number, number] {

    return Object.freeze(range
        .map(value => value * exaggeration)
        .sort((left, right) => left - right) as [number, number])
}

function createFrontierRenderTemplates(frontier: GpuTileFrontier) {

    return Object.freeze({
        renderPatch: frontier.renderTemplates('render-patch-source'),
    })
}

function createRenderTemplates(frontier: GpuRenderPatchFrontier) {

    return Object.freeze({
        terrain: frontier.renderTemplates(),
    })
}

async function createBindLayouts(runtime: GPURuntime, codecs: Codecs, mapMetaBytes: number) {

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
            label: 'Terrain field frontier scene layout',
            group: 0,
            entries: [
                uniform(0, 'mapMeta', mapMetaBytes, [ 'vertex' ]),
                uniform(1, 'terrainConfig', codecs.config.byteLength(), [ 'vertex' ]),
            ],
        }),
        terrainData: await runtime.createBindLayout({
            label: 'Terrain field terrain frontier data layout',
            group: 1,
            entries: [
                readStorage(0, 'indices'),
                readStorage(1, 'gridPositions'),
                readStorage(2, 'visibleInstances'),
                readStorage(3, 'renderPatchLookupEntries'),
            ],
        }),
        terrainTextures: await runtime.createBindLayout({
            label: 'Terrain field terrain texture layout',
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
    virtualRaster: TerrainVirtualRaster,
    templates: RenderTemplates
) {

    const terrainData = []
    for (const [ parity, template ] of templates.terrain.entries()) {
        terrainData.push(await runtime.createBindSet(layouts.terrainData, {
            indices: buffers.indices.region,
            gridPositions: buffers.positions.region,
            visibleInstances: template.visibleInstances.region(),
            renderPatchLookupEntries: template.renderPatchLookup.region(),
        }, { label: `Terrain field terrain frontier data ${parity}` }))
    }

    return {
        scene: await runtime.createBindSet(layouts.scene, {
            mapMeta: templates.terrain[0].mapMeta.region(),
            terrainConfig: uniforms.config.region,
        }, { label: 'Terrain field frontier scene' }),
        terrainData,
        terrainTextures: await runtime.createBindSet(layouts.terrainTextures, {
            fieldPageTable: virtualRaster.gpu.pageTable.region(),
            fieldAtlas: virtualRaster.gpu.atlasView,
        }, { label: 'Terrain field terrain textures' }),
    }
}

async function createPrograms({
    runtime,
    codecs,
    shader,
    fieldSampling,
    virtualRaster,
    presentations,
}: Readonly<{
    runtime: GPURuntime
    codecs: Codecs
    shader: string
    fieldSampling: TerrainFieldSamplingWgslOptions
    virtualRaster: TerrainVirtualRaster
    presentations: ReadonlyMap<string, TerrainFieldPresentationDescriptor>
}>): Promise<Readonly<Record<string, Program>>> {

    const renderWgsl = gpuRenderPatchWgslModule()
    const configRequirement: ProgramBufferLayoutRequirement = {
        group: 0,
        binding: 1,
        type: 'uniform',
        hasDynamicOffset: false,
        layout: codecs.config.artifact,
    }
    const frontierSource = {
        code: renderWgsl.code,
        layoutDependencies: renderWgsl.layoutDependencies,
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
    const terrainShader = await runtime.createShaderModule({
        label: 'Terrain field terrain shader',
        sourceParts: [
            frontierSource,
            { code: fieldWgsl.code },
            { code: shader },
        ],
    })
    const programs: Record<string, Program> = {}
    for (const presentation of presentations.values()) {
        programs[presentation.id] = runtime.createProgram({
            label: presentation.label ?? `Terrain field ${presentation.id} program`,
            vertex: { module: terrainShader, entryPoint: 'vMain' },
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
    presentations: ReadonlyMap<string, TerrainFieldPresentationDescriptor>
): Promise<Readonly<Record<string, RenderPipeline>>> {

    const pipelines: Record<string, RenderPipeline> = {}
    for (const presentation of presentations.values()) {
        pipelines[presentation.id] = await runtime.createRenderPipeline({
            label: presentation.label ?? `Terrain field ${presentation.id} pipeline`,
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
            label: 'Terrain field terrain stage',
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
    virtualRaster: TerrainVirtualRaster,
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
            { set: bindSets.scene },
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
                template.renderPatchLookup,
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
                Object.freeze(terrainCommands(`Draw terrain field ${id}`, pipeline)),
            ])
        )),
    })
}

function currentReads(resources: readonly ContentResource[]) {

    return resources.map(resource => ({ resource, contentEpoch: 'current-at-step' as const }))
}

async function publishChangedResidency(graph: TerrainFieldGraph, state: TerrainFieldState) {

    const publication = graph.virtualRaster.publish()
    if (!publication.changed) return publication
    const builder = graph.runtime.createSubmission({ validation: 'throw' })
    for (const upload of publication.update.commands) builder.upload(upload)
    const submitted = builder.submit()
    await Promise.all([
        observeSubmittedWork(submitted),
        graph.virtualRaster.acknowledge(publication, submitted),
    ])
    state.virtualSnapshotEpoch = publication.snapshotEpoch
    return undefined
}

async function consumeReadyFeedback(
    graph: TerrainFieldGraph,
    pending: PendingFeedback[],
    state: TerrainFieldState
): Promise<ConsumedFeedback | undefined> {

    if (pending.length < 2) return undefined
    const ready = pending.shift()!
    const [ frontierResult, renderPatchResult ] = await Promise.allSettled([
        graph.feedbackRing.feedback(ready.frame, ready.submitted),
        graph.renderPatchFrontier.feedback(ready.frame, ready.submitted),
    ])
    let feedback: VirtualRasterGpuFeedbackBatch | undefined
    if (frontierResult.status === 'fulfilled') {
        feedback = frontierResult.value
    } else {
        const code = frontierResult.reason instanceof GeoDiagnosticError
            ? frontierResult.reason.diagnostic.code
            : undefined
        if (code !== 'GEO_GPU_TILE_FEEDBACK_STALE') throw frontierResult.reason
        state.staleFeedbackCount++
    }
    let renderPatchFeedback: GpuRenderPatchFeedback | undefined
    if (renderPatchResult.status === 'fulfilled') {
        renderPatchFeedback = renderPatchResult.value
    } else if (!(renderPatchResult.reason instanceof GpuRenderPatchFeedbackStaleError)) {
        throw renderPatchResult.reason
    }
    return Object.freeze({
        decisionKey: ready.decisionKey,
        view: ready.view,
        ...(feedback === undefined ? {} : { feedback }),
        ...(renderPatchFeedback === undefined ? {} : { renderPatchFeedback }),
    })
}

function frontierDecisionKey(view: GeoViewSnapshot): string {

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
    graph: TerrainFieldGraph,
    frame: GpuTileFrontierFrame,
    terrainPresentation: string
) {

    const terrainCommand = graph.commands.terrain[terrainPresentation]![frame.parity]!
    const renderPatchCommands = graph.renderPatchFrontier.commandsFor(frame)
    const sourceTemplate = graph.frontierRenderTemplates.renderPatch[frame.parity]
    const terrainTemplate = graph.renderTemplates.terrain[frame.parity]
    const pairs = [
        {
            name: 'frontier-map-meta-to-render-patch',
            resource: sourceTemplate.mapMeta,
            consumerCommandId: renderPatchCommands.expand.id,
        },
        {
            name: 'frontier-visible-to-render-patch',
            resource: sourceTemplate.visibleInstances,
            consumerCommandId: renderPatchCommands.expand.id,
        },
        {
            name: 'frontier-indirect-to-render-patch',
            resource: sourceTemplate.drawArgument.resource,
            consumerCommandId: renderPatchCommands.expand.id,
        },
        {
            name: 'render-patch-visible-to-terrain-draw',
            resource: terrainTemplate.visibleInstances,
            consumerCommandId: terrainCommand.id,
        },
        {
            name: 'render-patch-lookup-to-terrain-draw',
            resource: terrainTemplate.renderPatchLookup,
            consumerCommandId: terrainCommand.id,
        },
        {
            name: 'render-patch-indirect-to-terrain-draw',
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
            throw new Error(`Terrain field submission provenance mismatch for ${pair.name}`)
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

function stableIdentitySnapshot(graph: TerrainFieldGraph) {

    const objects = Object.values(identityObjectsByKind(graph)).flat()
    return [ ...new Set(objects.map(object => object.id)) ].sort()
}

function identityFactSnapshot(graph: TerrainFieldGraph) {

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

function identityObjectsByKind(graph: TerrainFieldGraph) {

    const renderPatchIdentity = graph.renderPatchFrontier.identityObjects()
    const templateResources = [
        ...graph.frontierRenderTemplates.renderPatch,
        ...graph.renderTemplates.terrain,
    ].flatMap(template => [
        template.mapMeta,
        template.visibleInstances,
        ...('renderPatchLookup' in template ? [ template.renderPatchLookup ] : []),
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
            ...renderPatchIdentity.resources,
        ]),
        uploads: [
            graph.uniforms.config.upload,
            graph.buffers.positions.upload,
            graph.buffers.indices.upload,
            ...renderPatchIdentity.uploads,
        ],
        bindLayouts: [ ...Object.values(graph.layouts), ...renderPatchIdentity.bindLayouts ],
        bindSets: [ ...allBindSets(graph.bindSets), ...renderPatchIdentity.bindSets ],
        programs: [ ...Object.values(graph.programs), ...renderPatchIdentity.programs ],
        pipelines: [ ...Object.values(graph.pipelines), ...renderPatchIdentity.pipelines ],
        passes: [ ...Object.values(graph.passes), ...renderPatchIdentity.passes ],
        commands: [
            ...renderPatchIdentity.commands,
            ...Object.values(graph.commands.terrain).flat(),
        ],
    }
}

function allBindSets(bindSets: BindSets) {

    return [
        bindSets.scene,
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

function graphContractSnapshot(graph: TerrainFieldGraph): TerrainFieldContractFacts {

    const dataMaximumMatrixLevel = graph.frontier.descriptor.policy.maximumMatrixLevel
    return Object.freeze({
        stageOrder: TERRAIN_FIELD_STAGE_ORDER,
        countPath: 'gpu-produced-indirect-arguments',
        selectionPath: 'gpu-resident-active-frontier',
        dataMaximumMatrixLevel,
        renderMaximumMatrixLevel: GPU_RENDER_PATCH_MAXIMUM_MATRIX_LEVEL,
        fieldLayer: Object.freeze({
            id: graph.fieldLayer.id,
            fieldId: graph.fieldLayer.field.id,
            representationId: graph.fieldLayer.representation.id,
            spatialProfileId: graph.fieldLayer.spatialProfile.id,
            viewAdapterId: graph.fieldLayer.viewAdapter.id,
            demandProducerId: graph.fieldLayer.demandProducer.id,
        }),
        terrainVertexCount: graph.geometry.vertexCount,
        frontier: graph.frontier.facts(),
        renderPatches: graph.renderPatchFrontier.facts(),
        feedback: graph.feedbackRing.facts(),
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
            renderPatches: graph.renderPatchFrontier.identityObjects().passes[0]!.id,
            terrain: graph.passes.terrain.id,
        }),
        commandIds: Object.freeze({
            renderPatches: Object.freeze(
                graph.renderPatchFrontier.facts().parity.map(parity => parity.commandIds)
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
): TerrainFieldState<Presentation> {

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
        latestFeedbackDiagnostics: Object.freeze([]),
        terrainPresentation,
    }
}

function stateSnapshot<Presentation extends string>(
    state: TerrainFieldState<Presentation>,
    pendingFeedbackCount: number,
    feedbackRing: VirtualRasterGpuFeedbackRing
): TerrainFieldRendererState<Presentation> {

    const latest = state.latestFrontierFacts
    const renderPatches = state.latestRenderPatchFeedback
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
        frontierCount: latest?.activeFrontierCount ?? 0,
        visibleNodeCount: latest?.visibleInstanceCount ?? 0,
        demandCount: latest?.demandCount ?? 0,
        fallbackCount: latest?.fallbackCount ?? 0,
        staleGenerationCount: latest?.staleGenerationCount ?? 0,
        budgetLimitedCount: latest?.budgetLimitedCount ?? 0,
        levelRange: Object.freeze([
            latest?.minimumSelectedMatrixLevel,
            latest?.maximumSelectedMatrixLevel,
        ] as const),
        maximumObservedSse: latest?.maximumObservedSse ?? 0,
        renderPatchCount: renderPatches?.selectedPatchCount ?? 0,
        renderPatchLevelRange: Object.freeze([
            renderPatches?.minimumMatrixLevel,
            renderPatches?.maximumMatrixLevel,
        ] as const),
        renderPatchCellSpanRange: Object.freeze([
            renderPatches?.minimumCellSpanPixels,
            renderPatches?.maximumCellSpanPixels,
        ] as const),
        renderPatchDescriptorOverflowCount:
            renderPatches?.descriptorOverflowCount ?? 0,
        renderPatchLookupOverflowCount: renderPatches?.lookupOverflowCount ?? 0,
        ...(renderPatches === undefined
            ? {}
            : { renderPatchFrameEpoch: renderPatches.frameEpoch }),
        renderPatchBaselineBudget: renderPatches?.baselinePatchBudget ?? 0,
        renderPatchFrameBudget: renderPatches?.framePatchBudget ?? 0,
        renderPatchRequestedCount: renderPatches?.requestedPatchCount ?? 0,
        renderPatchMinimumTrialCount: renderPatches?.minimumTrialPatchCount ?? 0,
        renderPatchSourceRootCount: renderPatches?.sourceRootPatchCount ?? 0,
        renderPatchSelectedBiasLevels: renderPatches?.selectedBiasLevels ?? 0,
        renderPatchBudgetLimitedByMinimumTrial:
            renderPatches?.budgetLimitedByMinimumTrial ?? false,
        ...(renderPatches === undefined ? {} : { renderPatchFeedback: renderPatches }),
        convergenceState: latest?.convergenceState ?? 'transitioning',
        ...(latest === undefined ? {} : { frontierFacts: latest }),
        latestFeedbackDiagnostics: state.latestFeedbackDiagnostics,
        terrainPresentation: state.terrainPresentation,
        feedback: feedbackRing.facts(),
    })
}

async function observeSubmittedWork(submitted: SubmittedWork) {

    const [ nativeOutcome ] = await Promise.all([ submitted.nativeOutcome, submitted.done ])
    if (nativeOutcome.status !== 'observed-succeeded') {
        throw new Error(`Terrain field submission native outcome was ${nativeOutcome.status}`)
    }
    return Object.freeze({ submissionId: submitted.id, nativeStatus: nativeOutcome.status })
}

function assertSameIdentities(
    before: readonly string[],
    after: readonly string[],
    action: string
) {

    if (before.length !== after.length || before.some((id, index) => id !== after[index])) {
        throw new Error(`Persistent Terrain field graph identity changed during ${action}`)
    }
}

function assertPersistentCounts(before: PersistentFacts, after: PersistentFacts, action: string) {

    for (const name of [ 'resources', 'bindLayouts', 'bindSets', 'pipelines' ] as const) {
        if (before[name] !== after[name]) {
            throw new Error(`Persistent Terrain field ${name} count changed during ${action}`)
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
        throw new TypeError('Terrain field size must contain positive integer width and height')
    }
}

function assertVirtualRaster(value: TerrainVirtualRaster) {

    if (value === undefined || value.kind !== 'virtual-raster-runtime' ||
        value.model?.kind !== 'web-mercator-virtual-raster-field' ||
        value.addressSpace?.dimensions !== 2 || value.gpu?.atlas === undefined ||
        value.gpu.pageTable === undefined || value.gpu.slotTable === undefined ||
        value.field?.kind !== 'geo-field' ||
        value.representation?.kind !== 'tiled-field-representation' ||
        value.spatialProfile?.kind !== 'tile-spatial-profile' ||
        value.viewDemandProducer?.kind !== 'view-demand-producer' ||
        typeof value.reconcileFeedback !== 'function') {
        throw new TypeError(
            'Terrain field renderer requires a prepared WebMercator Virtual Raster runtime'
        )
    }
}

function assertFieldLayer<ViewInput>(
    value: MapFieldLayer<ViewInput>,
    virtualRaster: TerrainVirtualRaster
) {

    if (value?.field !== virtualRaster.field ||
        value.representation !== virtualRaster.representation ||
        value.spatialProfile !== virtualRaster.spatialProfile ||
        value.demandProducer !== virtualRaster.viewDemandProducer ||
        typeof value.viewAdapter?.read !== 'function') {
        throw new TypeError(
            'Terrain field renderer requires one coherent MapFieldLayer and Virtual Raster runtime'
        )
    }
}

function assertShader(value: string) {

    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError('Terrain field renderer requires application terrain WGSL')
    }
}

function assertFieldSampling(value: TerrainFieldSamplingWgslOptions) {

    if (typeof value?.namespace !== 'string' || value.namespace.length === 0 ||
        typeof value.addressNamespace !== 'string' || value.addressNamespace.length === 0) {
        throw new TypeError('Terrain field sampling requires WGSL namespaces')
    }
}

function assertElevation(range: readonly [number, number], exaggeration: number) {

    if (!Array.isArray(range) || range.length !== 2 ||
        range.some(value => !Number.isFinite(value)) || range[0] > range[1] ||
        !Number.isFinite(exaggeration) || exaggeration <= 0) {
        throw new TypeError('Terrain field elevation range and exaggeration are invalid')
    }
}

function normalizePresentations<Presentation extends string>(
    values: readonly TerrainFieldPresentationDescriptor<Presentation>[],
    initial: Presentation
): ReadonlyMap<Presentation, TerrainFieldPresentationDescriptor<Presentation>> {

    if (!Array.isArray(values) || values.length === 0) {
        throw new TypeError('Terrain field renderer requires at least one presentation')
    }
    const normalized = new Map<Presentation, TerrainFieldPresentationDescriptor<Presentation>>()
    for (const value of values) {
        if (typeof value?.id !== 'string' || value.id.length === 0 ||
            typeof value.fragmentEntryPoint !== 'string' ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.fragmentEntryPoint) ||
            normalized.has(value.id)) {
            throw new TypeError('Terrain field presentations require unique ids and WGSL entry points')
        }
        normalized.set(value.id, Object.freeze({ ...value }))
    }
    if (!normalized.has(initial)) {
        throw new TypeError(`Unknown initial terrain presentation ${initial}`)
    }
    return normalized
}
