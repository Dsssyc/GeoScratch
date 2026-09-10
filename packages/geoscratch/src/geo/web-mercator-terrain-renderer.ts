import { snapshotWebMercatorCoverVerticalBounds } from './gpu-web-mercator-quad-cover-vertical-bounds.js'
import {
    GPURuntime,
    plane,
    type BindLayoutEntry,
    type BindVisibility,
    type BufferResource,
    type UploadCommand,
    type LayoutCodec,
    type Program,
    type ProgramBufferLayoutRequirement,
    type RenderPipeline,
    type SubmittedWork,
    type Surface,
    type SurfaceSize,
    type TextureResource,
} from '../scratch/index.js'
import type { WebMercatorTileVerticalBounds } from './gpu-web-mercator-quad-cover.js'
import {
    WebMercatorQuadCover, webMercatorQuadCoverPolicy,
    type WebMercatorQuadCoverSelectionFacts,
} from './web-mercator-quad-cover.js'
import {
    WebMercatorQuadDemandProjection, type WebMercatorQuadProjectedDemands,
} from './web-mercator-quad-demand.js'
import {
    WebMercatorQuadCoverUpload, type WebMercatorQuadCoverUploadFrame,
    type WebMercatorQuadCoverUploadReceipt,
} from './web-mercator-quad-cover-upload.js'
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

/** Current CPU selection/source intent with independent asynchronous resource progress. */
export type WebMercatorTerrainFrameSettlement = GeoFrameSettlement & Readonly<{
    coverSelection?: WebMercatorQuadCoverSelectionFacts
    projectedDemands?: WebMercatorQuadProjectedDemands
    reconciliation?: VirtualRasterFeedbackReconciliation
    residencySettlement: Promise<unknown>
    residencyWorkCount: number
}>

/** Immediate identity and provenance facts for one submitted terrain frame. */
export type WebMercatorTerrainFrame<Presentation extends string = string> = Readonly<{
    submitted: SubmittedWork
    provenance: readonly WebMercatorTerrainProvenanceFact[]
    terrainPresentation: Presentation
    uploadReceipt?: WebMercatorQuadCoverUploadReceipt
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
    countPath: 'cpu-produced-indirect-arguments'
    selectionPath: 'cpu-camera-inverse-webmercatorquad-cover'
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
    cover: ReturnType<WebMercatorQuadCover['facts']>
    demandProjection: ReturnType<WebMercatorQuadDemandProjection['facts']>
    coverUpload: ReturnType<WebMercatorQuadCoverUpload['facts']>
    patchDraw: Readonly<{ elementCount: number, argumentByteLength: 20, bufferIds: readonly string[] }>
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
        terrain: string
    }>
    commandIds: Readonly<{
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
    coverSelection?: WebMercatorQuadCoverSelectionFacts
    projectedDemands?: WebMercatorQuadProjectedDemands
    convergenceState: 'converged' | 'transitioning' | 'failed'
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
    cover: WebMercatorQuadCover
    demandProjection: WebMercatorQuadDemandProjection
    coverUpload: WebMercatorQuadCoverUpload
    drawArguments: readonly BufferResource[]
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
    failed: boolean
    latestCoverSelection?: WebMercatorQuadCoverSelectionFacts
    latestProjectedDemands?: WebMercatorQuadProjectedDemands
    terrainPresentation: Presentation
}

type PersistentFacts = WebMercatorTerrainPersistentFacts

type OwnedTerrainObject = { dispose(): void }
type OwnTerrainObject = <Value extends OwnedTerrainObject>(value: Value) => Value

type ActivePublication = {
    publication: VirtualRasterRuntimePublication
    acknowledgment?: Promise<void>
}

const WEB_MERCATOR_TERRAIN_STAGE_ORDER = Object.freeze([
    'cpu-cover-selection', 'cpu-source-demand', 'cover-upload', 'patch-draw-upload', 'terrain',
])
const TERRAIN_SECTOR_SIZE = 128
const TERRAIN_COVER_MAXIMUM_MATRIX_LEVEL = 14
const TERRAIN_MAXIMUM_CELL_SPAN_REFERENCE_PIXELS = 5
const TERRAIN_REFINEMENT_TOLERANCE = 0.005
const BUFFER_COPY_DST = 0x08
const BUFFER_INDEX = 0x10
const BUFFER_UNIFORM = 0x40
const BUFFER_STORAGE = 0x80
const BUFFER_INDIRECT = 0x100
const TEXTURE_RENDER_ATTACHMENT = 0x10

/**
 * Composes certified CPU cover/source intent, explicit geometry uploads and indexed
 * terrain drawing. Owns its renderer resources; borrows Surface and Virtual Raster.
 * Native success and raster publication acknowledgement remain asynchronous.
 */
export async function createWebMercatorTerrainRenderer<
    ViewInput,
    Presentation extends string,
>({
    runtime, surface, fieldLayer, virtualRaster, size, presentationShader, fieldSampling,
    elevationRangeMeters, elevationBounds, exaggeration = 1, presentations,
    initialPresentation, observeProvenance,
}: WebMercatorTerrainRendererDescriptor<ViewInput, Presentation>): Promise<WebMercatorTerrainRenderer<ViewInput, Presentation>> {
    if (!(runtime instanceof GPURuntime)) throw new TypeError('Web Mercator terrain renderer requires GPURuntime')
    assertSize(size)
    assertVirtualRaster(virtualRaster)
    assertFieldLayer(fieldLayer, virtualRaster)
    assertPresentationShader(presentationShader)
    assertFieldSampling(fieldSampling)
    assertElevation(elevationRangeMeters, exaggeration)
    const presentationTable = normalizePresentations(presentations, initialPresentation)
    const terrainFieldLayer = fieldLayer as unknown as WebMercatorTerrainMapField
    if (observeProvenance !== undefined && typeof observeProvenance !== 'function')
        throw new TypeError('Web Mercator terrain provenance observer must be a function')
    const exaggeratedElevationRange = scaleElevationRange(elevationRangeMeters, exaggeration)
    const verticalBounds = snapshotWebMercatorCoverVerticalBounds(
        terrainCoverVerticalBounds(elevationBounds, exaggeration),
        terrainFieldLayer.spatialProfile.coverage.limits, exaggeratedElevationRange
    )
    const owned: OwnedTerrainObject[] = []
    const own: OwnTerrainObject = value => { owned.push(value); return value }
    try {
        const geometry = createTerrainGeometry()
        const buffers = await createBufferResources(runtime, geometry, own)
        const textures = await createTextures(runtime, size, own)
        const cover = own(new WebMercatorQuadCover({
            spatialProfile: terrainFieldLayer.spatialProfile,
            policy: webMercatorQuadCoverPolicy({
                minimumMatrixLevel: Number(virtualRaster.coverage.limits[0]!.matrixId),
                maximumMatrixLevel: TERRAIN_COVER_MAXIMUM_MATRIX_LEVEL,
                maximumPatches: terrainCoverCapacity(size), cellsPerPatchEdge: TERRAIN_SECTOR_SIZE,
                maximumCellSpanReferencePixels: TERRAIN_MAXIMUM_CELL_SPAN_REFERENCE_PIXELS,
                refinementTolerance: TERRAIN_REFINEMENT_TOLERANCE,
            }),
            verticalRangeMeters: exaggeratedElevationRange,
            ...(verticalBounds === undefined ? {} : { verticalBounds }),
        }))
        const demandProjection = own(new WebMercatorQuadDemandProjection({
            cover, sourceCoverage: virtualRaster.coverage, maximumDemands: cover.descriptor.policy.maximumPatches,
        }))
        const coverUpload = own(await WebMercatorQuadCoverUpload.create(runtime, { cover }))
        const drawArguments: BufferResource[] = []
        for (const parity of [0, 1]) drawArguments.push(own(await runtime.createBuffer({
            label: `CPU terrain indexed arguments ${parity}`, size: 20, usage: BUFFER_COPY_DST | BUFFER_INDIRECT,
        })))
        const renderTemplates = createRenderTemplates(coverUpload, drawArguments)
        const uniforms = await createUniformResources(runtime, virtualRaster, cover.facts().lookupCapacity,
            elevationRangeMeters, exaggeration, own)
        const layouts = await createBindLayouts(runtime, renderTemplates.terrain[0]!.mapMeta.size, own)
        const bindSets = await createBindSets(runtime, layouts, uniforms, buffers, virtualRaster, renderTemplates, own)
        const programs = await createPrograms({ runtime, presentationShader, fieldSampling, virtualRaster,
            presentations: presentationTable, own })
        const pipelines = await createPipelines(runtime, surface, textures, layouts, programs, presentationTable, own)
        const passes = createPasses(runtime, surface, textures, own)
        const commands = createCommands(runtime, uniforms, buffers, virtualRaster, renderTemplates,
            bindSets, pipelines, presentationTable, own)
        const graph: WebMercatorTerrainGraph = { runtime, surface, virtualRaster, fieldLayer: terrainFieldLayer,
            geometry, uniforms, buffers, textures, cover, coverUpload, demandProjection, drawArguments,
            renderTemplates, layouts, bindSets, programs, pipelines, passes, commands }
        const state = createState(size, initialPresentation)
        const stableIdentities = Object.freeze(stableIdentitySnapshot(graph))
        const stableIdentityFacts = identityFactSnapshot(graph)
        const stableIdentityHash = stableIdentityFacts.hash
        const persistentBaseline = persistentFactSnapshot(graph)
        let initialization: Promise<WebMercatorTerrainInitialization> | undefined
        let activePublication: ActivePublication | undefined
        let terminalFailure: unknown

        function assertActive(): void {
            if (state.disposed) throw new Error('Web Mercator terrain graph is disposed')
            if (terminalFailure !== undefined) throw terminalFailure
        }

        function failTerminal(error: unknown): void {
            if (terminalFailure === undefined) terminalFailure = error
            state.failed = true
        }

        function acknowledge(entry: ActivePublication, submitted: SubmittedWork): Promise<void> {
            if (entry.acknowledgment !== undefined) return entry.acknowledgment
            entry.acknowledgment = Promise.resolve()
                .then(() => virtualRaster.acknowledge(entry.publication, submitted))
                .then(() => {
                    if (activePublication === entry) activePublication = undefined
                    if (!state.disposed) state.virtualSnapshotEpoch = virtualRaster.gpu.facts().snapshotEpoch
                }, error => { failTerminal(error); throw error })
            return entry.acknowledgment
        }

        function initialize(): Promise<WebMercatorTerrainInitialization> {
            if (initialization !== undefined) return initialization
            initialization = initializeOnce().catch(error => {
                if (terminalFailure === undefined) initialization = undefined
                throw error
            })
            return initialization
        }

        async function initializeOnce(): Promise<WebMercatorTerrainInitialization> {
            assertActive()
            if (activePublication === undefined) {
                let publication: VirtualRasterRuntimePublication
                try { publication = await virtualRaster.initialize() }
                catch (error) { failTerminal(error); throw error }
                // Record the borrowed runtime's publication before any later step can fail.
                activePublication = { publication }
            }
            assertActive()
            const entry = activePublication
            const builder = runtime.createSubmission({ validation: 'throw' })
            let submitted: SubmittedWork
            try {
                builder.upload(uniforms.config.upload).upload(buffers.positions.upload)
                    .upload(buffers.indices.upload).upload(buffers.wireframeIndices.upload)
                virtualRaster.gpu.encode(builder, entry.publication.update)
                submitted = builder.submit()
            } catch (error) {
                if (builder.isSubmitted) failTerminal(error)
                throw error
            }
            const observation = Promise.all([observeSubmittedWork(submitted), acknowledge(entry, submitted)])
                .then(([result]) => {
                    if (!state.disposed) { state.initialized = true; state.failed = false }
                    return result
                }, error => { failTerminal(error); throw error })
            return Object.freeze({ submitted, observation })
        }

        async function render(capture: GeoViewSourceCapture<ViewInput>) {
            assertActive()
            if (!state.initialized) throw new Error('Web Mercator terrain graph must be initialized before rendering')
            try {
                assertSize(capture?.presentationSize)
                if (!sameSize(state.size, capture.presentationSize)) await resize(capture.presentationSize)
                const result = submitFrame(capture.view)
                return Object.freeze({ observation: result.observation, settlement: result.settlement,
                    needsFollowUp: result.needsFollowUp,
                    value: Object.freeze({ frame: result.frame, view: capture.view }) }) satisfies GeoFrameResult<
                        WebMercatorTerrainFrameValue<ViewInput, Presentation>>
            } catch (error) { state.failed = true; throw error }
        }

        function submitFrame(input: ViewInput) {
            assertActive()
            assertSameIdentities(stableIdentities, stableIdentitySnapshot(graph), 'frame')
            assertPersistentCounts(persistentBaseline, persistentFactSnapshot(graph), 'frame')
            if (activePublication === undefined) activePublication = { publication: virtualRaster.publish() }
            const entry = activePublication
            const publication = entry.acknowledgment === undefined ? entry.publication : undefined
            const view = fieldLayer.viewAdapter.read(input, {
                frameEpoch: state.frame + 1, residencySnapshotEpoch: entry.publication.snapshotEpoch,
            })
            delete state.latestCoverSelection
            delete state.latestProjectedDemands
            const selection = cover.select(view)
            const projectedDemands = demandProjection.project(selection)
            const presentation = state.terrainPresentation
            let uploadFrame: WebMercatorQuadCoverUploadFrame | undefined
            let argumentsUpload: UploadCommand | undefined
            let submitted: SubmittedWork
            let receipt: WebMercatorQuadCoverUploadReceipt | undefined
            let provenance: readonly WebMercatorTerrainProvenanceFact[] = Object.freeze([])
            let reconciliation: VirtualRasterFeedbackReconciliation | undefined
            let postSubmitFailure: unknown
            let residencyWorkCount = 0
            let needsFollowUp = false
            let publicationAcknowledgment: Promise<void> | undefined
            let builder: ReturnType<GPURuntime['createSubmission']> | undefined
            try {
                uploadFrame = coverUpload.prepare(selection)
                argumentsUpload = runtime.createUploadCommand({
                    label: `Upload indexed terrain arguments ${selection.id}`,
                    target: drawArguments[uploadFrame.parity]!.region(),
                    data: new Uint32Array([geometry.elementCount, selection.facts.patchCount, 0, 0, 0]),
                })
                builder = runtime.createSubmission({ validation: 'throw' })
                if (publication !== undefined) virtualRaster.gpu.encode(builder, publication.update)
                coverUpload.encode(builder, uploadFrame)
                builder.upload(argumentsUpload)
                builder.render(passes.terrain, [commands.terrain[presentation][uploadFrame.parity]!])
                submitted = builder.submit()
                // From this point every failure belongs to the returned Work's
                // observation, never to a discarded construction result.
                state.frame++
                publicationAcknowledgment = publication === undefined ? entry.acknowledgment : acknowledge(entry, submitted)
                try {
                    receipt = coverUpload.receipt(uploadFrame, submitted)
                    provenance = verifyFrameProvenance(submitted, graph, uploadFrame, receipt, argumentsUpload.id, presentation)
                    reconciliation = virtualRaster.reconcileViewDemands(coverViewDemands(
                        virtualRaster, terrainFieldLayer, projectedDemands, view))
                    state.virtualRequestedPageCount += reconciliation.requestedCount
                    state.latestCoverSelection = selection.facts
                    state.latestProjectedDemands = projectedDemands
                    state.failed = false
                    residencyWorkCount = virtualRaster.scheduler.inspect().activeRequestCount
                    needsFollowUp = virtualRaster.residency.inspect().stagedCount > 0
                    observeProvenance?.(provenance)
                } catch (error) { postSubmitFailure = error; failTerminal(error) }
            } catch (error) {
                if (builder?.isSubmitted) failTerminal(error)
                throw error
            } finally {
                uploadFrame?.dispose()
                argumentsUpload?.dispose()
            }
            const nativeObservation = observeSubmittedWork(submitted!)
            const observation = Promise.all([nativeObservation,
                ...(publicationAcknowledgment === undefined ? [] : [publicationAcknowledgment])])
                .then(([result]) => {
                    if (postSubmitFailure !== undefined) throw postSubmitFailure
                    return result!
                }, error => { failTerminal(error); throw error })
            const resourceCompletion = reconciliation?.settlement ?? Promise.resolve(undefined)
            const residencySettlement = residencyWorkCount === 0 || publicationAcknowledgment === undefined ? resourceCompletion :
                Promise.all([resourceCompletion, publicationAcknowledgment]).then(([result]) => result)
            // A failed acknowledgement can reject frame settlement before the
            // controller attaches to resource work; retain its rejection safely.
            void Promise.resolve(residencySettlement).catch(() => undefined)
            const progress = () => Object.freeze({
                ...(receipt === undefined ? {} : { coverSelection: selection.facts, projectedDemands }),
                ...(reconciliation === undefined ? {} : { reconciliation }),
                residencyWorkCount,
                residencySettlement,
                // Resources staged while an earlier publication was pending need
                // one latest-frame follow-up after acknowledgement, not polling.
                needsFollowUp: !state.disposed && postSubmitFailure === undefined && needsFollowUp,
            }) satisfies WebMercatorTerrainFrameSettlement
            // Settlement is normally immediate. Staged pages cannot be published
            // until the pending update is acknowledged; wait for that actual
            // event instead of spending another frame/follow-up slot polling it.
            const settlement = needsFollowUp && publicationAcknowledgment !== undefined
                ? publicationAcknowledgment.then(progress) : Promise.resolve(progress())
            const frame = Object.freeze({ submitted: submitted!, provenance, terrainPresentation: presentation,
                ...(receipt === undefined ? {} : { uploadReceipt: receipt }) }) satisfies WebMercatorTerrainFrame<Presentation>
            return { frame, observation, settlement, needsFollowUp: false }
        }

        function setPresentation(nextPresentation: Presentation) {
            assertActive()
            if (!presentationTable.has(nextPresentation)) throw new TypeError(`Unknown terrain presentation ${nextPresentation}`)
            state.terrainPresentation = nextPresentation
            return nextPresentation
        }

        async function resize(nextSize: SurfaceSize) {
            assertSize(nextSize)
            const identityBefore = stableIdentitySnapshot(graph)
            surface.resize(nextSize)
            await textures.depth.resize(nextSize)
            assertActive()
            const stale = allBindSets(bindSets).filter(set => set.preparationState === 'stale')
            for (const set of stale) await set.prepare()
            assertSameIdentities(identityBefore, stableIdentitySnapshot(graph), 'resize')
            assertPersistentCounts(persistentBaseline, persistentFactSnapshot(graph), 'resize')
            state.size = { ...nextSize }
            state.resizeGeneration++
            state.staleBindSetPreparationCount += stale.length
            state.lastResizeFacts = Object.freeze({ resizeGeneration: state.resizeGeneration,
                staleBindSetCount: stale.length, preparedBindSetCount: stale.length,
                depthAllocationVersion: textures.depth.allocationVersion })
            return state.lastResizeFacts
        }

        function dispose(): void {
            if (state.disposed) return
            state.disposed = true
            disposeTerrainObjects(owned)
        }

        return Object.freeze({ initialize, render, setPresentation, dispose, stableIdentities, stableIdentityHash,
            stableIdentityFacts, currentIdentityFacts: () => identityFactSnapshot(graph),
            persistentFacts: () => persistentFactSnapshot(graph), contractFacts: () => graphContractSnapshot(graph),
            virtualRasterFacts: virtualRaster.inspect, state: () => stateSnapshot(state) })
    } catch (cause) {
        try { disposeTerrainObjects(owned) }
        catch (cleanupError) { throw new AggregateError([cause, cleanupError], 'Terrain creation and cleanup failed') }
        throw cause
    }
}

function disposeTerrainObjects(owned: OwnedTerrainObject[]): void {
    const failures: unknown[] = []
    while (owned.length) {
        try { owned.pop()!.dispose() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Terrain resource disposal failed')
}

async function createUniformResources(
    runtime: GPURuntime,
    virtualRaster: WebMercatorTerrainVirtualRaster,
    coverLookupCapacity: number,
    elevationRangeMeters: readonly [number, number],
    exaggeration: number, own: OwnTerrainObject
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
            }, own
        ),
    }
}

async function createUniform(
    runtime: GPURuntime,
    label: string,
    codec: LayoutCodec,
    values: LayoutValues, own: OwnTerrainObject
) {

    const bytes = codec.pack(values)
    const buffer = own(await runtime.createBuffer({
        label,
        size: bytes.byteLength,
        usage: BUFFER_COPY_DST | BUFFER_UNIFORM,
    }))
    const region = buffer.region({ layout: codec.artifact })
    return Object.freeze({
        codec,
        bytes,
        buffer,
        region,
        upload: own(runtime.createUploadCommand({ label: `Upload ${label}`, target: region, data: bytes })),
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

async function createBufferResources(runtime: GPURuntime, geometry: TerrainGeometry, own: OwnTerrainObject) {

    return {
        positions: await createBufferWithUpload(
            runtime,
            'Web Mercator terrain grid positions',
            geometry.positions,
            BUFFER_COPY_DST | BUFFER_STORAGE, own
        ),
        indices: await createBufferWithUpload(
            runtime,
            'Web Mercator terrain grid indices',
            geometry.indices,
            BUFFER_COPY_DST | BUFFER_INDEX, own
        ),
        wireframeIndices: await createBufferWithUpload(
            runtime,
            'Web Mercator terrain wireframe indices',
            geometry.wireframeIndices,
            BUFFER_COPY_DST | BUFFER_INDEX, own
        ),
    }
}

async function createBufferWithUpload<T extends BufferData>(
    runtime: GPURuntime,
    label: string,
    data: T,
    usage: number, own: OwnTerrainObject
) {

    const buffer = own(await runtime.createBuffer({ label, size: data.byteLength, usage }))
    const region = buffer.region()
    return Object.freeze({
        data,
        buffer,
        region,
        upload: own(runtime.createUploadCommand({ label: `Upload ${label}`, target: region, data })),
    })
}

async function createTextures(runtime: GPURuntime, size: SurfaceSize, own: OwnTerrainObject) {

    const depth = own(await runtime.createTexture({
        label: 'Web Mercator terrain presentation depth',
        size,
        format: 'depth32float',
        usage: TEXTURE_RENDER_ATTACHMENT,
    }))
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

function createRenderTemplates(coverUpload: WebMercatorQuadCoverUpload, drawArguments: readonly BufferResource[]) {
    return Object.freeze({ terrain: Object.freeze(coverUpload.templates().map((template, parity) => Object.freeze({
        ...template, drawArgument: Object.freeze({ resource: drawArguments[parity]!,
            region: drawArguments[parity]!.region(), offset: 0, size: 20 }),
    }))) })
}

async function createBindLayouts(runtime: GPURuntime, mapMetaBytes: number, own: OwnTerrainObject) {

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
        scene: own(await runtime.createBindLayout({
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
        })),
        terrainData: own(await runtime.createBindLayout({
            label: 'Web Mercator terrain cover data layout',
            group: 1,
            entries: [
                readStorage(1, 'gridPositions'),
                readStorage(2, 'coverPatches'),
                readStorage(3, 'coverLookupEntries'),
            ],
        })),
        terrainTextures: own(await runtime.createBindLayout({
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
        })),
    }
}

async function createBindSets(
    runtime: GPURuntime,
    layouts: Layouts,
    uniforms: Uniforms,
    buffers: Buffers,
    virtualRaster: WebMercatorTerrainVirtualRaster,
    templates: RenderTemplates, own: OwnTerrainObject
) {

    const terrainData = []
    for (const [ parity, template ] of templates.terrain.entries()) {
        terrainData.push(own(await runtime.createBindSet(layouts.terrainData, {
            gridPositions: buffers.positions.region,
            coverPatches: template.patches.region(),
            coverLookupEntries: template.coverLookup.region(),
        }, { label: `Web Mercator terrain cover data ${parity}` })))
    }

    const scene = []
    for (const [ parity, template ] of templates.terrain.entries()) {
        scene.push(own(await runtime.createBindSet(layouts.scene, {
            mapMeta: template.mapMeta.region(),
            terrainConfig: uniforms.config.region,
        }, { label: `Web Mercator terrain cover scene ${parity}` })))
    }

    return {
        scene,
        terrainData,
        terrainTextures: own(await runtime.createBindSet(layouts.terrainTextures, {
            fieldPageTable: virtualRaster.gpu.pageTable.region(),
            fieldAtlas: virtualRaster.gpu.atlasView,
        }, { label: 'Web Mercator terrain textures' })),
    }
}

async function createPrograms({
    runtime,
    presentationShader,
    fieldSampling,
    virtualRaster,
    presentations,
    own,
}: Readonly<{
    runtime: GPURuntime
    own: OwnTerrainObject
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
    const terrainShader = own(await runtime.createShaderModule({
        label: 'Web Mercator terrain shader',
        sourceParts: [
            { code: fieldWgsl.code },
            {
                code: terrainWgsl.code,
                layoutDependencies: terrainWgsl.layoutDependencies,
            },
            { code: presentationShader },
        ],
    }))
    const programs: Record<string, Program> = {}
    for (const presentation of presentations.values()) {
        programs[presentation.id] = own(runtime.createProgram({
            label: presentation.label ?? `Web Mercator terrain ${presentation.id} program`,
            vertex: { module: terrainShader, entryPoint: terrainWgsl.vertexEntryPoint },
            fragment: {
                module: terrainShader,
                entryPoint: presentation.fragmentEntryPoint,
            },
            layoutRequirements: [ configRequirement ],
        }))
    }
    return Object.freeze(programs)
}

async function createPipelines(
    runtime: GPURuntime,
    surface: Surface,
    textures: Textures,
    layouts: Layouts,
    programs: Programs,
    presentations: ReadonlyMap<string, WebMercatorTerrainPresentationDescriptor>, own: OwnTerrainObject
): Promise<Readonly<Record<string, RenderPipeline>>> {

    const pipelines: Record<string, RenderPipeline> = {}
    for (const presentation of presentations.values()) {
        const wireframe = presentation.fragmentEntryPoint ===
            WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT
        pipelines[presentation.id] = own(await runtime.createRenderPipeline({
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
        }))
    }
    return Object.freeze(pipelines)
}

function createPasses(runtime: GPURuntime, surface: Surface, textures: Textures, own: OwnTerrainObject) {

    return {
        terrain: own(runtime.createRenderPass({
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
        })),
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
    presentations: ReadonlyMap<string, WebMercatorTerrainPresentationDescriptor>, own: OwnTerrainObject
) {

    const terrainCommands = (
        label: string,
        pipeline: RenderPipeline,
        indexBuffer: Buffers['indices']
    ) => templates.terrain.map((template, parity) => own(runtime.createDrawCommand({
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
    })))

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

function coverViewDemands(
    virtualRaster: WebMercatorTerrainVirtualRaster,
    fieldLayer: WebMercatorTerrainMapField,
    projected: WebMercatorQuadProjectedDemands,
    view: GeoViewSnapshot
) {

    return fieldLayer.demandProducer.produce({
        view,
        generation: projected.frameEpoch,
        demands: projected.demands.map(demand => ({
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
            reason: `cpu-demand:${projected.frameEpoch}:desired-z${demand.desiredSampleLevel}`,
        })),
    })
}

function verifyFrameProvenance(
    submitted: SubmittedWork,
    graph: WebMercatorTerrainGraph,
    frame: WebMercatorQuadCoverUploadFrame,
    receipt: WebMercatorQuadCoverUploadReceipt,
    argumentCommandId: string,
    presentation: string
): readonly WebMercatorTerrainProvenanceFact[] {
    const template = graph.renderTemplates.terrain[frame.parity]!
    const command = graph.commands.terrain[presentation]![frame.parity]!
    const pairs = [
        ...receipt.resources.map(fact => ({ name: `cpu-cover-${fact.name === 'mapMeta' ? 'map-meta' : fact.name === 'coverLookup' ? 'lookup' : 'patches'}-to-terrain-draw`,
            resourceId: fact.resourceId, commandId: fact.commandId })),
        { name: 'cpu-patch-draw-arguments-to-terrain-draw', resourceId: template.drawArgument.resource.id,
            commandId: argumentCommandId },
    ]
    return Object.freeze(pairs.map(pair => {
        const read = submitted.resourceAccesses.find(access => access.resourceId === pair.resourceId &&
            access.commandId === command.id && access.access === 'read')
        const producer = submitted.producerEpochs.find(epoch => epoch.resourceId === pair.resourceId &&
            epoch.producedBy.commandId === pair.commandId && epoch.contentEpoch === read?.contentEpochBefore)
        if (producer === undefined || read === undefined || read.declaredContentEpoch !== 'current-at-step' ||
            producer.allocationVersion !== read.allocationVersion || producer.producedBy.stepIndex >= read.stepIndex)
            throw new Error(`Web Mercator terrain submission provenance mismatch for ${pair.name}`)
        return Object.freeze({ name: pair.name, resourceId: pair.resourceId, declaredContentEpoch: 'current-at-step' as const,
            producerContentEpoch: producer.contentEpoch, readContentEpoch: read.contentEpochBefore,
            producerStepIndex: producer.producedBy.stepIndex, consumerStepIndex: read.stepIndex })
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
    return {
        resources: uniqueById([
            graph.uniforms.config.buffer, graph.buffers.positions.buffer, graph.buffers.indices.buffer,
            graph.buffers.wireframeIndices.buffer, graph.textures.depth, ...graph.drawArguments,
            ...graph.coverUpload.resources(), graph.virtualRaster.gpu.atlas,
            graph.virtualRaster.gpu.pageTable, graph.virtualRaster.gpu.slotTable,
        ]),
        uploads: [graph.uniforms.config.upload, graph.buffers.positions.upload,
            graph.buffers.indices.upload, graph.buffers.wireframeIndices.upload],
        bindLayouts: Object.values(graph.layouts), bindSets: allBindSets(graph.bindSets),
        programs: Object.values(graph.programs), pipelines: Object.values(graph.pipelines),
        passes: Object.values(graph.passes), commands: Object.values(graph.commands.terrain).flat(),
        controllers: [graph.cover, graph.coverUpload, graph.demandProjection],
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

function persistentFactSnapshot(graph: WebMercatorTerrainGraph): PersistentFacts {
    const buffers = [graph.uniforms.config.buffer, graph.buffers.positions.buffer, graph.buffers.indices.buffer,
        graph.buffers.wireframeIndices.buffer, ...graph.drawArguments, ...graph.coverUpload.resources()]
    const depth = graph.textures.depth
    return Object.freeze({
        resources: buffers.filter(buffer => !buffer.isDisposed).length + (depth.isDisposed ? 0 : 1),
        bindLayouts: Object.values(graph.layouts).filter(value => !value.isDisposed).length,
        bindSets: allBindSets(graph.bindSets).filter(value => !value.isDisposed).length,
        pipelines: Object.values(graph.pipelines).filter(value => !value.isDisposed).length,
        logicalFootprintBytes: buffers.reduce((sum, buffer) => sum + (buffer.isDisposed ? 0 : buffer.size), 0) +
            (depth.isDisposed ? 0 : depth.width * depth.height * 4),
    })
}

function graphContractSnapshot(graph: WebMercatorTerrainGraph): WebMercatorTerrainContractFacts {

    return Object.freeze({
        stageOrder: WEB_MERCATOR_TERRAIN_STAGE_ORDER,
        countPath: 'cpu-produced-indirect-arguments',
        selectionPath: 'cpu-camera-inverse-webmercatorquad-cover',
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
        coverUpload: graph.coverUpload.facts(),
        patchDraw: Object.freeze({ elementCount: graph.geometry.elementCount, argumentByteLength: 20,
            bufferIds: Object.freeze(graph.drawArguments.map(buffer => buffer.id)) }),
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
        passIds: Object.freeze({ terrain: graph.passes.terrain.id }),
        commandIds: Object.freeze({
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
        failed: false,
        terrainPresentation,
    }
}

function stateSnapshot<Presentation extends string>(
    state: WebMercatorTerrainState<Presentation>
): WebMercatorTerrainRendererState<Presentation> {

    const cover = state.latestCoverSelection
    const demand = state.latestProjectedDemands
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
                    projectedDemands: demand,
                }),
            coverFrameEpoch: cover.frameEpoch,
            coverSelection: cover,
        }),
        convergenceState: state.failed ? 'failed' : cover === undefined || demand === undefined
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
