import * as scr from '../../src/index.js'
import { Delaunay } from 'd3-delaunay'
import axios from 'axios'
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
        this.flowMaskCutoff = scr.f32(options.flowMaskCutoff ?? 0.02)
        this.clearOnMove = options.clearOnMove ?? true

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
        this.uniformBuffer_frame = undefined
        this.indexBuffer_voronoi = undefined
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
        this.flowMaskTexture = this.map.screen.createScreenDependentTexture('Texture (Flow Mask)')

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

    idle() {

        if (!this.swapPasses) return

        this.isIdling = true

        this.swapPasses[0].executable = true
        
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

        this.preheat = 10
        this.isIdling = false
        // this.arrowPipeline.executable = true
        this.swapPasses[0].executable = false
        this.particleRef.value = this.randomFillData
    }

    registerCameraInvalidation() {

        if (!this.clearOnMove) return

        const clearHistory = () => this.idle()
        const restartHistory = () => this.restart()
        const movingEvents = [ 'movestart', 'move', 'dragstart', 'drag', 'zoomstart', 'zoom', 'rotatestart', 'rotate', 'pitchstart', 'pitch' ]
        const settledEvents = [ 'moveend', 'dragend', 'zoomend', 'rotateend', 'pitchend' ]

        movingEvents.forEach(eventName => this.map.on(eventName, clearHistory))
        settledEvents.forEach(eventName => this.map.on(eventName, restartHistory))
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
        
        const res = await axios.get(url, { responseType: 'arraybuffer' })
        const meshes = new Delaunay(new Float32Array(res.data))
        
        const vertices = []
        const indices = meshes.triangles
        for (let i = 0; i < meshes.points.length; i += 2) {
    
            const x = encodeFloatToDouble(scr.MercatorCoordinate.mercatorXfromLon(meshes.points[i + 0]))
            const y = encodeFloatToDouble(scr.MercatorCoordinate.mercatorYfromLat(meshes.points[i + 1]))
    
            vertices.push(x[0])
            vertices.push(y[0])
            vertices.push(x[1])
            vertices.push(y[1])
        }

        this.toRef = scr.aRef(new Float32Array(meshes.points.length).fill(0.))
        this.fromRef = scr.aRef(new Float32Array(meshes.points.length).fill(0.))
        this.nextRef = scr.aRef(new Float32Array(meshes.points.length).fill(0.))

        this.indexBuffer_voronoi = scr.indexBuffer({
            name: `IndexBuffer (Voronoi Index (${url}))`,
            resource: { arrayRef: scr.aRef(new Uint32Array(indices)) }
        })
        this.vertexBuffer_voronoi = scr.vertexBuffer({
            name: `VertexBuffer (Station Position (${url}))`,
            resource: { arrayRef: scr.aRef(new Float32Array(vertices)), structure: [ { components: 4 } ] }
        })

        this.voronoiBinding = scr.binding({
            name: `Binding (Flow-Field Voronoi)`,
            range: () => [ this.indexBuffer_voronoi.length ],
            index: { buffer: this.indexBuffer_voronoi },
            vertices: [
                { buffer: this.vertexBuffer_voronoi },
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
        const res = await axios.get(url, { responseType: 'arraybuffer' })
        const uvs = new Float32Array(res.data)

        let maxSpeed = -Infinity
        for (let i = 0; i < uvs.length; i += 2) {
            
            const u = uvs[i + 0]
            const v = uvs[i + 1]

            const speed = Math.sqrt(u * u + v * v)
            maxSpeed = speed > maxSpeed ? speed : maxSpeed
        }

        this.nextRef.value = uvs
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
            that.nextRef.value = uvs

            that.nextPrepared = true
            that.nextPreparing = false
        })
    }

    addVoronoiBindingAsync(url) {

        this.nextPreparing = true

        this.loadWorker.postMessage({ url })
    }
}

// Helpers //////////////////////////////////////////////////////////////////////////////////////////////////////
function encodeFloatToDouble(value) {

    const result = new Float32Array(2);
    result[0] = value;
    
    const delta = value - result[0];
    result[1] = delta;
    return result;
}
