import { ScratchObject } from '../../core/object/object.js'
import director from '../director/director.js'

/**
 * @typedef {Object} SamplerDescription
 * @property {string} name
 * @property {number} [mipmap]
 * @property {number} [maxAnisotropy]
 * @property {Array<GPUFilterMode>} filterMinMag
 * @property {Array<GPUAddressMode>} addressModeUVW
 */

export class Sampler extends ScratchObject {

    /**
     * @param {SamplerDescription} description 
     */
    constructor(description) {

        super()

        /**
         * @type {string}
         */
        this.name = description.name
        /**
         * @type {GPUFilterMode}
         */
        this.minFilter = description.filterMinMag.length > 0 ? description.filterMinMag[0] : 'linear'
        /**
         * @type {GPUFilterMode}
         */
        this.magFilter = description.filterMinMag.length > 1 ? description.filterMinMag[1] : 'linear'
        /**
         * @type {GPUAddressMode}
         */
        this.addressModeU = description.addressModeUVW.length > 0 ? description.addressModeUVW[0] : 'repeat'
        /**
         * @type {GPUAddressMode}
         */
        this.addressModeV = description.addressModeUVW.length > 1 ? description.addressModeUVW[1] : 'repeat'
        /**
         * @type {GPUAddressMode}
         */
        this.addressModeW = description.addressModeUVW.length > 2 ? description.addressModeUVW[2] : 'repeat'
        /**
         * @type {GPUMipmapFilterMode}
         */
        this.mipmapFilter = description.mipmap !== undefined ? description.mipmap : undefined
        /**
         * @type {number}
         */
        this.maxAnisotropy = description.maxAnisotropy
        /**
         * @type {number}
         */
        this.refCount = 0
        /**
         * @type {GPUDevice}
         */
        this.device = undefined
        /**
         * @type {GPUSampler}
         */
        this._sampler = undefined

        // director.dispatchEvent({type: 'createSampler', emitter: this})
        this.needUpdate()
    }

    /**
     * @param {SamplerDescription} description 
     * @returns {Sampler}
     */
    static create(description) {

        return new Sampler(description)
    }

    get sampler() {
        
        return this._sampler
    }

    /**
     * @param {GPUSampler} sampler 
     */
    set sampler(sampler) {

        if (sampler instanceof GPUSampler) this._sampler = sampler
        else console.warn('ERROR::THE_SAMPLER_GETTED_IS_NOT_INSTANCE_OF_GPUSampler')
    }

    /**
     * @returns {GPUSamplerDescriptor}
     */
    exportDescriptor() {
        return {
            label: this.name,
            minFilter: this.minFilter,
            magFilter: this.magFilter,
            addressModeU: this.addressModeU,
            addressModeV: this.addressModeV,
            addressModeW: this.addressModeW,
            mipmapFilter: this.mipmapFilter,
            maxAnisotropy: this.maxAnisotropy,
        }
    }

    /**
     * @deprecated
     */
    update() {

        director.dispatchEvent({type: 'createSampler', emitter: this})
    }

    needUpdate() {

        director.addToUpdateList(this)
    }

    destroy() {

        this.maxAnisotropy = undefined
        this.addressModeU = undefined
        this.addressModeV = undefined
        this.addressModeW = undefined
        this.mipmapFilter = undefined
        this._sampler = undefined
        this.minFilter = undefined
        this.magFilter = undefined
        this.refCount = undefined
        this.device = undefined
        this.name = undefined

        super.destroy()
    }
}

/**
 * @param {SamplerDescription} description 
 */
export function sampler(description) {

    return Sampler.create(description)
}