import { RenderPipeline } from "../../gpu/pipeline/renderPipeline"
import { RenderPass } from "../../gpu/pass/renderPass"
import { Texture } from "../../gpu/texture/texture"
import shaderLoader from "../../loaders/shader/shaderLoader"
import { BindingsDescription } from "../../gpu/binding/binding"
import { ArrayRef } from "../../core/data/arrayRef"


export interface BloomPassDescription {
    threshold: number,
    strength: number,
    blurCount: number,
    inputColorAttachment: Texture,
}

export class BloomPass {

    constructor(description: BloomPassDescription)

    static create(description: BloomPassDescription): BloomPass

    execute(encoder: GPUCommandEncoder): void

    getOutputAttachment(): Texture

    onWindowResize(): void;
}

export function bloomPass(description: BloomPassDescription): BloomPass;