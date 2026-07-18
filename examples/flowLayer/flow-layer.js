import {
    MercatorCoordinate,
    ScratchRuntime,
    layoutCodec,
    mat4,
} from 'geoscratch'
import { Delaunay } from 'd3-delaunay'
import arrowShader from './shaders/flow/arrow.wgsl?raw'
import flowLayerShader from './shaders/flow/flowLayer.wgsl?raw'
import flowShowShader from './shaders/flow/flowShow.wgsl?raw'
import flowVoronoiShader from './shaders/flow/flowVoronoi.wgsl?raw'
import particlesShader from './shaders/flow/particles.wgsl?raw'
import simulationShader from './shaders/flow/simulation.compute.wgsl?raw'
import swapShader from './shaders/flow/swap.wgsl?raw'

export const PARTICLE_COUNT = 262_144
export const PARTICLE_BLOCK_SIZE = 16
export const FRAMES_PER_FIELD = 300
export const FIELD_COUNT = 27
export const STAGE_ORDER = Object.freeze([
    'voronoi-field',
    'particle-simulation',
    'history-particles',
    'flow-visualization',
    'history-presentation',
])

const FLOW_EXTENT = Object.freeze([
    120.04373606134682,
    31.173901952209487,
    121.96623240116922,
    32.08401085804678,
])
const GROUP_SIZE_X = Math.ceil(Math.sqrt(PARTICLE_COUNT) / PARTICLE_BLOCK_SIZE)
const GROUP_SIZE_Y = Math.ceil(Math.sqrt(PARTICLE_COUNT) / PARTICLE_BLOCK_SIZE)
const normalBlend = Object.freeze({
    color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
    alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
})

export async function createFlowLayer({
    runtime,
    surface,
    map,
    lifetime,
    loadField,
    size,
    random = Math.random,
    options = {},
    failureProof,
}) {

    if (!(runtime instanceof ScratchRuntime)) throw new TypeError('Flow Layer requires ScratchRuntime')
    const settings = normalizeOptions(options)
    const codecs = createCodecs()
    const stationGeometry = await createStationGeometry(settings.flowDomainMaxEdge)
    const [ firstField, secondField ] = await Promise.all([ loadField(0), loadField(1) ])
    const fieldData = createFieldData(stationGeometry, firstField, secondField)
    const particleData = createParticleData(random)
    const uniforms = await createUniformResources(runtime, codecs, settings, size)
    const buffers = await createBufferResources(
        runtime,
        stationGeometry,
        fieldData,
        particleData
    )
    const textures = await createTextures(runtime, size)
    const layouts = await createBindLayouts(runtime, codecs)
    const bindSets = await createBindSets(runtime, layouts, uniforms, buffers, textures)
    const programs = createPrograms(runtime, codecs, failureProof)
    const pipelines = await createPipelines(
        runtime,
        surface,
        textures,
        layouts,
        programs,
        failureProof
    )
    const passes = createPasses(runtime, surface, textures)
    const commands = createCommands(
        runtime,
        uniforms,
        buffers,
        textures,
        bindSets,
        pipelines,
        stationGeometry.vertexCount
    )
    const historyDirections = createHistoryDirections(passes, commands)
    const graph = {
        runtime,
        surface,
        map,
        settings,
        codecs,
        uniforms,
        buffers,
        textures,
        layouts,
        bindSets,
        programs,
        pipelines,
        passes,
        commands,
        historyDirections,
    }
    const state = createFlowState(size, fieldData, random)
    const stableIdentities = stableIdentitySnapshot(graph)

    await lifetime.track(initializeGraph(graph), 'flow-initial-submission')
    state.persistentFacts = persistentFactSnapshot(runtime)
    queueNextField(state, stationGeometry, loadField)

    return Object.freeze({
        renderFrame: camera => renderFrame(graph, state, camera),
        resize: nextSize => resizeFlowGraph(graph, state, nextSize),
        cameraMoving: () => setCameraMoving(state, settings),
        cameraSettled: () => setCameraSettled(state, settings),
        stableIdentities: Object.freeze([ ...stableIdentities ]),
        stableIdentityHash: hashStrings(stableIdentities),
        persistentFacts: () => persistentFactSnapshot(runtime),
        state: () => flowStateSnapshot(state),
        settings,
    })
}

function normalizeOptions(options) {

    const historyMode = options.historyMode ?? (options.clearOnMove === false ? 'off' : 'reproject')
    if (![ 'off', 'clear', 'reproject' ].includes(historyMode)) {
        throw new Error(`Unsupported flow history mode: ${historyMode}`)
    }
    return Object.freeze({
        trailDecay: options.trailDecay ?? 0.996,
        trailCutoff: options.trailCutoff ?? 1 / 255,
        useFlowMask: options.useFlowMask ?? true,
        flowMaskCutoff: options.flowMaskCutoff ?? 0,
        flowDomainMaxEdge: options.flowDomainMaxEdge ?? 0.04,
        historyMode,
        maxHistoryReprojectCenterDelta: options.maxHistoryReprojectCenterDelta ?? 0.25,
        showVoronoi: options.showVoronoi ?? true,
        showArrow: options.showArrow ?? false,
    })
}

function createCodecs() {

    const uniform = (name, fields) => layoutCodec({ name, fields }, { usage: [ 'uniform' ] })
    return Object.freeze({
        frame: uniform('FlowFrameUniform', [
            { name: 'randomSeed', type: 'f32' },
            { name: 'viewPort', type: 'vec2f' },
            { name: 'mapBounds', type: 'vec4f' },
            { name: 'zoomLevel', type: 'f32' },
            { name: 'progressRate', type: 'f32' },
            { name: 'maxSpeed', type: 'f32' },
            { name: 'flowMaskCutoff', type: 'f32' },
        ]),
        static: uniform('FlowStaticUniform', [
            { name: 'groupSize', type: 'vec2u' },
            { name: 'extent', type: 'vec4f' },
        ]),
        camera: uniform('FlowCameraUniform', [
            { name: 'far', type: 'f32' },
            { name: 'near', type: 'f32' },
            { name: 'uMatrix', type: 'mat4x4f' },
            { name: 'centerLow', type: 'vec3f' },
            { name: 'centerHigh', type: 'vec3f' },
        ]),
        controller: uniform('FlowControllerUniform', [
            { name: 'particleNum', type: 'u32' },
            { name: 'dropRate', type: 'f32' },
            { name: 'dropRateBump', type: 'f32' },
            { name: 'speedFactor', type: 'f32' },
            { name: 'useFlowMask', type: 'f32' },
        ]),
        cleanup: uniform('FlowCleanupUniform', [
            { name: 'trailDecay', type: 'f32' },
            { name: 'trailCutoff', type: 'f32' },
            { name: 'useFlowMask', type: 'f32' },
            { name: 'historyMode', type: 'f32' },
            { name: 'historyValid', type: 'f32' },
            { name: 'historyReprojecting', type: 'f32' },
            { name: 'previousMatrix', type: 'mat4x4f' },
            { name: 'currentMatrix', type: 'mat4x4f' },
            { name: 'currentInverseMatrix', type: 'mat4x4f' },
            { name: 'previousCenterHigh', type: 'vec3f' },
            { name: 'previousCenterLow', type: 'vec3f' },
            { name: 'currentCenterHigh', type: 'vec3f' },
            { name: 'currentCenterLow', type: 'vec3f' },
            { name: 'previousViewport', type: 'vec2f' },
            { name: 'currentViewport', type: 'vec2f' },
        ]),
    })
}

async function createUniformResources(runtime, codecs, settings, size) {

    const identity = Array.from(mat4.identity())
    return {
        frame: await createUniform(runtime, 'Flow frame uniform', codecs.frame, {
            randomSeed: 0,
            viewPort: [ size.width, size.height ],
            mapBounds: FLOW_EXTENT,
            zoomLevel: 9,
            progressRate: 0,
            maxSpeed: 0,
            flowMaskCutoff: settings.flowMaskCutoff,
        }),
        static: await createUniform(runtime, 'Flow static uniform', codecs.static, {
            groupSize: [ GROUP_SIZE_X, GROUP_SIZE_Y ],
            extent: FLOW_EXTENT,
        }),
        camera: await createUniform(runtime, 'Flow camera uniform', codecs.camera, {
            far: 1,
            near: 0,
            uMatrix: identity,
            centerLow: [ 0, 0, 0 ],
            centerHigh: [ 0, 0, 0 ],
        }),
        controller: await createUniform(runtime, 'Flow simulation controller', codecs.controller, {
            particleNum: PARTICLE_COUNT,
            dropRate: 0.003,
            dropRateBump: 0.001,
            speedFactor: 1,
            useFlowMask: settings.useFlowMask ? 1 : 0,
        }),
        cleanup: await createUniform(runtime, 'Flow history cleanup', codecs.cleanup, {
            trailDecay: settings.trailDecay,
            trailCutoff: settings.trailCutoff,
            useFlowMask: settings.useFlowMask ? 1 : 0,
            historyMode: historyModeValue(settings.historyMode),
            historyValid: 0,
            historyReprojecting: 0,
            previousMatrix: identity,
            currentMatrix: identity,
            currentInverseMatrix: identity,
            previousCenterHigh: [ 0, 0, 0 ],
            previousCenterLow: [ 0, 0, 0 ],
            currentCenterHigh: [ 0, 0, 0 ],
            currentCenterLow: [ 0, 0, 0 ],
            previousViewport: [ size.width, size.height ],
            currentViewport: [ size.width, size.height ],
        }),
    }
}

async function createUniform(runtime, label, codec, values) {

    const bytes = codec.pack(values)
    const buffer = await runtime.createBuffer({
        label,
        size: bytes.byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    })
    const region = buffer.region({ layout: codec.artifact })
    return {
        codec,
        bytes,
        buffer,
        region,
        upload: runtime.createUploadCommand({ label: `Upload ${label}`, target: region, data: bytes }),
        write: nextValues => codec.write(bytes, nextValues),
    }
}

async function createStationGeometry(maxEdge) {

    const stationCoords = new Float32Array(await fetchArrayBuffer('/json/examples/flow/station.bin'))
    const meshes = new Delaunay(stationCoords)
    const vertices = []
    const domainSupport = []
    const stationIndices = []

    for (let index = 0; index < meshes.triangles.length; index += 3) {
        const ids = [
            meshes.triangles[index],
            meshes.triangles[index + 1],
            meshes.triangles[index + 2],
        ]
        const support = calculateTriangleDomainSupport(meshes.points, ids, maxEdge)
        for (const id of ids) {
            const x = encodeFloatToDouble(MercatorCoordinate.mercatorXfromLon(meshes.points[id * 2]))
            const y = encodeFloatToDouble(MercatorCoordinate.mercatorYfromLat(meshes.points[id * 2 + 1]))
            vertices.push(x[0], y[0], x[1], y[1])
            domainSupport.push(support)
            stationIndices.push(id)
        }
    }

    return Object.freeze({
        positions: new Float32Array(vertices),
        domainSupport: new Float32Array(domainSupport),
        stationIndices: new Uint32Array(stationIndices),
        vertexCount: stationIndices.length,
    })
}

function createFieldData(geometry, first, second) {

    return {
        from: expandStationVelocities(geometry, first.uvs),
        to: expandStationVelocities(geometry, second.uvs),
        fromIndex: first.index,
        toIndex: second.index,
        maxSpeed: Math.max(first.maxSpeed, second.maxSpeed),
    }
}

function createParticleData(random) {

    const data = new Float32Array(PARTICLE_COUNT * 6)
    for (let index = 0; index < data.length; index++) {
        data[index] = index % 6 === 4 || index % 6 === 5 ? 0 : random()
    }
    return data
}

async function createBufferResources(runtime, geometry, fields, particles) {

    return {
        stationPositions: await createBufferWithUpload(
            runtime,
            'Flow station positions',
            geometry.positions,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX
        ),
        domainSupport: await createBufferWithUpload(
            runtime,
            'Flow station domain support',
            geometry.domainSupport,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX
        ),
        fieldFrom: await createBufferWithUpload(
            runtime,
            'Flow station velocity from',
            fields.from,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX
        ),
        fieldTo: await createBufferWithUpload(
            runtime,
            'Flow station velocity to',
            fields.to,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX
        ),
        particles: await createBufferWithUpload(
            runtime,
            'Flow particle state',
            particles,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
        ),
    }
}

async function createBufferWithUpload(runtime, label, data, usage) {

    const buffer = await runtime.createBuffer({ label, size: data.byteLength, usage })
    const region = buffer.region()
    return {
        data,
        buffer,
        region,
        upload: runtime.createUploadCommand({ label: `Upload ${label}`, target: region, data }),
    }
}

async function createTextures(runtime, size) {

    const sampledTargetUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    const flow = await runtime.createTexture({
        label: 'Flow velocity field',
        size,
        format: 'rg32float',
        usage: sampledTargetUsage,
    })
    const mask = await runtime.createTexture({
        label: 'Flow domain mask',
        size,
        format: 'r8unorm',
        usage: sampledTargetUsage,
    })
    const historyA = await runtime.createTexture({
        label: 'Flow history A',
        size,
        format: 'rgba8unorm',
        usage: sampledTargetUsage,
    })
    const historyB = await runtime.createTexture({
        label: 'Flow history B',
        size,
        format: 'rgba8unorm',
        usage: sampledTargetUsage,
    })
    const depth = await runtime.createTexture({
        label: 'Flow depth',
        size,
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })

    return {
        flow,
        mask,
        historyA,
        historyB,
        depth,
        views: {
            flow: flow.view(),
            mask: mask.view(),
            historyA: historyA.view(),
            historyB: historyB.view(),
            depth: depth.view(),
        },
    }
}

async function createBindLayouts(runtime, codecs) {

    const uniform = (binding, name, codec, visibility) => ({
        binding,
        name,
        type: 'uniform',
        visibility,
        minBindingSize: codec.artifact.byteLength,
    })
    const texture = (binding, name, visibility, sampleType = 'float') => ({
        binding,
        name,
        type: 'texture',
        visibility,
        sampleType,
        viewDimension: '2d',
    })

    return {
        sharedUniforms: await runtime.createBindLayout({
            label: 'Flow shared uniform layout',
            group: 0,
            entries: [
                uniform(0, 'frameUniform', codecs.frame, [ 'vertex', 'fragment' ]),
                uniform(1, 'staticUniform', codecs.static, [ 'vertex' ]),
                uniform(2, 'dynamicUniform', codecs.camera, [ 'vertex' ]),
            ],
        }),
        simulationUniforms: await runtime.createBindLayout({
            label: 'Flow simulation uniform layout',
            group: 0,
            entries: [
                uniform(0, 'controllerUniform', codecs.controller, [ 'compute' ]),
                uniform(1, 'frameUniform', codecs.frame, [ 'compute' ]),
                uniform(2, 'staticUniform', codecs.static, [ 'compute' ]),
                uniform(3, 'dynamicUniform', codecs.camera, [ 'compute' ]),
            ],
        }),
        simulationStorage: await runtime.createBindLayout({
            label: 'Flow simulation particle layout',
            group: 1,
            entries: [ {
                binding: 0,
                name: 'particles',
                type: 'storage',
                visibility: [ 'compute' ],
            } ],
        }),
        simulationTextures: await runtime.createBindLayout({
            label: 'Flow simulation texture layout',
            group: 2,
            entries: [
                texture(0, 'fromTexture', [ 'compute' ], 'unfilterable-float'),
                texture(1, 'maskTexture', [ 'compute' ]),
            ],
        }),
        particleStorage: await runtime.createBindLayout({
            label: 'Flow particle draw storage layout',
            group: 1,
            entries: [ {
                binding: 0,
                name: 'particles',
                type: 'read-storage',
                visibility: [ 'vertex' ],
            } ],
        }),
        cleanupUniform: await runtime.createBindLayout({
            label: 'Flow history cleanup uniform layout',
            group: 0,
            entries: [ uniform(0, 'cleanupUniform', codecs.cleanup, [ 'vertex', 'fragment' ]) ],
        }),
        historyTextures: await runtime.createBindLayout({
            label: 'Flow history source layout',
            group: 1,
            entries: [
                texture(0, 'bgTexture', [ 'fragment' ]),
                texture(1, 'maskTexture', [ 'fragment' ]),
            ],
        }),
        fieldUniform: await runtime.createBindLayout({
            label: 'Flow visualization uniform layout',
            group: 0,
            entries: [ uniform(0, 'frameUniform', codecs.frame, [ 'vertex', 'fragment' ]) ],
        }),
        fieldTexture: await runtime.createBindLayout({
            label: 'Flow visualization texture layout',
            group: 1,
            entries: [ texture(0, 'fromTexture', [ 'fragment' ], 'unfilterable-float') ],
        }),
        presentationTexture: await runtime.createBindLayout({
            label: 'Flow presentation texture layout',
            group: 0,
            entries: [ texture(0, 'layerTexture', [ 'fragment' ]) ],
        }),
    }
}

async function createBindSets(runtime, layouts, uniforms, buffers, textures) {

    return {
        sharedUniforms: await runtime.createBindSet(layouts.sharedUniforms, {
            frameUniform: uniforms.frame.region,
            staticUniform: uniforms.static.region,
            dynamicUniform: uniforms.camera.region,
        }, { label: 'Flow shared uniforms' }),
        simulationUniforms: await runtime.createBindSet(layouts.simulationUniforms, {
            controllerUniform: uniforms.controller.region,
            frameUniform: uniforms.frame.region,
            staticUniform: uniforms.static.region,
            dynamicUniform: uniforms.camera.region,
        }, { label: 'Flow simulation uniforms' }),
        simulationStorage: await runtime.createBindSet(layouts.simulationStorage, {
            particles: buffers.particles.region,
        }, { label: 'Flow writable particles' }),
        simulationTextures: await runtime.createBindSet(layouts.simulationTextures, {
            fromTexture: textures.views.flow,
            maskTexture: textures.views.mask,
        }, { label: 'Flow simulation textures' }),
        particleStorage: await runtime.createBindSet(layouts.particleStorage, {
            particles: buffers.particles.region,
        }, { label: 'Flow particle draw state' }),
        cleanupUniform: await runtime.createBindSet(layouts.cleanupUniform, {
            cleanupUniform: uniforms.cleanup.region,
        }, { label: 'Flow history cleanup uniforms' }),
        historyBToA: await runtime.createBindSet(layouts.historyTextures, {
            bgTexture: textures.views.historyB,
            maskTexture: textures.views.mask,
        }, { label: 'Flow history B to A textures' }),
        historyAToB: await runtime.createBindSet(layouts.historyTextures, {
            bgTexture: textures.views.historyA,
            maskTexture: textures.views.mask,
        }, { label: 'Flow history A to B textures' }),
        fieldUniform: await runtime.createBindSet(layouts.fieldUniform, {
            frameUniform: uniforms.frame.region,
        }, { label: 'Flow visualization uniforms' }),
        fieldTexture: await runtime.createBindSet(layouts.fieldTexture, {
            fromTexture: textures.views.flow,
        }, { label: 'Flow visualization texture' }),
        presentationA: await runtime.createBindSet(layouts.presentationTexture, {
            layerTexture: textures.views.historyA,
        }, { label: 'Flow history A presentation' }),
        presentationB: await runtime.createBindSet(layouts.presentationTexture, {
            layerTexture: textures.views.historyB,
        }, { label: 'Flow history B presentation' }),
    }
}

function createPrograms(runtime, codecs, failureProof) {

    const requirement = (group, binding, type, codec) => ({
        group,
        binding,
        type,
        hasDynamicOffset: false,
        layout: codec.artifact,
    })
    const sharedRequirements = [
        requirement(0, 0, 'uniform', codecs.frame),
        requirement(0, 1, 'uniform', codecs.static),
        requirement(0, 2, 'uniform', codecs.camera),
    ]
    return {
        voronoi: runtime.createProgram({
            label: 'Flow Voronoi program',
            modules: [ flowVoronoiShader ],
            entryPoints: { vertex: 'vMain', fragment: 'fMain' },
            layoutRequirements: sharedRequirements,
        }),
        simulation: runtime.createProgram({
            label: 'Flow simulation program',
            modules: [ failureProof.simulationShader(simulationShader) ],
            entryPoints: { compute: 'cMain' },
            layoutRequirements: [
                requirement(0, 0, 'uniform', codecs.controller),
                requirement(0, 1, 'uniform', codecs.frame),
                requirement(0, 2, 'uniform', codecs.static),
                requirement(0, 3, 'uniform', codecs.camera),
            ],
        }),
        cleanup: runtime.createProgram({
            label: 'Flow history cleanup program',
            modules: [ swapShader ],
            entryPoints: { vertex: 'vMain', fragment: 'fMain' },
            layoutRequirements: [ requirement(0, 0, 'uniform', codecs.cleanup) ],
        }),
        particles: runtime.createProgram({
            label: 'Flow particle draw program',
            modules: [ particlesShader ],
            entryPoints: { vertex: 'vMain', fragment: 'fMain' },
            layoutRequirements: sharedRequirements,
        }),
        field: runtime.createProgram({
            label: 'Flow visualization program',
            modules: [ flowShowShader ],
            entryPoints: { vertex: 'vMain', fragment: 'fMain' },
            layoutRequirements: [ requirement(0, 0, 'uniform', codecs.frame) ],
        }),
        presentation: runtime.createProgram({
            label: 'Flow presentation program',
            modules: [ flowLayerShader ],
            entryPoints: { vertex: 'vMain', fragment: 'fMain' },
        }),
        arrow: runtime.createProgram({
            label: 'Flow arrow program',
            modules: [ arrowShader ],
            entryPoints: { vertex: 'vMain', fragment: 'fMain' },
            layoutRequirements: sharedRequirements,
        }),
    }
}

async function createPipelines(runtime, surface, textures, layouts, programs, failureProof) {

    const depthWrite = {
        format: textures.depth.format,
        depthWriteEnabled: true,
        depthCompare: 'less',
    }
    const depthRead = {
        format: textures.depth.format,
        depthWriteEnabled: false,
        depthCompare: 'less',
    }
    failureProof.beforeSimulationPipeline(runtime)

    const simulation = await runtime.createComputePipeline({
        label: 'Flow simulation pipeline',
        program: programs.simulation,
        bindLayouts: [
            layouts.simulationUniforms,
            layouts.simulationStorage,
            layouts.simulationTextures,
        ],
        constants: { blockSize: PARTICLE_BLOCK_SIZE },
    })

    return {
        voronoi: await runtime.createRenderPipeline({
            label: 'Flow Voronoi pipeline',
            program: programs.voronoi,
            bindLayouts: [ layouts.sharedUniforms ],
            vertexBuffers: [
                vertexLayout(16, 0, 'float32x4'),
                vertexLayout(4, 1, 'float32'),
                vertexLayout(8, 2, 'float32x2'),
                vertexLayout(8, 3, 'float32x2'),
            ],
            targets: [ { format: textures.flow.format }, { format: textures.mask.format } ],
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: depthWrite,
        }),
        simulation,
        cleanup: await runtime.createRenderPipeline({
            label: 'Flow history cleanup pipeline',
            program: programs.cleanup,
            bindLayouts: [ layouts.cleanupUniform, layouts.historyTextures ],
            targets: [ { format: textures.historyA.format } ],
            primitive: { topology: 'triangle-strip' },
            depthStencil: depthRead,
        }),
        particles: await runtime.createRenderPipeline({
            label: 'Flow particle draw pipeline',
            program: programs.particles,
            bindLayouts: [ layouts.sharedUniforms, layouts.particleStorage ],
            targets: [ { format: textures.historyA.format, blend: normalBlend } ],
            primitive: { topology: 'line-list' },
            depthStencil: depthWrite,
        }),
        field: await runtime.createRenderPipeline({
            label: 'Flow visualization pipeline',
            program: programs.field,
            bindLayouts: [ layouts.fieldUniform, layouts.fieldTexture ],
            targets: [ { format: surface.format, blend: normalBlend } ],
            primitive: { topology: 'triangle-strip' },
        }),
        presentation: await runtime.createRenderPipeline({
            label: 'Flow presentation pipeline',
            program: programs.presentation,
            bindLayouts: [ layouts.presentationTexture ],
            targets: [ { format: surface.format, blend: normalBlend } ],
            primitive: { topology: 'triangle-strip' },
        }),
        arrow: await runtime.createRenderPipeline({
            label: 'Flow arrow pipeline',
            program: programs.arrow,
            bindLayouts: [ layouts.sharedUniforms, layouts.particleStorage ],
            targets: [ { format: surface.format, blend: normalBlend } ],
            primitive: { topology: 'triangle-strip' },
        }),
    }
}

function vertexLayout(arrayStride, shaderLocation, format) {

    return {
        arrayStride,
        stepMode: 'vertex',
        attributes: [ { shaderLocation, offset: 0, format } ],
    }
}

function createPasses(runtime, surface, textures) {

    const depth = {
        target: textures.views.depth,
        depthLoad: 'clear',
        depthStore: 'store',
        depthClear: 1,
    }
    return {
        voronoi: runtime.createRenderPass({
            label: 'Flow Voronoi field stage',
            color: [
                { target: textures.views.flow, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] },
                { target: textures.views.mask, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] },
            ],
            depth,
        }),
        simulation: runtime.createComputePass({ label: 'Flow particle simulation stage' }),
        historyClear: runtime.createRenderPass({
            label: 'Flow history clear',
            color: [
                { target: textures.views.historyA, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] },
                { target: textures.views.historyB, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] },
            ],
        }),
        historyA: runtime.createRenderPass({
            label: 'Flow history B to A',
            color: [ { target: textures.views.historyA, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] } ],
            depth,
        }),
        historyB: runtime.createRenderPass({
            label: 'Flow history A to B',
            color: [ { target: textures.views.historyB, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] } ],
            depth,
        }),
        field: runtime.createRenderPass({
            label: 'Flow visualization stage',
            color: [ { target: surface, load: 'clear', store: 'store', clear: [ 0, 0, 0, 0 ] } ],
        }),
        presentation: runtime.createRenderPass({
            label: 'Flow history presentation stage',
            color: [ { target: surface, load: 'load', store: 'store' } ],
        }),
    }
}

function createCommands(runtime, uniforms, buffers, textures, bindSets, pipelines, vertexCount) {

    const sharedUniformResources = [
        uniforms.frame.buffer,
        uniforms.static.buffer,
        uniforms.camera.buffer,
    ]
    const voronoiVertexBuffers = [
        { slot: 0, region: buffers.stationPositions.region },
        { slot: 1, region: buffers.domainSupport.region },
        { slot: 2, region: buffers.fieldFrom.region },
        { slot: 3, region: buffers.fieldTo.region },
    ]
    const voronoi = runtime.createDrawCommand({
        label: 'Generate Flow Voronoi field',
        pipeline: pipelines.voronoi,
        bindSets: [ { set: bindSets.sharedUniforms } ],
        vertexBuffers: voronoiVertexBuffers,
        count: { vertexCount },
        resources: {
            read: currentReads([
                ...sharedUniformResources,
                buffers.stationPositions.buffer,
                buffers.domainSupport.buffer,
                buffers.fieldFrom.buffer,
                buffers.fieldTo.buffer,
            ]),
            write: [],
        },
        whenMissing: 'throw',
    })
    const simulation = runtime.createDispatchCommand({
        label: 'Simulate Flow particles',
        pipeline: pipelines.simulation,
        bindSets: [
            { set: bindSets.simulationUniforms },
            { set: bindSets.simulationStorage },
            { set: bindSets.simulationTextures },
        ],
        count: { workgroups: [ GROUP_SIZE_X, GROUP_SIZE_Y ] },
        resources: {
            read: currentReads([
                uniforms.controller.buffer,
                ...sharedUniformResources,
                buffers.particles.buffer,
                textures.flow,
                textures.mask,
            ]),
            write: [ buffers.particles.buffer ],
        },
        whenMissing: 'throw',
    })
    const cleanup = historyBindSet => runtime.createDrawCommand({
        label: historyBindSet === bindSets.historyBToA
            ? 'Compose Flow history B to A'
            : 'Compose Flow history A to B',
        pipeline: pipelines.cleanup,
        bindSets: [ { set: bindSets.cleanupUniform }, { set: historyBindSet } ],
        count: { vertexCount: 4 },
        resources: {
            read: currentReads([
                uniforms.cleanup.buffer,
                historyBindSet === bindSets.historyBToA ? textures.historyB : textures.historyA,
                textures.mask,
            ]),
            write: [],
        },
        whenMissing: 'throw',
    })
    const particles = runtime.createDrawCommand({
        label: 'Draw Flow particles',
        pipeline: pipelines.particles,
        bindSets: [ { set: bindSets.sharedUniforms }, { set: bindSets.particleStorage } ],
        count: { vertexCount: 2, instanceCount: PARTICLE_COUNT },
        resources: {
            read: currentReads([ ...sharedUniformResources, buffers.particles.buffer ]),
            write: [],
        },
        whenMissing: 'throw',
    })
    const field = runtime.createDrawCommand({
        label: 'Visualize Flow field',
        pipeline: pipelines.field,
        bindSets: [ { set: bindSets.fieldUniform }, { set: bindSets.fieldTexture } ],
        count: { vertexCount: 4 },
        resources: {
            read: currentReads([ uniforms.frame.buffer, textures.flow ]),
            write: [],
        },
        whenMissing: 'throw',
    })
    const arrow = runtime.createDrawCommand({
        label: 'Visualize Flow arrows',
        pipeline: pipelines.arrow,
        bindSets: [ { set: bindSets.sharedUniforms }, { set: bindSets.particleStorage } ],
        count: { vertexCount: 4, instanceCount: PARTICLE_COUNT },
        resources: {
            read: currentReads([ ...sharedUniformResources, buffers.particles.buffer ]),
            write: [],
        },
        whenMissing: 'throw',
    })
    const presentation = (bindSet, texture) => runtime.createDrawCommand({
        label: texture === textures.historyA
            ? 'Present Flow history A'
            : 'Present Flow history B',
        pipeline: pipelines.presentation,
        bindSets: [ { set: bindSet } ],
        count: { vertexCount: 4 },
        resources: { read: currentReads([ texture ]), write: [] },
        whenMissing: 'throw',
    })

    return {
        voronoi,
        simulation,
        cleanupBToA: cleanup(bindSets.historyBToA),
        cleanupAToB: cleanup(bindSets.historyAToB),
        particles,
        field,
        arrow,
        presentationA: presentation(bindSets.presentationA, textures.historyA),
        presentationB: presentation(bindSets.presentationB, textures.historyB),
    }
}

function createHistoryDirections(passes, commands) {

    return Object.freeze([
        Object.freeze({
            label: 'Flow history B to A',
            pass: passes.historyA,
            commands: Object.freeze([ commands.cleanupBToA, commands.particles ]),
            presentation: commands.presentationA,
            target: 'A',
        }),
        Object.freeze({
            label: 'Flow history A to B',
            pass: passes.historyB,
            commands: Object.freeze([ commands.cleanupAToB, commands.particles ]),
            presentation: commands.presentationB,
            target: 'B',
        }),
    ])
}

function createFlowState(size, fields, random) {

    const identity = Array.from(mat4.identity())
    return {
        size: { ...size },
        random,
        frame: 0,
        progress: 0,
        maxSpeed: fields.maxSpeed,
        fromFieldIndex: fields.fromIndex,
        toFieldIndex: fields.toIndex,
        nextField: undefined,
        nextFieldPromise: undefined,
        fieldFailure: undefined,
        transitionUploadsPending: false,
        particleResetPending: false,
        historyClearPending: false,
        historyDirectionIndex: 0,
        workerTransitions: 0,
        resizeGeneration: 0,
        cameraMoving: false,
        cameraMoveCount: 0,
        cameraSettleCount: 0,
        historyReprojectionFrames: 0,
        historyClearFrames: 0,
        hasHistoryCamera: false,
        currentMatrix: identity,
        currentInverseMatrix: identity,
        currentCenterHigh: [ 0, 0, 0 ],
        currentCenterLow: [ 0, 0, 0 ],
        currentViewport: [ size.width, size.height ],
        historyValid: 0,
        stageActivity: Object.fromEntries(STAGE_ORDER.map(name => [ name, 0 ])),
        persistentFacts: undefined,
    }
}

async function initializeGraph(graph) {

    const uploads = [
        ...Object.values(graph.uniforms).map(uniform => uniform.upload),
        ...Object.values(graph.buffers).map(buffer => buffer.upload),
    ]
    const builder = graph.runtime.createSubmission({ validation: 'throw' })
    for (const upload of uploads) builder.upload(upload)
    return observeSubmittedWork(builder.render(graph.passes.historyClear, []).submit())
}

async function renderFrame(graph, state, camera) {

    if (state.fieldFailure !== undefined) throw state.fieldFailure
    advanceFieldState(graph, state)
    updateCameraHistory(graph, state, camera)
    updateUniforms(graph, state, camera)

    const runtime = graph.runtime
    const direction = graph.historyDirections[state.historyDirectionIndex]
    const builder = runtime.createSubmission({ validation: 'throw' })
    builder.upload(graph.uniforms.frame.upload)
    builder.upload(graph.uniforms.camera.upload)
    builder.upload(graph.uniforms.cleanup.upload)
    if (state.transitionUploadsPending) {
        builder.upload(graph.buffers.fieldFrom.upload)
        builder.upload(graph.buffers.fieldTo.upload)
        state.transitionUploadsPending = false
    }
    if (state.particleResetPending) {
        builder.upload(graph.buffers.particles.upload)
        state.particleResetPending = false
    }

    builder.render(graph.passes.voronoi, [ graph.commands.voronoi ])
    builder.compute(graph.passes.simulation, [ graph.commands.simulation ])
    if (state.historyClearPending) {
        builder.render(graph.passes.historyClear, [])
        state.historyClearPending = false
        state.historyClearFrames++
    }
    builder.render(direction.pass, direction.commands)

    const visualizationCommands = []
    if (graph.settings.showVoronoi) visualizationCommands.push(graph.commands.field)
    if (graph.settings.showArrow) visualizationCommands.push(graph.commands.arrow)
    builder.render(graph.passes.field, visualizationCommands)
    builder.render(graph.passes.presentation, [ direction.presentation ])

    const submitted = builder.submit()
    const provenance = verifyFrameProvenance(submitted, graph, direction)

    state.frame++
    state.historyDirectionIndex = (state.historyDirectionIndex + 1) % graph.historyDirections.length
    for (const name of STAGE_ORDER) state.stageActivity[name]++
    return { submitted, observation: observeSubmittedWork(submitted), provenance }
}

function advanceFieldState(graph, state) {

    if (state.frame === 0) return
    if (state.progress < FRAMES_PER_FIELD - 1) {
        state.progress++
        return
    }
    if (state.nextField === undefined) return

    graph.buffers.fieldFrom.data.set(graph.buffers.fieldTo.data)
    graph.buffers.fieldTo.data.set(state.nextField.expanded)
    state.fromFieldIndex = state.toFieldIndex
    state.toFieldIndex = state.nextField.index
    state.maxSpeed = Math.max(state.maxSpeed, state.nextField.maxSpeed)
    state.nextField = undefined
    state.nextFieldPromise = undefined
    state.progress = 0
    state.transitionUploadsPending = true
    state.workerTransitions++
    queueNextField(state, { stationIndices: state.stationIndices }, state.loadField)
}

function queueNextField(state, geometry, loadField) {

    if (loadField !== undefined) {
        state.stationIndices = geometry.stationIndices
        state.loadField = loadField
    }
    if (state.nextFieldPromise !== undefined) return
    const nextIndex = (state.toFieldIndex + 1) % FIELD_COUNT
    state.nextFieldPromise = state.loadField(nextIndex).then(field => {
        state.nextField = {
            index: field.index,
            maxSpeed: field.maxSpeed,
            expanded: expandStationVelocities(
                { stationIndices: state.stationIndices },
                field.uvs
            ),
        }
    }).catch(error => {
        state.fieldFailure = error
    })
}

function updateCameraHistory(graph, state, camera) {

    const previousMatrix = state.currentMatrix
    const previousCenterHigh = state.currentCenterHigh
    const previousCenterLow = state.currentCenterLow
    const previousViewport = state.currentViewport
    const currentMatrix = Array.from(camera.matrix)
    const currentInverseMatrix = Array.from(mat4.inverse(currentMatrix))
    const currentCenterHigh = [ ...camera.centerHigh ]
    const currentCenterLow = [ ...camera.centerLow ]
    const currentViewport = [ ...camera.viewport ]
    const matrixValid = isFiniteArray(currentMatrix) && isFiniteArray(currentInverseMatrix)
    const viewportChanged = state.hasHistoryCamera && (
        previousViewport[0] !== currentViewport[0] ||
        previousViewport[1] !== currentViewport[1]
    )
    const previousCenter = addCenters(previousCenterHigh, previousCenterLow)
    const currentCenter = addCenters(currentCenterHigh, currentCenterLow)
    const centerDelta = Math.hypot(
        currentCenter[0] - previousCenter[0],
        currentCenter[1] - previousCenter[1]
    )
    const largeJump = state.hasHistoryCamera &&
        centerDelta > graph.settings.maxHistoryReprojectCenterDelta

    state.historyValid = graph.settings.historyMode === 'reproject' &&
        state.hasHistoryCamera && matrixValid && !viewportChanged && !largeJump ? 1 : 0
    state.hasHistoryCamera = matrixValid
    state.currentMatrix = currentMatrix
    state.currentInverseMatrix = currentInverseMatrix
    state.currentCenterHigh = currentCenterHigh
    state.currentCenterLow = currentCenterLow
    state.currentViewport = currentViewport
    if (graph.settings.historyMode === 'reproject' && state.cameraMoving) {
        state.historyReprojectionFrames++
    }

    state.historyUniformValues = {
        previousMatrix,
        previousCenterHigh,
        previousCenterLow,
        previousViewport,
    }
}

function updateUniforms(graph, state, camera) {

    graph.uniforms.frame.write({
        randomSeed: state.random(),
        viewPort: camera.viewport,
        mapBounds: camera.bounds,
        zoomLevel: camera.zoom,
        progressRate: state.progress / (FRAMES_PER_FIELD - 1),
        maxSpeed: state.maxSpeed,
        flowMaskCutoff: graph.settings.flowMaskCutoff,
    })
    graph.uniforms.camera.write({
        far: camera.far,
        near: camera.near,
        uMatrix: camera.matrix,
        centerLow: camera.centerLow,
        centerHigh: camera.centerHigh,
    })
    graph.uniforms.cleanup.write({
        trailDecay: graph.settings.trailDecay,
        trailCutoff: graph.settings.trailCutoff,
        useFlowMask: graph.settings.useFlowMask ? 1 : 0,
        historyMode: historyModeValue(graph.settings.historyMode),
        historyValid: state.historyValid,
        historyReprojecting: state.cameraMoving && graph.settings.historyMode === 'reproject' ? 1 : 0,
        previousMatrix: state.historyUniformValues.previousMatrix,
        currentMatrix: state.currentMatrix,
        currentInverseMatrix: state.currentInverseMatrix,
        previousCenterHigh: state.historyUniformValues.previousCenterHigh,
        previousCenterLow: state.historyUniformValues.previousCenterLow,
        currentCenterHigh: state.currentCenterHigh,
        currentCenterLow: state.currentCenterLow,
        previousViewport: state.historyUniformValues.previousViewport,
        currentViewport: state.currentViewport,
    })
}

function setCameraMoving(state, settings) {

    if (!state.cameraMoving) state.cameraMoveCount++
    state.cameraMoving = true
    if (settings.historyMode === 'clear') state.historyClearPending = true
}

function setCameraSettled(state, settings) {

    if (state.cameraMoving) state.cameraSettleCount++
    state.cameraMoving = false
    if (settings.historyMode === 'clear') state.particleResetPending = true
}

async function resizeFlowGraph(graph, state, size) {

    const before = stableIdentitySnapshot(graph)
    graph.surface.resize(size)
    for (const texture of [
        graph.textures.flow,
        graph.textures.mask,
        graph.textures.historyA,
        graph.textures.historyB,
        graph.textures.depth,
    ]) {
        await texture.resize(size)
    }
    await prepareStaleBindSets([
        graph.bindSets.simulationTextures,
        graph.bindSets.historyBToA,
        graph.bindSets.historyAToB,
        graph.bindSets.fieldTexture,
        graph.bindSets.presentationA,
        graph.bindSets.presentationB,
    ])
    const after = stableIdentitySnapshot(graph)
    if (before.length !== after.length || before.some((id, index) => id !== after[index])) {
        throw new Error('Persistent Flow graph identity changed during resize')
    }
    const facts = persistentFactSnapshot(graph.runtime)
    for (const name of [ 'resources', 'bindLayouts', 'bindSets', 'pipelines' ]) {
        if (facts[name] !== state.persistentFacts[name]) {
            throw new Error(`Persistent Flow ${name} count changed during resize`)
        }
    }
    state.size = { ...size }
    state.resizeGeneration++
    state.historyClearPending = true
    state.hasHistoryCamera = false
}

async function prepareStaleBindSets(bindSets) {

    for (const bindSet of bindSets) {
        if (bindSet.preparationState === 'stale') await bindSet.prepare()
    }
}

function verifyFrameProvenance(submitted, graph, direction) {

    const pairs = [
        {
            name: 'voronoi-to-simulation',
            resource: graph.textures.flow,
            producerPassId: graph.passes.voronoi.id,
            consumerCommandId: graph.commands.simulation.id,
        },
        {
            name: 'simulation-to-particle-draw',
            resource: graph.buffers.particles.buffer,
            producerCommandId: graph.commands.simulation.id,
            consumerCommandId: graph.commands.particles.id,
        },
        {
            name: 'history-to-presentation',
            resource: direction.target === 'A'
                ? graph.textures.historyA
                : graph.textures.historyB,
            producerPassId: direction.pass.id,
            consumerCommandId: direction.presentation.id,
        },
    ]
    return pairs.map(pair => {
        const producer = submitted.producerEpochs.find(epoch => (
            epoch.resourceId === pair.resource.id &&
            (pair.producerCommandId === undefined || epoch.producedBy.commandId === pair.producerCommandId) &&
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
            read.contentEpochBefore !== producer.contentEpoch
        ) {
            throw new Error(`Flow submission provenance mismatch for ${pair.name}`)
        }
        return Object.freeze({
            name: pair.name,
            resourceId: pair.resource.id,
            declaredContentEpoch: read.declaredContentEpoch,
            producerContentEpoch: producer.contentEpoch,
            readContentEpoch: read.contentEpochBefore,
        })
    })
}

function stableIdentitySnapshot(graph) {

    const objects = [
        ...Object.values(graph.uniforms).flatMap(value => [ value.buffer, value.upload ]),
        ...Object.values(graph.buffers).flatMap(value => [ value.buffer, value.upload ]),
        graph.textures.flow,
        graph.textures.mask,
        graph.textures.historyA,
        graph.textures.historyB,
        graph.textures.depth,
        ...Object.values(graph.layouts),
        ...Object.values(graph.bindSets),
        ...Object.values(graph.programs),
        ...Object.values(graph.pipelines),
        ...Object.values(graph.passes),
        ...Object.values(graph.commands),
    ]
    return [ ...new Set(objects.map(object => object.id)) ].sort()
}

function persistentFactSnapshot(runtime) {

    const facts = runtime.diagnostics.snapshot()
    return Object.freeze({
        resources: facts.resources.length,
        bindLayouts: facts.bindLayouts.length,
        bindSets: facts.bindSets.length,
        pipelines: facts.pipelines.length,
        logicalFootprintBytes: facts.pressure.currentScratchLogicalFootprintBytes,
    })
}

function flowStateSnapshot(state) {

    return Object.freeze({
        frame: state.frame,
        progress: state.progress,
        fromFieldIndex: state.fromFieldIndex,
        toFieldIndex: state.toFieldIndex,
        nextFieldReady: state.nextField !== undefined,
        workerTransitions: state.workerTransitions,
        historyDirection: state.historyDirectionIndex === 0 ? 'B-to-A' : 'A-to-B',
        resizeGeneration: state.resizeGeneration,
        cameraMoving: state.cameraMoving,
        cameraMoveCount: state.cameraMoveCount,
        cameraSettleCount: state.cameraSettleCount,
        historyValid: state.historyValid,
        historyReprojectionFrames: state.historyReprojectionFrames,
        historyClearFrames: state.historyClearFrames,
        stageActivity: Object.freeze({ ...state.stageActivity }),
    })
}

async function observeSubmittedWork(submitted) {

    const [ nativeOutcome ] = await Promise.all([ submitted.nativeOutcome, submitted.done ])
    if (nativeOutcome.status !== 'observed-succeeded') {
        throw new Error(`Flow submission native outcome was ${nativeOutcome.status}`)
    }
}

function currentReads(resources) {

    const unique = new Map(resources.map(resource => [ resource.id, resource ]))
    return [ ...unique.values() ].map(resource => ({
        resource,
        contentEpoch: 'current-at-step',
    }))
}

function expandStationVelocities(geometry, uvs) {

    const expanded = new Float32Array(geometry.stationIndices.length * 2)
    for (let index = 0; index < geometry.stationIndices.length; index++) {
        const stationIndex = geometry.stationIndices[index]
        expanded[index * 2] = uvs[stationIndex * 2]
        expanded[index * 2 + 1] = uvs[stationIndex * 2 + 1]
    }
    return expanded
}

function calculateTriangleDomainSupport(points, ids, maxEdge) {

    return Math.max(
        calculateStationEdgeLength(points, ids[0], ids[1]),
        calculateStationEdgeLength(points, ids[1], ids[2]),
        calculateStationEdgeLength(points, ids[2], ids[0])
    ) <= maxEdge ? 1 : 0
}

function calculateStationEdgeLength(points, a, b) {

    return Math.hypot(
        points[a * 2] - points[b * 2],
        points[a * 2 + 1] - points[b * 2 + 1]
    )
}

async function fetchArrayBuffer(url) {

    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
    return response.arrayBuffer()
}

function encodeFloatToDouble(value) {

    const high = Math.fround(value)
    return [ high, value - high ]
}

function historyModeValue(mode) {

    if (mode === 'off') return 0
    if (mode === 'clear') return 1
    return 2
}

function addCenters(high, low) {

    return [ high[0] + low[0], high[1] + low[1], high[2] + low[2] ]
}

function isFiniteArray(values) {

    return values.every(value => Number.isFinite(value))
}

function hashStrings(values) {

    let hash = 2166136261
    for (const value of values.join('|')) {
        hash ^= value.charCodeAt(0)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}
