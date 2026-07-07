import { Program } from './program'
import { ScratchRuntime } from './runtime'

export type RenderPipelineDescriptor = {
    label?: string
    program: Program
    vertex?: string
    fragment?: string
    targets: GPUColorTargetState[]
    primitive?: GPUPrimitiveState
    depthStencil?: GPUDepthStencilState
    multisample?: GPUMultisampleState
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
