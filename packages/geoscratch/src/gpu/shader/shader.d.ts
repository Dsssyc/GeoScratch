import { ScratchObject } from "../../core/object/object";

export interface ShaderDescription {
    name: string,
    codeFunc: Function,
}

export class Shader extends ScratchObject {

    code: string;
    shaderModule: GPUShaderModule | undefined;

    constructor(description: ShaderDescription);
    static create(description: ShaderDescription): Shader;

    /**
     * @deprecated
     * @param device 
     */
    update(device: GPUDevice): void;

    isComplete(): boolean;
    exportDescriptor(): GPUShaderModuleDescriptor;
}

export function shader(description: ShaderDescription): Shader;
