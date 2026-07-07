import { BindLayout } from './binding'
import { Program } from './program'
import { ScratchRuntime } from './runtime'

export type RenderPipelineDescriptor = {
    label?: string
    program: Program
    vertex?: string
    fragment?: string
    bindLayouts?: BindLayout[]
    vertexBuffers?: GPUVertexBufferLayout[]
    targets: GPUColorTargetState[]
    primitive?: GPUPrimitiveState
    depthStencil?: GPUDepthStencilState
    multisample?: GPUMultisampleState
}

export type ComputePipelineDescriptor = {
    label?: string
    program: Program
    compute?: string
    bindLayouts?: BindLayout[]
    constants?: Record<string, GPUPipelineConstantValue>
}

export class RenderPipeline {
    constructor(runtime: ScratchRuntime, descriptor: RenderPipelineDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly pipelineKind: 'render'
    readonly program: Program
    readonly vertexEntryPoint: string
    readonly fragmentEntryPoint: string
    readonly bindLayouts: BindLayout[]
    readonly vertexBuffers: GPUVertexBufferLayout[]
    readonly targets: GPUColorTargetState[]
    readonly targetFormats: GPUTextureFormat[]
    readonly shaderModule: GPUShaderModule
    readonly pipelineLayout: GPUPipelineLayout
    readonly gpuPipeline: GPURenderPipeline
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    dispose(): void
}

export class ComputePipeline {
    constructor(runtime: ScratchRuntime, descriptor: ComputePipelineDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly pipelineKind: 'compute'
    readonly program: Program
    readonly computeEntryPoint: string
    readonly bindLayouts: BindLayout[]
    readonly constants?: Record<string, GPUPipelineConstantValue>
    readonly shaderModule: GPUShaderModule
    readonly pipelineLayout: GPUPipelineLayout
    readonly gpuPipeline: GPUComputePipeline
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    dispose(): void
}
