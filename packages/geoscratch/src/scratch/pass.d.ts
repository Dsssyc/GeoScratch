import { Surface } from './surface'
import { ScratchRuntime } from './runtime'
import { QuerySetResource } from './query-set'
import { TextureResource } from './texture'

export type TimestampWritesSpec = {
    querySet: QuerySetResource
    begin?: number
    end?: number
}

export type RenderPassColorAttachmentSpec = {
    target: Surface | TextureResource
    format?: GPUTextureFormat
    load?: GPULoadOp
    store?: GPUStoreOp
    clear?: GPUColor
    viewDescriptor?: GPUTextureViewDescriptor
}

export type RenderPassSpecDescriptor = {
    label?: string
    color: RenderPassColorAttachmentSpec[]
    timestampWrites?: TimestampWritesSpec
    occlusionQuerySet?: QuerySetResource
}

export type ComputePassSpecDescriptor = {
    label?: string
    timestampWrites?: TimestampWritesSpec
}

export class RenderPassSpec {
    constructor(runtime: ScratchRuntime, descriptor: RenderPassSpecDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly passKind: 'render'
    readonly color: RenderPassColorAttachmentSpec[]
    readonly timestampWrites?: TimestampWritesSpec
    readonly occlusionQuerySet?: QuerySetResource
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    createRenderPassDescriptor(): GPURenderPassDescriptor
    hasEncoderSideEffects(): boolean
    advanceTimestampWriteEpochs(): void
    dispose(): void
}

export class ComputePassSpec {
    constructor(runtime: ScratchRuntime, descriptor?: ComputePassSpecDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly passKind: 'compute'
    readonly timestampWrites?: TimestampWritesSpec
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    createComputePassDescriptor(): GPUComputePassDescriptor
    hasEncoderSideEffects(): boolean
    advanceTimestampWriteEpochs(): void
    dispose(): void
}
