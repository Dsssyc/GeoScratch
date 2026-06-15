import { UniformBuffer } from '../buffer/uniformBuffer.js'
import { StorageBuffer } from '../buffer/storageBuffer.js'
import { Texture } from '../texture/texture.js'
import { VertexBuffer } from '../buffer/vertexBuffer.js'
import { IndirectBuffer } from '../buffer/indirectBuffer.js'
import { IndexBuffer } from '../buffer/indexBuffer.js'
import { BlockRef } from '../../core/data/blockRef.js'
import { Sampler } from '../sampler/sampler.js'
import director from '../director/director.js'
import { ScratchObject } from '../../core/object/object.js'

/**
 * @typedef {Object} VertexBindingDescription
 * @property {VertexBuffer} buffer
 * @property {number} [visibility]
 * @property {boolean} [isInstanced]
 */

/**
 * @typedef {Object} IndexBindingDescription
 * @property {IndexBuffer} buffer
 */

/**
 * @typedef {Object} IndexBinding
 * @property {IndexBuffer} [buffer]
 */

/**
 * @typedef {Object} IndirectBindingDescription
 * @property {IndirectBuffer} [buffer]
 * @property {number} [byteOffset]
 */

/**
 * @typedef {Object} IndirectBinding
 * @property {IndirectBuffer} [buffer]
 * @property {number} byteOffset
 */

/**
 * @typedef {Object} VertexBinding
 * @property {VertexBuffer} buffer
 * @property {number} visibility
 * @property {GPUVertexStepMode} stepMode
 */

/**
 * @typedef {Object} UniformBindingDescription
 * @property {string} name
 * @property {boolean} [dynamic]
 * @property {number} [visibility]
 * @property {{[varName: string]: Numeric | { type: string, data: any }}} map
 */

/**
 * @typedef {Object} UniformBinding
 * @property {string} name
 * @property {number} [visibility]
 * @property {{[dataName: string]: Function}} map
 * @property {import('./webgpu-utils.module.js').StructuredView} view
 * @property {BlockRef} ref
 */

/**
 * @typedef {Object} SharedUniformBindingDescription
 * @property {UniformBuffer} buffer
 * @property {number} [visibility]
 */

/**
 * @typedef {Object} SamplerBindingDescription
 * @property {Sampler} sampler
 * @property {number} [visibility]
 * @property {GPUSamplerBindingType} [bindingType]
 */

/**
 * @typedef {Object} StorageBindingDescription
 * @property {StorageBuffer} buffer
 * @property {boolean} [writable]
 */

/**
 * @typedef {Object} StorageBinding
 * @property {StorageBuffer} buffer
 * @property {number} visibility
 * @property {GPUBufferBindingType} type
 */

/**
 * @typedef {Object} TextureBindingDescription
 * @property {Texture} texture
 * @property {GPUTextureSampleType} [sampleType]
 * @property {GPUTextureViewDimension} [viewDimension]
 * @property {number} [visibility]
 * @property {boolean} [multisampled]
 * @property {boolean} [asStorage]
 * @property {GPUStorageTextureAccess} [accessibility]
 */

/**
 * @typedef {Object} SamplerBinding
 * @property {Sampler} sampler
 * @property {number} visibility
 * @property {GPUSamplerBindingType} bindingType
 */

/**
 * @typedef {Object} TextureBinding
 * @property {Texture} [texture]
 * @property {GPUTextureSampleType} sampleType
 * @property {GPUTextureViewDimension} viewDimension
 * @property {number} visibility
 * @property {boolean} multisampled
 * @property {boolean} asStorage
 * @property {GPUStorageTextureAccess} [accessibility]
 * @property {number} callbackIndex
 */

/**
 * @typedef {Object} BindingsDescription
 * @property {string} [name]
 * @property {Function} [range]
 * @property {IndexBindingDescription} [index]
 * @property {Array<SamplerBindingDescription>} [samplers]
 * @property {Array<UniformBindingDescription>} [uniforms]
 * @property {Array<SharedUniformBindingDescription>} [sharedUniforms]
 * @property {IndirectBindingDescription} [indirect]
 * @property {Array<VertexBindingDescription>} [vertices]
 * @property {Array<StorageBindingDescription>} [storages]
 * @property {Array<TextureBindingDescription>} [textures]
 */

class Binding extends ScratchObject {

    /**
     * @param {BindingsDescription} description 
     */
    constructor(description) {

        super()

        /**
         * @type {[UniformBinding]}
         */
        this.uniforms = []

        /**
         * @type {[SharedUniformBindingDescription]}
         */
        this.sharedUniforms = []

        /**
         * @type {IndexBinding}
         */
        this.indexBinding = description.index
        this.indexBinding && this.indexBinding.buffer.use()

        /**
         * @type {IndirectBinding}
         */
        this.indirectBinding = description.indirect ? {
            buffer: description.indirect.buffer.use(),
            byteOffset: description.indirect.byteOffset ? description.indirect.byteOffset : 0
        } : undefined

        /**
         * @type {[VertexBinding]}
         */
        this.vertexBindings = []

        /**
         * @type {[StorageBinding]}
         */
        this.storageBindings = []

        /**
         * @type {[TextureBinding]}
         */
        this.textureBindings = []

        /**
         * @type {[SamplerBinding]}
         */
        this.samplerBindings = []
        
        /**
         * @type {[GPUBindGroupLayout]}
         */
        this.layouts = []

        /**
         * @type {[GPUVertexBufferLayout]}
         */
        this.vertexLayouts = new Array(description.vertices ? description.vertices.length : 0)

        /**
         * @type {[GPUBindGroup]}
         */
        this.groups = []

        this.name = description.name ? description.name : 'Binding'

        description.vertices && description.vertices.forEach((bindingDesc) => {
            this.addVertexBuffer(bindingDesc)
        })

        let groupOrder = 0
        this.uniformOrder = 0;
        if (description.uniforms || description.sharedUniforms) {

            this.uniformOrder = groupOrder++
            description.uniforms?.forEach(uniformDesc => this.addUniformBlock(uniformDesc)) 
            description.sharedUniforms?.forEach(description => this.sharedUniforms.push({
                buffer: description.buffer.use(),
                visibility: description.visibility || (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE)
            })) 
        }

        this.storageOrder = 0;
        description.storages && (this.storageOrder = groupOrder++)
        description.storages && description.storages.forEach((bindingDesc) => {
            this.addStorageBuffer(bindingDesc)
        }) 

        this.textureOrder = 0;
        description.textures && (this.textureOrder = groupOrder++)
        description.textures && description.textures.forEach((bindingDesc) => {
            this.addTexture(bindingDesc)
        }) 

        description.samplers && description.samplers.forEach((samplerDesc, index) => {
            this.addSampler(index, samplerDesc)
        });

        this.isIndirect = description.range !== undefined ? false : true
        if (!this.isIndirect) this.range = description.range

        this.isComplete = false

        this.uniformBufferReady = false

        this.released = false

        // this.crteateBindGroupLayouts()

        director.addBinding(this)

        this.executable = true

    }

    /**
     * @param {BindingsDescription} description 
     * @returns 
     */
    static create(description) {

        return new Binding(description)
    }

    /**
     * @param {UniformBindingDescription} blockDesc 
     */
    addUniformBlock(blockDesc) {

        this.uniforms.push({
            ref: new BlockRef({
                map: blockDesc.map,
                name: blockDesc.name,
                dynamic: blockDesc.dynamic !== undefined ? blockDesc.dynamic : false,
            }),
            visibility: blockDesc.visibility || (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE)
        })

        const blocks = []
        this.uniforms.forEach(uniform => blocks.push(uniform.ref))

        /**
         * Create the uniform buffer
         * @type {UniformBuffer}
         * Notation: a binding has only one uniform buffer
         */
                this.uniformBuffer = UniformBuffer.create({
                    name: `Uniform buffer (${this.name})`,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
                    blocks: blocks
                }).use()
        
                this.uniformBufferReady = true
    }

    /**
     * @param {VertexBindingDescription} bindingDesc 
     */
    addVertexBuffer(bindingDesc) {

        let isInstanced = false
        isInstanced = bindingDesc.isInstanced === undefined ? isInstanced : bindingDesc.isInstanced

        this.vertexBindings.push({
            buffer: bindingDesc.buffer.use(),
            stepMode: isInstanced ? 'instance' : 'vertex',
            visibility: bindingDesc.visibility || GPUShaderStage.VERTEX
        })
    }

    /**
     * @param {StorageBindingDescription} bindingDesc 
     */
    addStorageBuffer(bindingDesc) {

        const writable = bindingDesc.writable !== undefined ? bindingDesc.writable : false

        this.storageBindings.push({
            buffer: bindingDesc.buffer.use(),
            type: writable ? 'storage' : 'read-only-storage',
            visibility: writable ? GPUShaderStage.COMPUTE : (GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE),
        })
    }

    /**
     * @param {TextureBindingDescription} bindingDesc 
     */
    addTexture(bindingDesc) {

        let accessibility = 'read-only'
        let asStorage = bindingDesc.asStorage !== undefined ? bindingDesc.asStorage : false
        let visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE
        if (asStorage) {
            visibility = GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE
            if (bindingDesc.texture.computable) accessibility = 'write-only'
        }
        if (bindingDesc.visibility) visibility = bindingDesc.visibility

        this.textureBindings.push({
            texture: bindingDesc.texture.use(),
            callbackIndex: bindingDesc.texture.registerCallback(() => {
                
                if (!this.isComplete) return
                director.dispatchEvent({type: 'createBindGroup', emitter: this, bindGroupType: 'texture', order: this.textureOrder})
            }),

            asStorage: asStorage,
            visibility: visibility,
            accessibility: accessibility,

            sampleType: bindingDesc.sampleType || 'float',
            multisampled: bindingDesc.multisampled !== undefined ? bindingDesc.multisampled : false,

            viewDimension: bindingDesc.viewDimension || '2d',
        })
    }

    /**
     * @param {number} index 
     * @param {SamplerBindingDescription} bindingDesc 
     */
    addSampler(index, bindingDesc) {

        this.samplerBindings[index] = {
            sampler: bindingDesc.sampler.use(),
            bindingType: bindingDesc.bindingType || 'filtering',
            visibility: bindingDesc.visibility || GPUShaderStage.FRAGMENT,
        }
    }

    /**
     * @deprecated
     * @param {GPUDevice} device 
     */
    createUniformBindGroupLayout(device) {

        if (!this.uniforms.length && !this.sharedUniforms.length) return

        // const device = getDevice()

        /**
         * @type {Array<GPUBindGroupLayoutEntry>}
         */
        const entries = new Array(this.uniforms.length + this.sharedUniforms.length)
        let index = 0
        this.uniforms.concat(this.sharedUniforms).forEach(block => {
            entries[index] = {
                binding: index++,
                visibility: block.visibility,
                buffer: { type: 'uniform' }
            }
        })

        this.layouts[this.uniformOrder] = device.createBindGroupLayout({
            label: `Uniform binding group layout`,
            entries: entries
        })
    }

    /**
     * @deprecated
     * @param {GPUDevice} device 
     */
    createUniformBindGroup(device) {

        if (!this.uniforms.length && !this.sharedUniforms.length) return
        
        // const device = getDevice()
        
        /**
         * @type {Array<GPUBindGroupEntry>}
         */
        const entries = new Array(this.uniforms.length + this.sharedUniforms.length)
        let index = 0
        this.uniforms.forEach(block => {
            const area = this.uniformBuffer.areaMap[block.ref.name]
            entries[index] = {
                binding: index++,
                resource: {
                    buffer: this.uniformBuffer.buffer, 
                    offset: area.start,
                    size: area.length
                }
            }
        })
        this.sharedUniforms.forEach(sharedUniform => {
            entries[index] = {
                binding: index++,
                resource: { buffer: sharedUniform.buffer.buffer }
            }
        })

        this.groups[this.uniformOrder] = device.createBindGroup({
            label: `Uniform binding group`,
            layout: this.layouts[this.uniformOrder],
            entries: entries
        })
    }

    /**
     * @deprecated
     * @param {GPUDevice} device 
     */
    createStorageBindGroupLayout(device) {

        if (!this.storageBindings.length) return
        
        // const device = getDevice()

        /**
         * @type {Array<GPUBindGroupLayoutEntry>}
         */
        const entries = new Array(this.storageBindings.length)
        this.storageBindings.forEach((storageBinding, index) => {
            entries[index] = {
                binding: index,
                buffer: {type: storageBinding.type}, 
                visibility: storageBinding.visibility
            }
        })

        this.layouts[this.storageOrder] = device.createBindGroupLayout({
            label: `Storage binding group layout (${this.name})`,
            entries: entries
        })
    }

    /**
     * @deprecated
     * @param {GPUDevice} device 
     */
    createStorageBindGroup(device) {

        if (!this.storageBindings.length) return
        
        // const device = getDevice()

        /**
         * @type {Array<GPUBindGroupEntry>}
         */
        const entries = new Array(this.storageBindings.length)
        this.storageBindings.forEach((storageBinding, index) => {
            entries[index] = {
                binding: index,
                resource: {buffer: storageBinding.buffer.buffer}
            }
        })

        this.groups[this.storageOrder] = device.createBindGroup({
            label: `Storage binding group (${this.name})`,
            layout: this.layouts[this.storageOrder],
            entries: entries
        })
    }

    createVertexBufferLayout() {
        /**
         * @type {Array<GPUVertexBufferLayout>}
         */
        let indexOffset = 0;
        this.vertexBindings.forEach((vertexBuffer, index) => {

            const attributes = new Array(vertexBuffer.buffer.attributes.length)
            vertexBuffer.buffer.attributes.forEach((attribute, index) => {
                attributes[index] = {
                    format: attribute.format,
                    shaderLocation: indexOffset++,
                    offset: attribute.offset
                }
            })

            this.vertexLayouts[index] = {
                arrayStride: vertexBuffer.buffer.stride,
                stepMode: vertexBuffer.stepMode,
                attributes: attributes
            }
        })
    }

    /**
     * @deprecated
     * @param {GPUDevice} device 
     */
    createTextureBindGroupLayout(device) {

        if (!this.samplerBindings.length && !this.textureBindings.length) return
        
        // const device = getDevice()

        /**
         * @type {Array<GPUBindGroupLayoutEntry>}
         */
        const entries = new Array(this.samplerBindings.length + this.textureBindings.length)
        this.samplerBindings.concat(this.textureBindings).forEach((binding, index) => {
            
            entries[index] = {
                binding: index,
                visibility: binding.visibility,
                ...(binding.sampler && {
                    sampler: {type: binding.bindingType}
                }),
                ...(binding.texture && (!binding.asStorage) && {
                    texture: {sampleType: binding.sampleType, viewDimension: binding.viewDimension, multisampled: binding.multisampled}
                }),
                ...(binding.texture && binding.asStorage && {
                    storageTexture: {access: binding.accessibility, format: binding.texture.format}
                })
            }
        })

        this.layouts[this.textureOrder] = device.createBindGroupLayout({
            label: `Texture binding group layout`,
            entries: entries
        })
    }

    /**
     * @deprecated
     * @param {GPUDevice} device 
     */
    createTextureBindGroup(device) {

        if (!this.samplerBindings.length && !this.textureBindings.length) return
        
        // const device = getDevice()
        
        /**
         * @type {Array<GPUBindGroupEntry>}
         */
        const entries= new Array(this.samplerBindings.length + this.textureBindings.length)
        this.samplerBindings.concat(this.textureBindings).forEach((binding, index) => {
            entries[index] = {
                binding: index,
                ...(binding.sampler && {
                    resource: binding.sampler.sampler
                }),
                ...(binding.texture && {
                    resource: binding.texture.view()
                })
            }
        })

        !this.layouts[this.textureOrder] && this.createTextureBindGroupLayout(device)
        this.groups[this.textureOrder] = device.createBindGroup({
            label: `Texture binding group (${this.name})`,
            layout: this.layouts[this.textureOrder],
            entries: entries
        })
    }

    /**
     * @param {string} type 
     * @returns {GPUBindGroupLayoutDescriptor}
     */
    exportLayoutDescriptor(type) {

        switch (type) {
            case 'uniform': {
                /**
                 * @type {Array<GPUBindGroupLayoutEntry>}
                 */
                const entries = new Array(this.uniforms.length + this.sharedUniforms.length)
                let index = 0
                this.uniforms.concat(this.sharedUniforms).forEach(block => {
                    entries[index] = {
                        binding: index++,
                        visibility: block.visibility,
                        buffer: { type: 'uniform' }
                    }
                })

                return {
                    label: `Uniform binding group layout (${this.name})`,
                    entries: entries
                }
            }
            case 'storage': {
                /**
                 * @type {Array<GPUBindGroupLayoutEntry>}
                 */
                const entries = new Array(this.storageBindings.length)
                this.storageBindings.forEach((storageBinding, index) => {
                    entries[index] = {
                        binding: index,
                        buffer: {type: storageBinding.type}, 
                        visibility: storageBinding.visibility
                    }
                })
                return {
                    label: `Storage binding group layout (${this.name})`,
                    entries: entries
                }
            }
            case 'texture': {

                /**
                 * @type {Array<GPUBindGroupLayoutEntry>}
                 */
                const entries = new Array(this.samplerBindings.length + this.textureBindings.length)
                this.samplerBindings.concat(this.textureBindings).forEach((binding, index) => {
                    
                    entries[index] = {
                        binding: index,
                        visibility: binding.visibility,
                        ...(binding.sampler && {
                            sampler: {type: binding.bindingType}
                        }),
                        ...(binding.texture && (!binding.asStorage) && {
                            texture: {sampleType: binding.sampleType, viewDimension: binding.viewDimension, multisampled: binding.multisampled}
                        }),
                        ...(binding.texture && binding.asStorage && {
                            storageTexture: {access: binding.accessibility, format: binding.texture.format}
                        })
                    }
                })
                return {
                    label: `Texture binding group layout (${this.name})`,
                    entries: entries
                }
            }
        }
    }

    /**
     * @param {string} type 
     * @returns {GPUBindGroupDescriptor}
     */
    exportDescriptor(type) {

        switch (type) {
            case 'uniform': {
                /**
                 * @type {Array<GPUBindGroupEntry>}
                 */
                const entries = new Array(this.uniforms.length + this.sharedUniforms.length)
                let index = 0
                this.uniforms.forEach(block => {
                    const area = this.uniformBuffer.areaMap[block.ref.name]
                    entries[index] = {
                        binding: index++,
                        resource: {
                            buffer: this.uniformBuffer.buffer, 
                            offset: area.start,
                            size: area.length
                        }
                    }
                })
                this.sharedUniforms.forEach(sharedUniform => {
                    entries[index] = {
                        binding: index++,
                        resource: { buffer: sharedUniform.buffer.buffer }
                    }
                })
        
                return {
                    label: `Uniform binding group (${this.name})`,
                    layout: this.layouts[this.uniformOrder],
                    entries: entries
                }
            }
            case 'storage': {
                /**
                 * @type {Array<GPUBindGroupEntry>}
                 */
                const entries = new Array(this.storageBindings.length)
                this.storageBindings.forEach((storageBinding, index) => {
                    entries[index] = {
                        binding: index,
                        resource: {buffer: storageBinding.buffer.buffer}
                    }
                })
        
                return {
                    label: `Storage binding group (${this.name})`,
                    layout: this.layouts[this.storageOrder],
                    entries: entries
                }
            }
            case 'texture': {
                /**
                 * @type {Array<GPUBindGroupEntry>}
                 */
                const entries= new Array(this.samplerBindings.length + this.textureBindings.length)
                this.samplerBindings.concat(this.textureBindings).forEach((binding, index) => {
                    entries[index] = {
                        binding: index,
                        ...(binding.sampler && {
                            resource: binding.sampler.sampler
                        }),
                        ...(binding.texture && {
                            resource: binding.texture.view()
                        })
                    }
                })

                // !this.layouts[this.textureOrder] && this.createTextureBindGroupLayout(device)
                return {
                    label: `Texture binding group (${this.name})`,
                    layout: this.layouts[this.textureOrder],
                    entries: entries
                }
            }
        }
    }

    crteateBindGroupLayouts() {

        if (this.uniforms.length || this.sharedUniforms.length)
            director.dispatchEvent({type: 'createBindGroupLayout', emitter: this, bindGroupType: 'uniform', order: this.uniformOrder})

        if (this.storageBindings.length)
            director.dispatchEvent({type: 'createBindGroupLayout', emitter: this, bindGroupType: 'storage', order: this.storageOrder})

        if (this.samplerBindings.length || this.textureBindings.length)
            director.dispatchEvent({type: 'createBindGroupLayout', emitter: this, bindGroupType: 'texture', order: this.textureOrder})
    }

    createBindGroups() {

        this.createVertexBufferLayout()

        if (this.uniforms.length || this.sharedUniforms.length){
            director.dispatchEvent({type: 'createBindGroupLayout', emitter: this, bindGroupType: 'uniform', order: this.uniformOrder})
            director.dispatchEvent({type: 'createBindGroup', emitter: this, bindGroupType: 'uniform', order: this.uniformOrder})
        }

        if (this.storageBindings.length) {
            director.dispatchEvent({type: 'createBindGroupLayout', emitter: this, bindGroupType: 'storage', order: this.storageOrder})
            director.dispatchEvent({type: 'createBindGroup', emitter: this, bindGroupType: 'storage', order: this.storageOrder})
        }

        if (this.samplerBindings.length || this.textureBindings.length) {

            director.dispatchEvent({type: 'createBindGroupLayout', emitter: this, bindGroupType: 'texture', order: this.textureOrder})
            director.dispatchEvent({type: 'createBindGroup', emitter: this, bindGroupType: 'texture', order: this.textureOrder})
        }
    }

    tryMakeComplete() {

        if (this.isComplete) return true
        if (this.released) return false

        for (const textureBinding of this.textureBindings) {
            if (!textureBinding.texture.texture) return false
        }

        this.createBindGroups()

        this.isComplete = true
        return true
    }
    
    update() {

        // Used to be the update method of the binding
        // {
        //     this.indirectBinding && this.indirectBinding.buffer.update()
        //     this.indexBinding && this.indexBinding.buffer.update()
        //     this.updateStorageBuffer()
        //     this.updateVertexBuffer()
        //     this.updateUniformBlock()
        // }
        // this.updateTexture()

    }

    getIndirect() {

        return this.indirectBinding
    }

    getBindGroupLayouts() {

        return this.layouts
    }

    getBindGroups() {

        return this.groups
    }

    getVertexLayouts() {

        return this.vertexLayouts
    }

    /**
     * 
     * @param {GPURenderPassEncoder | GPUComputePassEncoder} pass 
     */
    setBindGroups(pass) {

        this.groups.forEach((group, index) => {
            pass.setBindGroup(index, group);
        });
    }

    /**
     * 
     * @param {GPURenderPassEncoder} pass 
     */
    setVertexBuffers(pass) {

        this.vertexBindings.forEach((vertexBinding, index) => {
            pass.setVertexBuffer(index, vertexBinding.buffer.buffer)
        })
    }

    getShader() {
        return this.shader.shaderModule
    }

    getIndex() {
        return this.indexBinding ? this.indexBinding.buffer : undefined
    }

    destroy() {

        this.isComplete = false
        this.released = true

        this.range = null

        this.uniforms.forEach(block => {
            block.ref = block.ref?.release()
            block.visibility = null
            block.name = null
            block.view = null
            block.map = null
        })
        this.uniforms = null

        this.sharedUniforms.forEach(sharedUniform => {
            sharedUniform.buffer = sharedUniform.buffer.release()
            sharedUniform.visibility = null
        })
        this.sharedUniforms = null

        if (this.indexBinding) {
            this.indexBinding.buffer = this.indexBinding.buffer.release()
            this.indexBinding = null
        }
    
        if (this.indirectBinding) {
            this.indirectBinding.buffer = this.indirectBinding.buffer.release()
            this.indirectBinding = null
        }
    
        this.vertexBindings.forEach(binding => {
            binding.buffer = binding.buffer.release()
            binding.visibility = null
            binding.stepMode = null
        })
        this.vertexBindings = null
    
        this.storageBindings.forEach(binding => {
            binding.buffer = binding.buffer.release()
            binding.visibility = null
            binding.type = null
        })
        this.storageBindings = null

        this.textureBindings.forEach(binding => {
            binding.callbackIndex = binding.texture.removeCallback(binding.callbackIndex)
            binding.texture = binding.texture.release()
            binding.viewDimension = null
            binding.accessibility = null
            binding.multisampled = null
            binding.sampleType = null
            binding.visibility = null
            binding.asStorage = null
        })
        this.textureBindings = null
    
        this.samplerBindings.forEach(binding => {
            binding.sampler = binding.sampler.release()
            binding.bindingType = null
            binding.visibility = null
        })
        this.samplerBindings = null
    
        this.vertexLayouts = null
        this.layouts = null
        this.groups = null
        this.vertexLayouts = null
        this.layouts = null
        this.groups = null
    
        this.uniformBuffer = this.uniformBuffer?.release()
        this.refCount = null
        this.name = null

        super.destroy()

        return null
    }
}

/**
 * @param {BindingsDescription} description 
 */
function binding(description) {

    return Binding.create(description)
}

export {
    binding,
    Binding,
}