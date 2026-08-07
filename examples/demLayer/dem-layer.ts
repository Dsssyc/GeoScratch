import {
    GPURuntime,
    layoutCodec,
    plane,
} from 'geoscratch/scratch'
import type {
    BindLayoutEntry,
    BindVisibility,
    BufferResource,
    LayoutCodec,
    LayoutFixedFieldDescriptor,
    ProgramBufferLayoutRequirement,
    SubmittedWork,
    Surface,
    SurfaceSize,
    TextureResource,
} from 'geoscratch/scratch'
import {
    GeoDiagnosticError,
    GpuTileFrontier,
    VirtualRasterGpuFeedbackRing,
    WEB_MERCATOR_QUAD_HALF_WORLD,
    WEB_MERCATOR_QUAD_WORLD_WIDTH,
    WebMercatorQuad,
    gpuTileFrontierPolicy,
} from 'geoscratch/geo'
import type {
    GpuTileFrontierFacts,
    GpuTileFrontierFrame,
    GpuTileFrontierView,
    VirtualRasterGpuFeedbackBatch,
} from 'geoscratch/geo'
import { demVirtualRasterWgslModule } from './dem-virtual-raster.ts'
import type {
    DemVirtualRasterPublication,
    createDemVirtualRasterRuntime,
} from './dem-virtual-raster.ts'
import {
    DEM_MAX_RENDER_EXTRA_LEVELS,
    DEM_MAX_RENDER_MATRIX_LEVEL,
    DEM_RENDER_PATCH_MAXIMUM_CELL_SPAN_PIXELS,
    DEM_RENDER_PATCH_TERRAIN_SECTOR_SIZE,
    DemRenderPatchFeedbackStaleError,
    createDemRenderPatchFrontier,
    demRenderPatchWgslModule,
} from './dem-render-patch-frontier.ts'
import type {
    DemRenderPatchFeedback,
    DemRenderPatchFrontier,
} from './dem-render-patch-frontier.ts'

type DemShaders = {
    renderPatch: string
    terrain: string
}

export type DemTerrainPresentation = 'shaded' | 'tile-wireframe'

type DemFailureProof = {
    terrainShader(source: string): string
    beforeTerrainShaderModule(runtime: GPURuntime): void
}

type DemCameraState = Omit<
    GpuTileFrontierView,
    'frameEpoch' | 'residencySnapshotEpoch'
> & Readonly<{
    far: number
    near: number
}>

type DemVirtualRaster = Awaited<ReturnType<typeof createDemVirtualRasterRuntime>>
type Codecs = ReturnType<typeof createCodecs>
type TerrainGeometry = ReturnType<typeof createTerrainGeometry>
type Uniforms = Awaited<ReturnType<typeof createUniformResources>>
type Buffers = Awaited<ReturnType<typeof createBufferResources>>
type Textures = Awaited<ReturnType<typeof createTextures>>
type Frontier = Awaited<ReturnType<typeof createFrontier>>
type FrontierRenderTemplates = ReturnType<typeof createFrontierRenderTemplates>
type RenderPatchFrontier = DemRenderPatchFrontier
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

type DemGraph = {
    runtime: GPURuntime
    surface: Surface
    virtualRaster: DemVirtualRaster
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

type ProvenanceFact = Readonly<{
    name: string
    resourceId: string
    declaredContentEpoch: 'current-at-step'
    producerContentEpoch: number
    readContentEpoch: number
    producerStepIndex: number
    consumerStepIndex: number
}>

type ProvenanceVerifier = (
    submitted: SubmittedWork,
    graph: DemGraph,
    frame: GpuTileFrontierFrame,
    terrainPresentation: DemTerrainPresentation
) => readonly ProvenanceFact[]

type ResizeFacts = Readonly<{
    resizeGeneration: number
    staleBindSetCount: number
    preparedBindSetCount: number
    depthAllocationVersion: number
}>

type DemState = {
    initialized: boolean
    disposed: boolean
    frame: number
    size: SurfaceSize
    resizeGeneration: number
    staleBindSetPreparationCount: number
    lastResizeFacts?: ResizeFacts
    virtualSnapshotEpoch: number
    virtualRequestedPageCount: number
    staleFeedbackCount: number
    supersededFeedbackCount: number
    latestFrontierFacts?: GpuTileFrontierFacts
    latestRenderPatchFeedback?: DemRenderPatchFeedback
    latestFeedbackDiagnostics: readonly unknown[]
    terrainPresentation: DemTerrainPresentation
    stageActivity: {
        'frontier-compute': number
        'render-patch-compute': number
        terrain: number
    }
}

type PersistentFacts = Readonly<{
    resources: number
    bindLayouts: number
    bindSets: number
    pipelines: number
    logicalFootprintBytes: number
}>

type DemLayerOptions = {
    runtime: GPURuntime
    surface: Surface
    virtualRaster: DemVirtualRaster
    size: SurfaceSize
    shaders: DemShaders
    terrainPresentation?: DemTerrainPresentation
    failureProof?: DemFailureProof
    provenanceVerifier?: ProvenanceVerifier
}

type PendingFeedback = Readonly<{
    frame: GpuTileFrontierFrame
    submitted: SubmittedWork
    decisionKey: string
}>

type ConsumedFeedback = Readonly<{
    decisionKey: string
    feedback?: VirtualRasterGpuFeedbackBatch
    renderPatchFeedback?: DemRenderPatchFeedback
}>

export const DEM_STAGE_ORDER = Object.freeze([
    'frontier-compute',
    'render-patch-compute',
    'terrain',
])
export const TERRAIN_SECTOR_SIZE = DEM_RENDER_PATCH_TERRAIN_SECTOR_SIZE
export const TERRAIN_EXAGGERATION = 50

const bufferUsage = globalThis.GPUBufferUsage ?? Object.freeze({
    COPY_DST: 0x08,
    UNIFORM: 0x40,
    STORAGE: 0x80,
})
const textureUsage = globalThis.GPUTextureUsage ?? Object.freeze({
    RENDER_ATTACHMENT: 0x10,
})

export async function createDemLayer({
    runtime,
    surface,
    virtualRaster,
    size,
    shaders,
    terrainPresentation = 'shaded',
    failureProof = defaultFailureProof,
    provenanceVerifier = verifyFrameProvenance,
}: DemLayerOptions) {

    if (!(runtime instanceof GPURuntime)) throw new TypeError('DEM Layer requires GPURuntime')
    assertSize(size)
    assertVirtualRaster(virtualRaster)
    assertShaders(shaders)
    assertTerrainPresentation(terrainPresentation)
    if (typeof provenanceVerifier !== 'function') {
        throw new TypeError('DEM provenance verifier must be a function')
    }

    const codecs = createCodecs()
    const geometry = createTerrainGeometry()
    const buffers = await createBufferResources(runtime, geometry)
    const textures = await createTextures(runtime, size)
    const frontier = await createFrontier(runtime, virtualRaster)
    const feedbackRing = await VirtualRasterGpuFeedbackRing.create(frontier)
    const frontierRenderTemplates = createFrontierRenderTemplates(frontier)
    const renderPatchFrontier = await createDemRenderPatchFrontier(runtime, {
        sourceTemplates: frontierRenderTemplates.renderPatch,
        maximumSourceTiles: frontier.descriptor.policy.maximumActiveTiles,
        dataMaximumMatrixLevel: frontier.descriptor.policy.maximumMatrixLevel,
        renderMaximumMatrixLevel: DEM_MAX_RENDER_MATRIX_LEVEL,
        maximumExtraLevels: DEM_MAX_RENDER_EXTRA_LEVELS,
        coordinateBits: virtualRaster.addressCodec.coordinateBits,
        elevationRangeMeters: terrainElevationRange(virtualRaster),
        terrainVertexCount: geometry.vertexCount,
        terrainSectorSize: TERRAIN_SECTOR_SIZE,
        maximumCellSpanPixels: DEM_RENDER_PATCH_MAXIMUM_CELL_SPAN_PIXELS,
        shader: shaders.renderPatch,
    })
    const renderTemplates = createRenderTemplates(renderPatchFrontier)
    const uniforms = await createUniformResources(
        runtime,
        codecs,
        virtualRaster,
        renderPatchFrontier.facts().renderPatchLookupCapacity
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
    const programs = await createPrograms(
        runtime,
        codecs,
        shaders,
        failureProof,
        virtualRaster
    )
    const pipelines = await createPipelines(runtime, surface, textures, layouts, programs)
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
    const graph: DemGraph = {
        runtime,
        surface,
        virtualRaster,
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
    const state = createState(size, terrainPresentation)
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

    async function renderFrame(camera: DemCameraState) {

        if (!state.initialized) throw new Error('DEM graph must be initialized before rendering')
        if (state.disposed) throw new Error('DEM graph is disposed')
        assertCamera(camera)
        assertSameIdentities(stableIdentities, stableIdentitySnapshot(graph), 'frame')
        assertPersistentCounts(persistentBaseline, persistentFactSnapshot(runtime), 'frame')
        const frameTerrainPresentation = state.terrainPresentation

        const noOpPublication = await publishChangedResidency(graph, state)
        const residencySnapshotEpoch = virtualRaster.gpu.facts().snapshotEpoch
        const decisionKey = frontierDecisionKey(camera, residencySnapshotEpoch)
        const viewToken = frontier.writeView({
            clipFromRelativeWorld: camera.clipFromRelativeWorld,
            cameraHigh: camera.cameraHigh,
            cameraLow: camera.cameraLow,
            viewport: camera.viewport,
            verticalFovRadians: camera.verticalFovRadians,
            cameraLatitudeRadians: camera.cameraLatitudeRadians,
            zoomHint: camera.zoomHint,
            frameEpoch: state.frame + 1,
            residencySnapshotEpoch,
        })
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

        let provenance: readonly ProvenanceFact[] = Object.freeze([])
        let provenanceFailure: unknown
        try {
            provenance = provenanceVerifier(
                submitted!,
                graph,
                frame!,
                frameTerrainPresentation
            )
        } catch (error) {
            provenanceFailure = error
        }
        const nativeObservation = observeSubmittedWork(submitted!)
        const observation = provenanceFailure === undefined
            ? nativeObservation
            : nativeObservation.then(() => { throw provenanceFailure })

        pendingFeedback.push(Object.freeze({
            frame: frame!,
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
            state.latestFrontierFacts = undefined
            state.latestFeedbackDiagnostics = Object.freeze([])
        } else {
            state.latestFrontierFacts = feedback.facts
            state.latestFeedbackDiagnostics = feedback.diagnostics
        }
        const reconciliation = feedback === undefined
            ? undefined
            : virtualRaster.reconcileFeedback(feedback)
        if (reconciliation !== undefined) {
            state.virtualRequestedPageCount += reconciliation.requestedCount
        }

        state.frame++
        state.virtualSnapshotEpoch = virtualRaster.gpu.facts().snapshotEpoch
        state.stageActivity['frontier-compute']++
        state.stageActivity['render-patch-compute']++
        state.stageActivity.terrain++
        const needsFollowUp = feedback === undefined ||
            feedback.facts.convergenceState === 'transitioning' ||
            (reconciliation?.requestedCount ?? 0) > 0

        return Object.freeze({
            submitted: submitted!,
            observation,
            provenance,
            feedback,
            renderPatchFeedback: consumed?.renderPatchFeedback,
            reconciliation,
            residencySettlement: reconciliation?.settlement ?? Promise.resolve(undefined),
            requestedPageCount: reconciliation?.requestedCount ?? 0,
            needsFollowUp,
            terrainPresentation: frameTerrainPresentation,
        })
    }

    function setTerrainPresentation(nextPresentation: DemTerrainPresentation) {

        assertTerrainPresentation(nextPresentation)
        if (state.disposed) throw new Error('DEM graph is disposed')
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
        setTerrainPresentation,
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

const defaultFailureProof: DemFailureProof = Object.freeze({
    terrainShader: (source: string) => source,
    beforeTerrainShaderModule() {},
})

function createCodecs() {

    const uniform = (name: string, fields: LayoutFixedFieldDescriptor[]) =>
        layoutCodec({ name, fields }, { usage: [ 'uniform' ] })
    return Object.freeze({
        config: uniform('DemTerrainConfig', [
            { name: 'sourceMercatorBox', type: 'vec4f' },
            { name: 'elevationRange', type: 'vec2f' },
            { name: 'coordinateBits', type: 'u32' },
            { name: 'exaggeration', type: 'f32' },
            { name: 'renderMaximumMatrixLevel', type: 'u32' },
            { name: 'renderPatchLookupCapacity', type: 'u32' },
            { name: 'reserved', type: 'f32' },
        ]),
    })
}

async function createUniformResources(
    runtime: GPURuntime,
    codecs: Codecs,
    virtualRaster: DemVirtualRaster,
    renderPatchLookupCapacity: number
) {

    const [ west, south, east, north ] = virtualRaster.manifest.projectedBounds.bounds
    const sourceMercatorBox = [
        (west + WEB_MERCATOR_QUAD_HALF_WORLD) / WEB_MERCATOR_QUAD_WORLD_WIDTH,
        (WEB_MERCATOR_QUAD_HALF_WORLD - north) / WEB_MERCATOR_QUAD_WORLD_WIDTH,
        (east + WEB_MERCATOR_QUAD_HALF_WORLD) / WEB_MERCATOR_QUAD_WORLD_WIDTH,
        (WEB_MERCATOR_QUAD_HALF_WORLD - south) / WEB_MERCATOR_QUAD_WORLD_WIDTH,
    ]
    const elevationRange = [
        virtualRaster.manifest.offset,
        virtualRaster.manifest.offset + virtualRaster.manifest.scale * 255,
    ]
    return {
        config: await createUniform(runtime, 'DEM terrain configuration', codecs.config, {
            sourceMercatorBox,
            elevationRange,
            coordinateBits: virtualRaster.addressCodec.coordinateBits,
            exaggeration: TERRAIN_EXAGGERATION,
            renderMaximumMatrixLevel: DEM_MAX_RENDER_MATRIX_LEVEL,
            renderPatchLookupCapacity,
            reserved: 0,
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
        usage: bufferUsage.COPY_DST | bufferUsage.UNIFORM,
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
            'DEM terrain positions',
            geometry.positions,
            bufferUsage.COPY_DST | bufferUsage.STORAGE
        ),
        indices: await createBufferWithUpload(
            runtime,
            'DEM terrain indices',
            geometry.indices,
            bufferUsage.COPY_DST | bufferUsage.STORAGE
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
        label: 'DEM presentation depth',
        size,
        format: 'depth32float',
        usage: textureUsage.RENDER_ATTACHMENT,
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
    virtualRaster: DemVirtualRaster
) {

    const minimumMatrixLevel = Number(virtualRaster.manifest.tileMatrixSet.minTileMatrix)
    const maximumMatrixLevel = Number(virtualRaster.manifest.tileMatrixSet.maxTileMatrix)
    const rootCount = virtualRaster.safetyCoverPages.length
    const maxPhysicalPages = virtualRaster.gpu.maxPhysicalPages
    if (maxPhysicalPages <= rootCount) {
        throw new Error('DEM GPU frontier requires transition capacity beyond its safety cover')
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
    const elevation = terrainElevationRange(virtualRaster)

    return GpuTileFrontier.create(runtime, {
        gpuState: virtualRaster.gpu,
        addressCodec: virtualRaster.addressCodec,
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
        levelMetrics: virtualRaster.manifest.tileMatrixSet.tileMatrixIds.map(matrixId => {
            const matrix = WebMercatorQuad.matrix(matrixId)
            return Object.freeze({
                matrixLevel: Number(matrixId),
                minimumElevationMeters: elevation[0]!,
                maximumElevationMeters: elevation[1]!,
                geometricErrorMeters: matrix.cellSize * matrix.tileWidth /
                    TERRAIN_SECTOR_SIZE,
            })
        }),
        roots: virtualRaster.safetyCoverPages,
        drawTemplates: [
            { id: 'render-patch-source', vertexCount: 1 },
        ],
    })
}

function terrainElevationRange(
    virtualRaster: DemVirtualRaster
): readonly [number, number] {

    return Object.freeze([
        virtualRaster.manifest.offset * TERRAIN_EXAGGERATION,
        (virtualRaster.manifest.offset + virtualRaster.manifest.scale * 255) *
            TERRAIN_EXAGGERATION,
    ].sort((left, right) => left - right) as [number, number])
}

function createFrontierRenderTemplates(frontier: GpuTileFrontier) {

    return Object.freeze({
        renderPatch: frontier.renderTemplates('render-patch-source'),
    })
}

function createRenderTemplates(frontier: DemRenderPatchFrontier) {

    return Object.freeze({
        terrain: frontier.renderTemplates('terrain'),
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
            label: 'DEM frontier scene layout',
            group: 0,
            entries: [
                uniform(0, 'mapMeta', mapMetaBytes, [ 'vertex' ]),
                uniform(1, 'terrainConfig', codecs.config.byteLength(), [ 'vertex' ]),
            ],
        }),
        terrainData: await runtime.createBindLayout({
            label: 'DEM terrain frontier data layout',
            group: 1,
            entries: [
                readStorage(0, 'indices'),
                readStorage(1, 'gridPositions'),
                readStorage(2, 'visibleInstances'),
                readStorage(3, 'renderPatchLookupEntries'),
            ],
        }),
        terrainTextures: await runtime.createBindLayout({
            label: 'DEM terrain texture layout',
            group: 2,
            entries: [
                readStorage(0, 'demPageTable'),
                {
                    binding: 1,
                    name: 'demAtlas',
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
    virtualRaster: DemVirtualRaster,
    templates: RenderTemplates
) {

    const terrainData = []
    for (const [ parity, template ] of templates.terrain.entries()) {
        terrainData.push(await runtime.createBindSet(layouts.terrainData, {
            indices: buffers.indices.region,
            gridPositions: buffers.positions.region,
            visibleInstances: template.visibleInstances.region(),
            renderPatchLookupEntries: template.renderPatchLookup.region(),
        }, { label: `DEM terrain frontier data ${parity}` }))
    }

    return {
        scene: await runtime.createBindSet(layouts.scene, {
            mapMeta: templates.terrain[0].mapMeta.region(),
            terrainConfig: uniforms.config.region,
        }, { label: 'DEM frontier scene' }),
        terrainData,
        terrainTextures: await runtime.createBindSet(layouts.terrainTextures, {
            demPageTable: virtualRaster.gpu.pageTable.region(),
            demAtlas: virtualRaster.gpu.atlasView,
        }, { label: 'DEM terrain textures' }),
    }
}

async function createPrograms(
    runtime: GPURuntime,
    codecs: Codecs,
    shaders: DemShaders,
    failureProof: DemFailureProof,
    virtualRaster: DemVirtualRaster
) {

    const renderWgsl = demRenderPatchWgslModule()
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
    failureProof.beforeTerrainShaderModule(runtime)
    const terrainShader = await runtime.createShaderModule({
        label: 'DEM terrain shader',
        sourceParts: [
            frontierSource,
            { code: demVirtualRasterWgslModule(virtualRaster.model) },
            { code: failureProof.terrainShader(shaders.terrain) },
        ],
    })
    const terrainProgram = (label: string, fragmentEntryPoint: string) => runtime.createProgram({
        label,
        vertex: { module: terrainShader, entryPoint: 'vMain' },
        fragment: { module: terrainShader, entryPoint: fragmentEntryPoint },
        layoutRequirements: [ configRequirement ],
    })
    return {
        terrain: terrainProgram('DEM terrain program', 'fMain'),
        tileWireframe: terrainProgram(
            'DEM tile wireframe program',
            'fTileWireframe'
        ),
    }
}

async function createPipelines(
    runtime: GPURuntime,
    surface: Surface,
    textures: Textures,
    layouts: Layouts,
    programs: Programs
) {

    const terrain = await runtime.createRenderPipeline({
        label: 'DEM terrain pipeline',
        program: programs.terrain,
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
    const tileWireframe = await runtime.createRenderPipeline({
        label: 'DEM tile wireframe pipeline',
        program: programs.tileWireframe,
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
    return { terrain, tileWireframe }
}

function createPasses(runtime: GPURuntime, surface: Surface, textures: Textures) {

    return {
        terrain: runtime.createRenderPass({
            label: 'DEM terrain stage',
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
    virtualRaster: DemVirtualRaster,
    templates: RenderTemplates,
    bindSets: BindSets,
    pipelines: Pipelines
) {

    const terrainCommands = (
        label: string,
        pipeline: Pipelines['terrain']
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

    return {
        terrain: {
            shaded: terrainCommands('Draw DEM terrain', pipelines.terrain),
            'tile-wireframe': terrainCommands(
                'Draw DEM tile wireframe',
                pipelines.tileWireframe
            ),
        },
    }
}

function currentReads(resources: readonly ContentResource[]) {

    return resources.map(resource => ({ resource, contentEpoch: 'current-at-step' as const }))
}

async function publishChangedResidency(graph: DemGraph, state: DemState) {

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
    graph: DemGraph,
    pending: PendingFeedback[],
    state: DemState
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
    let renderPatchFeedback: DemRenderPatchFeedback | undefined
    if (renderPatchResult.status === 'fulfilled') {
        renderPatchFeedback = renderPatchResult.value
    } else if (!(renderPatchResult.reason instanceof DemRenderPatchFeedbackStaleError)) {
        throw renderPatchResult.reason
    }
    return Object.freeze({
        decisionKey: ready.decisionKey,
        feedback,
        renderPatchFeedback,
    })
}

function frontierDecisionKey(camera: DemCameraState, residencySnapshotEpoch: number): string {

    return JSON.stringify([
        camera.clipFromRelativeWorld,
        camera.cameraHigh,
        camera.cameraLow,
        camera.viewport,
        camera.verticalFovRadians,
        camera.cameraLatitudeRadians,
        camera.zoomHint,
        residencySnapshotEpoch,
    ])
}

function verifyFrameProvenance(
    submitted: SubmittedWork,
    graph: DemGraph,
    frame: GpuTileFrontierFrame,
    terrainPresentation: DemTerrainPresentation
) {

    const terrainCommand = graph.commands.terrain[terrainPresentation][frame.parity]
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
            throw new Error(`DEM submission provenance mismatch for ${pair.name}`)
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

function stableIdentitySnapshot(graph: DemGraph) {

    const objects = Object.values(identityObjectsByKind(graph)).flat()
    return [ ...new Set(objects.map(object => object.id)) ].sort()
}

function identityFactSnapshot(graph: DemGraph) {

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

function identityObjectsByKind(graph: DemGraph) {

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
            ...graph.commands.terrain.shaded,
            ...graph.commands.terrain['tile-wireframe'],
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

function graphContractSnapshot(graph: DemGraph) {

    const dataMaximumMatrixLevel = graph.frontier.descriptor.policy.maximumMatrixLevel
    return Object.freeze({
        stageOrder: DEM_STAGE_ORDER,
        countPath: 'gpu-produced-indirect-arguments',
        selectionPath: 'gpu-resident-active-frontier',
        dataMaximumMatrixLevel,
        renderMaximumMatrixLevel: DEM_MAX_RENDER_MATRIX_LEVEL,
        terrainVertexCount: graph.geometry.vertexCount,
        frontier: graph.frontier.facts(),
        renderPatches: graph.renderPatchFrontier.facts(),
        feedback: graph.feedbackRing.facts(),
        virtualRaster: Object.freeze({
            contentVersion: graph.virtualRaster.manifest.contentVersion,
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
            drawTerrain: Object.freeze({
                shaded: Object.freeze(
                    graph.commands.terrain.shaded.map(command => command.id)
                ),
                tileWireframe: Object.freeze(
                    graph.commands.terrain['tile-wireframe'].map(command => command.id)
                ),
            }),
        }),
    })
}

function createState(
    size: SurfaceSize,
    terrainPresentation: DemTerrainPresentation
): DemState {

    return {
        initialized: false,
        disposed: false,
        frame: 0,
        size: { ...size },
        resizeGeneration: 0,
        staleBindSetPreparationCount: 0,
        lastResizeFacts: undefined,
        virtualSnapshotEpoch: 0,
        virtualRequestedPageCount: 0,
        staleFeedbackCount: 0,
        supersededFeedbackCount: 0,
        latestFrontierFacts: undefined,
        latestRenderPatchFeedback: undefined,
        latestFeedbackDiagnostics: Object.freeze([]),
        terrainPresentation,
        stageActivity: {
            'frontier-compute': 0,
            'render-patch-compute': 0,
            terrain: 0,
        },
    }
}

function stateSnapshot(
    state: DemState,
    pendingFeedbackCount: number,
    feedbackRing: VirtualRasterGpuFeedbackRing
) {

    const latest = state.latestFrontierFacts
    const renderPatches = state.latestRenderPatchFeedback
    return Object.freeze({
        initialized: state.initialized,
        disposed: state.disposed,
        frame: state.frame,
        size: Object.freeze({ ...state.size }),
        resizeGeneration: state.resizeGeneration,
        staleBindSetPreparationCount: state.staleBindSetPreparationCount,
        lastResizeFacts: state.lastResizeFacts,
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
        ]),
        maximumObservedSse: latest?.maximumObservedSse ?? 0,
        renderPatchCount: renderPatches?.selectedPatchCount ?? 0,
        renderPatchLevelRange: Object.freeze([
            renderPatches?.minimumMatrixLevel,
            renderPatches?.maximumMatrixLevel,
        ]),
        renderPatchCellSpanRange: Object.freeze([
            renderPatches?.minimumCellSpanPixels,
            renderPatches?.maximumCellSpanPixels,
        ]),
        renderPatchDescriptorOverflowCount:
            renderPatches?.descriptorOverflowCount ?? 0,
        renderPatchLookupOverflowCount: renderPatches?.lookupOverflowCount ?? 0,
        renderPatchFrameEpoch: renderPatches?.frameEpoch,
        renderPatchFeedback: renderPatches,
        convergenceState: latest?.convergenceState ?? 'transitioning',
        frontierFacts: latest,
        latestFeedbackDiagnostics: state.latestFeedbackDiagnostics,
        terrainPresentation: state.terrainPresentation,
        feedback: feedbackRing.facts(),
        stageActivity: Object.freeze({ ...state.stageActivity }),
    })
}

async function observeSubmittedWork(submitted: SubmittedWork) {

    const [ nativeOutcome ] = await Promise.all([ submitted.nativeOutcome, submitted.done ])
    if (nativeOutcome.status !== 'observed-succeeded') {
        throw new Error(`DEM submission native outcome was ${nativeOutcome.status}`)
    }
    return Object.freeze({ submissionId: submitted.id, nativeStatus: nativeOutcome.status })
}

function assertSameIdentities(
    before: readonly string[],
    after: readonly string[],
    action: string
) {

    if (before.length !== after.length || before.some((id, index) => id !== after[index])) {
        throw new Error(`Persistent DEM graph identity changed during ${action}`)
    }
}

function assertPersistentCounts(before: PersistentFacts, after: PersistentFacts, action: string) {

    for (const name of [ 'resources', 'bindLayouts', 'bindSets', 'pipelines' ] as const) {
        if (before[name] !== after[name]) {
            throw new Error(`Persistent DEM ${name} count changed during ${action}`)
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
        throw new TypeError('DEM size must contain positive integer width and height')
    }
}

function assertVirtualRaster(value: DemVirtualRaster) {

    if (value === undefined || value.manifest?.contentVersion === undefined ||
        value.addressSpace?.dimensions !== 2 || value.gpu?.atlas === undefined ||
        value.gpu.pageTable === undefined || value.gpu.slotTable === undefined ||
        typeof value.reconcileFeedback !== 'function') {
        throw new TypeError('DEM Layer requires a prepared GPU-demand virtual raster runtime')
    }
}

function assertShaders(value: DemShaders) {

    if (typeof value?.renderPatch !== 'string' || typeof value?.terrain !== 'string') {
        throw new TypeError(
            'DEM shaders must contain renderPatch and terrain WGSL strings'
        )
    }
}

function assertTerrainPresentation(
    value: unknown
): asserts value is DemTerrainPresentation {

    if (value !== 'shaded' && value !== 'tile-wireframe') {
        throw new TypeError('DEM terrain presentation must be shaded or tile-wireframe')
    }
}

function assertCamera(value: DemCameraState) {

    if (value === undefined || !Number.isFinite(value.far) || !Number.isFinite(value.near) ||
        !Number.isFinite(value.zoomHint) || value.clipFromRelativeWorld?.length !== 16 ||
        value.cameraLow?.length !== 3 || value.cameraHigh?.length !== 3 ||
        value.viewport?.length !== 2 || !Number.isFinite(value.verticalFovRadians) ||
        !Number.isFinite(value.cameraLatitudeRadians)) {
        throw new TypeError('DEM camera state is incomplete')
    }
}
