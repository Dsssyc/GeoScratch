import {
    ScratchRuntime,
    layoutCodec,
    plane,
} from 'geoscratch'
import { mat4 } from 'wgpu-matrix'
import type {
    BindLayoutEntry,
    BindVisibility,
    BufferResource,
    LayoutCodec,
    LayoutFixedFieldDescriptor,
    ProgramBufferLayoutRequirement,
    ScratchRuntimeDiagnosticsSnapshot,
    SubmittedWork,
    Surface,
    SurfaceSize,
    TextureResource,
} from 'geoscratch'
import {
    MAX_TERRAIN_NODES,
    TERRAIN_BOUNDARY,
    selectTerrainNodes,
} from './terrain-selection.ts'

type DemShaders = {
    lodMap: string
    terrain: string
}

type DemFailureProof = {
    terrainShader(source: string): string
    beforeTerrainShaderModule(runtime: ScratchRuntime): void
}

type DemCameraState = {
    far: number
    near: number
    matrix: ArrayLike<number>
    centerLow: ArrayLike<number>
    centerHigh: ArrayLike<number>
    cameraPos: ArrayLike<number> & Iterable<number>
    zoom: number
    viewport: ArrayLike<number>
}

type TerrainSelection = ReturnType<typeof selectTerrainNodes>
type Codecs = ReturnType<typeof createCodecs>
type Uniforms = Awaited<ReturnType<typeof createUniformResources>>
type TerrainGeometry = ReturnType<typeof createTerrainGeometry>
type Buffers = Awaited<ReturnType<typeof createBufferResources>>
type Textures = Awaited<ReturnType<typeof createTextures>>
type Layouts = Awaited<ReturnType<typeof createBindLayouts>>
type BindSets = Awaited<ReturnType<typeof createBindSets>>
type Programs = Awaited<ReturnType<typeof createPrograms>>
type Pipelines = Awaited<ReturnType<typeof createPipelines>>
type Passes = ReturnType<typeof createPasses>
type Commands = ReturnType<typeof createCommands>
type LayoutValues = Parameters<LayoutCodec['pack']>[0]
type BufferData = Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>
type ContentResource = BufferResource | TextureResource

type DemGraph = {
    runtime: ScratchRuntime
    surface: Surface
    codecs: Codecs
    geometry: TerrainGeometry
    uniforms: Uniforms
    buffers: Buffers
    textures: Textures
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
    graph: DemGraph
) => readonly ProvenanceFact[]

type ResizeFacts = Readonly<{
    resizeGeneration: number
    staleBindSetCount: number
    preparedBindSetCount: number
    depthAllocationVersion: number
}>

type DemState = {
    initialized: boolean
    frame: number
    size: SurfaceSize
    resizeGeneration: number
    staleBindSetPreparationCount: number
    lastResizeFacts?: ResizeFacts
    selection?: TerrainSelection
    stageActivity: { 'lod-map': number; terrain: number }
}

type PersistentFacts = Readonly<{
    resources: number
    bindLayouts: number
    bindSets: number
    pipelines: number
    logicalFootprintBytes: number
}>

type DemLayerOptions = {
    runtime: ScratchRuntime
    surface: Surface
    demImage: ImageBitmap
    size: SurfaceSize
    shaders: DemShaders
    failureProof?: DemFailureProof
    provenanceVerifier?: ProvenanceVerifier
}

export const DEM_STAGE_ORDER = Object.freeze([ 'lod-map', 'terrain' ])
export const LOD_MAP_SIZE = Object.freeze({ width: 512, height: 256 })
export const TERRAIN_MAX_LEVEL = 14
export const TERRAIN_SECTOR_SIZE = 64
export const TERRAIN_EXAGGERATION = 50
export const TERRAIN_ELEVATION_RANGE = Object.freeze([ -80.06899999999999, 4.3745 ])

const bufferUsage = globalThis.GPUBufferUsage ?? Object.freeze({
    COPY_DST: 0x08,
    UNIFORM: 0x40,
    STORAGE: 0x80,
    INDIRECT: 0x100,
})
const textureUsage = globalThis.GPUTextureUsage ?? Object.freeze({
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    RENDER_ATTACHMENT: 0x10,
})

export async function createDemLayer({
    runtime,
    surface,
    demImage,
    size,
    shaders,
    failureProof = defaultFailureProof,
    provenanceVerifier = verifyFrameProvenance,
}: DemLayerOptions) {

    if (!(runtime instanceof ScratchRuntime)) throw new TypeError('DEM Layer requires ScratchRuntime')
    assertSize(size)
    assertDemImage(demImage)
    assertShaders(shaders)
    if (typeof provenanceVerifier !== 'function') {
        throw new TypeError('DEM provenance verifier must be a function')
    }

    const codecs = createCodecs()
    const geometry = createTerrainGeometry()
    const uniforms = await createUniformResources(runtime, codecs)
    const buffers = await createBufferResources(runtime, geometry)
    const textures = await createTextures(runtime, demImage, size)
    const layouts = await createBindLayouts(runtime, codecs)
    const bindSets = await createBindSets(runtime, layouts, uniforms, buffers, textures)
    const programs = await createPrograms(runtime, codecs, shaders, failureProof)
    const pipelines = await createPipelines(
        runtime,
        surface,
        textures,
        layouts,
        programs
    )
    const passes = createPasses(runtime, surface, textures)
    const commands = createCommands(
        runtime,
        geometry,
        uniforms,
        buffers,
        textures,
        bindSets,
        pipelines
    )
    const graph = {
        runtime,
        surface,
        codecs,
        geometry,
        uniforms,
        buffers,
        textures,
        layouts,
        bindSets,
        programs,
        pipelines,
        passes,
        commands,
    }
    const state = createState(size)
    const stableIdentities = Object.freeze(stableIdentitySnapshot(graph))
    const stableIdentityFacts = identityFactSnapshot(graph)
    const stableIdentityHash = stableIdentityFacts.hash
    const persistentBaseline = persistentFactSnapshot(runtime)
    let initialization: Readonly<{
        submitted: SubmittedWork
        observation: Promise<Readonly<{ submissionId: string; nativeStatus: 'observed-succeeded' }>>
    }> | undefined

    function initialize() {

        if (initialization !== undefined) return initialization
        const builder = runtime.createSubmission({ validation: 'throw' })
        for (const upload of [
            uniforms.map.upload,
            uniforms.static.upload,
            buffers.positions.upload,
            buffers.indices.upload,
            textures.demUpload,
        ]) {
            builder.upload(upload)
        }
        const submitted = builder.submit()
        const observation = observeSubmittedWork(submitted).then(result => {
            state.initialized = true
            return result
        })
        initialization = Object.freeze({ submitted, observation })
        return initialization
    }

    function renderFrame(camera: DemCameraState) {

        if (!state.initialized) throw new Error('DEM graph must be initialized before rendering')
        assertCamera(camera)
        assertSameIdentities(stableIdentities, stableIdentitySnapshot(graph), 'frame')
        assertPersistentCounts(persistentBaseline, persistentFactSnapshot(runtime), 'frame')
        const selection = selectTerrainNodes({
            cameraPos: camera.cameraPos,
            zoomLevel: camera.zoom,
            maxLevel: TERRAIN_MAX_LEVEL,
            maxNodes: MAX_TERRAIN_NODES,
        })
        updateFrameData(graph, selection, camera)

        const submitted = runtime.createSubmission({ validation: 'throw' })
            .upload(uniforms.dynamic.upload)
            .upload(uniforms.tile.upload)
            .upload(buffers.nodeLevels.upload)
            .upload(buffers.nodeBoxes.upload)
            .upload(buffers.lodArguments.upload)
            .upload(buffers.terrainArguments.upload)
            .render(passes.lodMap, [ commands.drawLodMap ])
            .render(passes.terrain, [ commands.drawTerrain ])
            .submit()
        const nativeObservation = observeSubmittedWork(submitted)
        let provenance: readonly ProvenanceFact[] = Object.freeze([])
        let provenanceFailure: unknown
        try {
            provenance = provenanceVerifier(submitted, graph)
        } catch (error) {
            provenanceFailure = error
        }
        const observation = provenanceFailure === undefined
            ? nativeObservation
            : nativeObservation.then(() => { throw provenanceFailure })

        state.frame++
        state.selection = selection
        state.stageActivity['lod-map']++
        state.stageActivity.terrain++

        return Object.freeze({
            submitted,
            observation,
            provenance,
            selection,
        })
    }

    async function resize(nextSize: SurfaceSize) {

        assertSize(nextSize)
        const identityBefore = stableIdentitySnapshot(graph)
        surface.resize(nextSize)
        await textures.depth.resize(nextSize)

        const staleBindSets = Object.values(bindSets)
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

    return Object.freeze({
        initialize,
        renderFrame,
        resize,
        stableIdentities,
        stableIdentityHash,
        stableIdentityFacts,
        currentIdentityFacts: () => identityFactSnapshot(graph),
        persistentFacts: () => persistentFactSnapshot(runtime),
        contractFacts: () => graphContractSnapshot(graph),
        state: () => stateSnapshot(state),
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
        map: uniform('DemMapUniform', [
            { name: 'dimensions', type: 'vec2f' },
        ]),
        tile: uniform('DemTileUniform', [
            { name: 'tileBox', type: 'vec4f' },
            { name: 'levelRange', type: 'vec2f' },
            { name: 'sectorRange', type: 'vec2f' },
            { name: 'sectorSize', type: 'f32' },
            { name: 'exaggeration', type: 'f32' },
        ]),
        static: uniform('DemStaticUniform', [
            { name: 'terrainBox', type: 'vec4f' },
            { name: 'e', type: 'vec2f' },
        ]),
        dynamic: uniform('DemDynamicUniform', [
            { name: 'far', type: 'f32' },
            { name: 'near', type: 'f32' },
            { name: 'uMatrix', type: 'mat4x4f' },
            { name: 'centerLow', type: 'vec3f' },
            { name: 'centerHigh', type: 'vec3f' },
        ]),
    })
}

async function createUniformResources(runtime: ScratchRuntime, codecs: Codecs) {

    const identity = Array.from((mat4.identity as (destination?: Float32Array) => Float32Array)())
    return {
        map: await createUniform(runtime, 'DEM LoD-map dimensions', codecs.map, {
            dimensions: [ LOD_MAP_SIZE.width, LOD_MAP_SIZE.height ],
        }),
        tile: await createUniform(runtime, 'DEM tile state', codecs.tile, {
            tileBox: [ 0, 0, 0, 0 ],
            levelRange: [ 0, 0 ],
            sectorRange: [ 1, 1 ],
            sectorSize: TERRAIN_SECTOR_SIZE,
            exaggeration: TERRAIN_EXAGGERATION,
        }),
        static: await createUniform(runtime, 'DEM terrain constants', codecs.static, {
            terrainBox: TERRAIN_BOUNDARY,
            e: TERRAIN_ELEVATION_RANGE,
        }),
        dynamic: await createUniform(runtime, 'DEM camera state', codecs.dynamic, {
            far: 1,
            near: 0,
            uMatrix: identity,
            centerLow: [ 0, 0, 0 ],
            centerHigh: [ 0, 0, 0 ],
        }),
    }
}

async function createUniform(
    runtime: ScratchRuntime,
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
        write: (nextValues: LayoutValues) => codec.write(bytes, nextValues),
    })
}

function createTerrainGeometry() {

    const generated = plane(Math.log2(TERRAIN_SECTOR_SIZE))
    return Object.freeze({
        positions: new Float32Array(generated.positions),
        indices: new Uint32Array(generated.indices),
        vertexCount: generated.indices.length,
    })
}

async function createBufferResources(runtime: ScratchRuntime, geometry: TerrainGeometry) {

    const nodeLevels = new Uint32Array(MAX_TERRAIN_NODES)
    const nodeBoxes = new Float32Array(MAX_TERRAIN_NODES * 4)
    const lodArguments = new Uint32Array([ 4, 0, 0, 0 ])
    const terrainArguments = new Uint32Array([ geometry.vertexCount, 0, 0, 0 ])

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
        nodeLevels: await createBufferWithUpload(
            runtime,
            'DEM selected node levels',
            nodeLevels,
            bufferUsage.COPY_DST | bufferUsage.STORAGE
        ),
        nodeBoxes: await createBufferWithUpload(
            runtime,
            'DEM selected node boxes',
            nodeBoxes,
            bufferUsage.COPY_DST | bufferUsage.STORAGE
        ),
        lodArguments: await createBufferWithUpload(
            runtime,
            'DEM LoD indirect arguments',
            lodArguments,
            bufferUsage.COPY_DST | bufferUsage.INDIRECT
        ),
        terrainArguments: await createBufferWithUpload(
            runtime,
            'DEM terrain indirect arguments',
            terrainArguments,
            bufferUsage.COPY_DST | bufferUsage.INDIRECT
        ),
    }
}

async function createBufferWithUpload<T extends BufferData>(
    runtime: ScratchRuntime,
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

async function createTextures(runtime: ScratchRuntime, demImage: ImageBitmap, size: SurfaceSize) {

    const dem = await runtime.createTexture({
        label: 'DEM elevation texture',
        size: { width: demImage.width, height: demImage.height },
        format: 'rgba8unorm',
        usage: textureUsage.COPY_DST |
            textureUsage.TEXTURE_BINDING |
            textureUsage.RENDER_ATTACHMENT,
    })
    const lodMap = await runtime.createTexture({
        label: 'DEM LoD map',
        size: LOD_MAP_SIZE,
        format: 'rgba8unorm',
        usage: textureUsage.RENDER_ATTACHMENT | textureUsage.TEXTURE_BINDING,
    })
    const depth = await runtime.createTexture({
        label: 'DEM presentation depth',
        size,
        format: 'depth32float',
        usage: textureUsage.RENDER_ATTACHMENT,
    })
    const demUpload = runtime.createExternalImageUploadCommand({
        label: 'Upload DEM elevation image',
        source: demImage,
        flipY: true,
        target: dem,
        colorSpace: 'srgb',
        premultipliedAlpha: false,
        size: { width: demImage.width, height: demImage.height },
    })

    return {
        dem,
        lodMap,
        depth,
        demUpload,
        views: {
            dem: dem.view(),
            lodMap: lodMap.view(),
            depth: depth.view(),
        },
    }
}

async function createBindLayouts(runtime: ScratchRuntime, codecs: Codecs) {

    const uniform = (
        binding: number,
        name: string,
        codec: LayoutCodec,
        visibility: readonly BindVisibility[]
    ): BindLayoutEntry => ({
        binding,
        name,
        type: 'uniform',
        visibility,
        minBindingSize: codec.byteLength(),
    })
    const readStorage = (binding: number, name: string): BindLayoutEntry => ({
        binding,
        name,
        type: 'read-storage',
        visibility: [ 'vertex' ],
    })

    return {
        lodUniforms: await runtime.createBindLayout({
            label: 'DEM LoD uniform layout',
            group: 0,
            entries: [
                uniform(0, 'mapUniform', codecs.map, [ 'vertex' ]),
                uniform(1, 'tileUniform', codecs.tile, [ 'vertex' ]),
                uniform(2, 'staticUniform', codecs.static, [ 'vertex' ]),
            ],
        }),
        lodStorage: await runtime.createBindLayout({
            label: 'DEM LoD storage layout',
            group: 1,
            entries: [ readStorage(0, 'level'), readStorage(1, 'box') ],
        }),
        terrainUniforms: await runtime.createBindLayout({
            label: 'DEM terrain uniform layout',
            group: 0,
            entries: [
                uniform(0, 'tileUniform', codecs.tile, [ 'vertex' ]),
                uniform(1, 'staticUniform', codecs.static, [ 'vertex' ]),
                uniform(2, 'dynamicUniform', codecs.dynamic, [ 'vertex' ]),
            ],
        }),
        terrainStorage: await runtime.createBindLayout({
            label: 'DEM terrain storage layout',
            group: 1,
            entries: [
                readStorage(0, 'indices'),
                readStorage(1, 'positions'),
                readStorage(2, 'level'),
                readStorage(3, 'box'),
            ],
        }),
        terrainTextures: await runtime.createBindLayout({
            label: 'DEM terrain texture layout',
            group: 2,
            entries: [
                {
                    binding: 1,
                    name: 'demTexture',
                    type: 'texture',
                    sampleType: 'float',
                    viewDimension: '2d',
                    visibility: [ 'vertex' ],
                },
                {
                    binding: 2,
                    name: 'lodMap',
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
    runtime: ScratchRuntime,
    layouts: Layouts,
    uniforms: Uniforms,
    buffers: Buffers,
    textures: Textures
) {

    return {
        lodUniforms: await runtime.createBindSet(layouts.lodUniforms, {
            mapUniform: uniforms.map.region,
            tileUniform: uniforms.tile.region,
            staticUniform: uniforms.static.region,
        }, { label: 'DEM LoD uniforms' }),
        lodStorage: await runtime.createBindSet(layouts.lodStorage, {
            level: buffers.nodeLevels.region,
            box: buffers.nodeBoxes.region,
        }, { label: 'DEM LoD selected nodes' }),
        terrainUniforms: await runtime.createBindSet(layouts.terrainUniforms, {
            tileUniform: uniforms.tile.region,
            staticUniform: uniforms.static.region,
            dynamicUniform: uniforms.dynamic.region,
        }, { label: 'DEM terrain uniforms' }),
        terrainStorage: await runtime.createBindSet(layouts.terrainStorage, {
            indices: buffers.indices.region,
            positions: buffers.positions.region,
            level: buffers.nodeLevels.region,
            box: buffers.nodeBoxes.region,
        }, { label: 'DEM terrain data' }),
        terrainTextures: await runtime.createBindSet(layouts.terrainTextures, {
            demTexture: textures.views.dem,
            lodMap: textures.views.lodMap,
        }, { label: 'DEM terrain textures' }),
    }
}

async function createPrograms(
    runtime: ScratchRuntime,
    codecs: Codecs,
    shaders: DemShaders,
    failureProof: DemFailureProof
) {

    const requirement = (
        group: number,
        binding: number,
        codec: LayoutCodec
    ): ProgramBufferLayoutRequirement => ({
        group,
        binding,
        type: 'uniform',
        hasDynamicOffset: false,
        layout: codec.artifact,
    })
    failureProof.beforeTerrainShaderModule(runtime)
    const terrainShader = await runtime.createShaderModule({
        label: 'DEM terrain shader',
        sourceParts: [ { code: failureProof.terrainShader(shaders.terrain) } ],
    })
    const lodMapShader = await runtime.createShaderModule({
        label: 'DEM LoD-map shader',
        sourceParts: [ { code: shaders.lodMap } ],
    })
    return {
        lodMap: runtime.createProgram({
            label: 'DEM LoD-map program',
            vertex: { module: lodMapShader, entryPoint: 'vMain' },
            fragment: { module: lodMapShader, entryPoint: 'fMain' },
            layoutRequirements: [
                requirement(0, 0, codecs.map),
                requirement(0, 1, codecs.tile),
                requirement(0, 2, codecs.static),
            ],
        }),
        terrain: runtime.createProgram({
            label: 'DEM terrain program',
            vertex: { module: terrainShader, entryPoint: 'vMain' },
            fragment: { module: terrainShader, entryPoint: 'fMain' },
            layoutRequirements: [
                requirement(0, 0, codecs.tile),
                requirement(0, 1, codecs.static),
                requirement(0, 2, codecs.dynamic),
            ],
        }),
    }
}

async function createPipelines(
    runtime: ScratchRuntime,
    surface: Surface,
    textures: Textures,
    layouts: Layouts,
    programs: Programs
) {

    const lodMap = await runtime.createRenderPipeline({
        label: 'DEM LoD-map pipeline',
        program: programs.lodMap,
        layout: {
            mode: 'explicit',
            bindLayouts: [ layouts.lodUniforms, layouts.lodStorage ],
        },
        targets: [ { format: textures.lodMap.format } ],
        primitive: { topology: 'triangle-strip', cullMode: 'none' },
    })
    const terrain = await runtime.createRenderPipeline({
        label: 'DEM terrain pipeline',
        program: programs.terrain,
        layout: {
            mode: 'explicit',
            bindLayouts: [
                layouts.terrainUniforms,
                layouts.terrainStorage,
                layouts.terrainTextures,
            ],
        },
        targets: [ { format: surface.format } ],
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: {
            format: textures.depth.format,
            depthWriteEnabled: true,
            depthCompare: 'less',
        },
    })

    return { lodMap, terrain }
}

function createPasses(runtime: ScratchRuntime, surface: Surface, textures: Textures) {

    return {
        lodMap: runtime.createRenderPass({
            label: 'DEM LoD-map stage',
            color: [ {
                target: textures.views.lodMap,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 0 ],
            } ],
        }),
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
    runtime: ScratchRuntime,
    geometry: TerrainGeometry,
    uniforms: Uniforms,
    buffers: Buffers,
    textures: Textures,
    bindSets: BindSets,
    pipelines: Pipelines
) {

    return {
        drawLodMap: runtime.createDrawCommand({
            label: 'Draw DEM LoD map',
            pipeline: pipelines.lodMap,
            bindSets: [ { set: bindSets.lodUniforms }, { set: bindSets.lodStorage } ],
            count: { indirect: buffers.lodArguments.region },
            resources: {
                read: currentReads([
                    uniforms.map.buffer,
                    uniforms.tile.buffer,
                    uniforms.static.buffer,
                    buffers.nodeLevels.buffer,
                    buffers.nodeBoxes.buffer,
                    buffers.lodArguments.buffer,
                ]),
                write: [],
            },
            whenMissing: 'throw',
        }),
        drawTerrain: runtime.createDrawCommand({
            label: 'Draw DEM terrain',
            pipeline: pipelines.terrain,
            bindSets: [
                { set: bindSets.terrainUniforms },
                { set: bindSets.terrainStorage },
                { set: bindSets.terrainTextures },
            ],
            count: { indirect: buffers.terrainArguments.region },
            resources: {
                read: currentReads([
                    uniforms.tile.buffer,
                    uniforms.static.buffer,
                    uniforms.dynamic.buffer,
                    buffers.indices.buffer,
                    buffers.positions.buffer,
                    buffers.nodeLevels.buffer,
                    buffers.nodeBoxes.buffer,
                    textures.dem,
                    textures.lodMap,
                    buffers.terrainArguments.buffer,
                ]),
                write: [],
            },
            whenMissing: 'throw',
        }),
    }
}

function currentReads(resources: readonly ContentResource[]) {

    return resources.map(resource => ({ resource, contentEpoch: 'current-at-step' as const }))
}

function updateFrameData(
    graph: DemGraph,
    selection: TerrainSelection,
    camera: DemCameraState
) {

    graph.uniforms.dynamic.write({
        far: camera.far,
        near: camera.near,
        uMatrix: camera.matrix,
        centerLow: camera.centerLow,
        centerHigh: camera.centerHigh,
    })
    graph.uniforms.tile.write({
        tileBox: selection.tileBox,
        levelRange: selection.levelRange,
        sectorRange: selection.sectorRange,
        sectorSize: TERRAIN_SECTOR_SIZE,
        exaggeration: TERRAIN_EXAGGERATION,
    })
    graph.buffers.nodeLevels.data.fill(0)
    graph.buffers.nodeLevels.data.set(selection.nodeLevels)
    graph.buffers.nodeBoxes.data.fill(0)
    graph.buffers.nodeBoxes.data.set(selection.nodeBoxes)
    graph.buffers.lodArguments.data[1] = selection.visibleNodeCount
    graph.buffers.terrainArguments.data[1] = selection.visibleNodeCount
}

function verifyFrameProvenance(submitted: SubmittedWork, graph: DemGraph) {

    const pairs = [
        {
            name: 'node-level-upload-to-lod-draw',
            resource: graph.buffers.nodeLevels.buffer,
            producerCommandId: graph.buffers.nodeLevels.upload.id,
            consumerCommandId: graph.commands.drawLodMap.id,
        },
        {
            name: 'lod-arguments-upload-to-lod-draw',
            resource: graph.buffers.lodArguments.buffer,
            producerCommandId: graph.buffers.lodArguments.upload.id,
            consumerCommandId: graph.commands.drawLodMap.id,
        },
        {
            name: 'node-box-upload-to-terrain-draw',
            resource: graph.buffers.nodeBoxes.buffer,
            producerCommandId: graph.buffers.nodeBoxes.upload.id,
            consumerCommandId: graph.commands.drawTerrain.id,
        },
        {
            name: 'terrain-arguments-upload-to-terrain-draw',
            resource: graph.buffers.terrainArguments.buffer,
            producerCommandId: graph.buffers.terrainArguments.upload.id,
            consumerCommandId: graph.commands.drawTerrain.id,
        },
        {
            name: 'lod-map-pass-to-terrain-draw',
            resource: graph.textures.lodMap,
            producerPassId: graph.passes.lodMap.id,
            consumerCommandId: graph.commands.drawTerrain.id,
        },
    ]

    return Object.freeze(pairs.map(pair => {
        const producer = submitted.producerEpochs.find(epoch => (
            epoch.resourceId === pair.resource.id &&
            (pair.producerCommandId === undefined ||
                epoch.producedBy.commandId === pair.producerCommandId) &&
            (pair.producerPassId === undefined || epoch.producedBy.passId === pair.producerPassId)
        ))
        const read = submitted.resourceAccesses.find(access => (
            access.resourceId === pair.resource.id &&
            access.commandId === pair.consumerCommandId &&
            access.access === 'read'
        ))
        if (
            producer === undefined ||
            read === undefined ||
            read.declaredContentEpoch !== 'current-at-step' ||
            producer.contentEpoch !== read.contentEpochBefore
        ) {
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

    return {
        resources: [
            ...Object.values(graph.uniforms).map(value => value.buffer),
            ...Object.values(graph.buffers).map(value => value.buffer),
            graph.textures.dem,
            graph.textures.lodMap,
            graph.textures.depth,
        ],
        uploads: [
            ...Object.values(graph.uniforms).map(value => value.upload),
            ...Object.values(graph.buffers).map(value => value.upload),
            graph.textures.demUpload,
        ],
        bindLayouts: Object.values(graph.layouts),
        bindSets: Object.values(graph.bindSets),
        programs: Object.values(graph.programs),
        pipelines: Object.values(graph.pipelines),
        passes: Object.values(graph.passes),
        commands: Object.values(graph.commands),
    }
}

function persistentFactSnapshot(runtime: ScratchRuntime): PersistentFacts {

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

    return Object.freeze({
        stageOrder: DEM_STAGE_ORDER,
        countPath: 'uploaded-indirect-arguments',
        maxNodes: MAX_TERRAIN_NODES,
        terrainVertexCount: graph.geometry.vertexCount,
        lodMapSize: LOD_MAP_SIZE,
        persistentIdentityCount: stableIdentitySnapshot(graph).length,
        passIds: Object.freeze({
            lodMap: graph.passes.lodMap.id,
            terrain: graph.passes.terrain.id,
        }),
        commandIds: Object.freeze({
            drawLodMap: graph.commands.drawLodMap.id,
            drawTerrain: graph.commands.drawTerrain.id,
        }),
    })
}

function createState(size: SurfaceSize): DemState {

    return {
        initialized: false,
        frame: 0,
        size: { ...size },
        resizeGeneration: 0,
        staleBindSetPreparationCount: 0,
        lastResizeFacts: undefined,
        selection: undefined,
        stageActivity: Object.fromEntries(DEM_STAGE_ORDER.map(name => [ name, 0 ])) as {
            'lod-map': number
            terrain: number
        },
    }
}

function stateSnapshot(state: DemState) {

    return Object.freeze({
        initialized: state.initialized,
        frame: state.frame,
        size: Object.freeze({ ...state.size }),
        resizeGeneration: state.resizeGeneration,
        staleBindSetPreparationCount: state.staleBindSetPreparationCount,
        lastResizeFacts: state.lastResizeFacts,
        visibleNodeCount: state.selection?.visibleNodeCount ?? 0,
        selection: state.selection,
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

    if (
        value === undefined ||
        !Number.isInteger(value.width) ||
        !Number.isInteger(value.height) ||
        value.width <= 0 ||
        value.height <= 0
    ) {
        throw new TypeError('DEM size must contain positive integer width and height')
    }
}

function assertDemImage(value: ImageBitmap) {

    if (
        value === undefined ||
        !Number.isInteger(value.width) ||
        !Number.isInteger(value.height) ||
        value.width <= 0 ||
        value.height <= 0
    ) {
        throw new TypeError('DEM image must expose positive integer width and height')
    }
}

function assertShaders(value: DemShaders) {

    if (typeof value?.lodMap !== 'string' || typeof value?.terrain !== 'string') {
        throw new TypeError('DEM shaders must contain lodMap and terrain WGSL strings')
    }
}

function assertCamera(value: DemCameraState) {

    if (
        value === undefined ||
        !Number.isFinite(value.far) ||
        !Number.isFinite(value.near) ||
        !Number.isFinite(value.zoom) ||
        value.matrix?.length !== 16 ||
        value.centerLow?.length !== 3 ||
        value.centerHigh?.length !== 3 ||
        value.cameraPos?.length !== 2 ||
        value.viewport?.length !== 2
    ) {
        throw new TypeError('DEM camera state is incomplete')
    }
}
