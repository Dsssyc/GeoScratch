import { Resource } from './resource'
import { ScratchRuntime } from './runtime'

export type SamplerResourceDescriptor = GPUSamplerDescriptor

export class SamplerResource extends Resource {
    constructor(runtime: ScratchRuntime, descriptor?: SamplerResourceDescriptor)

    readonly gpuSampler: GPUSampler

    static create(runtime: ScratchRuntime, descriptor?: SamplerResourceDescriptor): SamplerResource
}
