import { BufferResource } from './buffer'
import { ScratchRuntime } from './runtime'
import { SubmittedWork } from './submission'

export type ReadbackRange = {
    offset?: number
    byteLength?: number
}

export type ReadbackState =
    | 'requested'
    | 'scheduled'
    | 'submitted'
    | 'mapping'
    | 'ready'
    | 'consumed'
    | 'cancelled'
    | 'failed'
    | 'disposed'

export type ReadbackOperationDescriptor = {
    label?: string
    source: BufferResource
    after?: SubmittedWork
    range?: ReadbackRange
}

export type TypedArrayConstructor<T extends ArrayBufferView = ArrayBufferView> = {
    readonly BYTES_PER_ELEMENT: number
    readonly name: string
    new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): T
}

export class ReadbackOperation {
    constructor(runtime: ScratchRuntime, descriptor: ReadbackOperationDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly state: ReadbackState
    readonly source: BufferResource
    readonly range: {
        offset: number
        byteLength: number
    }
    readonly after?: SubmittedWork
    readonly contentEpoch: number
    readonly allocationVersion: number
    readonly isDisposed: boolean
    readonly isCancelled: boolean

    toBytes(): Promise<Uint8Array>
    toArray<T extends ArrayBufferView>(TypedArrayConstructor?: TypedArrayConstructor<T>): Promise<T>
    cancel(reason?: string): void
    dispose(): void
}
