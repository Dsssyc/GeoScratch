import { BufferResource } from './buffer'
import { SamplerResource } from './sampler'
import { ScratchRuntime } from './runtime'
import { TextureResource } from './texture'

export type BindVisibility = 'vertex' | 'fragment' | 'compute'

export type UniformBindLayoutEntry = {
    binding: number
    name: string
    type: 'uniform'
    visibility: BindVisibility[]
}

export type StorageBindLayoutEntry = {
    binding: number
    name: string
    type: 'read-storage' | 'storage'
    visibility: BindVisibility[]
}

export type TextureBindLayoutEntry = {
    binding: number
    name: string
    type: 'texture'
    visibility: BindVisibility[]
    sampleType?: GPUTextureSampleType
    viewDimension?: GPUTextureViewDimension
    multisampled?: boolean
}

export type SamplerBindLayoutEntry = {
    binding: number
    name: string
    type: 'sampler'
    visibility: BindVisibility[]
    samplerType?: GPUSamplerBindingType
}

export type BindLayoutEntry =
    | UniformBindLayoutEntry
    | StorageBindLayoutEntry
    | TextureBindLayoutEntry
    | SamplerBindLayoutEntry

export type BindLayoutDescriptor = {
    label?: string
    group: number
    entries: BindLayoutEntry[]
}

export type BindSetBindings = Record<string, BufferResource | TextureResource | SamplerResource>

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
