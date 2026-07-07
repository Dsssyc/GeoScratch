import { ScratchRuntime } from './runtime'

export type ResourceOptions = {
    label?: string
    resourceKind?: string
    descriptor?: Record<string, unknown>
}

export class Resource {
    constructor(runtime: ScratchRuntime, options?: ResourceOptions)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly resourceKind: string
    readonly descriptor: Record<string, unknown>
    readonly isDisposed: boolean
    readonly allocationVersion: number
    readonly contentEpoch: number

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    dispose(): void
}
