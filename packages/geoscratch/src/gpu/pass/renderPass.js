import { UUID } from "../../core/utils/uuid.js"
import { Binding } from "../binding/binding.js"
import { RenderPipeline } from "../pipeline/renderPipeline.js"
import { Texture } from "../texture/texture.js"

/**
 * @typedef {Object} RenderPassDescription
 * @property {string} name
 * @property {Array<{colorResource: Texture, clearValue?: Array<number>, loadOp?: 'clear' | 'load', storeOp?: 'store'| 'discard'}>} colorAttachments
 * @property {{depthStencilResource: Texture, depthClearValue?: number, depthLoadOp?: 'clear' | 'load', depthStoreOp?: 'store' | 'discard'}} [depthStencilAttachment]
 */

export class RenderPass {

    /**
     * @param {RenderPassDescription} description 
     */
    constructor(description) {

        this.uuid = UUID()
        
        this.name = description.name
        this.colorDescription = description.colorAttachments
        /**
         * @type {Array<GPURenderPassColorAttachment>}
         */
        this.colorAttachments = new Array(this.colorDescription.length)
        this.depthStencilDescription = description.depthStencilAttachment
        this.depthStencilAttachment = undefined

        /**
         * @type {Array<{pipeline: RenderPipeline, binding: Binding}>}
         */
        this.drawcalls = []

        this.pass = null

        this.dirty = true
        this.initialized = false
        this.completed = false
        this.executable = true
    }

    addColorAttachments() {

        this.colorDescription.forEach((description, index) => {

            this.colorAttachments[index] = {
                view: description.colorResource.view(),
                clearValue: description.clearValue ? description.clearValue : [0.0, 0.0, 0.0, 1.0],
                loadOp: description.loadOp ? description.loadOp : 'clear',
                storeOp: description.storeOp ? description.storeOp : 'store'
            }

            description.colorResource.registerCallback(() => {
                this.colorAttachments[index].view = description.colorResource.view()
            })
        })
    }

    addDepthStencilAttachment() {

        if (!this.depthStencilDescription) return

        this.depthStencilAttachment = {
            view: this.depthStencilDescription.depthStencilResource.view(),
            depthClearValue: this.depthStencilDescription.depthClearValue ? this.depthStencilDescription.depthClearValue : 1.0,
            depthLoadOp: this.depthStencilDescription.depthLoadOp ? this.depthStencilDescription.depthLoadOp : 'clear',
            depthStoreOp: this.depthStencilDescription.depthStoreOp ? this.depthStencilDescription.depthStoreOp : 'store',
        }

        this.depthStencilDescription.depthStencilResource.registerCallback(() => {
            this.depthStencilAttachment.view = this.depthStencilDescription.depthStencilResource.view()
        })
    }

    makeColorFormats() {

        const colorFormats = new Array(this.colorDescription.length)
        this.colorDescription.forEach((description, index) => {
            colorFormats[index] = description.colorResource.format
        })
        return colorFormats
    }

    makeDepthStencilFormat() {

        if (!this.depthStencilDescription) return undefined
        return this.depthStencilDescription.depthStencilResource.format
    }

    /**
     * @param {RenderPassDescription} description 
     */
    static create(description) {
        
        return new RenderPass(description)
    }

    updateColorAttachments() {

        this.colorDescription.forEach((description, index) => {

            this.colorAttachments[index] = {
                view: description.colorResource.view(),
                clearValue: description.clearValue ? description.clearValue : [0.0, 0.0, 0.0, 0.0],
                loadOp: description.loadOp ? description.loadOp : 'clear',
                storeOp: description.storeOp ? description.storeOp : 'store'
            }
        })
    }

    updateDepthStencilAttachment() {

        if (!this.depthStencilDescription) return

        this.depthStencilAttachment = {
            view: this.depthStencilDescription.depthStencilResource.view(),
            depthClearValue: this.depthStencilDescription.depthClearValue ? this.depthStencilDescription.depthClearValue : 1.0,
            depthLoadOp: this.depthStencilDescription.depthLoadOp ? this.depthStencilDescription.depthLoadOp : 'clear',
            depthStoreOp: this.depthStencilDescription.depthStoreOp ? this.depthStencilDescription.depthStoreOp : 'store',
        }
    }

    /**
     * 
     * @param {number} canvasTextureIndex 
     */
    updateSwapChain(canvasTextureIndex = 0) {

        this.passDescription.colorAttachments[canvasTextureIndex].view = 
        this.colorDescription[canvasTextureIndex].colorResource.view()
    }

    initialize() {
        
        if (this.initialized) return

        this.addColorAttachments()
        this.addDepthStencilAttachment()
        this.initialize = true
    }

    isComplete() {

        if (this.completed) return true

        this.completed = true

        this.colorDescription.forEach(description => {
            !description.colorResource.texture && (this.completed = false)
        })

        this.depthStencilDescription && !this.depthStencilDescription.depthStencilResource.texture && (this.completed = false)

        return this.completed
    }

    update() {

        this.initialize()

        this.updateColorAttachments()
        this.updateDepthStencilAttachment()

        this.passDescription = {
            label: `Render pass (${this.name})`,
            colorAttachments: this.colorAttachments,
            ...(this.depthStencilDescription && {
                depthStencilAttachment: this.depthStencilAttachment
            })
        }

        this.dirty = false
    }

    /**
     * 
     * @param {RenderPipeline} pipeline 
     * @param {Binding} binding 
     */
    add(pipeline, binding) {

        this.drawcalls.push({pipeline, binding})
        return this
    }

    empty() {
        this.drawcalls = []
    }

    /**
     * @param {GPUCommandEncoder} encoder 
     */
    execute(encoder) {

        if (!this.isComplete()) return

        this.dirty && this.update()

        if (!this.executable) return

        this.pass = encoder.beginRenderPass(this.passDescription)

        this.drawcalls.forEach(({ binding, pipeline }) => {
            
            if (!binding.tryMakeComplete() || !pipeline.tryMakeComplete(this, binding) || !pipeline.executable || !binding.executable) return

            pipeline.draw(this, binding)
        })

        this.pass.end()
    }
}

/**
 * @param {RenderPassDescription} description 
 */
export function renderPass(description) {

    return RenderPass.create(description)
}
