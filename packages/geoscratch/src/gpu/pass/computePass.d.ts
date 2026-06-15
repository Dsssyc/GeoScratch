// ComputePass.d.ts

import { Binding } from "../binding/binding";
import { ComputePipeline } from "../pipeline/computePipeline";

/**
 * Describes the properties for creating a RenderPass.
 */
export interface ComputePassDescription {
    name: string,
}

/**
 * Represents a render pass that can be used in a graphics rendering pipeline.
 */
export class ComputePass {

    executable: boolean;

    constructor(description: ComputePassDescription);
    static create(description: ComputePassDescription): ComputePass;

    update(): void;

    /**
     * Adds a ComputableBuilder to the compute pass.
     * @param computable The ComputableBuilder to add.
     * @param binding The Binding resource for ComputableBuilder to compute.
     */
    add(computable: ComputePipeline, binding: Binding): ComputePass;

    empty(): void;

    /**
     * Executes the compute pass using the provided GPUCommandEncoder.
     * @param encoder The GPUCommandEncoder to use for the render pass.
     */
    execute(encoder: GPUCommandEncoder): void;
}

export function computePass(description: ComputePassDescription): ComputePass;
