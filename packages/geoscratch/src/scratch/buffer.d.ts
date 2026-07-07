import { Resource } from './resource'
import { ScratchRuntime } from './runtime'

export type BufferResourceDescriptor = GPUBufferDescriptor

export class BufferResource extends Resource {
    constructor(runtime: ScratchRuntime, descriptor: BufferResourceDescriptor)

    readonly gpuBuffer: GPUBuffer
    readonly size: number
    readonly usage: GPUBufferUsageFlags

    static create(runtime: ScratchRuntime, descriptor: BufferResourceDescriptor): BufferResource
}
