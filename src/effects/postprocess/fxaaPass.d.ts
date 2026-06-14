import { RenderPipeline } from "../../gpu/pipeline/renderPipeline"
import { RenderPass } from "../../gpu/pass/renderPass"
import { Texture } from "../../gpu/texture/texture"
import shaderLoader from "../../loaders/shader/shaderLoader"
import { BindingsDescription } from "../../gpu/binding/binding"
import { ArrayRef } from "../../core/data/arrayRef"


export interface FXAAPassDescription {
    threshold: number,
    searchStep: number,
    inputColorAttachment: Texture,
}

export class FXAAPass {

    constructor(description: FXAAPassDescription)

    static create(description: FXAAPassDescription): FXAAPass

    execute(encoder: GPUCommandEncoder): void

    getOutputAttachment(): Texture

    onWindowResize(): void;
}

export function fxaaPass(description: FXAAPassDescription): FXAAPass;