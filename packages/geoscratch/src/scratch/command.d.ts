import { BindSet } from './binding'
import { BufferResource } from './buffer'
import { ComputePipeline, RenderPipeline } from './pipeline'
import { ComputePassSpec, RenderPassSpec } from './pass'
import { Resource } from './resource'
import { ScratchRuntime } from './runtime'

export type ResourceReadinessPolicy =
    | 'throw'
    | 'skip-command'
    | 'skip-pass'
    | 'use-fallback'

export type StaticDrawCount = {
    vertexCount: number
    instanceCount?: number
    firstVertex?: number
    firstInstance?: number
}

export type DrawVertexBufferBinding = {
    slot: number
    buffer: BufferResource
    offset?: number
    size?: number
}

export type NormalizedDrawVertexBufferBinding = DrawVertexBufferBinding & {
    offset: number
}

export type DrawCommandDescriptor = {
    label?: string
    pipeline: RenderPipeline
    bindSets?: BindSet[]
    vertexBuffers?: DrawVertexBufferBinding[]
    count: StaticDrawCount
    whenMissing: ResourceReadinessPolicy
}

export type UploadCommandDescriptor = {
    label?: string
    target: BufferResource
    data: ArrayBuffer | ArrayBufferView
    offset?: number
    dataOffset?: number
    size?: number
}

export type StaticDispatchCount = {
    workgroups: [number] | [number, number] | [number, number, number]
}

export type DispatchCommandDescriptor = {
    label?: string
    pipeline: ComputePipeline
    bindSets?: BindSet[]
    count: StaticDispatchCount
    resources: {
        read: Resource[]
        write: Resource[]
    }
    whenMissing: ResourceReadinessPolicy
}

export class DrawCommand {
    constructor(runtime: ScratchRuntime, descriptor: DrawCommandDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'draw'
    readonly pipeline: RenderPipeline
    readonly bindSets: BindSet[]
    readonly vertexBuffers: NormalizedDrawVertexBufferBinding[]
    readonly count: StaticDrawCount
    readonly whenMissing: ResourceReadinessPolicy
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    validateForPass(passSpec: RenderPassSpec): void
    encode(passEncoder: GPURenderPassEncoder): void
    dispose(): void
}

export class UploadCommand {
    constructor(runtime: ScratchRuntime, descriptor: UploadCommandDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'upload'
    readonly target: BufferResource
    readonly data: ArrayBuffer | ArrayBufferView
    readonly offset: number
    readonly dataOffset: number
    readonly byteLength: number
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    execute(queue: GPUQueue): void
    dispose(): void
}

export class DispatchCommand {
    constructor(runtime: ScratchRuntime, descriptor: DispatchCommandDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'dispatch'
    readonly pipeline: ComputePipeline
    readonly bindSets: BindSet[]
    readonly count: { workgroups: [number, number, number] }
    readonly resources: {
        read: Resource[]
        write: Resource[]
    }
    readonly whenMissing: ResourceReadinessPolicy
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    validateForPass(passSpec: ComputePassSpec): void
    encode(passEncoder: GPUComputePassEncoder): void
    dispose(): void
}
