import * as scr from '../../src/index.js'
import { Delaunay } from 'd3-delaunay'
import arrowShader from './shaders/flow/arrow.wgsl?raw'
import flowLayerShader from './shaders/flow/flowLayer.wgsl?raw'
import flowShowShader from './shaders/flow/flowShow.wgsl?raw'
import flowVoronoiShader from './shaders/flow/flowVoronoi.wgsl?raw'
import particlesShader from './shaders/flow/particles.wgsl?raw'
import simulationShader from './shaders/flow/simulation.compute.wgsl?raw'
import swapShader from './shaders/flow/swap.wgsl?raw'

function inlineShader(name, code) {

    return scr.shader({ name, codeFunc: () => code })
}

async function fetchArrayBuffer(url) {

    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`)
    }
    return response.arrayBuffer()
}

const resourceUrl = [
    '/json/examples/flow/uv_0.bin',
    '/json/examples/flow/uv_1.bin',
    '/json/examples/flow/uv_2.bin',
    '/json/examples/flow/uv_3.bin',
    '/json/examples/flow/uv_4.bin',
    '/json/examples/flow/uv_5.bin',
    '/json/examples/flow/uv_6.bin',
    '/json/examples/flow/uv_7.bin',
    '/json/examples/flow/uv_8.bin',
    '/json/examples/flow/uv_9.bin',
    '/json/examples/flow/uv_10.bin',
    '/json/examples/flow/uv_11.bin',
    '/json/examples/flow/uv_12.bin',
    '/json/examples/flow/uv_13.bin',
    '/json/examples/flow/uv_14.bin',
    '/json/examples/flow/uv_15.bin',
    '/json/examples/flow/uv_16.bin',
    '/json/examples/flow/uv_17.bin',
    '/json/examples/flow/uv_18.bin',
    '/json/examples/flow/uv_19.bin',
    '/json/examples/flow/uv_20.bin',
    '/json/examples/flow/uv_21.bin',
    '/json/examples/flow/uv_22.bin',
    '/json/examples/flow/uv_23.bin',
    '/json/examples/flow/uv_24.bin',
    '/json/examples/flow/uv_25.bin',
    '/json/examples/flow/uv_26.bin',
]

export default class SteadyFlowLayer {

    constructor(options = {}) {

        // Layer
        this.type = 'custom'
        this.map = undefined
        this.id = 'FlowLayer'
        this.renderingMode = '3d'

        // Attributes
        this.preheat = 0
        this.swapPointer = 0
        this.extent = scr.boundingBox2D()
        this.randomSeed = scr.f32(Math.random())

        // Resource worker
        this.loadWorker = undefined
        this.cameraInvalidationHandlers = []

        // Control
        this.progress = 0.0
        this.framesPerPhase = 300
        this.maxSpeed = scr.f32()
        this.currentResourceUrl = 0
        this.maxParticleNum = 262144
        this.progressRate = scr.f32()
        this.particleNum = scr.u32(262144)
        this.trailDecay = scr.f32(options.trailDecay ?? 0.996)
        this.trailCutoff = scr.f32(options.trailCutoff ?? 1 / 255)
        this.useFlowMask = options.useFlowMask ?? true
        this.useFlowMaskValue = scr.f32(this.useFlowMask ? 1 : 0)
        this.flowMaskCutoff = scr.f32(options.flowMaskCutoff ?? 0.0)
        this.flowDomainMaxEdge = options.flowDomainMaxEdge ?? 0.04
        this.clearOnMove = options.clearOnMove ?? true
        this.historyMode = options.historyMode ?? (options.clearOnMove === false ? 'off' : 'reproject')
        this.historyModeValue = scr.f32(historyModeToValue(this.historyMode))
        this.historyValid = scr.f32(0)
        this.historyReprojecting = scr.f32(0)
        this.hasHistoryCameraState = false
        this.maxHistoryReprojectCenterDelta = options.maxHistoryReprojectCenterDelta ?? 0.25
        this.previousHistoryMatrix = scr.mat4f()
        this.currentHistoryMatrix = scr.mat4f()
        this.currentHistoryInverseMatrix = scr.mat4f()
        this.previousHistoryCenterHigh = scr.vec3f()
        this.previousHistoryCenterLow = scr.vec3f()
        this.currentHistoryCenterHigh = scr.vec3f()
        this.currentHistoryCenterLow = scr.vec3f()
        this.previousHistoryViewport = scr.vec2f()
        this.currentHistoryViewport = scr.vec2f()

        // Compute
        this.blockSizeX = 16
        this.blockSizeY = 16
        this.groupSizeX = Math.ceil(Math.sqrt(this.maxParticleNum) / this.blockSizeX)
        this.groupSizeY = Math.ceil(Math.sqrt(this.maxParticleNum) / this.blockSizeY)
        this.randomFillData = new Float32Array(this.maxParticleNum * 6).map((_, index) => {
            if (index % 6 == 4 || index % 6 == 5) return 0.
            else return Math.random()
        })

        // Buffer-related resource
        this.toRef = undefined
        this.fromRef = undefined
        this.nextRef = undefined
        this.triangleVertexIndices = undefined
        this.voronoiVertexCount = 0
        this.uniformBuffer_frame = undefined
        this.vertexBuffer_voronoi = undefined
        this.uniformBuffer_static = undefined
        this.storageBuffer_particle = undefined
        this.particleRef = scr.aRef(this.randomFillData)

        // Texture-related resource
        this.flowTexture = undefined
        this.flowMaskTexture = undefined
        this.layerTexture1 = undefined
        this.layerTexture2 = undefined

        // Binding
        this.showBinding = undefined
        this.layerBindings = undefined
        this.voronoiBinding = undefined
        this.particleBinding = undefined
        this.voronoiToBinding = undefined
        this.simulationBinding = undefined
        this.trajectoryBindings = undefined

        // Pipeline
        this.showPipeline = undefined
        this.layerPipeline = undefined
        this.voronoiPipeline = undefined
        this.particlePipeline = undefined
        this.trajectoryPipeline = undefined
        this.simulationPipeline = undefined

        // Pass
        this.swapPasses = undefined
        this.voronoiPass = undefined
        this.simulationPass = undefined

        // Flag
        this.isHided = false
        this.isIdling = false
        this.showArrow = false
        this.showVoronoi = options.showVoronoi ?? true
        this.nextPrepared = false
        this.isInitialized = false
        this.nextPreparing = false
    }

    async onAdd(map, gl) {

        this.map = map

        this.addWorker(new Worker(new URL( './flowJson.worker.js', import.meta.url ), { type: 'module' }))

        this.extent.reset(120.0437360613468201, 31.1739019522094871, 121.9662324011692220, 32.0840108580467813)
        // this.extent.reset(120.04485952099877, 31.757211235652274, 121.00010037560567, 32.08267764177068)

        // Buffer-related resource
        this.storageBuffer_particle = scr.storageBuffer({
            name: 'Storage Buffer (Particle Position & Velocity)',
            resource: { arrayRef: this.particleRef }
        })
        this.uniformBuffer_static = scr.uniformBuffer({
            name: 'Uniform Buffer (Flow Layer Static)',
            blocks: [
                scr.bRef(
                    {
                        name: 'staticUniform',
                        map: {
                            groupSize: scr.asVec2u(this.groupSizeX, this.groupSizeY),
                            extent: this.extent.boundary,
                        }
                    },)
            ]
        })
        this.uniformBuffer_frame = scr.uniformBuffer({
            name: 'Uniform Buffer (Flow Layer Frame)',
            blocks: [
                scr.bRef({
                    name: 'frameUniform',
                    dynamic: true,
                    map: {
                        randomSeed: this.randomSeed,
                        viewPort: this.map.screen.sizeF,
                        mapBounds: this.map.cameraBounds.boundary,
                        zoomLevel: this.map.zoom,
                        progressRate: this.progressRate,
                        maxSpeed: this.maxSpeed,
                        flowMaskCutoff: this.flowMaskCutoff,
                    }
                })
            ]
        })

        // Texture-related resource
        this.layerTexture1 = this.map.screen.createScreenDependentTexture('Texture (Background 1)')
        this.layerTexture2 = this.map.screen.createScreenDependentTexture('Texture (Background 2)')
        this.flowTexture = this.map.screen.createScreenDependentTexture('Texture (Velocity)', 'rg32float')
        this.flowMaskTexture = this.map.screen.createScreenDependentTexture('Texture (Flow Mask)', 'r8unorm')

        // PASS - 1: flow textures (mix(from -> to)) generation ////////////////////////////////////////////////
        await this.getVoronoi('/json/examples/flow/station.bin')
        await this.addVoronoiBindingSync('/json/examples/flow/uv_0.bin'); this.swapVoronoiBinding()
        await this.addVoronoiBindingSync('/json/examples/flow/uv_1.bin'); this.swapVoronoiBinding()
        this.currentResourceUrl = 1
        this.nextPrepared = true

        this.voronoiPipeline = scr.renderPipeline({
            name: 'Render Pipeline (Voronoi Flow)',
            shader: { module: inlineShader('Shader (Flow Voronoi)', flowVoronoiShader) },
        })
        this.voronoiPass = scr.renderPass({
            name: 'Render Pass (Voronoi Flow From)',
            colorAttachments: [ { colorResource: this.flowTexture }, { colorResource: this.flowMaskTexture } ],
            depthStencilAttachment: { depthStencilResource: this.map.depthTexture }
        }).add(this.voronoiPipeline, this.voronoiBinding)

        // PASS - 2: particle position simulation ////////////////////////////////////////////////
        this.simulationBinding = scr.binding({
            name: 'Binding (Particle Simulation)',
            range: () => [ this.groupSizeX, this.groupSizeY ],
            textures: [ { texture: this.flowTexture, sampleType: 'unfilterable-float' }, { texture: this.flowMaskTexture } ],
            storages: [ { buffer: this.storageBuffer_particle, writable: true } ],
            uniforms: [
                {
                    name: 'controllerUniform',
                    map: {
                        particleNum: scr.asU32(this.maxParticleNum),
                        dropRate: scr.asF32(0.003),
                        dropRateBump: scr.asF32(0.001),
                        speedFactor: scr.asF32(1.0),
                        useFlowMask: this.useFlowMaskValue,
                    }
                }
            ],
            sharedUniforms: [
                { buffer: this.uniformBuffer_frame },
                { buffer: this.uniformBuffer_static },
                { buffer: this.map.dynamicUniformBuffer },
            ],
        })
        this.simulationPipeline = scr.computePipeline({
            name: 'Compute Pipeline (Flow Simulation)',
            shader: { module: inlineShader('Shader (Particle Simulation)', simulationShader) },
            constants: { blockSize: 16 },
        })
        this.simulationPass = scr.computePass({
            name: 'Compute Pass (Particle Simulation)',
        }).add(this.simulationPipeline, this.simulationBinding)

        // PASS - 3: flow trajectory rendering (particle past trajectory + particle current position) ////////////////////////////////////////////////
        // SubPass - 1: past trajectory rendering
        this.trajectoryBindings = [
            scr.binding({
                name: 'Binding (Background Swap 1)',
                range: () => [ 4 ],
                uniforms: [
                    {
                        name: 'cleanupUniform',
                        dynamic: true,
                        map: {
                            trailDecay: this.trailDecay,
                            trailCutoff: this.trailCutoff,
                            useFlowMask: this.useFlowMaskValue,
                            historyMode: this.historyModeValue,
                            historyValid: this.historyValid,
                            historyReprojecting: this.historyReprojecting,
                            previousMatrix: this.previousHistoryMatrix,
                            currentMatrix: this.currentHistoryMatrix,
                            currentInverseMatrix: this.currentHistoryInverseMatrix,
                            previousCenterHigh: this.previousHistoryCenterHigh,
                            previousCenterLow: this.previousHistoryCenterLow,
                            currentCenterHigh: this.currentHistoryCenterHigh,
                            currentCenterLow: this.currentHistoryCenterLow,
                            previousViewport: this.previousHistoryViewport,
                            currentViewport: this.currentHistoryViewport,
                        }
                    }
                ],
                textures: [ { texture: this.layerTexture2 }, { texture: this.flowMaskTexture } ]
            }),
            scr.binding({
                name: 'Binding (Background Swap 2)',
                range: () => [ 4 ],
                uniforms: [
                    {
                        name: 'cleanupUniform',
                        dynamic: true,
                        map: {
                            trailDecay: this.trailDecay,
                            trailCutoff: this.trailCutoff,
                            useFlowMask: this.useFlowMaskValue,
                            historyMode: this.historyModeValue,
                            historyValid: this.historyValid,
                            historyReprojecting: this.historyReprojecting,
                            previousMatrix: this.previousHistoryMatrix,
                            currentMatrix: this.currentHistoryMatrix,
                            currentInverseMatrix: this.currentHistoryInverseMatrix,
                            previousCenterHigh: this.previousHistoryCenterHigh,
                            previousCenterLow: this.previousHistoryCenterLow,
                            currentCenterHigh: this.currentHistoryCenterHigh,
                            currentCenterLow: this.currentHistoryCenterLow,
                            previousViewport: this.previousHistoryViewport,
                            currentViewport: this.currentHistoryViewport,
                        }
                    }
                ],
                textures: [ { texture: this.layerTexture1 }, { texture: this.flowMaskTexture } ]
            }),
        ]
        this.trajectoryPipeline = scr.renderPipeline({
            name: 'Rendej pipeline (Background Swap)', 
            shader: { module: inlineShader('Shader (Background Swap)', swapShader) },
            primitive: { topology: 'triangle-strip' },
            depthTest: false
        })
        // SubPass - 2: current position rendering
        this.particleBinding = scr.binding({
            name: 'Binding (Particles)',
            range: () => [ 2, this.particleNum.n ],
            storages: [ { buffer: this.storageBuffer_particle } ],
            sharedUniforms: [
                { buffer: this.uniformBuffer_frame },
                { buffer: this.uniformBuffer_static },
                { buffer: this.map.dynamicUniformBuffer },
            ],
        })
        this.particlePipeline = scr.renderPipeline({
            name: 'Render Pipeline (Particles)',
            shader: { module: inlineShader('Shader (Particles)', particlesShader) },
            primitive: { topology: 'line-list' },
        })
        this.swapPasses = [

            scr.renderPass({
                name: 'Render Pass (Trajectory Empty)',
                colorAttachments: [ 
                    { colorResource: this.layerTexture1 },
                    { colorResource: this.layerTexture2 }
                ],
            }) /* Pass 3.3* Trajectory Clear */,

            scr.renderPass({
                name: 'Render Pass (Past Trajectory 1)',
                colorAttachments: [ { colorResource: this.layerTexture1 } ],
                depthStencilAttachment: { depthStencilResource: this.map.depthTexture }
            })
            /* Pass 3.1 */.add(this.trajectoryPipeline, this.trajectoryBindings[0])
            /* Pass 3.2 */.add(this.particlePipeline, this.particleBinding),

            scr.renderPass({
                name: 'Render Pass (Past Trajectory 2)',
                colorAttachments: [ { colorResource: this.layerTexture2 } ],
                depthStencilAttachment: { depthStencilResource: this.map.depthTexture }
            })
            /* Pass 3.1 */.add(this.trajectoryPipeline, this.trajectoryBindings[1])
            /* Pass 3.2 */.add(this.particlePipeline, this.particleBinding),
        ]

        // PASS - 4: flow layer rendering ////////////////////////////////////////////////
        this.layerBindings = [
            scr.binding({
                name: 'Binding (Layer Renderig 1)',
                range: () => [ 4 ],
                textures: [ { texture: this.layerTexture1 } ],
            }),
            scr.binding({
                name: 'Binding (Layer Renderig 2)',
                range: () => [ 4 ],
                textures: [ { texture: this.layerTexture2 } ],
            })
        ]
        this.layerPipeline = scr.renderPipeline({
            name: 'Render Pipeline (Layer Rendering)',
            shader: { module: inlineShader('Shader (Flow Layer Rendering)', flowLayerShader) },
            primitive: { topology: 'triangle-strip' },
            colorTargetStates: [ { blend: scr.NormalBlending } ],
        })

        // PASS - 5*: flow texture showing
        this.showBinding = scr.binding({
            name: 'Binding (Flow Show)',
            range: () => [ 4 ],
            textures: [ { texture: this.flowTexture, sampleType: 'unfilterable-float' } ],
            sharedUniforms: [ { buffer: this.uniformBuffer_frame } ]
        })
        this.showPipeline = scr.renderPipeline({
            name: 'Render Pipeline (Flow Show)',
            shader: { module: inlineShader('Shader (Flow Show)', flowShowShader) },
            primitive: { topology: 'triangle-strip' },
            colorTargetStates: [ { blend: scr.NormalBlending } ],
        })
        this.arrowPipeline = scr.renderPipeline({
            name: 'Render Pipeline (Flow Arrow)',
            shader: { module: inlineShader('Shader (Flow Show)', arrowShader) },
            primitive: { topology: 'triangle-strip' },
            colorTargetStates: [ { blend: scr.NormalBlending } ],
        })

        // Execution configuration
        this.swapPasses[1].executable = true
        this.swapPasses[2].executable = false
        this.swapPasses[0].executable = false
        this.layerBindings[0].executable = true
        this.layerBindings[1].executable = false

        // Add to map
        // this.showArrow && this.map.add2RenderPass(this.arrowPipeline, this.particleBinding)
        this.showVoronoi && this.map.add2RenderPass(this.showPipeline, this.showBinding)
        .add2RenderPass(this.layerPipeline, this.layerBindings[0])
        .add2RenderPass(this.layerPipeline, this.layerBindings[1])
        this.map.add2PreProcess(this.voronoiPass)
        .add2PreProcess(this.simulationPass)
        .add2PreProcess(this.swapPasses[0])
        .add2PreProcess(this.swapPasses[1])
        .add2PreProcess(this.swapPasses[2])

        this.registerCameraInvalidation()

        this.isInitialized = true
    }

    async render(gl, matrix) {

        // Ask map to repaint
        this.map.triggerRepaint()

        // No render condition
        if (!this.isInitialized || this.isIdling || this.preheat-- > 0) return
        if (this.isHided) { this.makeVisibility(false); return } else { this.makeVisibility(true) }

        this.updateHistoryCameraState()

        // Swap
        this.showBinding.executable = false

        // this.swapPasses[0].executable = true
        // this.swapPasses[1].executable = false
        this.swapPasses[1].executable = this.swapPointer
        this.swapPasses[2].executable = 1 - this.swapPointer
        this.layerBindings[0].executable = this.swapPointer
        this.layerBindings[1].executable = 1 - this.swapPointer

        // Update
        this.updateVoronoi()
        this.randomSeed.n = Math.random()
        this.swapPointer = (this.swapPointer + 1) % 2
    }

    onRemove() {

        this.unregisterCameraInvalidation()

        if (this.isInitialized) this.makeVisibility(false)

        if (this.loadWorker) {

            this.loadWorker.terminate()
            this.loadWorker = undefined
        }

        this.isInitialized = false
        this.map = undefined
    }

    updateHistoryCameraState() {

        if (!this.map) return

        const hadHistory = this.hasHistoryCameraState
        const previousViewport = [ this.currentHistoryViewport.x, this.currentHistoryViewport.y ]
        const previousCenter = [
            this.currentHistoryCenterHigh.x + this.currentHistoryCenterLow.x,
            this.currentHistoryCenterHigh.y + this.currentHistoryCenterLow.y,
        ]

        this.previousHistoryMatrix.data = new Float32Array(this.currentHistoryMatrix.data)
        copyVec3(this.currentHistoryCenterHigh, this.previousHistoryCenterHigh)
        copyVec3(this.currentHistoryCenterLow, this.previousHistoryCenterLow)
        copyVec2(this.currentHistoryViewport, this.previousHistoryViewport)

        const matrix = new Float32Array(this.map.uMatrix.data)
        const inverseMatrix = scr.mat4.inverse(matrix)
        const matrixValid = isFiniteArray(matrix) && isFiniteArray(inverseMatrix)

        this.currentHistoryMatrix.data = matrix
        this.currentHistoryInverseMatrix.data = new Float32Array(inverseMatrix)
        copyVec3(this.map.centerHigh, this.currentHistoryCenterHigh)
        copyVec3(this.map.centerLow, this.currentHistoryCenterLow)
        copyVec2(this.map.screen.sizeF, this.currentHistoryViewport)

        const currentViewport = [ this.currentHistoryViewport.x, this.currentHistoryViewport.y ]
        const currentCenter = [
            this.currentHistoryCenterHigh.x + this.currentHistoryCenterLow.x,
            this.currentHistoryCenterHigh.y + this.currentHistoryCenterLow.y,
        ]
        const viewportChanged = hadHistory && (
            previousViewport[0] !== currentViewport[0] ||
            previousViewport[1] !== currentViewport[1]
        )
        const centerDelta = Math.hypot(
            currentCenter[0] - previousCenter[0],
            currentCenter[1] - previousCenter[1],
        )
        const largeJump = hadHistory && centerDelta > this.maxHistoryReprojectCenterDelta

        this.historyValid.n = this.historyMode === 'reproject' && hadHistory && matrixValid && !viewportChanged && !largeJump ? 1 : 0
        this.hasHistoryCameraState = matrixValid
    }

    idle() {

        if (!this.swapPasses) return

        if (this.historyMode !== 'clear') {

            if (this.historyMode === 'reproject') this.historyReprojecting.n = 1
            this.simulationPass.executable = true
            return
        }

        this.swapPasses[0].executable = true
        this.simulationPass.executable = true
        
        // this.showBinding.executable = true
        // this.swapPasses[2].executable = true
        // this.arrowPipeline.executable = false
        
        // this.swapPasses[0].executable = false
        // this.swapPasses[1].executable = false
        // this.layerBindings[0].executable = false
        // this.layerBindings[1].executable = false
    }

    restart() {

        if (!this.swapPasses) return
        if (this.historyMode !== 'clear') {

            this.historyReprojecting.n = 0
            return
        }

        this.preheat = 10
        this.isIdling = false
        // this.arrowPipeline.executable = true
        this.swapPasses[0].executable = false
        this.simulationPass.executable = true
        this.particleRef.value = this.randomFillData
    }

    registerCameraInvalidation() {

        if (this.historyMode === 'off' || !this.map) return

        this.unregisterCameraInvalidation()

        const clearHistory = () => this.idle()
        const restartHistory = () => this.restart()
        const movingEvents = [ 'movestart', 'move', 'dragstart', 'drag', 'zoomstart', 'zoom', 'rotatestart', 'rotate', 'pitchstart', 'pitch' ]
        const settledEvents = [ 'moveend', 'dragend', 'zoomend', 'rotateend', 'pitchend' ]

        movingEvents.forEach(eventName => {

            this.map.on(eventName, clearHistory)
            this.cameraInvalidationHandlers.push({ eventName, handler: clearHistory })
        })
        settledEvents.forEach(eventName => {

            this.map.on(eventName, restartHistory)
            this.cameraInvalidationHandlers.push({ eventName, handler: restartHistory })
        })
    }

    unregisterCameraInvalidation() {

        if (!this.map || this.cameraInvalidationHandlers.length === 0) return

        this.cameraInvalidationHandlers.forEach(({ eventName, handler }) => this.map.off(eventName, handler))
        this.cameraInvalidationHandlers = []
    }

    show() {

        this.isHided = false
    }

    hide() {

        this.isHided = true
    }

    makeVisibility(visibility) {

        if (!visibility) {

            this.showPipeline.executable = false
            this.layerBindings[0].executable = false
            this.layerBindings[1].executable = false
    
            this.voronoiPass.executable = false
            this.swapPasses[0].executable = false
            this.swapPasses[1].executable = false
            this.swapPasses[2].executable = false
            this.simulationPass.executable = false

        } else {

            this.showPipeline.executable = true
                
            this.voronoiPass.executable = true
            this.simulationPass.executable = true
        }
    }

    updateMaxSpeed(maxSpeed) {

        this.maxSpeed.n = maxSpeed > this.maxSpeed.n ? maxSpeed : this.maxSpeed.n
    }

    updateVoronoi() {

        // No update and tick when preparing resource
        if (this.nextPreparing) return

        // Update resource codition
        if (this.progress === 0) {

            this.currentResourceUrl = (this.currentResourceUrl + 1) % resourceUrl.length
            this.addVoronoiBindingAsync(resourceUrl[this.currentResourceUrl])
        }

        // Tick progress
        this.progress = Math.min(this.progress + 1, this.framesPerPhase - 1)

        // Swap condition
        if (this.nextPrepared && this.progress === this.framesPerPhase - 1) {

            this.progress = 0
            this.swapVoronoiBinding()
        }

        // Tick progress rate
        this.progressRate.n = this.progress / (this.framesPerPhase - 1)
    }
    async getVoronoi(url) {
        
        const stationCoords = new Float32Array(await fetchArrayBuffer(url))
        const meshes = new Delaunay(stationCoords)
        
        const vertices = []
        const domainSupport = []
        const triangleVertexIndices = []
        const triangles = meshes.triangles
        for (let i = 0; i < triangles.length; i += 3) {

            const ids = [ triangles[i + 0], triangles[i + 1], triangles[i + 2] ]
            const support = calculateTriangleDomainSupport(meshes.points, ids, this.flowDomainMaxEdge)

            ids.forEach(id => {

                const x = encodeFloatToDouble(scr.MercatorCoordinate.mercatorXfromLon(meshes.points[id * 2 + 0]))
                const y = encodeFloatToDouble(scr.MercatorCoordinate.mercatorYfromLat(meshes.points[id * 2 + 1]))

                vertices.push(x[0])
                vertices.push(y[0])
                vertices.push(x[1])
                vertices.push(y[1])

                domainSupport.push(support)
                triangleVertexIndices.push(id)
            })
        }

        this.triangleVertexIndices = new Uint32Array(triangleVertexIndices)
        this.voronoiVertexCount = this.triangleVertexIndices.length

        this.toRef = scr.aRef(new Float32Array(this.voronoiVertexCount * 2).fill(0.))
        this.fromRef = scr.aRef(new Float32Array(this.voronoiVertexCount * 2).fill(0.))
        this.nextRef = scr.aRef(new Float32Array(this.voronoiVertexCount * 2).fill(0.))

        this.vertexBuffer_voronoi = scr.vertexBuffer({
            name: `VertexBuffer (Station Position (${url}))`,
            resource: { arrayRef: scr.aRef(new Float32Array(vertices)), structure: [ { components: 4 } ] }
        })

        this.voronoiBinding = scr.binding({
            name: `Binding (Flow-Field Voronoi)`,
            range: () => [ this.voronoiVertexCount ],
            vertices: [
                { buffer: this.vertexBuffer_voronoi },
                {
                    buffer: scr.vertexBuffer({
                        name: `VertexBuffer (Flow Domain Support (${url}))`,
                        resource: { arrayRef: scr.aRef(new Float32Array(domainSupport)), structure: [ { components: 1 } ] }
                    })
                },
                {
                    buffer: scr.vertexBuffer({
                        name: `VertexBuffer (Station Velocity (From)`,
                        resource: { arrayRef: this.fromRef, structure: [ { components: 2 } ] }
                    })
                },
                {
                    buffer: scr.vertexBuffer({
                        name: `VertexBuffer (Station Velocity (To)`,
                        resource: { arrayRef: this.toRef, structure: [ { components: 2 } ] }
                    })
                }
            ],
            sharedUniforms: [
                { buffer: this.uniformBuffer_frame },
                { buffer: this.uniformBuffer_static },
                { buffer: this.map.dynamicUniformBuffer },
            ],
        })
    }

    async addVoronoiBindingSync(url) {
        
        this.nextPreparing = true
        const uvs = new Float32Array(await fetchArrayBuffer(url))

        let maxSpeed = -Infinity
        for (let i = 0; i < uvs.length; i += 2) {
            
            const u = uvs[i + 0]
            const v = uvs[i + 1]

            const speed = Math.sqrt(u * u + v * v)
            maxSpeed = speed > maxSpeed ? speed : maxSpeed
        }

        this.nextRef.value = this.expandStationVelocities(uvs)
        this.updateMaxSpeed(maxSpeed)

        this.nextPreparing = false
        this.nextPrepared = true
    }

    swapVoronoiBinding() {

        // from - to - next --> to - next - from

        let tmpValue = this.fromRef.value
        this.fromRef.value = this.toRef.value
        this.toRef.value = tmpValue

        tmpValue = this.toRef.value
        this.toRef.value = this.nextRef.value
        this.nextRef.value = tmpValue
        this.nextPrepared = false
    }

    addWorker(worker) {

        const that = this
        this.loadWorker = worker
        this.loadWorker.addEventListener('message', event => {

            const { url, maxSpeed, uvs } = event.data
            const name = url
            that.updateMaxSpeed(maxSpeed)
            that.nextRef.value = that.expandStationVelocities(uvs)

            that.nextPrepared = true
            that.nextPreparing = false
        })
    }

    addVoronoiBindingAsync(url) {

        this.nextPreparing = true

        this.loadWorker.postMessage({ url })
    }

    expandStationVelocities(uvs) {

        const expandedUvs = new Float32Array(this.voronoiVertexCount * 2)
        for (let i = 0; i < this.triangleVertexIndices.length; i++) {

            const stationIndex = this.triangleVertexIndices[i]
            expandedUvs[i * 2 + 0] = uvs[stationIndex * 2 + 0]
            expandedUvs[i * 2 + 1] = uvs[stationIndex * 2 + 1]
        }

        return expandedUvs
    }
}

// Helpers //////////////////////////////////////////////////////////////////////////////////////////////////////
function calculateTriangleDomainSupport(points, ids, maxEdge) {

    const edge01 = calculateStationEdgeLength(points, ids[0], ids[1])
    const edge12 = calculateStationEdgeLength(points, ids[1], ids[2])
    const edge20 = calculateStationEdgeLength(points, ids[2], ids[0])

    return Math.max(edge01, edge12, edge20) <= maxEdge ? 1 : 0
}

function calculateStationEdgeLength(points, a, b) {

    const dx = points[a * 2 + 0] - points[b * 2 + 0]
    const dy = points[a * 2 + 1] - points[b * 2 + 1]

    return Math.sqrt(dx * dx + dy * dy)
}

function encodeFloatToDouble(value) {

    const result = new Float32Array(2);
    result[0] = value;
    
    const delta = value - result[0];
    result[1] = delta;
    return result;
}

function historyModeToValue(mode) {

    if (mode === 'off') return 0
    if (mode === 'clear') return 1
    if (mode === 'reproject') return 2
    throw new Error(`Unsupported DEM flow history mode: ${mode}`)
}

function copyVec2(source, target) {

    target.x = source.x
    target.y = source.y
}

function copyVec3(source, target) {

    target.x = source.x
    target.y = source.y
    target.z = source.z
}

function isFiniteArray(values) {

    return values.every(value => Number.isFinite(value))
}
