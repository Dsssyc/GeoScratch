import { f32, i32 } from '../../core/numericType/numericType.js'
import { Binding } from "../../gpu/binding/binding.js"
import { Texture } from "../../gpu/texture/texture.js"
import { ComputePass } from "../../gpu/pass/computePass.js"
import shaderLoader from "../../loaders/shader/shaderLoader.js"
import { ComputePipeline } from "../../gpu/pipeline/computePipeline.js"

/**
 * @typedef {Object} FXAAPassDescription
 * @property {number} threshold
 * @property {number} searchStep
 * @property {Texture} inputColorAttachment
 */

export class FXAAPass {

    /**
     * @param {FXAAPassDescription} description 
     */
    constructor(description) {

        this.threshold = f32(description.threshold)
        this.searchStep = i32(description.searchStep)
        this.inputColorAttachment = description.inputColorAttachment

        this.fxaaTexture = Texture.create({
            name: 'Texture (FXAA)',
            format: 'rgba16float', 
            computable: true,
            resource: { size: () => [ description.inputColorAttachment.width, description.inputColorAttachment.height ] }
        })

        this.blockSizeX = 16
        this.blockSizeY = 16
        // FXAA binding
        this.fxaaBinding = Binding.create({
            name: 'FXAA',
            range: () => [ Math.ceil(this.fxaaTexture.width / this.blockSizeX), Math.ceil(this.fxaaTexture.height / this.blockSizeY) ],
            uniforms: [
                {
                    name: 'staticUniform',
                    map: {
                        threshold: this.threshold,
                        searchStep: this.searchStep,
                    }
                }
            ],
            textures: [
                { texture: this.inputColorAttachment },
                { texture: this.fxaaTexture, asStorage: true },
            ]
        })

        /**
         * @type {ComputePipeline}
         */
        this.fxaaPipeline = ComputePipeline.create({
            name: 'Compute Pipeline (FXAA)',
            shader: { module: shaderLoader.load('Shader (FXAA)', '/shaders/postprocess/fxaa/fxaa.compute.wgsl') },
            constants: { blockSize: 16 },
        })

        /**
         * @type {ComputePass}
         */
        this.computePass = ComputePass.create({
            name: 'Compute Pass (FXAA)',
        }).add(this.fxaaPipeline, this.fxaaBinding)
    }

    /**
     * 
     * @param {FXAAPass} description 
     */
    static create(description) {
        
        return new FXAAPass(description)
    }

    /**
     * @param {GPUCommandEncoder} encoder 
     */
    execute(encoder) {

        this.computePass.execute(encoder)
    }

    getOutputAttachment() {

        return this.fxaaTexture
    }

    onWindowResize() {
        
        this.fxaaTexture.reset()
        this.fxaaBinding.range = () => [ Math.ceil(this.fxaaTexture.width / this.blockSizeX), Math.ceil(this.fxaaTexture.height / this.blockSizeY) ]
    }
}

/**
 * @param {FXAAPassDescription} description 
 */
export function fxaaPass(description) {

    return FXAAPass.create(description)
}