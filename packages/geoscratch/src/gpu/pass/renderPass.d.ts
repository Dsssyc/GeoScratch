// RenderPass.d.ts

import { Binding } from "../binding/binding";
import { RenderPipeline } from "../pipeline/renderPipeline";
import { Texture } from "../texture/texture";

/**
 * Describes the properties for creating a RenderPass.
 */
export interface RenderPassDescription {
    name: string;
    colorAttachments: Array<{
        colorResource: Texture;
        clearValue?: Array<number>;
        loadOp?: 'clear' | 'load';
        storeOp?: 'store'| 'discard';
    }>;
    depthStencilAttachment?: {
        depthStencilResource: Texture;
        depthClearValue?: number;
        depthLoadOp?: 'clear' | 'load';
        depthStoreOp?: 'store' | 'discard';
    };
}

/**
 * Represents a render pass that can be used in a graphics rendering pipeline.
 */
export class RenderPass {
    
    pass: GPURenderPassEncoder;
    executable: boolean;

    constructor(description: RenderPassDescription);
    static create(description: RenderPassDescription): RenderPass;

    updateColorAttachments(): void;
    updateDepthStencilAttachment(): void;
    update(): void;

    /**
     * Adds a DrawableBuilder to the render pass.
     * @param drawable The DrawableBuilder to add.
     * @param binding The Binding resource for drawableBuilder to render.
     */
    add(drawable: RenderPipeline, binding: Binding): RenderPass;

    empty(): void;

    makeColorFormats(): Array<GPUTextureFormat>;

    makeDepthStencilFormat(): GPUTextureFormat | null;

    /**
     * Executes the render pass using the provided GPUCommandEncoder.
     * @param encoder The GPUCommandEncoder to use for the render pass.
     */
    execute(encoder: GPUCommandEncoder): void;

    /**
     * Get current texture used by canvas
     * More efficient than update()
     * !!!!!!!!!! Only can be used by the last renderPass !!!!!!!!!!
     * @deprecated
     * @param canvasTextureIndex 
     */
    updateSwapChain(canvasTextureIndex = 0)
}

export function renderPass(description: RenderPassDescription): RenderPass;
