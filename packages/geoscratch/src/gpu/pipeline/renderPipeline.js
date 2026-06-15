import { UUID } from '../../core/utils/uuid.js'
import { Binding } from '../binding/binding.js'
import { NoBlending } from '../blending/blending.js'
import director from '../director/director.js'
import { RenderPass } from '../pass/renderPass.js'
import { Shader } from '../shader/shader.js'

/**
 * @typedef {Object} RenderPipelineDescription
 * @property {string} name
 * @property {{module: Shader, vsEntryPoint?: string, fsEntryPoint?: string}} shader
 * @property {Array<{format?: GPUTextureFormat, blend?: GPUBlendState, writeMask?: GPUColorWriteFlags}>} [colorTargetStates]
 * @property {GPUPrimitiveState} [primitive]
 * @property {boolean} [depthTest]
 * @property {boolean} [asBundle]
 */

class RenderPipeline {

    /**
     * @param {RenderPipelineDescription} description 
     */
    constructor(description) {

        this.uuid = UUID()
        this.shader = description.shader.module.use()
        this.name = description.name || 'Render Pipeline'
        this.vsEntryPoint = description.shader.vsEntryPoint || 'vMain'
        this.fsEntryPoint = description.shader.fsEntryPoint || 'fMain'

        /**
         * @type {Array<GPUColorTargetState>}
         */
        this.colorTargetStates = []
        this.colorTargetStateDescriptions = description.colorTargetStates

        /**
         * @type {GPUDepthStencilState}
         */
        this.depthStencilState = undefined

        /**
         * @type {GPUPrimitiveState}
         */
        this.primitive = description.primitive || {
            cullMode: 'none',
            topology: 'triangle-list',
        }
        
        this.depthTest = description.depthTest

        this.pipelineLayout = undefined
        this.pipeline = undefined

        this.asBundle = description.asBundle !== undefined ? description.asBundle : false
        this.bundleDirty = this.asBundle
        this.renderBundle = undefined

        this.pipelineCreating = false

        this.isFinite = false
        this.triggerCount = 0

        this.executable = true
    }

    /**
     * @param {RenderPipelineDescription} description 
     */
    static create(description) {
        return new RenderPipeline(description)
    }

    /**
     * @deprecated
     * @param {GPUDevice} device
     * @param {Binding} binding 
     */
    createPipelineLayout(device, binding) {

        // const device = getDevice()
        this.pipelineLayout = device.createPipelineLayout({
            label: `Rendering pipline layout (${this.name})`,
            bindGroupLayouts: binding.getBindGroupLayouts(),
        })
    }

    exportLayoutDescriptor(binding) {

        if (this.layout) return this.layout

        this.layout = {
            label: `Rendering pipline layout (${this.name})`,
            bindGroupLayouts: binding.getBindGroupLayouts(),
        }

        return this.layout
    }

    exportDescriptor(binding) {

        /**
         * @type {GPUPrimitiveState}
         */
        const primitiveState = {
            topology: this.primitive.topology,
            frontFace: this.primitive.frontFace,
            cullMode: this.primitive.cullMode,
            unclippedDepth: this.primitive.unclippedDepth,
            ...(binding.indexBinding && (this.primitive.topology === 'line-strip' || this.primitive.topology === 'triangle-strip') && {
                stripIndexFormat: binding.indexBinding.buffer.type
            })
        }

        return {
            label: `Rendering pipeline (${this.name})`,
            layout: this.pipelineLayout,
            vertex: {
                module: this.shader.shaderModule,
                entryPoint: this.vsEntryPoint,
                buffers: binding.getVertexLayouts(),
            },
            fragment: {
                module: this.shader.shaderModule,
                entryPoint: this.fsEntryPoint,
                targets: this.colorTargetStates,
            },
            primitive: primitiveState,
            depthStencil: this.depthStencilState,
        }
    }

    /**
     * @param {RenderPass} pass
     */
    createTargetState(pass) {

        const colorFormats = pass.makeColorFormats()
        this.colorTargetStates = new Array(colorFormats.length)
        colorFormats.forEach((format, index) => {
            this.colorTargetStates[index] = {
                format: format,
                blend: this.colorTargetStateDescriptions !== undefined ? this.colorTargetStateDescriptions[index].blend : undefined,
                writeMask: this.colorTargetStateDescriptions !== undefined ? this.colorTargetStateDescriptions[index].writeMask: undefined,
            }
        })

        const depthStencilFormat = pass.makeDepthStencilFormat()
        if (depthStencilFormat !== undefined) {
            this.depthTest === undefined && (this.depthTest = true)

            this.depthStencilState = {
                depthWriteEnabled: this.depthTest,
                depthCompare: 'less',
                format: depthStencilFormat
            }
        }
    }

    /**
     * @param {RenderPass} renderPass 
     * @param {Binding} binding 
     */
    createPipeline(renderPass, binding) {

        // const device = getDevice()

        this.pipelineCreating = true

        // this.createPipelineLayout(device, binding)

        director.dispatchEvent({type: 'createPipelineLayout', emitter: this, binding})
        this.createTargetState(renderPass)
        director.dispatchEvent({type: 'createRenderPipelineAsync', emitter: this, binding})


        // /**
        //  * @type {GPUPrimitiveState}
        //  */
        // const primitiveState = {
        //     topology: this.primitive.topology,
        //     frontFace: this.primitive.frontFace,
        //     cullMode: this.primitive.cullMode,
        //     unclippedDepth: this.primitive.unclippedDepth,
        //     ...(binding.indexBinding && (this.primitive.topology === 'line-strip' || this.primitive.topology === 'triangle-strip') && {
        //         stripIndexFormat: binding.indexBinding.buffer.type
        //     })
        // }

        // device.createRenderPipelineAsync({
        //     label: `rendering pipeline (${this.name})`,
        //     layout: this.pipelineLayout,
        //     vertex: {
        //         module: this.shader.shaderModule,
        //         entryPoint: this.vsEntryPoint,
        //         buffers: binding.getVertexLayouts(),
        //     },
        //     fragment: {
        //         module: this.shader.shaderModule,
        //         entryPoint: this.fsEntryPoint,
        //         targets: this.colorTargetStates,
        //     },
        //     primitive: primitiveState,
        //     depthStencil: this.depthStencilState,
        // })
    }

    /**
     * @param {RenderPass} renderPass 
     * @param {Binding} binding 
     */
    tryMakeComplete(renderPass, binding) {

        if (this.pipeline) return true

        this.shader.isComplete() && !this.pipelineCreating && this.createPipeline(renderPass, binding)
        return false
    }

    /**
     * 
     * @param {RenderPass} renderPass 
     * @param {Binding} binding 
     */
    makeRenderBundle(renderPass, binding) {

        // const device = getDevice()

        director.dispatchEvent({type: 'createRenderBundle', emitter: this, renderPass, binding})
        // const renderBundleEncoder = device.createRenderBundleEncoder({
        //     colorFormats: renderPass.makeColorFormats(),
        //     depthStencilFormat: renderPass.makeDepthStencilFormat(),
        // })
        // this.executeRenderPass(renderBundleEncoder, binding)
        // this.renderBundle = renderBundleEncoder.finish()
        // this.bundleDirty = false
    }

    /**
     * 
     * @param {GPURenderPassEncoder | GPURenderBundleEncoder} renderPass 
     * @param {Binding} binding 
     */
    executeRenderPass(renderPass, binding) {
        
        binding.setBindGroups(renderPass)
        binding.setVertexBuffers(renderPass)
        renderPass.setPipeline(this.pipeline)

        if (!binding.indexBinding) {
            if (binding.isIndirect) renderPass.drawIndirect(binding.indirectBinding.buffer.buffer, binding.indirectBinding.byteOffset)
            else renderPass.draw(...binding.range())
        } else {
            renderPass.setIndexBuffer(binding.indexBinding.buffer.buffer, binding.indexBinding.buffer.type)
            if (binding.isIndirect) renderPass.drawIndexedIndirect(binding.indirectBinding.buffer.buffer, binding.indirectBinding.byteOffset)
            else renderPass.drawIndexed(...binding.range())
        }
    }

    /**
     * @param {number} counts 
     */
    triggerFiniteTimes(counts) {

        this.isFinite = true
        this.triggerCount = counts

        return this
    }

    /**
     * 
     * @param {RenderPass} renderPass 
     * @param {Binding} binding 
     */
    draw(renderPass, binding) {

        if (this.isFinite && (!this.triggerCount)) return
        else this.triggerCount = Math.max(this.triggerCount - 1, 0)

        if (!this.executable) return
        
        if (this.asBundle) {
            if (this.bundleDirty) this.makeRenderBundle(renderPass, binding)
            renderPass.pass.executeBundles([this.renderBundle])
        } 
        else this.executeRenderPass(renderPass.pass, binding)
    }
}

/**
 * @param {RenderPipelineDescription} description 
 */
function renderPipeline(description) {

    return RenderPipeline.create(description)
}

export {
    renderPipeline,
    RenderPipeline
}