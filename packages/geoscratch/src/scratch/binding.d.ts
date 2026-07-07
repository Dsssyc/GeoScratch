import { BufferResource } from './buffer'
import { ScratchRuntime } from './runtime'

export type BindVisibility = 'vertex' | 'fragment' | 'compute'

export type UniformBindLayoutEntry = {
    binding: number
    name: string
    type: 'uniform'
    visibility: BindVisibility[]
}

export type BindLayoutEntry = UniformBindLayoutEntry

export type BindLayoutDescriptor = {
    label?: string
    group: number
    entries: BindLayoutEntry[]
}

export type BindSetBindings = Record<string, BufferResource>

export type BindSetOptions = {
    label?: string
}

export class BindLayout {
    constructor(runtime: ScratchRuntime, descriptor: BindLayoutDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly group: number
    readonly entries: BindLayoutEntry[]
    readonly gpuBindGroupLayout: GPUBindGroupLayout
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    dispose(): void
}

export class BindSet {
    constructor(
        runtime: ScratchRuntime,
        layout: BindLayout,
        bindings: BindSetBindings,
        options?: BindSetOptions,
    )

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly layout: BindLayout
    readonly gpuBindGroup?: GPUBindGroup
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    getBindGroup(): GPUBindGroup
    dispose(): void
}
