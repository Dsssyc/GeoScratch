import { BindSet } from './binding'
import { BufferResource } from './buffer'
import { RenderPipeline } from './pipeline'
import { RenderPassSpec } from './pass'
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

export type DrawCommandDescriptor = {
    label?: string
    pipeline: RenderPipeline
    bindSets?: BindSet[]
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

export class DrawCommand {
    constructor(runtime: ScratchRuntime, descriptor: DrawCommandDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'draw'
    readonly pipeline: RenderPipeline
    readonly bindSets: BindSet[]
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
