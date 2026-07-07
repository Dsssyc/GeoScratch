import { Resource } from './resource'
import { ScratchRuntime } from './runtime'

export type TextureResourceDescriptor = Omit<GPUTextureDescriptor, 'size'> & {
    size: GPUTextureDescriptor['size'] | [number, number] | [number, number, number]
}

export type TextureViewDescriptor = GPUTextureViewDescriptor

export class TextureResource extends Resource {
    constructor(runtime: ScratchRuntime, descriptor: TextureResourceDescriptor)

    readonly gpuTexture: GPUTexture
    readonly size: { width: number, height: number, depthOrArrayLayers: number }
    readonly width: number
    readonly height: number
    readonly depthOrArrayLayers: number
    readonly format: GPUTextureFormat
    readonly usage: GPUTextureUsageFlags
    readonly dimension: GPUTextureDimension
    readonly mipLevelCount: number
    readonly sampleCount: number

    static create(runtime: ScratchRuntime, descriptor: TextureResourceDescriptor): TextureResource
    createView(descriptor?: TextureViewDescriptor): GPUTextureView
}
