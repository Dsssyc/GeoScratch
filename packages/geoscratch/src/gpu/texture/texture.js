import { ScratchObject } from '../../core/object/object.js'
import director from '../director/director.js'
import monitor from '../monitor/monitor.js'

/**
 * @typedef {Object} TextureResourceDescription
 * @property {'imageBitmap' | 'buffer' | 'data' | 'size' | 'canvasTexture'} [dataType]
 * @property {Function} [imageBitmap]
 * @property {Function} [resource]
 * @property {Function} [canvasTexture]
 * @property {Function} [size]
 */

/**
 * @typedef {Object} TextureDescription
 * @property {string} [name]
 * @property {number} [usage]
 * @property {boolean} [flipY]
 * @property {boolean} [mipMapped]
 * @property {boolean} [computable]
 * @property {number} [sampleCount]
 * @property {GPUTextureFormat} [format]
 * @property {TextureResourceDescription} [resource]
 */

class Texture extends ScratchObject {

    /**
     * @param {TextureDescription} description 
     */
    constructor(description) {

        super()
        
        this.name = description.name ? description.name : 'Texture'

        this.resource = description.resource

        this.resource.dataType = description.resource.dataType ? description.resource.dataType : 'size'

        this.flipY = (description.flipY !== undefined) ? description.flipY : true

        this.computable = description.computable ? description.computable : false

        this.usage = description.usage ? description.usage : (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC)

        if (this.computable) this.usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC

        this.format = description.format ? description.format : 'rgba8unorm'

        this.mipMapped = description.mipMapped ? description.mipMapped : false

        /**
         * @type {'clean' | 'imageBitmap' | 'buffer' | 'data' | 'size' | 'canvasTexture'}
         */
        this.dirtyType = this.resource.dataType

        this.sampleCount = description.sampleCount

        /**
         * @type {{[dirtyType: string]: Function}}
         */
        this.executeUpdate = {
            'clean': () => {},
            'size': () => this.updateBySize(),
            'imageBitmap': () => this.updateByImageBitmap(),
            'canvasTexture': () => this.updateByCanvasTexture(),
        }

        /**
         * @type {Array<Function>}
         */
        this.onChangeHandlers = []

        this.byteLength = 0;

        this.updatePerFrame = false

        this.needUpdate()

        this.texture = undefined
    }

    /**
     * 
     * @param {TextureDescription} description 
     */
    static create(description) {

        const texture = new Texture(description)

        return texture;
    }

    view() {
        return this.texture.createView({
            ...(this.mipMapped && {
                baseMipLevel: 0, 
                mipLevelCount: Math.max(this.texture.mipLevelCount, 1)
            })
        })
    }

    updateByImageBitmap() {

        if (this.texture) {
            monitor.memorySizeInBytes -= this.byteLength
            this.texture.destroy()
        }

        const {imageBitmap, id} = this.resource.imageBitmap()
        if (!imageBitmap) return

        director.dispatchEvent({type: 'createTextureByImageBitmap', emitter: this, imageBitmap})

        this.dirtyType = 'clean'
        this.getByteLength()
        monitor.memorySizeInBytes += this.byteLength
    }

    updateByCanvasTexture() {

        if (this.texture) {
            monitor.memorySizeInBytes -= this.byteLength
        }

        const gpuTexture = this.resource.canvasTexture()

        this.texture = gpuTexture
        this.dirtyType = 'canvasTexture'
        
        this.getByteLength()
        monitor.memorySizeInBytes += this.byteLength

        this.onChangeHandlers.forEach(handler => handler && handler())
    }

    updateBySize() {

        if (this.texture) {
            monitor.memorySizeInBytes -= this.byteLength
            this.texture.destroy()
        }

        director.dispatchEvent({type: 'createTextureBySize', emitter: this})


        this.getByteLength()
        this.dirtyType = 'clean'
        monitor.memorySizeInBytes += this.byteLength
    }

    getByteLength()  {

        const formatSize = {
            'r8unorm': 1,
            'r16float': 2,
            'rg8unorm': 2,
            'r32float': 4,
            'rg32float': 4,
            'rg16float': 4,
            'rgba8unorm': 4,
            'bgra8unorm': 4,
            'rgba16float': 8,
            'rgba32float': 16,
            'depth24plus': 3,
            'depth32float': 4,
        }
    
        if (!(this.format in formatSize)) {
            throw new Error(`Unsupported format: ${this.format}`)
        }
    
        let singleLayerSize = this.texture.width * this.texture.height * formatSize[this.format]
    
        this.byteLength = 0
        let currentWidth = this.texture.width
        let currentHeight = this.texture.height
        if (this.mipMapped) {
            while (currentWidth > 1 || currentHeight > 1) {
                this.byteLength += singleLayerSize
                currentWidth = Math.max(1, currentWidth / 2)
                currentHeight = Math.max(1, currentHeight / 2)
                singleLayerSize = currentWidth * currentHeight * formatSize[this.format]
            }
        }
    
        this.byteLength += singleLayerSize;
    }

    get width() {

        if (!this.texture) {

            if (this.resource.size) return this.resource.size()[0]
            else return 0
        }
        return this.texture.width
    }

    get height() {

        if (!this.texture) {

            if (this.resource.size) return this.resource.size()[1]
            else return 0
        }
        return this.texture.height
    }

    update() {

        this.executeUpdate[this.dirtyType](this)
    }

    needUpdate() {

        director.addToUpdateList(this)
    }

    /**
     * @param {TextureDescription} [description] 
     */
    reset(description) {
        
        if (description) {

            this.name = description.name ? description.name : this.name
            this.flipY = description.flipY ? description.flipY : this.flipY
            this.usage = description.usage ? description.usage : this.usage
            this.format = description.format ? description.format : this.format
            this.mipMapped = description.mipMapped ? description.mipMapped : this.mipMapped
            this.resource = description.resource 
            this.dirtyType = description.resource.dataType ? description.resource.dataType : 'size'
        } else {

            this.dirtyType = this.resource.dataType
        }

        if (!this.texture) return

        this.update()

        // May Be Dangerous!
        this.texture && this.onChangeHandlers.forEach(handler => handler && handler())
    }

    registerCallback(callback) {
        this.onChangeHandlers.push(callback)

        return this.onChangeHandlers.length - 1
    }

    removeCallback(index) {

        this.onChangeHandlers[index] = null
        return null
    }

    destroy() {

        if (this.texture) {
            this.texture.destroy()
            this.texture = null
        }

        this.uuid = null
        this.refCount = null
        this.name = null
        this.resource = null
        this.flipY = null
        this.computable = null
        this.usage = null
        this.format = null
        this.mipMapped = null
        this.dirtyType = null

        for (const key in this.executeUpdate) {
            this.executeUpdate[key] = null
        }
        this.executeUpdate = null

        this.onChangeHandlers.length = 0
        this.onChangeHandlers = null

        this.byteLength && (monitor.memorySizeInBytes -= this.byteLength)
        this.byteLength = 0

        super.destroy()
    }
}

/**
 * 
 * @param {TextureDescription} description 
 */
function texture(description) {

    return Texture.create(description)
}

export {
    texture,
    Texture
}