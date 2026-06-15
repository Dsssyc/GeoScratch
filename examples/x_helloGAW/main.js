import * as scr from '../../src/index.js'
import cloudShader from './shaders/cloud.wgsl?raw'
import landShader from './shaders/land.wgsl?raw'
import lastShader from './shaders/last.wgsl?raw'
import linkComputeShader from './shaders/link.compute.wgsl?raw'
import linkShader from './shaders/link.wgsl?raw'
import particleComputeShader from './shaders/particle.compute.wgsl?raw'
import pointShader from './shaders/point.wgsl?raw'
import waterShader from './shaders/water.wgsl?raw'

scr.StartDash().then(() => main(document.getElementById('GPUFrame')))

const earthImage = new URL('./assets/images/earth.jpg', import.meta.url).href
const cloudImage = new URL('./assets/images/cloud.jpg', import.meta.url).href
const landMaskImage = new URL('./assets/images/mask-land.jpg', import.meta.url).href
const cloudAlphaImage = new URL('./assets/images/cloud-alpha.jpg', import.meta.url).href
const earthNightImage = new URL('./assets/images/earth-night.jpg', import.meta.url).href
const cloudNightImage = new URL('./assets/images/cloud-night.jpg', import.meta.url).href
const earthSpecularImage = new URL('./assets/images/earth-specular.jpg', import.meta.url).href
const earthEmissionImage = new URL('./assets/images/earth-selfillumination.jpg', import.meta.url).href

function inlineShader(name, code) {

    return scr.shader({ name, codeFunc: () => code })
}

const main = function (canvas) {

    // Screen canvas
    const screen = scr.screen({ canvas })

    // Scene parameters
    const timeCount = scr.f32(0.)
    const up = scr.vec3f(0., 1., 0.)
    const target = scr.vec3f(0., 0., 0.)
    const cameraPos = scr.vec3f(0., 0., 1200.)
    const lightPos = scr.vec3f(-600., 0., 0.).transformFromMat4(scr.Mat4f.rotationZ(scr.utils.degToRad(-23.)))

    // Earth
    const diam = 800.
    const radius = scr.f32(diam / 2.)

    // Linked particles
    const maxParticleCount = 100
    const nodeInLink = scr.f32(20)
    const rLink = scr.f32(radius.data - 100.)
    const minDistance = scr.f32(rLink.data * 2.0)
    const maxConnections = scr.u32(maxParticleCount / 2)

    // Global matrix
    const viewMatrix = scr.mat4f()
    const projectionMatrix = scr.mat4f()
    const modelMatrix = scr.Mat4f.rotationX(scr.utils.degToRad(32.))
    const normalMatrix = scr.Mat4f.transposing(scr.Mat4f.inverse(modelMatrix))

    // Global arrayRef
    const connetionNums = scr.aRef(new Uint32Array(maxParticleCount).fill(0))
    const linkIndirect = scr.aRef(new Uint32Array([nodeInLink.data, 0, 0, 0]))

    // Global sampler
    const lSampler = scr.sampler({
        name: 'Sampler (Linear)',
        filterMinMag: ['linear', 'linear'],
        addressModeUVW: ['repeat', 'repeat'],
    })

    const initEarth = function () {

        // Buffer-related resource
        const { indices, vertices, normals, uvs } = scr.sphere(radius.data, 64, 32)
        const vertexBuffer_sphere_index = scr.vertexBuffer({
            name: 'Vertex Buffer (Sphere index)',
            resource: { arrayRef: scr.aRef(new Uint32Array(indices)), structure: [ { components: 1 } ] }
        })
        const storageBuffer_sphere_position = scr.storageBuffer({
            name: 'Storage Buffer (Sphere position)',
            resource: { arrayRef: scr.aRef(new Float32Array(vertices)) }
        })
        const storageBuffer_sphere_normal = scr.storageBuffer({
            name: 'Storage Buffer (Sphere normal)',
            resource: { arrayRef: scr.aRef(new Float32Array(normals)) }
        })
        const storageBuffer_sphere_uv = scr.storageBuffer({
            name: 'Storage Buffer (Sphere uv)' ,
            resource: { arrayRef: scr.aRef(new Float32Array(uvs)) }
        })

        // Texture-related resource
        const ldTexture = scr.imageLoader.load('Land day', earthImage)
        const cdTexture = scr.imageLoader.load('Cloud day', cloudImage)
        const lmTexture = scr.imageLoader.load('Land mask', landMaskImage)
        const cmTexture = scr.imageLoader.load('Cloud mask', cloudAlphaImage)
        const lnTexture = scr.imageLoader.load('Land night', earthNightImage)
        const cnTexture = scr.imageLoader.load('Cloud night', cloudNightImage)
        const lsTexture = scr.imageLoader.load('Land specular', earthSpecularImage)
        const leTexture = scr.imageLoader.load('Land emission', earthEmissionImage)

        // Binding: Land and water
        const landWater = scr.binding({
            name: 'Binding (Land and Water)',
            range: () => [ indices.length ],
            uniforms: [
                {
                    name: 'dynamicUniform',
                    dynamic: true,
                    map: {
                        projection: projectionMatrix,
                        view: viewMatrix,
                        model: modelMatrix,
                        normal: normalMatrix,
                        deleta: timeCount,
                    }
                },
                {
                    name: 'staticUniform',
                    map: {
                        radius: radius,
                        alphaTest: scr.asF32(0.3),
                        opacity: scr.asF32(1.),
                    }
                },
                {
                    name: 'light',
                    map: {
                        position: lightPos,
                        color: scr.asVec3f(1.),
                        intensity: scr.asF32(6.),
                        viewPos: cameraPos,
                    }
                },
                {
                    name: 'material',
                    map: {
                        ambient: scr.asVec3f(0.4),
                        diffuse: scr.asVec3f(1.),
                        specular: scr.asVec3f(1.),
                        shininess: scr.asF32(16.),
                        emissive: scr.asF32(1.),
                    }
                }
            ],
            samplers: [ { sampler: lSampler } ],
            textures: [
                { texture: ldTexture },
                { texture: lnTexture },
                { texture: lsTexture },
                { texture: lmTexture },
                { texture: leTexture },
            ],
            storages: [
                { buffer: storageBuffer_sphere_position },
                { buffer: storageBuffer_sphere_uv },
                { buffer: storageBuffer_sphere_normal },
            ],
            vertices: [ { buffer: vertexBuffer_sphere_index } ],
        })
        // Binding: Cloud
        const cloud = scr.binding({
            name: 'Binding (Cloud)',
            range: () => [ indices.length ],
            uniforms: [
                {
                    name: 'dynamicUniform',
                    dynamic: true,
                    map: {
                        projection: projectionMatrix,
                        view: viewMatrix,
                        model: modelMatrix,
                        normal: normalMatrix,
                        delta: timeCount,
                    }
                },
                {
                    name: 'staticUniform',
                    map: {
                        radius: radius,
                        alphaTest: scr.asF32(0.3),
                        opacity: scr.asF32(0.6),
                    }
                },
                {
                    name: 'light',
                    map: {
                        position: lightPos,
                        color: scr.asVec3f(1.),
                        intensity: scr.asF32(6.),
                        viewPos: cameraPos,
                    }
                },
                {
                    name: 'material',
                    map: {
                        ambient: scr.asVec3f(0.8),
                        diffuse: scr.asVec3f(1.),
                        specular: scr.asVec3f(1.),
                        shininess: scr.asF32(16.),
                        emissive: scr.asF32(1.),
                    }
                }
            ],
            samplers: [ { sampler: lSampler } ],
            textures: [ 
                { texture: cdTexture },
                { texture: cnTexture },
                { texture: cmTexture },
            ],
            storages: [
                { buffer: storageBuffer_sphere_position },
                { buffer: storageBuffer_sphere_uv },
                { buffer: storageBuffer_sphere_normal },
            ],
            vertices: [ { buffer: vertexBuffer_sphere_index } ],
        })

        // Pipeline: Land
        const landPipeline = scr.renderPipeline({
            name: 'Render Pipeline (Land)',
            shader: { module: inlineShader('Shader (GawEarth land)', landShader) },
            colorTargetStates: [ { blend: scr.NormalBlending } ],
        })
        // Pipeline: Water
        const waterPipeline = scr.renderPipeline({
            name: 'Render Pipeline (Water)',
            shader: { module: inlineShader('Shader (GawEarth water)', waterShader) },
            colorTargetStates: [ { blend: scr.NormalBlending } ],
        })
        // Pipeline: Cloud
        const cloudPipeline = scr.renderPipeline({
            name: 'Render Pipeline (Cloud)',
            shader: { module: inlineShader('Shader (GawEarth cloud)', cloudShader) },
            colorTargetStates: [ { blend: scr.AdditiveBlending } ],
        })

        return {
            land: [ landPipeline, landWater ], water: [ waterPipeline, landWater ], cloud: [ cloudPipeline, cloud ]
        }
    }

    const initEarthCore = function () {

        // Buffer-related resource of particles
        const pPositions = new Float32Array(maxParticleCount * 3)
        const pVelocities = new Float32Array(maxParticleCount * 3)
        const palette = [ 250. / 255., 250. / 255., 210. / 250., 1. ]
        const pColors = new Float32Array(maxParticleCount * 4).map((_, index) => palette[index % 4])

        for (let i = 0; i < maxParticleCount; i++) {
            const v = scr.vec3f(Math.random() * 2. - 1., Math.random() * 2. - 1., Math.random() * 2. - 1.).normalize().scale(rLink)
        
            pPositions[i * 3 + 0] = v.x
            pPositions[i * 3 + 1] = v.y
            pPositions[i * 3 + 2] = v.z
            pVelocities[i * 3 + 0] = scr.randomNonZeroBetweenMinusOneAndOne(0.3)
            pVelocities[i * 3 + 1] = scr.randomNonZeroBetweenMinusOneAndOne(0.3)
            pVelocities[i * 3 + 2] = scr.randomNonZeroBetweenMinusOneAndOne(0.3)
        }
        const storageBuffer_particle_velocity = scr.storageBuffer({
            name: 'Storage Buffer (Particle velocity)',
            resource: { arrayRef: scr.aRef(pVelocities) }
        })
        const vertexBuffer_particle_color = scr.vertexBuffer({
            name: 'Vertex Buffer (Particle color)',
            resource: { arrayRef: scr.aRef(pColors), structure: [ { components: 4 } ] }
        })
        const vertexBuffer_particle_position = scr.vertexBuffer({
            name: 'Vertex Buffer (Particle position)',
            randomAccessible: true,
            resource: { arrayRef: scr.aRef(pPositions), structure: [ { components: 3 } ] }
        })

        // Buffer-related resource of links
        const linkIndices = scr.aRef(new Uint32Array(maxParticleCount * maxParticleCount * 2).fill(0))
        for (let i = 0, numConnected = 0; i < maxParticleCount; i++) {
            for (let j = i + 1; j < maxConnections.data; j++) {
                linkIndices.element(numConnected++, i)
                linkIndices.element(numConnected++, j)
            }
        }
        const storageBuffer_link_index = scr.storageBuffer({
            name: 'Storage Buffer (Link)',
            resource: { arrayRef: linkIndices }
        })
        
        const storageBuffer_connection_nums = scr.storageBuffer({
            name: 'Storage Buffer (Connection num)',
            resource: { arrayRef: connetionNums }
        })

        const indirectBuffer_link = scr.indirectBuffer({
            name: 'Storage Buffer (Indirect)',
            randomAccessible: true,
            resource: { arrayRef: linkIndirect }
        })

        // Binding: Particles
        const particles = scr.binding({
            name: 'Binding (Earth core particels)',
            range: () => [ 4, maxParticleCount ],
            uniforms: [
                {
                    name: 'dynamicUniform',
                    dynamic: true,
                    map: {
                        projection: projectionMatrix,
                        view: viewMatrix,
                        viewPort: screen.sizeF,
                    },
                },
                {
                    name: 'staticUniform',
                    map: {
                        size: scr.asF32(5.),
                    },
                },
            ],
            vertices: [
                { buffer: vertexBuffer_particle_position, isInstanced: true },
                { buffer: vertexBuffer_particle_color, isInstanced: true }
            ],
        })

        // Binding: Particle simulator
        const particleSimulator = scr.binding({
            name: 'Binding (Particel simulator)',
            range: () => [ 1, 1 ],
            uniforms: [
                {
                    name: 'staticUniform',
                    map: {
                        rLink: rLink,
                        groupSize: scr.asVec2u(1),
                        angle: scr.asF32(0.01),
                    }
                }
            ],
            storages: [
                { buffer: storageBuffer_particle_velocity },
                { buffer: vertexBuffer_particle_position, writable: true },
            ]
        })

        // Binding: Links
        const links = scr.binding({
            name: 'Binding (Earth core link)',
            uniforms: [
                {
                    name: 'dynamicUniform',
                    dynamic: true,
                    map: {
                        projection: projectionMatrix,
                        view: viewMatrix,
                    },
                },
                {
                    name: 'staticUniform',
                    map: {
                        minDistance: minDistance,
                        cardinalColor: scr.asVec3f(175. / 255., 65. / 255., 5. / 255.),
                        evenColor: scr.asVec3f(80. / 255., 190. / 255., 1.),
                        rLink: rLink,
                        maxNodeIndex: nodeInLink.add(-1.),
                    }
                }
            ],
            indirect: { buffer: indirectBuffer_link },
            storages: [
                { buffer: vertexBuffer_particle_position },
                { buffer: storageBuffer_link_index },
            ],
        })

        // Binding: Link indexer
        const linkIndexer = scr.binding({
            name: 'Binding (Link indexer)',
            range: () => [ 1, 1 ],
            uniforms: [
                {
                    name: 'staticUniform',
                    map: {
                        minDistance: minDistance,
                        maxConnection: maxConnections,
                        groupSize: scr.asVec2u(1),
                    }
                }
            ],
            storages: [
                { buffer: vertexBuffer_particle_position },
                { buffer: storageBuffer_link_index, writable: true },
                { buffer: storageBuffer_connection_nums, writable: true },
                { buffer: indirectBuffer_link, writable: true }
            ]
        })

        // Pipeline: Particle
        const particlePipeline = scr.renderPipeline({
            name: 'Render Pipeline (Earth core particel)',
            shader: { module: inlineShader('Shader (Earth core particel)', pointShader) },
            colorTargetStates: [ { blend: scr.NormalBlending } ],
            primitive: { topology: 'triangle-strip' },
            depthTest: false,
        })
        // Pipeline: Link
        const linkPipeline = scr.renderPipeline({
            name: 'Render Pipeline (Earth core link)',
            shader: { module: inlineShader('Shader (Earth core link)', linkShader) },
            primitive: { topology: 'line-strip' },
            depthTest: false,
        })
        // Pipeline: Simulation
        const simulationPipeline = scr.computePipeline({
            name: 'Compute Pipeline (Particle simulation)',
            shader: { module: inlineShader('Shader (Particle simulation)', particleComputeShader) },
            constants: { blockSize: 10 },
        })
        // Pipeline: Indexing
        const indexingPipeline = scr.computePipeline({
            name: 'Compute Pipeline (Link indexing)',
            shader: { module: inlineShader('Shader (Link indexing)', linkComputeShader) },
            constants: { blockSize: 10 },
        })

        return {
            particles: [ particlePipeline, particles ], links: [ linkPipeline, links ],
            simulator: [ simulationPipeline, particleSimulator ], indexer: [ indexingPipeline, linkIndexer ]
        }
    }

    const initPass = function () {

        // Texture-related resource
        const sceneTexture = screen.createScreenDependentTexture('Texture (Scene)')
        const depthTexture = screen.createScreenDependentTexture('Texture (Depth)', 'depth24plus')

        // Pass: Blooming postprocess
        const bloomPass = scr.BloomPass.create({
            threshold: 0.0,
            strength: 0.4,
            blurCount: 5,
            inputColorAttachment: sceneTexture,
        })
        // Pass：FXAA postprocess
        const fxaaPass = scr.FXAAPass.create({
            threshold: 0.0312,
            searchStep: 10,
            inputColorAttachment: bloomPass.getOutputAttachment(),
        })
        screen.addScreenDependentElement(bloomPass).addScreenDependentElement(fxaaPass)
        // Pass: Scene computation
        const computePass_scene = scr.computePass({
            name: 'Compute Pass (GAW Compute)',
        })
        // Pass: Scene rendering
        const renderPass_scene = scr.renderPass({
            name: 'Render Pass (GAW Scene)',
            colorAttachments: [ { colorResource: sceneTexture } ],
            depthStencilAttachment: { depthStencilResource: depthTexture },
        })

        return {
            bloomPass, fxaaPass,
            computePass_scene, renderPass_scene
        }
    }

    const initOutputPass = function (prePass) {
        
        // Binding: Output
        const output = scr.binding({
            name: 'Binding (Output)',
            range: () => [ 4 ],
            samplers: [ { sampler: lSampler } ],
            uniforms: [
                {
                    name: 'staticUniform',
                    map: {
                        gamma: scr.asF32(1.),
                        density: scr.asF32(6.),
                    }
                }
            ],
            textures: [ { texture: prePass.getOutputAttachment() } ],
        })

        // Pipeline: Output
        const outputPipeline = scr.renderPipeline({
            name: 'Render Pipeline (Output)',
            shader: { module: inlineShader('Shader (Output)', lastShader) },
            primitive: { topology: 'triangle-strip' },
        })

        // Pass: Output rendering
        const renderPass_output = scr.renderPass({
            name: 'Render Pass (GAW Output)',
            colorAttachments: [ { colorResource: screen } ],
        }).add(outputPipeline, output)

        return renderPass_output
    }

    const init = function () {

        // Earth
        const { land, water, cloud } = initEarth()

        // Particle and link
        const { simulator, indexer, particles, links } = initEarthCore()

        // Intermediate pass
        const { renderPass_scene, computePass_scene, bloomPass, fxaaPass } = initPass()

        // Output pass
        const outputPass = initOutputPass(fxaaPass)

        // Stage
        scr.director.addStage({
            name: 'HelloGeoAnythingWeb',
            items: [
                /* 1st pass */  computePass_scene.add(...simulator).add(...indexer), 
                /* 2nd pass */  renderPass_scene.add(...land).add(...links).add(...particles).add(...water).add(...cloud),
                /* 3rd pass */  bloomPass, /* 4th pass */  fxaaPass, /* 5th pass */  outputPass,
            ],
        })
    }

    const animate = function () {

        /* Accumulation */      timeCount.add(-0.001)
        /* Connections */       connetionNums.fill(0)
        /* Link buffer */       linkIndirect.element(1, 0)
        /* View matrix */       viewMatrix.lookAt(cameraPos, target, up)
        /* Projection matrix */ projectionMatrix.perspective(45., screen.width / screen.height, 1., 4000.)

        scr.director.tick()
        setTimeout(() => requestAnimationFrame( animate ), 1000. / 45. )
    }

    init()
    animate()
}
