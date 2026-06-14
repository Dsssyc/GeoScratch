import director from "../director/director.js"
import { vec2f, vec2i, vec2u } from '../../core/numericType/numericType.js'
import { Texture } from "./texture.js"

/**
 * Information about the canvas and its GPU context.
 *
 * @typedef {Object} ScreenDescription
 * @property {HTMLCanvasElement} canvas - The HTML canvas element.
 * @property {number} [sampleCount] - The sample count, which can be 1 or 4.
 * @property {GPUCanvasAlphaMode} [alphaMode]
 */

class Screen extends Texture {
    
    /**
     * @param {ScreenDescription} description 
     */
    constructor(description) {

        super({
            name: 'Texture (Canvas)',
            format: navigator.gpu.getPreferredCanvasFormat(),
            resource: {
                canvasTexture: () => undefined,
                dataType: 'canvasTexture'
            },
        })

        this.canvas = description.canvas
        this.canvas.width = Math.max(1, Math.min(director.limits.maxTextureDimension2D, this.canvas.clientWidth)) * window.devicePixelRatio
        this.canvas.height = Math.max(1, Math.min(director.limits.maxTextureDimension2D, this.canvas.clientHeight)) * window.devicePixelRatio

        this.sampleCount = description.sampleCount ? description.sampleCount : 1

        this.alphaMode = description.alphaMode

        this.presentationFormat = navigator.gpu.getPreferredCanvasFormat()
        
        /**
         * @type {Array<{texture: Texture, multiplier: number[]}>}
         */
        this.screenDependentTextures = []

        this.screenDependentElements = []

        this._sizeI = vec2i(this.canvas.width, this.canvas.height)
        this._sizeU = vec2u(this.canvas.width, this.canvas.height)
        this._sizeF = vec2f(this.canvas.width, this.canvas.height)

        this.needUpdate()
        this.updatePerFrame = true

        window.addEventListener('resize', () => this.onWindowResize())
    }

    /**
     * @param {ScreenDescription} description 
     */
    static create(description) {

        return new Screen(description)
    }

    getCurrentCanvasTexture() {

        // return this.renderTarget
        return this.texture
    }

    exportDescriptor() {

        return {
            format: this.presentationFormat,
            alphaMode: this.alphaMode
        }
    }

    update() {

        if (this.context === undefined) {

            director.dispatchEvent({type: 'createContext', emitter: this})
            this.resource.canvasTexture = () => this.context.getCurrentTexture()
            this.onWindowResize()
        }

        super.update()
    }

    /**
     * 
     * @param {string} [name] 
     * @param {number} [usage]
     * @param {boolean} [mipMapped]
     * @param {boolean} [computable]
     * @param {GPUTextureFormat} [format] 
     * @param {number[]} [multiplier = [1, 1]]
     */
    createScreenDependentTexture(name, format, computable, mipMapped, usage, multiplier = [1, 1]) {
        
        const texture = Texture.create({
            name,
            usage,
            format,
            mipMapped,
            computable,
            resource: { size: () => [ this.canvas.width * multiplier[0], this.canvas.height * multiplier[1] ] }
        })

        this.addScreenDependentTexture(texture, multiplier)
        
        return texture
    }

    /**
     * 
     * @param {Texture} texture 
     * @param {number[]} [multiplier = [1, 1]]
     * @returns {Screen}
     */
    addScreenDependentTexture(texture, multiplier = [1, 1]) {

        this.screenDependentTextures.push({texture, multiplier})

        return this
    }

    addScreenDependentElement(element) {

        this.screenDependentElements.push(element)

        return this
    }

    onWindowResize() {

        let width, height
        width = Math.max(1, Math.min(director.limits.maxTextureDimension2D, this.canvas.clientWidth)) * window.devicePixelRatio
        height = Math.max(1, Math.min(director.limits.maxTextureDimension2D, this.canvas.clientHeight)) * window.devicePixelRatio

        this.canvas.width = width
        this.canvas.height = height
        this._sizeI.data = [ this.canvas.width, this.canvas.height ]
        this._sizeU.data = [ this.canvas.width, this.canvas.height ]
        this._sizeF.data = [ this.canvas.width, this.canvas.height ]

        if (this.sampleCount > 1) {
        }

        this.screenDependentTextures.forEach(textureContent => {

            textureContent.texture.texture && textureContent.texture.reset({
                resource: { size: () => [ width * textureContent.multiplier[0], height * textureContent.multiplier[1] ] }
            })
        })

        this.screenDependentElements.forEach(element => {
            
            element.onWindowResize & element.onWindowResize()
        })
    }

    get width() {

        return this.canvas.width
    }

    get height() {

        return this.canvas.height
    }

    get sizeF() {

        return this._sizeF
    }

    get sizeU() {

        return this._sizeU
    }

    get sizeI() {

        return this._sizeI
    }

    swap() {

        this.reset()
    }

    destroy() {

        super.destroy()
    }
}

/**
 * @param {ScreenDescription} description 
 */
function screen(description) {

    return Screen.create(description)
}

export {
    screen,
    Screen,
}