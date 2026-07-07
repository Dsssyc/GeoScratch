import { BindSet } from './binding'
import { BufferResource } from './buffer'
import { ComputePipeline, RenderPipeline } from './pipeline'
import { ComputePassSpec, RenderPassSpec } from './pass'
import { QuerySetResource } from './query-set'
import { Resource } from './resource'
import { ScratchRuntime } from './runtime'
import { TextureResource } from './texture'

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

export type BeginOcclusionQueryCommandDescriptor = {
    label?: string
    querySet: QuerySetResource
    index: number
}

export type EndOcclusionQueryCommandDescriptor = {
    label?: string
}

export type UploadCommandDescriptor = {
    label?: string
    target: BufferResource
    data: ArrayBuffer | ArrayBufferView
    offset?: number
    dataOffset?: number
    size?: number
}

export type CopyCommandDescriptor = {
    label?: string
    source: BufferResource
    sourceOffset?: number
    target: BufferResource
    targetOffset?: number
    byteLength: number
}

export type ResolveQuerySetCommandDescriptor = {
    label?: string
    querySet: QuerySetResource
    firstQuery?: number
    queryCount: number
    destination: BufferResource
    destinationOffset?: number
}

export type TextureUploadOrigin = {
    x?: number
    y?: number
    z?: number
} | [number, number?, number?]

export type TextureUploadSize = {
    width: number
    height: number
    depthOrArrayLayers?: number
} | [number, number] | [number, number, number]

export type TextureUploadLayout = {
    offset?: number
    bytesPerRow?: number
    rowsPerImage?: number
}

export type TextureUploadCommandDescriptor = {
    label?: string
    target: TextureResource
    data: ArrayBuffer | ArrayBufferView
    layout?: TextureUploadLayout
    size: TextureUploadSize
    origin?: TextureUploadOrigin
    mipLevel?: number
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

export class BeginOcclusionQueryCommand {
    constructor(runtime: ScratchRuntime, descriptor: BeginOcclusionQueryCommandDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'begin-occlusion-query'
    readonly querySet: QuerySetResource
    readonly index: number
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    validateForPass(passSpec: RenderPassSpec): void
    encode(passEncoder: GPURenderPassEncoder): void
    dispose(): void
}

export class EndOcclusionQueryCommand {
    constructor(runtime: ScratchRuntime, descriptor?: EndOcclusionQueryCommandDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'end-occlusion-query'
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

export class CopyCommand {
    constructor(runtime: ScratchRuntime, descriptor: CopyCommandDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'copy'
    readonly source: BufferResource
    readonly sourceOffset: number
    readonly target: BufferResource
    readonly targetOffset: number
    readonly byteLength: number
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    encode(commandEncoder: GPUCommandEncoder): void
    dispose(): void
}

export class ResolveQuerySetCommand {
    constructor(runtime: ScratchRuntime, descriptor: ResolveQuerySetCommandDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'resolve-query-set'
    readonly querySet: QuerySetResource
    readonly firstQuery: number
    readonly queryCount: number
    readonly destination: BufferResource
    readonly destinationOffset: number
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    encode(commandEncoder: GPUCommandEncoder): void
    dispose(): void
}

export class TextureUploadCommand {
    constructor(runtime: ScratchRuntime, descriptor: TextureUploadCommandDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'upload'
    readonly uploadKind: 'texture'
    readonly target: TextureResource
    readonly data: ArrayBuffer | ArrayBufferView
    readonly layout: Required<TextureUploadLayout>
    readonly origin: { x: number, y: number, z: number }
    readonly size: { width: number, height: number, depthOrArrayLayers: number }
    readonly mipLevel: number
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
