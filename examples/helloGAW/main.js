import {
    ScratchRuntime,
    layoutCodec,
    mat4,
    sphere,
    utils,
} from 'geoscratch'
import bloomBlurXShader from './shaders/bloom-blur-x.wgsl?raw'
import bloomBlurYShader from './shaders/bloom-blur-y.wgsl?raw'
import bloomCombineShader from './shaders/bloom-combine.wgsl?raw'
import bloomDownsampleShader from './shaders/bloom-downsample.wgsl?raw'
import bloomShader from './shaders/bloom.wgsl?raw'
import cloudShader from './shaders/cloud.wgsl?raw'
import fxaaShader from './shaders/fxaa.wgsl?raw'
import landShader from './shaders/land.wgsl?raw'
import lastShader from './shaders/last.wgsl?raw'
import linkComputeShader from './shaders/link.compute.wgsl?raw'
import linkShader from './shaders/link.wgsl?raw'
import particleComputeShader from './shaders/particle.compute.wgsl?raw'
import pointShader from './shaders/point.wgsl?raw'
import waterShader from './shaders/water.wgsl?raw'
import { createPageLifetime } from './page-lifetime.js'

const canvas = document.getElementById('GPUFrame')
const EARTH_RADIUS = 400
const PARTICLE_COUNT = 100
const PARTICLE_WORKGROUP_SIZE = 10
const LINK_NODE_COUNT = 20
const LINK_RADIUS = EARTH_RADIUS - 100
const MAX_CONNECTIONS = PARTICLE_COUNT / 2
const BLOOM_BLUR_LEVELS = 5
const POST_WORKGROUP_SIZE = 16
const PROJECTION_FOV = 45
const FAILURE_RUNTIME_EVIDENCE_MAX_BYTES = 512 * 1024
const STAGE_ORDER = Object.freeze([
    'simulation-indexing',
    'scene',
    'bloom',
    'fxaa',
    'presentation',
])
const proofParameters = new URLSearchParams(window.location.search)
const proofMode = proofParameters.get('proof') === '1'
const FAILURE_SCENARIOS = Object.freeze([
    'after-runtime-created',
    'after-first-image-decoded',
    'invalid-bloom-pipeline-wgsl',
    'after-graph-created',
    'after-initial-submit-issued',
])
const requestedFailureScenario = proofParameters.get('fault')
const failureConfiguration = Object.freeze({
    scenario: proofMode && requestedFailureScenario !== null
        ? requestedFailureScenario
        : undefined,
})

const imageSources = Object.freeze({
    earthDay: new URL('./assets/images/earth.jpg', import.meta.url).href,
    earthNight: new URL('./assets/images/earth-night.jpg', import.meta.url).href,
    earthSpecular: new URL('./assets/images/earth-specular.jpg', import.meta.url).href,
    earthEmission: new URL('./assets/images/earth-selfillumination.jpg', import.meta.url).href,
    landMask: new URL('./assets/images/mask-land.jpg', import.meta.url).href,
    cloudDay: new URL('./assets/images/cloud.jpg', import.meta.url).href,
    cloudNight: new URL('./assets/images/cloud-night.jpg', import.meta.url).href,
    cloudMask: new URL('./assets/images/cloud-alpha.jpg', import.meta.url).href,
})

const pageLifetime = createPageLifetime()
const failureProof = createFailureProofController(failureConfiguration)
let pageFailureSettlement

setStatus('loading')
void main(pageLifetime, failureProof).catch(error => {
    void failPage(error)
})

async function main(lifetime, proof) {

    proof.assertConfiguration()
    assertPresentationShaderContract()

    const runtime = await ScratchRuntime.create({
        label: 'Hello GAW runtime',
        powerPreference: 'high-performance',
        diagnostics: {
            operationCapacity: 256,
            incidentCapacity: 32,
            evidenceByteCapacity: 256 * 1024,
            submissionScopes: 'summary',
            maxPendingNativeObservations: 64,
        },
    })
    proof.ownRuntime(runtime, lifetime)
    proof.reach('after-runtime-created')
    const initialSize = canvasPixelSize(canvas)
    const surface = runtime.createSurface(canvas, {
        label: 'Hello GAW surface',
        format: 'preferred',
        alphaMode: 'opaque',
        size: initialSize,
    })
    proof.observeSurface(surface)
    const graph = await createRenderGraph(runtime, surface, initialSize, proofMode, lifetime, proof)
    proof.reach('after-graph-created')
    const {
        simulationPass,
        scenePass,
        bloomPass,
        fxaaPass,
        outputPass,
        simulationCommands,
        sceneCommands,
        outputCommand,
    } = graph
    let active = true
    let animationFrame
    let animationTimer
    let disposal
    let submittedFrames = 0
    let observedFrames = 0
    let resizeGeneration = 0
    let delta = 0
    let { bloomCommands, fxaaCommand } = createSizeDependentCommands(graph)

    if (!(bloomCommands.length === 17)) {
        throw new Error(`Bloom graph must contain 17 commands, received ${bloomCommands.length}.`)
    }
    if (!(sceneCommands.length === 5)) {
        throw new Error(`Scene graph must contain 5 commands, received ${sceneCommands.length}.`)
    }

    await initializeGraph(runtime, graph, lifetime, proof)
    await Promise.all(graph.imageBitmapOwnerships.map(ownership => ownership.run()))

    const stableIdentityBaseline = stableIdentitySnapshot(graph)
    publishGraphFacts(graph, stableIdentityBaseline, bloomCommands, fxaaCommand, resizeGeneration)

    const handleUncapturedError = event => fail(event.error)
    runtime.device.addEventListener('uncapturederror', handleUncapturedError)
    proof.listenerRegistered()
    lifetime.defer({
        phase: 'stop',
        label: 'uncaptured-error-listener',
        run: () => {
            runtime.device.removeEventListener('uncapturederror', handleUncapturedError)
            proof.listenerRemoved()
        },
    })
    void runtime.device.lost.then((info) => {
        if (active) fail(new Error(`WebGPU device lost: ${info.message || info.reason}.`))
    })

    const handlePageHide = () => {
        void disposePage()
    }
    window.addEventListener('pagehide', handlePageHide, { once: true })
    proof.listenerRegistered()
    lifetime.defer({
        phase: 'stop',
        label: 'pagehide-listener',
        run: () => {
            window.removeEventListener('pagehide', handlePageHide)
            proof.listenerRemoved()
        },
    })

    lifetime.defer({
        phase: 'stop',
        label: 'frame-scheduler',
        run: () => {
            active = false
            if (animationTimer !== undefined) {
                clearTimeout(animationTimer)
                animationTimer = undefined
                proof.frameWorkCancelled()
            }
            if (animationFrame !== undefined) {
                cancelAnimationFrame(animationFrame)
                animationFrame = undefined
                proof.frameWorkCancelled()
            }
        },
    })

    function scheduleFrame() {

        animationTimer = window.setTimeout(() => {
            animationTimer = undefined
            proof.frameWorkCompleted()
            if (!active) return
            animationFrame = requestAnimationFrame(render)
            proof.frameWorkScheduled()
        }, 1000 / 45)
        proof.frameWorkScheduled()
    }

    function disposePage() {

        if (disposal !== undefined) return disposal
        disposal = lifetime.dispose()
        void disposal.then(report => {
            if (report.cleanupFailures.length > 0) {
                reportFatalError(report.cleanupFailures[0].error)
            }
        })
        return disposal
    }

    function fail(error) {

        if (!active) return
        active = false
        void failPage(error)
    }

    async function render() {

        if (animationFrame !== undefined) {
            animationFrame = undefined
            proof.frameWorkCompleted()
        }
        if (!active) return

        try {
            const nextSize = canvasPixelSize(canvas)
            if (!sameSize(surface.size, nextSize)) {
                await resizeRenderGraph(graph, nextSize)
                if (!active) return
                ;({ bloomCommands, fxaaCommand } = createSizeDependentCommands(graph))
                resizeGeneration++
                publishGraphFacts(
                    graph,
                    stableIdentityBaseline,
                    bloomCommands,
                    fxaaCommand,
                    resizeGeneration
                )
            }

            assertStableIdentities(graph, stableIdentityBaseline)
            delta -= 0.001
            updateFrameData(graph, delta)

            const submission = runtime.createSubmission({ validation: 'throw' })
            for (const upload of graph.frameUploads) submission.upload(upload)
            const submitted = submission
                .compute(simulationPass, simulationCommands)
                .render(scenePass, sceneCommands)
                .compute(bloomPass, bloomCommands)
                .compute(fxaaPass, [ fxaaCommand ])
                .render(outputPass, [ outputCommand ])
                .submit()

            submittedFrames++
            const frameNumber = submittedFrames
            const provenance = verifyFrameProvenance(submitted, graph, bloomCommands, fxaaCommand)
            publishFrameFacts(
                runtime,
                submittedFrames,
                observedFrames,
                resizeGeneration,
                provenance
            )

            const observation = observeSubmittedWork(submitted).then(() => {
                observedFrames = Math.max(observedFrames, frameNumber)
                publishFrameFacts(
                    runtime,
                    submittedFrames,
                    observedFrames,
                    resizeGeneration,
                    provenance
                )
                if (active) setStatus('ready')
            })
            void lifetime.track(observation, `frame-submission-${frameNumber}`).catch(fail)
        } catch (error) {
            fail(error)
            return
        }

        if (active) scheduleFrame()
    }

    animationFrame = requestAnimationFrame(render)
    proof.frameWorkScheduled()
}

async function createRenderGraph(runtime, surface, size, deterministic, lifetime, proof) {

    const matrices = createSceneMatrices(size)
    const codecs = createCodecs()
    const uniforms = await createUniformResources(runtime, codecs, matrices)
    const geometry = await createGeometryResources(runtime)
    const particleData = createParticleData(deterministic)
    const particles = await createParticleResources(runtime, particleData)
    const post = await createRenderTextures(runtime, size)
    const images = await createImageResources(runtime, lifetime, proof)
    const samplers = await createSamplers(runtime)
    const layouts = await createBindLayouts(runtime, codecs)
    const bindSets = await createBindSets({
        runtime,
        layouts,
        uniforms,
        geometry,
        particles,
        post,
        images: images.textures,
        samplers,
    })
    const programs = createPrograms(runtime, codecs, proof)
    const pipelines = await createPipelines(runtime, surface, post, layouts, programs, proof)
    const passes = createPasses(runtime, surface, post)
    const commands = createPersistentCommands({
        runtime,
        uniforms,
        geometry,
        particles,
        post,
        images: images.textures,
        bindSets,
        pipelines,
    })
    const gaussianKernel = createGaussianKernel(BLOOM_BLUR_LEVELS)
    const gaussian = await createBufferWithUpload(
        runtime,
        'Hello GAW Gaussian kernel',
        gaussianKernel,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
    )

    bindSets.gaussian = await runtime.createBindSet(layouts.gaussian, {
        gaussianKernel: gaussian.region,
    }, {
        label: 'Hello GAW Gaussian kernel bindings',
    })

    const postBindSets = await createPostBindSets({
        runtime,
        layouts,
        uniforms,
        post,
        gaussian,
        bindSets,
    })
    const postCommands = createPersistentPostCommands({
        runtime,
        uniforms,
        post,
        bindSets,
        postBindSets,
        pipelines,
    })
    const uniformUploads = Object.values(uniforms).flatMap(value => (
        Array.isArray(value) ? value.map(uniform => uniform.upload) : [ value.upload ]
    ))
    const initUploads = [
        ...uniformUploads,
        geometry.index.upload,
        geometry.positions.upload,
        geometry.normals.upload,
        geometry.uvs.upload,
        particles.velocities.upload,
        particles.positions.upload,
        particles.colors.upload,
        particles.linkIndices.upload,
        particles.connectionNums.upload,
        particles.linkIndirect.upload,
        gaussian.upload,
        ...images.uploads,
    ]
    const frameUploads = [
        uniforms.sceneDynamic.upload,
        uniforms.particleDynamic.upload,
        uniforms.linkDynamic.upload,
        particles.connectionNums.upload,
        particles.linkIndirect.upload,
    ]
    const resizableBindSets = [
        postBindSets.highlight,
        ...postBindSets.downsample,
        ...postBindSets.blurX,
        ...postBindSets.blurY,
        postBindSets.combine,
        postBindSets.fxaa,
        bindSets.outputTexture,
    ]

    return {
        runtime,
        surface,
        matrices,
        codecs,
        uniforms,
        geometry,
        particles,
        post,
        layouts,
        bindSets,
        postBindSets,
        programs,
        pipelines,
        gaussian,
        initUploads,
        frameUploads,
        imageBitmaps: images.bitmaps,
        imageBitmapOwnerships: images.ownerships,
        resizableBindSets,
        simulationPass: passes.simulation,
        scenePass: passes.scene,
        bloomPass: passes.bloom,
        fxaaPass: passes.fxaa,
        outputPass: passes.output,
        simulationCommands: commands.simulation,
        sceneCommands: commands.scene,
        outputCommand: postCommands.output,
    }
}

function createCodecs() {

    const uniform = (name, fields) => layoutCodec({ name, fields }, { usage: [ 'uniform' ] })

    return Object.freeze({
        sceneDynamic: uniform('HelloGawSceneDynamic', [
            { name: 'projection', type: 'mat4x4f' },
            { name: 'view', type: 'mat4x4f' },
            { name: 'model', type: 'mat4x4f' },
            { name: 'normal', type: 'mat4x4f' },
            { name: 'delta', type: 'f32' },
        ]),
        earthStatic: uniform('HelloGawEarthStatic', [
            { name: 'radius', type: 'f32' },
            { name: 'alphaTest', type: 'f32' },
            { name: 'opacity', type: 'f32' },
        ]),
        light: uniform('HelloGawLight', [
            { name: 'position', type: 'vec3f' },
            { name: 'color', type: 'vec3f' },
            { name: 'intensity', type: 'f32' },
            { name: 'viewPos', type: 'vec3f' },
        ]),
        material: uniform('HelloGawMaterial', [
            { name: 'ambient', type: 'vec3f' },
            { name: 'diffuse', type: 'vec3f' },
            { name: 'specular', type: 'vec3f' },
            { name: 'shininess', type: 'f32' },
            { name: 'emissive', type: 'f32' },
        ]),
        particleDynamic: uniform('HelloGawParticleDynamic', [
            { name: 'projection', type: 'mat4x4f' },
            { name: 'view', type: 'mat4x4f' },
            { name: 'viewPort', type: 'vec2f' },
        ]),
        particleStatic: uniform('HelloGawParticleStatic', [
            { name: 'size', type: 'f32' },
        ]),
        simulationStatic: uniform('HelloGawSimulationStatic', [
            { name: 'rLink', type: 'f32' },
            { name: 'groupSize', type: 'vec2u' },
            { name: 'angle', type: 'f32' },
        ]),
        linkDynamic: uniform('HelloGawLinkDynamic', [
            { name: 'projection', type: 'mat4x4f' },
            { name: 'view', type: 'mat4x4f' },
            { name: 'minDistance', type: 'f32' },
        ]),
        linkStatic: uniform('HelloGawLinkStatic', [
            { name: 'minDistance', type: 'f32' },
            { name: 'cardinalColor', type: 'vec3f' },
            { name: 'evenColor', type: 'vec3f' },
            { name: 'rLink', type: 'f32' },
            { name: 'maxNodeIndex', type: 'f32' },
        ]),
        indexingStatic: uniform('HelloGawIndexingStatic', [
            { name: 'minDistance', type: 'f32' },
            { name: 'maxConnection', type: 'u32' },
            { name: 'groupSize', type: 'vec2u' },
        ]),
        bloomThreshold: uniform('HelloGawBloomThreshold', [
            { name: 'threshold', type: 'f32' },
        ]),
        bloomSteps: uniform('HelloGawBloomSteps', [
            { name: 'steps', type: 'u32' },
        ]),
        bloomStrength: uniform('HelloGawBloomStrength', [
            { name: 'strength', type: 'f32' },
        ]),
        fxaa: uniform('HelloGawFxaa', [
            { name: 'threshold', type: 'f32' },
            { name: 'searchStep', type: 'i32' },
        ]),
        output: uniform('HelloGawOutput', [
            { name: 'gamma', type: 'f32' },
            { name: 'density', type: 'f32' },
        ]),
    })
}

async function createUniformResources(runtime, codecs, matrices) {

    const lightAngle = utils.degToRad(-23)
    const lightPosition = [ -600 * Math.cos(lightAngle), -600 * Math.sin(lightAngle), 0 ]
    const sceneValues = {
        projection: matrices.projection,
        view: matrices.view,
        model: matrices.model,
        normal: matrices.normal,
        delta: 0,
    }
    const particleValues = {
        projection: matrices.projection,
        view: matrices.view,
        viewPort: [ matrices.size.width, matrices.size.height ],
    }
    const linkValues = {
        projection: matrices.projection,
        view: matrices.view,
        minDistance: LINK_RADIUS * 2,
    }
    const blurSteps = []

    for (let level = 0; level < BLOOM_BLUR_LEVELS; level++) {
        blurSteps.push(await createUniform(runtime, `Hello GAW Bloom steps ${level}`, codecs.bloomSteps, {
            steps: 3 + level * 2,
        }))
    }

    return {
        sceneDynamic: await createUniform(runtime, 'Hello GAW scene dynamic', codecs.sceneDynamic, sceneValues),
        earthOpaque: await createUniform(runtime, 'Hello GAW earth opaque', codecs.earthStatic, {
            radius: EARTH_RADIUS,
            alphaTest: 0.3,
            opacity: 1,
        }),
        cloudStatic: await createUniform(runtime, 'Hello GAW cloud static', codecs.earthStatic, {
            radius: EARTH_RADIUS,
            alphaTest: 0.3,
            opacity: 0.6,
        }),
        light: await createUniform(runtime, 'Hello GAW light', codecs.light, {
            position: lightPosition,
            color: [ 1, 1, 1 ],
            intensity: 6,
            viewPos: [ 0, 0, 1200 ],
        }),
        earthMaterial: await createUniform(runtime, 'Hello GAW earth material', codecs.material, {
            ambient: [ 0.4, 0.4, 0.4 ],
            diffuse: [ 1, 1, 1 ],
            specular: [ 1, 1, 1 ],
            shininess: 16,
            emissive: 1,
        }),
        cloudMaterial: await createUniform(runtime, 'Hello GAW cloud material', codecs.material, {
            ambient: [ 0.8, 0.8, 0.8 ],
            diffuse: [ 1, 1, 1 ],
            specular: [ 1, 1, 1 ],
            shininess: 16,
            emissive: 1,
        }),
        particleDynamic: await createUniform(runtime, 'Hello GAW particle dynamic', codecs.particleDynamic, particleValues),
        particleStatic: await createUniform(runtime, 'Hello GAW particle static', codecs.particleStatic, {
            size: 5,
        }),
        simulationStatic: await createUniform(runtime, 'Hello GAW simulation static', codecs.simulationStatic, {
            rLink: LINK_RADIUS,
            groupSize: [ 1, 1 ],
            angle: 0.01,
        }),
        linkDynamic: await createUniform(runtime, 'Hello GAW link dynamic', codecs.linkDynamic, linkValues),
        linkStatic: await createUniform(runtime, 'Hello GAW link static', codecs.linkStatic, {
            minDistance: LINK_RADIUS * 2,
            cardinalColor: [ 175 / 255, 65 / 255, 5 / 255 ],
            evenColor: [ 80 / 255, 190 / 255, 1 ],
            rLink: LINK_RADIUS,
            maxNodeIndex: LINK_NODE_COUNT - 1,
        }),
        indexingStatic: await createUniform(runtime, 'Hello GAW indexing static', codecs.indexingStatic, {
            minDistance: LINK_RADIUS * 2,
            maxConnection: MAX_CONNECTIONS,
            groupSize: [ 1, 1 ],
        }),
        bloomThreshold: await createUniform(runtime, 'Hello GAW Bloom threshold', codecs.bloomThreshold, {
            threshold: 0,
        }),
        blurSteps,
        bloomStrength: await createUniform(runtime, 'Hello GAW Bloom strength', codecs.bloomStrength, {
            strength: 0.4,
        }),
        fxaa: await createUniform(runtime, 'Hello GAW FXAA settings', codecs.fxaa, {
            threshold: 0.0312,
            searchStep: 10,
        }),
        output: await createUniform(runtime, 'Hello GAW output settings', codecs.output, {
            gamma: 1,
            density: 6,
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
    const upload = runtime.createUploadCommand({
        label: `Upload ${label}`,
        target: region,
        data: bytes,
    })

    return {
        codec,
        bytes,
        buffer,
        region,
        upload,
        write(nextValues) {
            codec.write(bytes, nextValues)
        },
    }
}

async function createGeometryResources(runtime) {

    const generated = sphere(EARTH_RADIUS, 64, 32)

    return {
        indexCount: generated.indices.length,
        index: await createBufferWithUpload(
            runtime,
            'Hello GAW sphere index attributes',
            new Uint32Array(generated.indices),
            GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX
        ),
        positions: await createBufferWithUpload(
            runtime,
            'Hello GAW sphere positions',
            new Float32Array(generated.vertices),
            GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
        ),
        normals: await createBufferWithUpload(
            runtime,
            'Hello GAW sphere normals',
            new Float32Array(generated.normals),
            GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
        ),
        uvs: await createBufferWithUpload(
            runtime,
            'Hello GAW sphere UVs',
            new Float32Array(generated.uvs),
            GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
        ),
    }
}

function createParticleData(deterministic) {

    const random = deterministic ? seededRandom(0x6d2b79f5) : Math.random
    const positions = new Float32Array(PARTICLE_COUNT * 3)
    const velocities = new Float32Array(PARTICLE_COUNT * 3)
    const colors = new Float32Array(PARTICLE_COUNT * 4)
    const palette = [ 250 / 255, 250 / 255, 210 / 250, 1 ]

    for (let index = 0; index < PARTICLE_COUNT; index++) {
        let x = random() * 2 - 1
        let y = random() * 2 - 1
        let z = random() * 2 - 1
        let length = Math.hypot(x, y, z)
        if (length < 0.0001) {
            x = 1
            y = 0
            z = 0
            length = 1
        }
        positions[index * 3] = x / length * LINK_RADIUS
        positions[index * 3 + 1] = y / length * LINK_RADIUS
        positions[index * 3 + 2] = z / length * LINK_RADIUS
        velocities[index * 3] = randomOutsideRadius(random, 0.3)
        velocities[index * 3 + 1] = randomOutsideRadius(random, 0.3)
        velocities[index * 3 + 2] = randomOutsideRadius(random, 0.3)
        colors[index * 4] = palette[0]
        colors[index * 4 + 1] = palette[1]
        colors[index * 4 + 2] = palette[2]
        colors[index * 4 + 3] = palette[3]
    }

    return { positions, velocities, colors }
}

async function createParticleResources(runtime, data) {

    const connectionData = new Uint32Array(PARTICLE_COUNT)
    const linkIndirectData = new Uint32Array([ LINK_NODE_COUNT, 0, 0, 0 ])

    return {
        velocities: await createBufferWithUpload(
            runtime,
            'Hello GAW particle velocities',
            data.velocities,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
        ),
        positions: await createBufferWithUpload(
            runtime,
            'Hello GAW particle positions',
            data.positions,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX
        ),
        colors: await createBufferWithUpload(
            runtime,
            'Hello GAW particle colors',
            data.colors,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX
        ),
        linkIndices: await createBufferWithUpload(
            runtime,
            'Hello GAW link indices',
            new Uint32Array(PARTICLE_COUNT * PARTICLE_COUNT * 2),
            GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
        ),
        connectionNums: await createBufferWithUpload(
            runtime,
            'Hello GAW connection counters',
            connectionData,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
        ),
        linkIndirect: await createBufferWithUpload(
            runtime,
            'Hello GAW link indirect arguments',
            linkIndirectData,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT
        ),
    }
}

async function createBufferWithUpload(runtime, label, data, usage) {

    const buffer = await runtime.createBuffer({
        label,
        size: data.byteLength,
        usage,
    })
    const region = buffer.region()
    const upload = runtime.createUploadCommand({
        label: `Upload ${label}`,
        target: region,
        data,
    })

    return { buffer, region, data, upload }
}

async function createRenderTextures(runtime, size) {

    const sampledStorageUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
    const scene = await runtime.createTexture({
        label: 'Hello GAW scene color',
        size,
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    const depth = await runtime.createTexture({
        label: 'Hello GAW scene depth',
        size,
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    const highlight = await runtime.createTexture({
        label: 'Hello GAW Bloom highlight',
        size,
        format: 'rgba16float',
        usage: sampledStorageUsage,
    })
    const bloomOutput = await runtime.createTexture({
        label: 'Hello GAW Bloom output',
        size,
        format: 'rgba16float',
        usage: sampledStorageUsage,
    })
    const fxaaOutput = await runtime.createTexture({
        label: 'Hello GAW FXAA output',
        size,
        format: 'rgba16float',
        usage: sampledStorageUsage,
    })
    const downsample = []
    const blurX = []
    const blurY = []

    for (let level = 0; level < BLOOM_BLUR_LEVELS; level++) {
        downsample.push(await runtime.createTexture({
            label: `Hello GAW Bloom downsample ${level}`,
            size: scaledSize(size, level + 1),
            format: 'rgba16float',
            usage: sampledStorageUsage,
        }))
        blurX.push(await runtime.createTexture({
            label: `Hello GAW Bloom blur X ${level}`,
            size: scaledSize(size, level),
            format: 'rgba16float',
            usage: sampledStorageUsage,
        }))
        blurY.push(await runtime.createTexture({
            label: `Hello GAW Bloom blur Y ${level}`,
            size: scaledSize(size, level),
            format: 'rgba16float',
            usage: sampledStorageUsage,
        }))
    }

    return {
        scene,
        depth,
        highlight,
        downsample,
        blurX,
        blurY,
        bloomOutput,
        fxaaOutput,
        views: {
            scene: scene.view(),
            depth: depth.view(),
            highlight: highlight.view(),
            downsample: downsample.map(texture => texture.view()),
            blurX: blurX.map(texture => texture.view()),
            blurY: blurY.map(texture => texture.view()),
            bloomOutput: bloomOutput.view(),
            fxaaOutput: fxaaOutput.view(),
        },
    }
}

async function createImageResources(runtime, lifetime, proof) {

    const definitions = Object.entries(imageSources)
    const textures = {}
    const bitmaps = []
    const ownerships = []
    const uploads = []

    for (const [ name, source ] of definitions) {
        const response = await fetch(source)
        if (!response.ok) throw new Error(`Image request failed for ${name}: HTTP ${response.status}.`)
        const bitmap = await createImageBitmap(await response.blob())
        const ownership = proof.ownBitmap(name, bitmap, lifetime)
        bitmaps.push(bitmap)
        ownerships.push(ownership)
        proof.reach('after-first-image-decoded')
        const texture = await runtime.createTexture({
            label: `Hello GAW image ${name}`,
            size: { width: bitmap.width, height: bitmap.height },
            format: 'rgba8unorm',
            usage: GPUTextureUsage.COPY_DST |
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.TEXTURE_BINDING,
        })
        const upload = runtime.createExternalImageUploadCommand({
            label: `Upload Hello GAW image ${name}`,
            source: bitmap,
            flipY: true,
            target: texture,
            colorSpace: 'srgb',
            premultipliedAlpha: false,
            size: { width: bitmap.width, height: bitmap.height },
        })
        textures[name] = texture
        uploads.push(upload)
    }

    return { textures, bitmaps, ownerships, uploads }
}

async function createSamplers(runtime) {

    const linear = await runtime.createSampler({
        label: 'Hello GAW linear repeating sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        addressModeW: 'repeat',
    })

    return { earth: linear, output: linear }
}

async function createBindLayouts(runtime, codecs) {

    const uniformEntry = (binding, name, codec, visibility) => ({
        binding,
        name,
        type: 'uniform',
        visibility,
        minBindingSize: codec.artifact.byteLength,
    })
    const textureEntry = (binding, name, visibility = [ 'fragment' ]) => ({
        binding,
        name,
        type: 'texture',
        sampleType: 'float',
        viewDimension: '2d',
        visibility,
    })
    const storageTextureEntry = (binding, name) => ({
        binding,
        name,
        type: 'storage-texture',
        access: 'write-only',
        format: 'rgba16float',
        viewDimension: '2d',
        visibility: [ 'compute' ],
    })

    return {
        earthUniforms: await runtime.createBindLayout({
            label: 'Hello GAW earth uniform layout',
            group: 0,
            entries: [
                uniformEntry(0, 'dynamicUniform', codecs.sceneDynamic, [ 'vertex', 'fragment' ]),
                uniformEntry(1, 'staticUniform', codecs.earthStatic, [ 'vertex', 'fragment' ]),
                uniformEntry(2, 'light', codecs.light, [ 'fragment' ]),
                uniformEntry(3, 'material', codecs.material, [ 'fragment' ]),
            ],
        }),
        sphereStorage: await runtime.createBindLayout({
            label: 'Hello GAW sphere storage layout',
            group: 1,
            entries: [
                { binding: 0, name: 'vertices', type: 'read-storage', visibility: [ 'vertex' ] },
                { binding: 1, name: 'uvs', type: 'read-storage', visibility: [ 'vertex' ] },
                { binding: 2, name: 'normals', type: 'read-storage', visibility: [ 'vertex' ] },
            ],
        }),
        earthTextures: await runtime.createBindLayout({
            label: 'Hello GAW earth texture layout',
            group: 2,
            entries: [
                { binding: 0, name: 'lsampler', type: 'sampler', samplerType: 'filtering', visibility: [ 'fragment' ] },
                textureEntry(1, 'earthDayDiffuse'),
                textureEntry(2, 'earthNightDiffuse'),
                textureEntry(3, 'earthSpecular'),
                textureEntry(4, 'landMask'),
                textureEntry(5, 'earthEmssion'),
            ],
        }),
        cloudTextures: await runtime.createBindLayout({
            label: 'Hello GAW cloud texture layout',
            group: 2,
            entries: [
                { binding: 0, name: 'lsampler', type: 'sampler', samplerType: 'filtering', visibility: [ 'fragment' ] },
                textureEntry(1, 'cloudDayDiffuse'),
                textureEntry(2, 'cloudNightDiffuse'),
                textureEntry(3, 'cloudMask'),
            ],
        }),
        particleUniforms: await runtime.createBindLayout({
            label: 'Hello GAW particle uniform layout',
            group: 0,
            entries: [
                uniformEntry(0, 'dynamicUniform', codecs.particleDynamic, [ 'vertex' ]),
                uniformEntry(1, 'staticUniform', codecs.particleStatic, [ 'vertex' ]),
            ],
        }),
        simulationUniforms: await runtime.createBindLayout({
            label: 'Hello GAW simulation uniform layout',
            group: 0,
            entries: [ uniformEntry(0, 'staticUniform', codecs.simulationStatic, [ 'compute' ]) ],
        }),
        simulationStorage: await runtime.createBindLayout({
            label: 'Hello GAW simulation storage layout',
            group: 1,
            entries: [
                { binding: 0, name: 'velocities', type: 'read-storage', visibility: [ 'compute' ] },
                { binding: 1, name: 'positions', type: 'storage', visibility: [ 'compute' ] },
            ],
        }),
        linkUniforms: await runtime.createBindLayout({
            label: 'Hello GAW link uniform layout',
            group: 0,
            entries: [
                uniformEntry(0, 'dynamicUniform', codecs.linkDynamic, [ 'vertex' ]),
                uniformEntry(1, 'staticUniform', codecs.linkStatic, [ 'vertex' ]),
            ],
        }),
        linkStorage: await runtime.createBindLayout({
            label: 'Hello GAW link storage layout',
            group: 1,
            entries: [
                { binding: 0, name: 'particlePositions', type: 'read-storage', visibility: [ 'vertex' ] },
                { binding: 1, name: 'linkIndices', type: 'read-storage', visibility: [ 'vertex' ] },
            ],
        }),
        indexingUniforms: await runtime.createBindLayout({
            label: 'Hello GAW indexing uniform layout',
            group: 0,
            entries: [ uniformEntry(0, 'staticUniform', codecs.indexingStatic, [ 'compute' ]) ],
        }),
        indexingStorage: await runtime.createBindLayout({
            label: 'Hello GAW indexing storage layout',
            group: 1,
            entries: [
                { binding: 0, name: 'particlePositions', type: 'read-storage', visibility: [ 'compute' ] },
                { binding: 1, name: 'linkIndices', type: 'storage', visibility: [ 'compute' ] },
                { binding: 2, name: 'connectionNums', type: 'storage', visibility: [ 'compute' ] },
                { binding: 3, name: 'numConnected', type: 'storage', visibility: [ 'compute' ] },
            ],
        }),
        bloomThreshold: await runtime.createBindLayout({
            label: 'Hello GAW Bloom threshold layout',
            group: 0,
            entries: [ uniformEntry(0, 'staticUniform', codecs.bloomThreshold, [ 'compute' ]) ],
        }),
        bloomHighlight: await runtime.createBindLayout({
            label: 'Hello GAW Bloom highlight texture layout',
            group: 1,
            entries: [
                textureEntry(0, 'inTexture', [ 'compute' ]),
                storageTextureEntry(1, 'outTexture'),
            ],
        }),
        downsample: await runtime.createBindLayout({
            label: 'Hello GAW Bloom downsample layout',
            group: 0,
            entries: [
                textureEntry(0, 'srcTexture', [ 'compute' ]),
                storageTextureEntry(1, 'dstTexture'),
            ],
        }),
        bloomSteps: await runtime.createBindLayout({
            label: 'Hello GAW Bloom steps layout',
            group: 0,
            entries: [ uniformEntry(0, 'staticUniform', codecs.bloomSteps, [ 'compute' ]) ],
        }),
        gaussian: await runtime.createBindLayout({
            label: 'Hello GAW Gaussian layout',
            group: 1,
            entries: [
                { binding: 0, name: 'gaussianKernel', type: 'read-storage', visibility: [ 'compute' ] },
            ],
        }),
        blurX: await runtime.createBindLayout({
            label: 'Hello GAW Bloom blur X layout',
            group: 2,
            entries: [
                textureEntry(0, 'srcTexture', [ 'compute' ]),
                storageTextureEntry(1, 'dstTexture'),
            ],
        }),
        blurY: await runtime.createBindLayout({
            label: 'Hello GAW Bloom blur Y layout',
            group: 2,
            entries: [
                textureEntry(0, 'highlightTexture', [ 'compute' ]),
                textureEntry(1, 'srcTexture', [ 'compute' ]),
                storageTextureEntry(2, 'dstTexture'),
            ],
        }),
        bloomStrength: await runtime.createBindLayout({
            label: 'Hello GAW Bloom strength layout',
            group: 0,
            entries: [ uniformEntry(0, 'staticUniform', codecs.bloomStrength, [ 'compute' ]) ],
        }),
        bloomCombine: await runtime.createBindLayout({
            label: 'Hello GAW Bloom combine layout',
            group: 1,
            entries: [
                textureEntry(0, 'sceneTexture', [ 'compute' ]),
                textureEntry(1, 'blurTexture', [ 'compute' ]),
                storageTextureEntry(2, 'dstTexture'),
            ],
        }),
        fxaaUniforms: await runtime.createBindLayout({
            label: 'Hello GAW FXAA uniform layout',
            group: 0,
            entries: [ uniformEntry(0, 'staticUniform', codecs.fxaa, [ 'compute' ]) ],
        }),
        fxaaTextures: await runtime.createBindLayout({
            label: 'Hello GAW FXAA texture layout',
            group: 1,
            entries: [
                textureEntry(0, 'srcTexture', [ 'compute' ]),
                storageTextureEntry(1, 'dstTexture'),
            ],
        }),
        outputUniforms: await runtime.createBindLayout({
            label: 'Hello GAW output uniform layout',
            group: 0,
            entries: [ uniformEntry(0, 'staticUniform', codecs.output, [ 'fragment' ]) ],
        }),
        outputTexture: await runtime.createBindLayout({
            label: 'Hello GAW output texture layout',
            group: 1,
            entries: [
                { binding: 0, name: 'lsampler', type: 'sampler', samplerType: 'filtering', visibility: [ 'fragment' ] },
                textureEntry(1, 'sceneTexture'),
            ],
        }),
    }
}

async function createBindSets({ runtime, layouts, uniforms, geometry, particles, post, images, samplers }) {

    return {
        earthUniforms: await runtime.createBindSet(layouts.earthUniforms, {
            dynamicUniform: uniforms.sceneDynamic.region,
            staticUniform: uniforms.earthOpaque.region,
            light: uniforms.light.region,
            material: uniforms.earthMaterial.region,
        }, { label: 'Hello GAW earth uniform bindings' }),
        cloudUniforms: await runtime.createBindSet(layouts.earthUniforms, {
            dynamicUniform: uniforms.sceneDynamic.region,
            staticUniform: uniforms.cloudStatic.region,
            light: uniforms.light.region,
            material: uniforms.cloudMaterial.region,
        }, { label: 'Hello GAW cloud uniform bindings' }),
        sphereStorage: await runtime.createBindSet(layouts.sphereStorage, {
            vertices: geometry.positions.region,
            uvs: geometry.uvs.region,
            normals: geometry.normals.region,
        }, { label: 'Hello GAW sphere storage bindings' }),
        earthTextures: await runtime.createBindSet(layouts.earthTextures, {
            lsampler: samplers.earth,
            earthDayDiffuse: images.earthDay.view(),
            earthNightDiffuse: images.earthNight.view(),
            earthSpecular: images.earthSpecular.view(),
            landMask: images.landMask.view(),
            earthEmssion: images.earthEmission.view(),
        }, { label: 'Hello GAW earth texture bindings' }),
        cloudTextures: await runtime.createBindSet(layouts.cloudTextures, {
            lsampler: samplers.earth,
            cloudDayDiffuse: images.cloudDay.view(),
            cloudNightDiffuse: images.cloudNight.view(),
            cloudMask: images.cloudMask.view(),
        }, { label: 'Hello GAW cloud texture bindings' }),
        particleUniforms: await runtime.createBindSet(layouts.particleUniforms, {
            dynamicUniform: uniforms.particleDynamic.region,
            staticUniform: uniforms.particleStatic.region,
        }, { label: 'Hello GAW particle uniform bindings' }),
        simulationUniforms: await runtime.createBindSet(layouts.simulationUniforms, {
            staticUniform: uniforms.simulationStatic.region,
        }, { label: 'Hello GAW simulation uniform bindings' }),
        simulationStorage: await runtime.createBindSet(layouts.simulationStorage, {
            velocities: particles.velocities.region,
            positions: particles.positions.region,
        }, { label: 'Hello GAW simulation storage bindings' }),
        linkUniforms: await runtime.createBindSet(layouts.linkUniforms, {
            dynamicUniform: uniforms.linkDynamic.region,
            staticUniform: uniforms.linkStatic.region,
        }, { label: 'Hello GAW link uniform bindings' }),
        linkStorage: await runtime.createBindSet(layouts.linkStorage, {
            particlePositions: particles.positions.region,
            linkIndices: particles.linkIndices.region,
        }, { label: 'Hello GAW link storage bindings' }),
        indexingUniforms: await runtime.createBindSet(layouts.indexingUniforms, {
            staticUniform: uniforms.indexingStatic.region,
        }, { label: 'Hello GAW indexing uniform bindings' }),
        indexingStorage: await runtime.createBindSet(layouts.indexingStorage, {
            particlePositions: particles.positions.region,
            linkIndices: particles.linkIndices.region,
            connectionNums: particles.connectionNums.region,
            numConnected: particles.linkIndirect.region,
        }, { label: 'Hello GAW indexing storage bindings' }),
        bloomThreshold: await runtime.createBindSet(layouts.bloomThreshold, {
            staticUniform: uniforms.bloomThreshold.region,
        }, { label: 'Hello GAW Bloom threshold bindings' }),
        bloomStrength: await runtime.createBindSet(layouts.bloomStrength, {
            staticUniform: uniforms.bloomStrength.region,
        }, { label: 'Hello GAW Bloom strength bindings' }),
        fxaaUniforms: await runtime.createBindSet(layouts.fxaaUniforms, {
            staticUniform: uniforms.fxaa.region,
        }, { label: 'Hello GAW FXAA uniform bindings' }),
        outputUniforms: await runtime.createBindSet(layouts.outputUniforms, {
            staticUniform: uniforms.output.region,
        }, { label: 'Hello GAW output uniform bindings' }),
        outputTexture: await runtime.createBindSet(layouts.outputTexture, {
            lsampler: samplers.output,
            sceneTexture: post.views.fxaaOutput,
        }, { label: 'Hello GAW output texture bindings' }),
    }
}

function createPrograms(runtime, codecs, proof) {

    const requirement = (group, binding, type, codec) => ({
        group,
        binding,
        type,
        hasDynamicOffset: false,
        layout: codec.artifact,
    })
    const earthRequirements = [
        requirement(0, 0, 'uniform', codecs.sceneDynamic),
        requirement(0, 1, 'uniform', codecs.earthStatic),
        requirement(0, 2, 'uniform', codecs.light),
        requirement(0, 3, 'uniform', codecs.material),
    ]

    return {
        land: runtime.createProgram({
            label: 'Hello GAW land program',
            modules: [ landShader ],
            entryPoints: { vertex: 'vMain', fragment: 'fMain' },
            layoutRequirements: earthRequirements,
        }),
        water: runtime.createProgram({
            label: 'Hello GAW water program',
            modules: [ waterShader ],
            entryPoints: { vertex: 'vMain', fragment: 'fMain' },
            layoutRequirements: earthRequirements,
        }),
        cloud: runtime.createProgram({
            label: 'Hello GAW cloud program',
            modules: [ cloudShader ],
            entryPoints: { vertex: 'vMain', fragment: 'fMain' },
            layoutRequirements: earthRequirements,
        }),
        particle: runtime.createProgram({
            label: 'Hello GAW particle program',
            modules: [ pointShader ],
            entryPoints: { vertex: 'vMain', fragment: 'fMain' },
            layoutRequirements: [
                requirement(0, 0, 'uniform', codecs.particleDynamic),
                requirement(0, 1, 'uniform', codecs.particleStatic),
            ],
        }),
        link: runtime.createProgram({
            label: 'Hello GAW link program',
            modules: [ linkShader ],
            entryPoints: { vertex: 'vMain', fragment: 'fMain' },
            layoutRequirements: [
                requirement(0, 0, 'uniform', codecs.linkDynamic),
                requirement(0, 1, 'uniform', codecs.linkStatic),
            ],
        }),
        simulation: runtime.createProgram({
            label: 'Hello GAW simulation program',
            modules: [ particleComputeShader ],
            entryPoints: { compute: 'cMain' },
            layoutRequirements: [ requirement(0, 0, 'uniform', codecs.simulationStatic) ],
        }),
        indexing: runtime.createProgram({
            label: 'Hello GAW indexing program',
            modules: [ linkComputeShader ],
            entryPoints: { compute: 'cMain' },
            layoutRequirements: [ requirement(0, 0, 'uniform', codecs.indexingStatic) ],
        }),
        bloomHighlight: runtime.createProgram({
            label: 'Hello GAW Bloom highlight program',
            modules: [ bloomShader ],
            entryPoints: { compute: 'cMain' },
            layoutRequirements: [ requirement(0, 0, 'uniform', codecs.bloomThreshold) ],
        }),
        bloomDownsample: runtime.createProgram({
            label: 'Hello GAW Bloom downsample program',
            modules: [ bloomDownsampleShader ],
            entryPoints: { compute: 'cMain' },
        }),
        bloomBlurX: runtime.createProgram({
            label: 'Hello GAW Bloom blur X program',
            modules: [ bloomBlurXShader ],
            entryPoints: { compute: 'cMain' },
            layoutRequirements: [ requirement(0, 0, 'uniform', codecs.bloomSteps) ],
        }),
        bloomBlurY: runtime.createProgram({
            label: 'Hello GAW Bloom blur Y program',
            modules: [ bloomBlurYShader ],
            entryPoints: { compute: 'cMain' },
            layoutRequirements: [ requirement(0, 0, 'uniform', codecs.bloomSteps) ],
        }),
        bloomCombine: runtime.createProgram({
            label: 'Hello GAW Bloom combine program',
            modules: [ proof.bloomCombineShader(bloomCombineShader) ],
            entryPoints: { compute: 'cMain' },
            layoutRequirements: [ requirement(0, 0, 'uniform', codecs.bloomStrength) ],
        }),
        fxaa: runtime.createProgram({
            label: 'Hello GAW FXAA program',
            modules: [ fxaaShader ],
            entryPoints: { compute: 'cMain' },
            layoutRequirements: [ requirement(0, 0, 'uniform', codecs.fxaa) ],
        }),
        output: runtime.createProgram({
            label: 'Hello GAW output program',
            modules: [ lastShader ],
            entryPoints: { vertex: 'vMain', fragment: 'fMain' },
            layoutRequirements: [ requirement(0, 0, 'uniform', codecs.output) ],
        }),
    }
}

async function createPipelines(runtime, surface, post, layouts, programs, proof) {

    const normalBlend = {
        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    }
    const additiveBlend = {
        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one' },
        alpha: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one' },
    }
    const depthWrite = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
    const depthRead = { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' }
    const sphereVertexBuffers = [ {
        arrayStride: 4,
        stepMode: 'vertex',
        attributes: [ { shaderLocation: 0, offset: 0, format: 'uint32' } ],
    } ]
    const particleVertexBuffers = [
        {
            arrayStride: 12,
            stepMode: 'instance',
            attributes: [ { shaderLocation: 0, offset: 0, format: 'float32x3' } ],
        },
        {
            arrayStride: 16,
            stepMode: 'instance',
            attributes: [ { shaderLocation: 1, offset: 0, format: 'float32x4' } ],
        },
    ]
    const compute = async (label, program, bindLayouts) => {
        if (label === 'Hello GAW Bloom combine pipeline') {
            proof.beforeBloomCombinePipeline(runtime)
        }
        return await runtime.createComputePipeline({
            label,
            program,
            bindLayouts,
            constants: { blockSize: label.includes('simulation') || label.includes('indexing')
                ? PARTICLE_WORKGROUP_SIZE
                : POST_WORKGROUP_SIZE },
        })
    }

    return {
        land: await runtime.createRenderPipeline({
            label: 'Hello GAW land pipeline',
            program: programs.land,
            bindLayouts: [ layouts.earthUniforms, layouts.sphereStorage, layouts.earthTextures ],
            vertexBuffers: sphereVertexBuffers,
            targets: [ { format: post.scene.format, blend: normalBlend } ],
            depthStencil: depthWrite,
        }),
        water: await runtime.createRenderPipeline({
            label: 'Hello GAW water pipeline',
            program: programs.water,
            bindLayouts: [ layouts.earthUniforms, layouts.sphereStorage, layouts.earthTextures ],
            vertexBuffers: sphereVertexBuffers,
            targets: [ { format: post.scene.format, blend: normalBlend } ],
            depthStencil: depthWrite,
        }),
        cloud: await runtime.createRenderPipeline({
            label: 'Hello GAW cloud pipeline',
            program: programs.cloud,
            bindLayouts: [ layouts.earthUniforms, layouts.sphereStorage, layouts.cloudTextures ],
            vertexBuffers: sphereVertexBuffers,
            targets: [ { format: post.scene.format, blend: additiveBlend } ],
            depthStencil: depthWrite,
        }),
        particle: await runtime.createRenderPipeline({
            label: 'Hello GAW particle pipeline',
            program: programs.particle,
            bindLayouts: [ layouts.particleUniforms ],
            vertexBuffers: particleVertexBuffers,
            targets: [ { format: post.scene.format, blend: normalBlend } ],
            primitive: { topology: 'triangle-strip' },
            depthStencil: depthRead,
        }),
        link: await runtime.createRenderPipeline({
            label: 'Hello GAW link pipeline',
            program: programs.link,
            bindLayouts: [ layouts.linkUniforms, layouts.linkStorage ],
            targets: [ { format: post.scene.format } ],
            primitive: { topology: 'line-strip' },
            depthStencil: depthRead,
        }),
        simulation: await compute(
            'Hello GAW simulation pipeline',
            programs.simulation,
            [ layouts.simulationUniforms, layouts.simulationStorage ]
        ),
        indexing: await compute(
            'Hello GAW indexing pipeline',
            programs.indexing,
            [ layouts.indexingUniforms, layouts.indexingStorage ]
        ),
        bloomHighlight: await compute(
            'Hello GAW Bloom highlight pipeline',
            programs.bloomHighlight,
            [ layouts.bloomThreshold, layouts.bloomHighlight ]
        ),
        bloomDownsample: await compute(
            'Hello GAW Bloom downsample pipeline',
            programs.bloomDownsample,
            [ layouts.downsample ]
        ),
        bloomBlurX: await compute(
            'Hello GAW Bloom blur X pipeline',
            programs.bloomBlurX,
            [ layouts.bloomSteps, layouts.gaussian, layouts.blurX ]
        ),
        bloomBlurY: await compute(
            'Hello GAW Bloom blur Y pipeline',
            programs.bloomBlurY,
            [ layouts.bloomSteps, layouts.gaussian, layouts.blurY ]
        ),
        bloomCombine: await compute(
            'Hello GAW Bloom combine pipeline',
            programs.bloomCombine,
            [ layouts.bloomStrength, layouts.bloomCombine ]
        ),
        fxaa: await compute(
            'Hello GAW FXAA pipeline',
            programs.fxaa,
            [ layouts.fxaaUniforms, layouts.fxaaTextures ]
        ),
        output: await runtime.createRenderPipeline({
            label: 'Hello GAW output pipeline',
            program: programs.output,
            bindLayouts: [ layouts.outputUniforms, layouts.outputTexture ],
            targets: [ { format: surface.format } ],
            primitive: { topology: 'triangle-strip' },
        }),
    }
}

function createPasses(runtime, surface, post) {

    return {
        simulation: runtime.createComputePass({ label: 'Hello GAW simulation and indexing stage' }),
        scene: runtime.createRenderPass({
            label: 'Hello GAW scene stage',
            color: [ {
                target: post.views.scene,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            } ],
            depth: {
                target: post.views.depth,
                depthLoad: 'clear',
                depthStore: 'store',
                depthClear: 1,
            },
        }),
        bloom: runtime.createComputePass({ label: 'Hello GAW Bloom stage' }),
        fxaa: runtime.createComputePass({ label: 'Hello GAW FXAA stage' }),
        output: runtime.createRenderPass({
            label: 'Hello GAW presentation stage',
            color: [ {
                target: surface,
                load: 'clear',
                store: 'store',
                clear: [ 0, 0, 0, 1 ],
            } ],
        }),
    }
}

function createPersistentCommands({ runtime, uniforms, geometry, particles, images, bindSets, pipelines }) {

    const simulation = runtime.createDispatchCommand({
        label: 'Simulate Hello GAW particles',
        pipeline: pipelines.simulation,
        bindSets: [ { set: bindSets.simulationUniforms }, { set: bindSets.simulationStorage } ],
        count: { workgroups: [ 1, 1 ] },
        resources: {
            read: currentReads([
                uniforms.simulationStatic.buffer,
                particles.velocities.buffer,
                particles.positions.buffer,
            ]),
            write: [ particles.positions.buffer ],
        },
        whenMissing: 'throw',
    })
    const indexing = runtime.createDispatchCommand({
        label: 'Index Hello GAW links',
        pipeline: pipelines.indexing,
        bindSets: [ { set: bindSets.indexingUniforms }, { set: bindSets.indexingStorage } ],
        count: { workgroups: [ 1, 1 ] },
        resources: {
            read: currentReads([
                uniforms.indexingStatic.buffer,
                particles.positions.buffer,
                particles.linkIndices.buffer,
                particles.connectionNums.buffer,
                particles.linkIndirect.buffer,
            ]),
            write: [
                particles.linkIndices.buffer,
                particles.connectionNums.buffer,
                particles.linkIndirect.buffer,
            ],
        },
        whenMissing: 'throw',
    })
    const earthReads = [
        uniforms.sceneDynamic.buffer,
        uniforms.earthOpaque.buffer,
        uniforms.light.buffer,
        uniforms.earthMaterial.buffer,
        geometry.index.buffer,
        geometry.positions.buffer,
        geometry.uvs.buffer,
        geometry.normals.buffer,
        images.earthDay,
        images.earthNight,
        images.earthSpecular,
        images.landMask,
        images.earthEmission,
    ]
    const sphereVertices = [ { slot: 0, region: geometry.index.region } ]
    const land = runtime.createDrawCommand({
        label: 'Draw Hello GAW land',
        pipeline: pipelines.land,
        bindSets: [
            { set: bindSets.earthUniforms },
            { set: bindSets.sphereStorage },
            { set: bindSets.earthTextures },
        ],
        vertexBuffers: sphereVertices,
        count: { vertexCount: geometry.indexCount },
        resources: { read: currentReads(earthReads), write: [] },
        whenMissing: 'throw',
    })
    const linkIndirectRegion = particles.linkIndirect.region
    const links = runtime.createDrawCommand({
        label: 'Draw Hello GAW links indirectly',
        pipeline: pipelines.link,
        bindSets: [ { set: bindSets.linkUniforms }, { set: bindSets.linkStorage } ],
        count: { indirect: linkIndirectRegion },
        resources: {
            read: currentReads([
                uniforms.linkDynamic.buffer,
                uniforms.linkStatic.buffer,
                particles.positions.buffer,
                particles.linkIndices.buffer,
                particles.linkIndirect.buffer,
            ]),
            write: [],
        },
        whenMissing: 'throw',
    })
    const particle = runtime.createDrawCommand({
        label: 'Draw Hello GAW particles',
        pipeline: pipelines.particle,
        bindSets: [ { set: bindSets.particleUniforms } ],
        vertexBuffers: [
            { slot: 0, region: particles.positions.region },
            { slot: 1, region: particles.colors.region },
        ],
        count: { vertexCount: 4, instanceCount: PARTICLE_COUNT },
        resources: {
            read: currentReads([
                uniforms.particleDynamic.buffer,
                uniforms.particleStatic.buffer,
                particles.positions.buffer,
                particles.colors.buffer,
            ]),
            write: [],
        },
        whenMissing: 'throw',
    })
    const water = runtime.createDrawCommand({
        label: 'Draw Hello GAW water',
        pipeline: pipelines.water,
        bindSets: [
            { set: bindSets.earthUniforms },
            { set: bindSets.sphereStorage },
            { set: bindSets.earthTextures },
        ],
        vertexBuffers: sphereVertices,
        count: { vertexCount: geometry.indexCount },
        resources: { read: currentReads(earthReads), write: [] },
        whenMissing: 'throw',
    })
    const cloud = runtime.createDrawCommand({
        label: 'Draw Hello GAW cloud',
        pipeline: pipelines.cloud,
        bindSets: [
            { set: bindSets.cloudUniforms },
            { set: bindSets.sphereStorage },
            { set: bindSets.cloudTextures },
        ],
        vertexBuffers: sphereVertices,
        count: { vertexCount: geometry.indexCount },
        resources: {
            read: currentReads([
                uniforms.sceneDynamic.buffer,
                uniforms.cloudStatic.buffer,
                uniforms.light.buffer,
                uniforms.cloudMaterial.buffer,
                geometry.index.buffer,
                geometry.positions.buffer,
                geometry.uvs.buffer,
                geometry.normals.buffer,
                images.cloudDay,
                images.cloudNight,
                images.cloudMask,
            ]),
            write: [],
        },
        whenMissing: 'throw',
    })

    return {
        simulation: [ simulation, indexing ],
        scene: [ land, links, particle, water, cloud ],
    }
}

async function createPostBindSets({ runtime, layouts, uniforms, post, bindSets }) {

    const highlight = await runtime.createBindSet(layouts.bloomHighlight, {
        inTexture: post.views.scene,
        outTexture: post.views.highlight,
    }, { label: 'Hello GAW Bloom highlight textures' })
    const downsample = []
    const blurX = []
    const blurY = []

    for (let level = 0; level < BLOOM_BLUR_LEVELS; level++) {
        const downsampleSource = level === 0 ? post.views.highlight : post.views.downsample[level - 1]
        const hierarchyInput = level === 0 ? post.views.highlight : post.views.downsample[level - 1]
        const blurXSource = level === BLOOM_BLUR_LEVELS - 1
            ? post.views.downsample[level]
            : post.views.blurY[level + 1]

        downsample.push(await runtime.createBindSet(layouts.downsample, {
            srcTexture: downsampleSource,
            dstTexture: post.views.downsample[level],
        }, { label: `Hello GAW Bloom downsample textures ${level}` }))
        blurX.push(await runtime.createBindSet(layouts.blurX, {
            srcTexture: blurXSource,
            dstTexture: post.views.blurX[level],
        }, { label: `Hello GAW Bloom blur X textures ${level}` }))
        blurY.push(await runtime.createBindSet(layouts.blurY, {
            highlightTexture: hierarchyInput,
            srcTexture: post.views.blurX[level],
            dstTexture: post.views.blurY[level],
        }, { label: `Hello GAW Bloom blur Y textures ${level}` }))
    }

    const steps = []
    for (let level = 0; level < BLOOM_BLUR_LEVELS; level++) {
        steps.push(await runtime.createBindSet(layouts.bloomSteps, {
            staticUniform: uniforms.blurSteps[level].region,
        }, { label: `Hello GAW Bloom steps bindings ${level}` }))
    }

    return {
        highlight,
        downsample,
        blurX,
        blurY,
        steps,
        combine: await runtime.createBindSet(layouts.bloomCombine, {
            sceneTexture: post.views.scene,
            blurTexture: post.views.blurY[0],
            dstTexture: post.views.bloomOutput,
        }, { label: 'Hello GAW Bloom combine textures' }),
        fxaa: await runtime.createBindSet(layouts.fxaaTextures, {
            srcTexture: post.views.bloomOutput,
            dstTexture: post.views.fxaaOutput,
        }, { label: 'Hello GAW FXAA textures' }),
        threshold: bindSets.bloomThreshold,
        strength: bindSets.bloomStrength,
        fxaaUniforms: bindSets.fxaaUniforms,
    }
}

function createPersistentPostCommands({ runtime, uniforms, post, bindSets, pipelines }) {

    return {
        output: runtime.createDrawCommand({
            label: 'Present Hello GAW',
            pipeline: pipelines.output,
            bindSets: [ { set: bindSets.outputUniforms }, { set: bindSets.outputTexture } ],
            count: { vertexCount: 4 },
            resources: {
                read: currentReads([ uniforms.output.buffer, post.fxaaOutput ]),
                write: [],
            },
            whenMissing: 'throw',
        }),
    }
}

function createSizeDependentCommands(graph) {

    const { runtime, uniforms, post, postBindSets, bindSets, pipelines, gaussian } = graph
    const bloomCommands = []
    const workgroups = texture => ({
        workgroups: [
            Math.ceil(texture.size.width / POST_WORKGROUP_SIZE),
            Math.ceil(texture.size.height / POST_WORKGROUP_SIZE),
        ],
    })

    bloomCommands.push(runtime.createDispatchCommand({
        label: 'Extract Hello GAW Bloom highlights',
        pipeline: pipelines.bloomHighlight,
        bindSets: [ { set: bindSets.bloomThreshold }, { set: postBindSets.highlight } ],
        count: workgroups(post.highlight),
        resources: {
            read: currentReads([ uniforms.bloomThreshold.buffer, post.scene ]),
            write: [ post.highlight ],
        },
        whenMissing: 'throw',
    }))

    for (let level = 0; level < BLOOM_BLUR_LEVELS; level++) {
        const source = level === 0 ? post.highlight : post.downsample[level - 1]
        bloomCommands.push(runtime.createDispatchCommand({
            label: `Downsample Hello GAW Bloom level ${level}`,
            pipeline: pipelines.bloomDownsample,
            bindSets: [ { set: postBindSets.downsample[level] } ],
            count: workgroups(post.downsample[level]),
            resources: {
                read: currentReads([ source ]),
                write: [ post.downsample[level] ],
            },
            whenMissing: 'throw',
        }))
    }

    for (let level = BLOOM_BLUR_LEVELS - 1; level >= 0; level--) {
        const hierarchyInput = level === 0 ? post.highlight : post.downsample[level - 1]
        const blurXSource = level === BLOOM_BLUR_LEVELS - 1
            ? post.downsample[level]
            : post.blurY[level + 1]

        bloomCommands.push(runtime.createDispatchCommand({
            label: `Blur Hello GAW Bloom X level ${level}`,
            pipeline: pipelines.bloomBlurX,
            bindSets: [
                { set: postBindSets.steps[level] },
                { set: bindSets.gaussian },
                { set: postBindSets.blurX[level] },
            ],
            count: workgroups(post.blurX[level]),
            resources: {
                read: currentReads([
                    uniforms.blurSteps[level].buffer,
                    gaussian.buffer,
                    blurXSource,
                ]),
                write: [ post.blurX[level] ],
            },
            whenMissing: 'throw',
        }))
        bloomCommands.push(runtime.createDispatchCommand({
            label: `Blur Hello GAW Bloom Y level ${level}`,
            pipeline: pipelines.bloomBlurY,
            bindSets: [
                { set: postBindSets.steps[level] },
                { set: bindSets.gaussian },
                { set: postBindSets.blurY[level] },
            ],
            count: workgroups(post.blurY[level]),
            resources: {
                read: currentReads([
                    uniforms.blurSteps[level].buffer,
                    gaussian.buffer,
                    hierarchyInput,
                    post.blurX[level],
                ]),
                write: [ post.blurY[level] ],
            },
            whenMissing: 'throw',
        }))
    }

    bloomCommands.push(runtime.createDispatchCommand({
        label: 'Combine Hello GAW Bloom',
        pipeline: pipelines.bloomCombine,
        bindSets: [ { set: bindSets.bloomStrength }, { set: postBindSets.combine } ],
        count: workgroups(post.bloomOutput),
        resources: {
            read: currentReads([ uniforms.bloomStrength.buffer, post.scene, post.blurY[0] ]),
            write: [ post.bloomOutput ],
        },
        whenMissing: 'throw',
    }))

    const fxaaCommand = runtime.createDispatchCommand({
        label: 'Apply Hello GAW FXAA',
        pipeline: pipelines.fxaa,
        bindSets: [ { set: bindSets.fxaaUniforms }, { set: postBindSets.fxaa } ],
        count: workgroups(post.fxaaOutput),
        resources: {
            read: currentReads([ uniforms.fxaa.buffer, post.bloomOutput ]),
            write: [ post.fxaaOutput ],
        },
        whenMissing: 'throw',
    })

    return { bloomCommands, fxaaCommand }
}

async function initializeGraph(runtime, graph, lifetime, proof) {

    const builder = runtime.createSubmission({ validation: 'throw' })
    for (const upload of graph.initUploads) builder.upload(upload)
    const submitted = builder.submit()
    const observation = lifetime.track(
        observeSubmittedWork(submitted),
        'initial-submission'
    )
    proof.reach('after-initial-submit-issued')
    await observation
}

function updateFrameData(graph, delta) {

    const { matrices, uniforms, particles } = graph
    uniforms.sceneDynamic.write({
        projection: matrices.projection,
        view: matrices.view,
        model: matrices.model,
        normal: matrices.normal,
        delta,
    })
    uniforms.particleDynamic.write({
        projection: matrices.projection,
        view: matrices.view,
        viewPort: [ matrices.size.width, matrices.size.height ],
    })
    uniforms.linkDynamic.write({
        projection: matrices.projection,
        view: matrices.view,
        minDistance: LINK_RADIUS * 2,
    })
    particles.connectionNums.data.fill(0)
    particles.linkIndirect.data[0] = LINK_NODE_COUNT
    particles.linkIndirect.data[1] = 0
    particles.linkIndirect.data[2] = 0
    particles.linkIndirect.data[3] = 0
}

async function resizeRenderGraph(graph, size) {

    graph.surface.resize(size)
    const resizeTargets = [
        [ graph.post.scene, size ],
        [ graph.post.depth, size ],
        [ graph.post.highlight, size ],
        [ graph.post.bloomOutput, size ],
        [ graph.post.fxaaOutput, size ],
    ]
    for (let level = 0; level < BLOOM_BLUR_LEVELS; level++) {
        resizeTargets.push([ graph.post.downsample[level], scaledSize(size, level + 1) ])
        resizeTargets.push([ graph.post.blurX[level], scaledSize(size, level) ])
        resizeTargets.push([ graph.post.blurY[level], scaledSize(size, level) ])
    }
    for (const [ texture, nextSize ] of resizeTargets) {
        await texture.resize(nextSize)
    }

    graph.matrices.size = { width: size.width, height: size.height }
    graph.matrices.projection = Array.from(mat4.perspective(
        PROJECTION_FOV,
        size.width / size.height,
        1,
        4000
    ))
    await prepareStaleBindSets(graph.resizableBindSets)
}

async function prepareStaleBindSets(bindSets) {

    for (const bindSet of bindSets) {
        if (bindSet.preparationState === 'stale') await bindSet.prepare()
    }
}

function verifyFrameProvenance(submitted, graph, bloomCommands, fxaaCommand) {

    const pairs = [
        {
            name: 'dynamic-upload-to-land',
            resource: graph.uniforms.sceneDynamic.buffer,
            producerCommandId: graph.uniforms.sceneDynamic.upload.id,
            consumerCommandId: graph.sceneCommands[0].id,
        },
        {
            name: 'simulation-to-particle-draw',
            resource: graph.particles.positions.buffer,
            producerCommandId: graph.simulationCommands[0].id,
            consumerCommandId: graph.sceneCommands[2].id,
        },
        {
            name: 'indexing-to-indirect-draw',
            resource: graph.particles.linkIndirect.buffer,
            producerCommandId: graph.simulationCommands[1].id,
            consumerCommandId: graph.sceneCommands[1].id,
        },
        {
            name: 'scene-to-bloom',
            resource: graph.post.scene,
            producerPassId: graph.scenePass.id,
            consumerCommandId: bloomCommands[0].id,
        },
        {
            name: 'bloom-to-fxaa',
            resource: graph.post.bloomOutput,
            producerCommandId: bloomCommands[bloomCommands.length - 1].id,
            consumerCommandId: fxaaCommand.id,
        },
        {
            name: 'fxaa-to-presentation',
            resource: graph.post.fxaaOutput,
            producerCommandId: fxaaCommand.id,
            consumerCommandId: graph.outputCommand.id,
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
        const exact = producer !== undefined &&
            read !== undefined &&
            read.declaredContentEpoch === 'current-at-step' &&
            read.contentEpochBefore === producer.contentEpoch &&
            read.contentEpochAfter === producer.contentEpoch

        if (!exact) throw new Error(`Submission provenance mismatch for ${pair.name}.`)

        return {
            name: pair.name,
            resourceId: pair.resource.id,
            declaredContentEpoch: read.declaredContentEpoch,
            producerContentEpoch: producer.contentEpoch,
            readContentEpoch: read.contentEpochBefore,
        }
    })
}

function stableIdentitySnapshot(graph) {

    const objects = [
        ...Object.values(graph.programs),
        ...Object.values(graph.pipelines),
        ...Object.values(graph.bindSets).filter(value => value && typeof value.id === 'string'),
        ...Object.values(graph.postBindSets).flatMap(value => Array.isArray(value) ? value : [ value ]),
        graph.simulationPass,
        graph.scenePass,
        graph.bloomPass,
        graph.fxaaPass,
        graph.outputPass,
        ...graph.simulationCommands,
        ...graph.sceneCommands,
        graph.outputCommand,
        ...graph.frameUploads,
    ]

    return [ ...new Set(objects.map(object => object.id)) ].sort()
}

function assertStableIdentities(graph, baseline) {

    const current = stableIdentitySnapshot(graph)
    if (current.length !== baseline.length || current.some((id, index) => id !== baseline[index])) {
        throw new Error('Persistent Hello GAW graph identity changed between resizes.')
    }
}

function publishGraphFacts(graph, baseline, bloomCommands, fxaaCommand, resizeGeneration) {

    canvas.dataset.stageOrder = STAGE_ORDER.join('|')
    canvas.dataset.stageCount = String(STAGE_ORDER.length)
    canvas.dataset.proofMode = String(proofMode)
    canvas.dataset.seed = proofMode ? '0x6d2b79f5' : 'random'
    canvas.dataset.fixedTimestep = String(proofMode)
    canvas.dataset.stableIdentityCount = String(baseline.length)
    canvas.dataset.stableIdentityHash = hashStrings(baseline)
    canvas.dataset.sizeDependentIdentityHash = hashStrings([
        ...bloomCommands.map(command => command.id),
        fxaaCommand.id,
    ])
    canvas.dataset.bloomCommandCount = String(bloomCommands.length)
    canvas.dataset.sceneCommandCount = String(graph.sceneCommands.length)
    canvas.dataset.resizeGeneration = String(resizeGeneration)
    canvas.dataset.indirectGpuOnly = 'true'
}

function publishFrameFacts(runtime, submittedFrames, observedFrames, resizeGeneration, provenance) {

    const diagnostics = runtime.diagnostics.snapshot()
    const bounded = diagnostics.recorder.retainedOperationCount <= diagnostics.recorder.operationCapacity &&
        diagnostics.recorder.retainedIncidentCount <= diagnostics.recorder.incidentCapacity &&
        diagnostics.recorder.retainedEvidenceBytes <= diagnostics.recorder.evidenceByteCapacity

    canvas.dataset.frames = String(submittedFrames)
    canvas.dataset.observedFrames = String(observedFrames)
    canvas.dataset.resizeGeneration = String(resizeGeneration)
    canvas.dataset.producerReadMatch = 'true'
    canvas.dataset.provenance = JSON.stringify(provenance)
    canvas.dataset.diagnosticsBounded = String(bounded)
    canvas.dataset.diagnosticOperationCapacity = String(diagnostics.recorder.operationCapacity)
    canvas.dataset.diagnosticIncidentCapacity = String(diagnostics.recorder.incidentCapacity)
    canvas.dataset.diagnosticEvidenceByteCapacity = String(diagnostics.recorder.evidenceByteCapacity)
    canvas.dataset.diagnosticOperations = String(diagnostics.recorder.retainedOperationCount)
    canvas.dataset.diagnosticIncidents = String(diagnostics.recorder.retainedIncidentCount)
    canvas.dataset.diagnosticEvidenceBytes = String(diagnostics.recorder.retainedEvidenceBytes)
    canvas.dataset.uncapturedErrors = String(diagnostics.aggregates.uncapturedErrors)
    canvas.dataset.deviceLosses = String(diagnostics.aggregates.deviceLosses)
}

async function observeSubmittedWork(submitted) {

    const [ nativeOutcome ] = await Promise.all([
        submitted.nativeOutcome,
        submitted.done,
    ])
    if (nativeOutcome.status !== 'observed-succeeded') {
        throw new Error(`Submission native outcome was ${nativeOutcome.status}.`)
    }
}

function createSceneMatrices(size) {

    const modelMatrix = mat4.rotationX(utils.degToRad(32))

    return {
        size: { width: size.width, height: size.height },
        view: Array.from(mat4.lookAt([ 0, 0, 1200 ], [ 0, 0, 0 ], [ 0, 1, 0 ])),
        projection: Array.from(mat4.perspective(
            PROJECTION_FOV,
            size.width / size.height,
            1,
            4000
        )),
        model: Array.from(modelMatrix),
        normal: Array.from(mat4.transpose(mat4.inverse(modelMatrix))),
    }
}

function createGaussianKernel(levels) {

    const length = 4 + (levels - 1) * 2
    const sigma = (3 + (levels - 1) * 2) / 2
    const values = new Float32Array(length)
    for (let index = 0; index < length; index++) {
        values[index] = Math.exp(-(index * index) / (2 * sigma * sigma)) /
            (sigma * Math.sqrt(2 * Math.PI))
    }
    return values
}

function currentReads(resources) {

    const unique = new Map(resources.map(resource => [ resource.id, resource ]))
    return [ ...unique.values() ].map(resource => ({
        resource,
        contentEpoch: 'current-at-step',
    }))
}

function canvasPixelSize(target) {

    const ratio = window.devicePixelRatio || 1
    return {
        width: Math.max(1, Math.floor(target.clientWidth * ratio)),
        height: Math.max(1, Math.floor(target.clientHeight * ratio)),
    }
}

function scaledSize(size, level) {

    const divisor = 2 ** level
    return {
        width: Math.max(1, Math.floor(size.width / divisor)),
        height: Math.max(1, Math.floor(size.height / divisor)),
    }
}

function sameSize(left, right) {

    return left.width === right.width && left.height === right.height
}

function seededRandom(seed) {

    let state = seed >>> 0
    return () => {
        state += 0x6d2b79f5
        let value = state
        value = Math.imul(value ^ value >>> 15, value | 1)
        value ^= value + Math.imul(value ^ value >>> 7, value | 61)
        return ((value ^ value >>> 14) >>> 0) / 4294967296
    }
}

function randomOutsideRadius(random, radius) {

    let value = 0
    while (Math.abs(value) < radius) value = random() * 2 - 1
    return value
}

function hashStrings(values) {

    let hash = 2166136261
    for (const value of values.join('|')) {
        hash ^= value.charCodeAt(0)
        hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
}

function assertPresentationShaderContract() {

    for (const functionName of [ 'toneMapACES', 'gammaCorrect' ]) {
        if (!lastShader.includes(`fn ${functionName}`)) {
            throw new Error(`Presentation shader is missing ${functionName}.`)
        }
    }
}

function createFailureProofController(configuration) {

    let runtime
    let surface
    let capture
    let captureReport
    let runtimeEvidence
    let runtimeEvidenceByteLength
    let evidenceFailure
    let reachedCount = 0
    let runtimeDisposeAttempts = 0
    let runtimeDisposed = false
    let bitmapCreatedCount = 0
    let bitmapCloseAttemptCount = 0
    let bitmapClosedCount = 0
    let bitmapDuplicateCloseCount = 0
    let listenerRegisteredCount = 0
    let listenerRemovedCount = 0
    let frameWorkScheduledCount = 0
    let frameWorkCompletedCount = 0
    let frameWorkCancelledCount = 0
    let listenersBeforeCleanup = 0
    let frameWorkBeforeCleanup = 0

    function assertConfiguration() {

        if (
            configuration.scenario !== undefined &&
            !FAILURE_SCENARIOS.includes(configuration.scenario)
        ) {
            throw new Error(`Unsupported Hello GAW failure scenario: ${configuration.scenario}.`)
        }
    }

    function ownRuntime(value, lifetime) {

        runtime = value
        lifetime.defer({
            phase: 'release',
            label: 'runtime',
            run: () => {
                runtimeDisposeAttempts += 1
                try {
                    value.dispose()
                } finally {
                    runtimeDisposed = value.isDisposed === true
                }
            },
        })
    }

    function observeSurface(value) {

        surface = value
    }

    function ownBitmap(name, bitmap, lifetime) {

        bitmapCreatedCount += 1
        let closed = false
        return lifetime.defer({
            phase: 'release',
            label: `image-bitmap:${name}`,
            run: () => {
                bitmapCloseAttemptCount += 1
                if (closed) {
                    bitmapDuplicateCloseCount += 1
                    return
                }
                closed = true
                bitmap.close()
                bitmapClosedCount += 1
            },
        })
    }

    function reach(scenario) {

        if (configuration.scenario !== scenario) return
        reachedCount += 1
        const error = new Error(`Injected Hello GAW initialization failure: ${scenario}.`)
        error.name = 'HelloGawInjectedFailure'
        error.code = 'HELLO_GAW_INJECTED_FAILURE'
        error.scenario = scenario
        throw error
    }

    function bloomCombineShader(source) {

        if (configuration.scenario !== 'invalid-bloom-pipeline-wgsl') return source
        return `${source}\n@compute fn helloGawInjectedFailure( {`
    }

    function beforeBloomCombinePipeline(value) {

        if (configuration.scenario !== 'invalid-bloom-pipeline-wgsl') return
        reachedCount += 1
        capture = value.diagnostics.capture({
            maxOperations: 1,
            maxDurationMs: 2_000,
            maxEvidenceBytes: 64 * 1024,
            includeStacks: true,
            includeDescriptors: true,
        })
    }

    function captureBeforeDisposal() {

        listenersBeforeCleanup = listenerRegisteredCount - listenerRemovedCount
        frameWorkBeforeCleanup = frameWorkScheduledCount -
            frameWorkCompletedCount - frameWorkCancelledCount
        try {
            if (capture !== undefined) captureReport = capture.stop()
            if (runtime !== undefined) {
                runtimeEvidence = runtime.diagnostics.exportEvidence()
                runtimeEvidenceByteLength = new TextEncoder()
                    .encode(JSON.stringify(runtimeEvidence)).byteLength
                if (runtimeEvidenceByteLength > FAILURE_RUNTIME_EVIDENCE_MAX_BYTES) {
                    throw new Error(
                        `Hello GAW runtime evidence exceeded ${FAILURE_RUNTIME_EVIDENCE_MAX_BYTES} bytes.`
                    )
                }
            }
        } catch (error) {
            evidenceFailure = error
        }
    }

    function finalize(primaryFailure, cleanupReport) {

        const scenario = configuration.scenario
        const runtimeWasCreated = runtime !== undefined
        const surfaceWasCreated = surface !== undefined
        runtimeDisposed = runtimeDisposed || runtime?.isDisposed === true
        const surfaceDisposed = surface?.isDisposed === true
        const diagnostic = primaryFailure && typeof primaryFailure === 'object'
            ? primaryFailure.diagnostic
            : undefined
        const incident = primaryFailure && typeof primaryFailure === 'object'
            ? primaryFailure.incident
            : undefined
        const cleanup = {
            runtime: {
                created: runtimeWasCreated,
                disposeAttempts: runtimeDisposeAttempts,
                disposed: runtimeDisposed,
            },
            surface: {
                created: surfaceWasCreated,
                disposed: surfaceDisposed,
            },
            bitmaps: {
                created: bitmapCreatedCount,
                closeAttempts: bitmapCloseAttemptCount,
                closed: bitmapClosedCount,
                duplicateCloseAttempts: bitmapDuplicateCloseCount,
            },
            pendingObservations: {
                before: cleanupReport.pendingObservationsBefore,
                after: cleanupReport.pendingObservationsAfter,
            },
            listeners: {
                registered: listenerRegisteredCount,
                removed: listenerRemovedCount,
                activeBefore: listenersBeforeCleanup,
                activeAfter: listenerRegisteredCount - listenerRemovedCount,
            },
            frameWork: {
                scheduled: frameWorkScheduledCount,
                completed: frameWorkCompletedCount,
                cancelled: frameWorkCancelledCount,
                activeBefore: frameWorkBeforeCleanup,
                activeAfter: frameWorkScheduledCount -
                    frameWorkCompletedCount - frameWorkCancelledCount,
            },
            invocationCount: cleanupReport.cleanupInvocationCount,
            actionCount: cleanupReport.cleanupActions.length,
            retainedActionCount: cleanupReport.retainedActionCount,
            failures: cleanupReport.cleanupFailures.map(({ phase, label, error }) => ({
                phase,
                label,
                error: serializeFailure(error),
            })),
        }

        runtime = undefined
        surface = undefined
        capture = undefined

        if (scenario === undefined) return undefined

        return frozenJson({
            schemaVersion: 1,
            scenario,
            reachedCount,
            primaryFailure: serializeFailure(primaryFailure),
            ...(diagnostic !== undefined ? { diagnostic } : {}),
            ...(incident !== undefined ? { incident } : {}),
            runtimeEvidence,
            runtimeEvidenceByteLength,
            runtimeEvidenceMaxBytes: FAILURE_RUNTIME_EVIDENCE_MAX_BYTES,
            ...(captureReport !== undefined ? { captureReport } : {}),
            ...(evidenceFailure !== undefined
                ? { evidenceFailure: serializeFailure(evidenceFailure) }
                : {}),
            cleanup,
        })
    }

    return Object.freeze({
        assertConfiguration,
        ownRuntime,
        observeSurface,
        ownBitmap,
        reach,
        bloomCombineShader,
        beforeBloomCombinePipeline,
        captureBeforeDisposal,
        finalize,
        listenerRegistered: () => { listenerRegisteredCount += 1 },
        listenerRemoved: () => { listenerRemovedCount += 1 },
        frameWorkScheduled: () => { frameWorkScheduledCount += 1 },
        frameWorkCompleted: () => { frameWorkCompletedCount += 1 },
        frameWorkCancelled: () => { frameWorkCancelledCount += 1 },
    })
}

function serializeFailure(error) {

    if (!(error instanceof Error)) {
        return { name: 'NonErrorFailure', message: String(error) }
    }

    return {
        name: error.name,
        message: error.message,
        ...(typeof error.code === 'string' ? { code: error.code } : {}),
        ...(typeof error.scenario === 'string' ? { scenario: error.scenario } : {}),
        ...(error.diagnostic?.code !== undefined
            ? { diagnosticCode: error.diagnostic.code }
            : {}),
        ...(typeof error.stack === 'string' ? { stack: error.stack.slice(0, 8 * 1024) } : {}),
    }
}

function frozenJson(value) {

    return deepFreeze(JSON.parse(JSON.stringify(value)))
}

function deepFreeze(value) {

    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) deepFreeze(child)
    return Object.freeze(value)
}

function failPage(error) {

    if (pageFailureSettlement !== undefined) return pageFailureSettlement
    reportFatalError(error)
    failureProof.captureBeforeDisposal()
    pageFailureSettlement = pageLifetime.dispose(error).then(cleanupReport => {
        const proof = failureProof.finalize(error, cleanupReport)
        if (proof !== undefined) {
            window.__HELLO_GAW_INIT_FAILURE_PROOF__ = proof
            canvas.dataset.initFailureProof = JSON.stringify(proof)
            canvas.dataset.failureScenario = proof.scenario
        }
        if (proof === undefined && cleanupReport.cleanupFailures.length > 0) {
            console.error(cleanupReport.cleanupFailures[0].error)
        }
    }).catch(cleanupFailure => {
        console.error(cleanupFailure)
    })
    return pageFailureSettlement
}

function setStatus(status) {

    canvas.dataset.status = status
    document.body.dataset.status = status
}

function reportFatalError(error) {

    const diagnostic = error && typeof error === 'object' && 'diagnostic' in error
        ? error.diagnostic
        : undefined
    const message = error instanceof Error ? error.message : String(error)
    setStatus('error')
    canvas.dataset.error = message
    if (diagnostic !== undefined) canvas.dataset.diagnostic = JSON.stringify(diagnostic)
    console.error(error)
}
