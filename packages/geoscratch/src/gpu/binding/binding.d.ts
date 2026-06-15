import { IndexBuffer } from "../buffer/indexBuffer";
import { IndirectBuffer } from "../buffer/indirectBuffer";
import { VertexBuffer } from "../buffer/vertexBuffer";
import { Shader } from "../shader/shader";
import { Texture } from "../texture/texture";
import { UniformBuffer } from '../buffer/uniformBuffer';
import { StorageBuffer } from '../buffer/storageBuffer';
import { BlockValueType } from '../../core/data/blockRef';
import { Sampler } from "../sampler/sampler";
import { ScratchObject } from "../../core/object/object";
import { Numeric } from '../../core/numericType/numericType.js';

export interface UniformBindingDescription {
    name: string,
    dynamic?: boolean,
    visibility?: number,
    map: { [varName: string]: Numeric | { type: string, data: any } },
};

export interface SharedUniformBindingDescription {
    buffer: UniformBuffer,
    visibility?: number,
};

export interface StorageBindingDescription {
    buffer: StorageBuffer | VertexBuffer | IndexBuffer | IndirectBuffer,
    writable?: boolean
};

export interface IndexBindingDescription {
    buffer: IndexBuffer
};

export interface IndirectBindingDescription {
    buffer: IndirectBuffer
    byteOffset?: number
};

export interface SamplerDescription {
    sampler: Sampler
    visibility?: number,
    bindingType?: GPUSamplerBindingType,
};

export interface VertexBindingDescription {
    buffer: VertexBuffer,
    visibility?: number,
    isInstanced?: boolean,
}

export interface TextureBindingDescription {
    texture: Texture,
    visibility?: number,
    sampleType?: GPUTextureSampleType,
    viewDimension?: GPUTextureViewDimension,
    multisampled? : boolean,
    asStorage?: boolean,
};

export interface BindingsDescription {
    name?: string,
    range?: Function,
    index?: IndexBindingDescription,
    samplers?: Array<SamplerDescription>,
    indirect?: IndirectBindingDescription,
    uniforms?: Array<UniformBindingDescription>,
    vertices?: Array<VertexBindingDescription>,
    storages?: Array<StorageBindingDescription>,
    textures?: Array<TextureBindingDescription>,
    sharedUniforms?: Array<SharedUniformBindingDescription>,
};

export class Binding extends ScratchObject {

    indirectBinding: {buffer: GPUBuffer | undefined, byteOffset: number};
    isComplete: boolean;
    executable: boolean;

    constructor();

    static create(description: BindingsDescription): Binding;

    exportLayoutDescriptor(type: 'uniform' | 'storage' | 'texture'): GPUBindGroupLayoutDescriptor;

    update(): void;

    getIndex(): IndexBuffer | undefined;

    afterShaderComplete(shader: Shader): void;

    // getIndirect(): {buffer: IndirectBuffer | undefined, byteOffset: number};

    getVertexLayouts(): Array<GPUVertexBufferLayout> | undefined;

    getBindGroupLayouts(): GPUBindGroupLayout[];

    createBindGroups(): void;

    getBindGroups(): GPUBindGroup[];

    setVertexBuffers(pass: GPURenderPassEncoder): void

    setBindGroups(pass: GPURenderPassEncoder | GPUComputePassEncoder): void;

    getShader(): GPUShaderModule;

    tryMakeComplete(): boolean;
}

export function binding(description: BindingsDescription): Binding;
