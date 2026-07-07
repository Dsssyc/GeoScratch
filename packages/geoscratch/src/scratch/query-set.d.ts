import { Resource } from './resource'
import { ScratchRuntime } from './runtime'

export type QuerySetType = 'timestamp' | 'occlusion'

export type QuerySetResourceDescriptor = {
    label?: string
    type: QuerySetType
    count: number
}

export class QuerySetResource extends Resource {
    constructor(runtime: ScratchRuntime, descriptor: QuerySetResourceDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly resourceKind: 'QuerySetResource'
    readonly descriptor: QuerySetResourceDescriptor
    readonly type: QuerySetType
    readonly count: number
    readonly slotContentEpochs: number[]
    readonly gpuQuerySet: GPUQuerySet
    readonly isDisposed: boolean
    readonly allocationVersion: number
    readonly contentEpoch: number

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    dispose(): void
}
