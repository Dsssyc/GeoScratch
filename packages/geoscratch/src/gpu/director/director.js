import getDevice from "../context/device.js"
import { EventDispatcher } from "../../core/event/dispatcher.js"

const numMipLevels = (...sizes) => {
    const maxSize = Math.max(...sizes)
    return 1 + Math.log2(maxSize) | 0
}

export class Director extends EventDispatcher {

    constructor(async = true) {

        super(async)

        /**
         * @type {{[name: string]: {items: Array<any>, visibility: boolean}}}
         */
        this.stages = {}
        this.stageNum = 0
        this.bindings = []
        this.updateList = {
            currentSet: {}, 
            nextSet: {}, 
            swap: () => {
                this.updateList.currentSet = this.updateList.nextSet
                this.updateList.nextSet = {}
            },
            push: (item) => {
                this.updateList.currentSet[item.uuid] = item
            },
            pushNext: (item) => {
                this.updateList.nextSet[item.uuid] = item
            },
        }

        /**
         * @type {GPUDevice}
         */
        this.device = undefined
        /**
         * @type {GPUSupportedLimits}
         */
        this._limits = undefined
    }

    get limits() {
    
        if (this._limits === undefined) this.tryGetDevice()
        return this._limits
    }

    tryGetDevice() {

        if (this.device === undefined) {

            this.device = getDevice()
            this._limits = this.device.limits
        }

        return this.device
    }

    makeNewStage(name) {

        if (!this.stages[name]) this.stageNum++
        this.stages[name] = {
            items: [],
            visibility: true,
        }

        return this
    }


    addBinding(binding) {

        this.bindings.push(binding.use())
    }

    addToUpdateList(item) {

        this.updateList.push(item)
    }

    /** 
     * @param {{name: string, items: Array<any>, visibility?: boolean}} stage 
     */
    addStage(stage) {

        if (!this.stages[stage.name]) this.stageNum++
        this.stages[stage.name] = {
            items: stage.items,
            visibility: stage.visibility !== undefined ? stage.visibility : true,
        }
    }

    /**
     * @param {string} name 
     */
    hideStage(name) {

        if (!this.stages[name]) return
        this.stages[name].visibility = false
    }

    showStage(name) {

        if (!this.stages[name]) return
        this.stages[name].visibility = true
    }

    /**
     * 
     * @param {string} stageName 
     * @param {any} item 
     */
    addItem(stageName, item) {

        this.stages[stageName].items.push(item)

        return this
    }

    tickMemory() {

        for (const key in this.updateList.currentSet) {
            const item = this.updateList.currentSet[key]
            item.update()
            if (item.updatePerFrame) this.updateList.pushNext(item)
        }
    }

    tickRender() {

        const encoders = []
        for (const name in this.stages) {
            if (!this.stages[name].visibility) continue

            const encoder = this.device.createCommandEncoder({label: `${name}`})
            this.stages[name].items.forEach(stage => {
                stage.execute(encoder)
            })
            encoders.push(encoder.finish())
        }
        this.device.queue.submit(encoders)
    }

    swap() {

        this.updateList.swap()
    }

    tick() {

        this.tryGetDevice()

        this.tickMemory()
        this.tickRender()

        this.swap()
    }
}

const director = new Director()
export default director

// Event listeners

// Create context
director.addEventListeners('createContext', ({_, emitter}) => {

    const device = director.tryGetDevice()

    const descriptor = emitter.exportDescriptor()
    emitter.context = emitter.canvas.getContext("webgpu")
    emitter.context.configure({
        device: device,
        format: descriptor.format,
        alphaMode: descriptor.alphaMode
    })
})

// Create shader
director.addEventListeners('createShader', ({_, emitter}) => {

    const device = director.tryGetDevice()
    emitter.shaderModule = device.createShaderModule(emitter.exportDescriptor())
})

// Create buffer
director.addEventListeners('createBuffer', ({_, emitter}) => {

    const device = director.tryGetDevice()
    emitter.buffer = device.createBuffer(emitter.exportDescriptor())
})

// Create sampler
director.addEventListeners('createSampler', ({_, emitter}) => {

    const device = director.tryGetDevice()
    emitter.sampler = device.createSampler(emitter.exportDescriptor())
})

// Create binding group layout
director.addEventListeners('createBindGroupLayout', ({_, emitter, bindGroupType, order}) => {

    const device = director.tryGetDevice()
    emitter.layouts[order] = device.createBindGroupLayout(emitter.exportLayoutDescriptor(bindGroupType))
})

// Create binding group
director.addEventListeners('createBindGroup', ({_, emitter, bindGroupType, order}) => {

    const device = director.tryGetDevice()
    emitter.groups[order] = device.createBindGroup(emitter.exportDescriptor(bindGroupType))
})

// Generate mipmaps
director.addEventListeners('generateMips', (() => {

    const generator = {
        sampler: undefined,
        module: undefined,
        pipelineByFormat: {},
    }

    return function generateMips({_, texture}) {

        const device = director.tryGetDevice()
        if (!generator.module) {
            generator.module = device.createShaderModule({
            label: 'textured quad shaders for mip level generation',
            code: `
                struct VSOutput {
                    @builtin(position) position: vec4f,
                    @location(0) texcoord: vec2f,
                };
    
                @vertex fn vs(
                    @builtin(vertex_index) vertexIndex : u32
                ) -> VSOutput {
                    let pos = array(
    
                    vec2f( 0.0,  0.0),  // center
                    vec2f( 1.0,  0.0),  // right, center
                    vec2f( 0.0,  1.0),  // center, top
    
                    // 2st triangle
                    vec2f( 0.0,  1.0),  // center, top
                    vec2f( 1.0,  0.0),  // right, center
                    vec2f( 1.0,  1.0),  // right, top
                    );
    
                    var vsOutput: VSOutput;
                    let xy = pos[vertexIndex];
                    vsOutput.position = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
                    vsOutput.texcoord = vec2f(xy.x, 1.0 - xy.y);
                    return vsOutput;
                }
    
                @group(0) @binding(0) var ourSampler: sampler;
                @group(0) @binding(1) var ourTexture: texture_2d<f32>;
    
                @fragment fn fs(fsInput: VSOutput) -> @location(0) vec4f {
                    return textureSample(ourTexture, ourSampler, fsInput.texcoord);
                }
                `,
            });
    
            generator.sampler = device.createSampler({
                minFilter: 'linear',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
            });
        }
    
        if (!generator.pipelineByFormat[texture.format]) {
            generator.pipelineByFormat[texture.format] = device.createRenderPipeline({
                label: 'mip level generator pipeline',
                layout: 'auto',
                vertex: {
                    module: generator.module,
                    entryPoint: 'vs',
                },
                fragment: {
                    module: generator.module,
                    entryPoint: 'fs',
                    targets: [{ format: texture.format }],
                },
            });
        }
        const pipeline = generator.pipelineByFormat[texture.format]
    
        const encoder = device.createCommandEncoder({ label: 'mip gen encoder' })
    
        let width = texture.width
        let height = texture.height
        let baseMipLevel = 0
        while (width > 1 || height > 1) {
            width = Math.max(1, Math.ceil(width / 2) | 0);
            height = Math.max(1, Math.ceil(height / 2) | 0);
    
            const bindGroup = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: generator.sampler },
                    { binding: 1, resource: texture.createView({baseMipLevel, mipLevelCount: 1}) },
                ],
            })
    
            ++baseMipLevel
    
            const renderPassDescriptor = {
                label: 'our basic canvas renderPass',
                colorAttachments: [
                {
                    view: texture.createView({baseMipLevel, mipLevelCount: 1}),
                    loadOp: 'clear',
                    storeOp: 'store',
                },
                ],
            }
    
            const pass = encoder.beginRenderPass(renderPassDescriptor)
            pass.setPipeline(pipeline)
            pass.setBindGroup(0, bindGroup)
            pass.draw(6)
            pass.end()
        }
    
        device.queue.submit([encoder.finish()])
    }
})())

// Create texture by imageBitmap
director.addEventListeners('createTextureByImageBitmap', ({_, emitter, imageBitmap}) => {
    
    const device = director.tryGetDevice()

    let rgba8Texture = device.createTexture({
        label: `${emitter.name}`,
        size: [imageBitmap.width, imageBitmap.height],
        format: 'rgba8unorm',
        usage: emitter.usage,
        ...(emitter.mipMapped && {
            mipLevelCount: numMipLevels(imageBitmap.width, imageBitmap.height)
        })
    })

    device.queue.copyExternalImageToTexture(
        {source: imageBitmap, flipY: emitter.flipY},
        {texture: rgba8Texture},
        {width: imageBitmap.width, height: imageBitmap.height}
    )

    if (emitter.format === 'rgba8unorm') emitter.texture = rgba8Texture
    else {

        const componentNum = {
            'rg32float': 2,
        }
    
        if (!(emitter.format in componentNum)) {
            throw new Error(`Unsupported reparsed format: ${emitter.format}`)
        }
        const targetComponents = componentNum[emitter.format]

        // Reparsing
        const tempEncoder = device.createCommandEncoder()
        const tempBuffer = device.createBuffer({
          label: 'tempBuffer',
          size: rgba8Texture.width * rgba8Texture.height * 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
        })
        tempEncoder.copyTextureToBuffer(
          { texture: rgba8Texture, mipLevel: 0, origin: [0, 0, 0], aspect: 'all' },
          { buffer: tempBuffer, offset: 0, bytesPerRow: rgba8Texture.width * 4, rowsPerImage: rgba8Texture.height },
          [rgba8Texture.width, rgba8Texture.height]
        )
    
        const parsedTexture = device.createTexture({
          label: emitter.name,
          format: emitter.format,
          size: [rgba8Texture.width / targetComponents, imageBitmap.height],
          usage: emitter.usage,
          ...(emitter.mipMapped && {
              mipLevelCount: numMipLevels(rgba8Texture.width / targetComponents, imageBitmap.height)
          })
        })
        tempEncoder.copyBufferToTexture(
          { buffer: tempBuffer, offset: 0, bytesPerRow: rgba8Texture.width * 4, rowsPerImage: parsedTexture.height },
          { texture: parsedTexture, mipLevel: 0, origin: [0, 0, 0], aspect: 'all' },
          [parsedTexture.width, parsedTexture.height]
        )
        device.queue.submit([tempEncoder.finish()])
        
        rgba8Texture.destroy()
        tempBuffer.destroy()
        emitter.texture = parsedTexture
    }

    if (emitter.texture.mipLevelCount > 1)
        director.dispatchEvent({type: 'generateMips', texture: emitter.texture})
})

// Create texture by size
director.addEventListeners('createTextureBySize', ({_, emitter}) => {

    const device = director.tryGetDevice()

    emitter.texture = device.createTexture({
        label: `${emitter.name}`,
        size: emitter.resource.size(),
        format: emitter.format,
        usage: emitter.usage,
        ...(emitter.mipMapped && {
            mipLevelCount: numMipLevels(...emitter.resource.size())
        })
    })

    if (emitter.texture.mipLevelCount > 1) {
        director.dispatchEvent({type: 'generateMips', texture: emitter.texture})
    }
})

// Create pipeline layout
director.addEventListeners('createPipelineLayout', ({_, emitter, binding}) => {

    const device = director.tryGetDevice()

    emitter.pipelineLayout = device.createPipelineLayout(emitter.exportLayoutDescriptor(binding))
})

// Create render pipeline async
director.addEventListeners('createRenderPipelineAsync', ({_, emitter, binding}) => {

    const device = director.tryGetDevice()
    
    device.createRenderPipelineAsync(emitter.exportDescriptor(binding))
    .then(pipeline => {
        emitter.pipeline = pipeline
        emitter.pipelineCreating = false
    })
    .catch(error => {
        console.error(`Error::Rendering Pipeline (${emitter.name}) Creation FAILED!`, error);
    })
})

// Create render bundle
director.addEventListeners('createRenderBundle', ({_, emitter, renderPass, binding}) => {

    const device = director.tryGetDevice()

    const renderBundleEncoder = device.createRenderBundleEncoder({
        colorFormats: renderPass.makeColorFormats(),
        depthStencilFormat: renderPass.makeDepthStencilFormat(),
    })
    emitter.executeRenderPass(renderBundleEncoder, binding)
    emitter.renderBundle = renderBundleEncoder.finish()
})

// Update buffer
director.addEventListeners('writeBuffer', ({_, emitter, subArea}) => {

    const device = director.tryGetDevice()
    device.queue.writeBuffer(emitter.buffer, subArea.start, subArea.ref.value, subArea.dataOffset, subArea.size)
})
