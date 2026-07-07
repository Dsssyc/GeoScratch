import { BufferResource, BufferResourceDescriptor } from './buffer'
import { BindLayout, BindLayoutDescriptor, BindSet, BindSetBindings, BindSetOptions } from './binding'
import { CopyCommand, CopyCommandDescriptor, DispatchCommand, DispatchCommandDescriptor, DrawCommand, DrawCommandDescriptor, ResolveQuerySetCommand, ResolveQuerySetCommandDescriptor, TextureUploadCommand, TextureUploadCommandDescriptor, UploadCommand, UploadCommandDescriptor } from './command'
import { ComputePassSpec, ComputePassSpecDescriptor, RenderPassSpec, RenderPassSpecDescriptor } from './pass'
import { ComputePipeline, ComputePipelineDescriptor, RenderPipeline, RenderPipelineDescriptor } from './pipeline'
import { Program, ProgramDescriptor } from './program'
import { QuerySetResource, QuerySetResourceDescriptor } from './query-set'
import { ReadbackOperation, ReadbackOperationDescriptor } from './readback'
import { SamplerResource, SamplerResourceDescriptor } from './sampler'
import { SubmissionBuilder, SubmissionBuilderOptions } from './submission'
import { Surface, SurfaceOptions } from './surface'
import { TextureResource, TextureResourceDescriptor } from './texture'

export type ScratchRuntimeCreateOptions = {
    gpu?: GPU
    label?: string
    powerPreference?: GPUPowerPreference
    forceFallbackAdapter?: boolean
    requiredFeatures?: Iterable<GPUFeatureName>
    requiredLimits?: Record<string, number>
}

export class ScratchRuntime {
    private constructor()

    readonly id: string
    readonly label?: string
    readonly gpu: GPU
    readonly adapter: GPUAdapter
    readonly device: GPUDevice
    readonly queue: GPUQueue
    readonly adapterFeatures: GPUSupportedFeatures
    readonly adapterLimits: GPUSupportedLimits
    readonly deviceFeatures: GPUSupportedFeatures
    readonly deviceLimits: GPUSupportedLimits
    readonly isDisposed: boolean
    readonly isDeviceLost: boolean
    readonly deviceLostInfo?: GPUDeviceLostInfo

    static create(options?: ScratchRuntimeCreateOptions): Promise<ScratchRuntime>

    assertActive(): void
    createSurface(canvas: HTMLCanvasElement | OffscreenCanvas, options?: SurfaceOptions): Surface
    surface(canvas: HTMLCanvasElement | OffscreenCanvas, options?: SurfaceOptions): Surface
    createBuffer(descriptor: BufferResourceDescriptor): BufferResource
    buffer(descriptor: BufferResourceDescriptor): BufferResource
    createTexture(descriptor: TextureResourceDescriptor): TextureResource
    texture(descriptor: TextureResourceDescriptor): TextureResource
    createSampler(descriptor?: SamplerResourceDescriptor): SamplerResource
    sampler(descriptor?: SamplerResourceDescriptor): SamplerResource
    createQuerySet(descriptor: QuerySetResourceDescriptor): QuerySetResource
    querySet(descriptor: QuerySetResourceDescriptor): QuerySetResource
    createBindLayout(descriptor: BindLayoutDescriptor): BindLayout
    bindLayout(descriptor: BindLayoutDescriptor): BindLayout
    createBindSet(layout: BindLayout, bindings: BindSetBindings, options?: BindSetOptions): BindSet
    bindSet(layout: BindLayout, bindings: BindSetBindings, options?: BindSetOptions): BindSet
    createProgram(descriptor: ProgramDescriptor): Program
    program(descriptor: ProgramDescriptor): Program
    createRenderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline
    renderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline
    createComputePipeline(descriptor: ComputePipelineDescriptor): ComputePipeline
    computePipeline(descriptor: ComputePipelineDescriptor): ComputePipeline
    createDrawCommand(descriptor: DrawCommandDescriptor): DrawCommand
    drawCommand(descriptor: DrawCommandDescriptor): DrawCommand
    createDispatchCommand(descriptor: DispatchCommandDescriptor): DispatchCommand
    dispatchCommand(descriptor: DispatchCommandDescriptor): DispatchCommand
    createUploadCommand(descriptor: UploadCommandDescriptor): UploadCommand
    uploadCommand(descriptor: UploadCommandDescriptor): UploadCommand
    createCopyCommand(descriptor: CopyCommandDescriptor): CopyCommand
    copyCommand(descriptor: CopyCommandDescriptor): CopyCommand
    createResolveQuerySetCommand(descriptor: ResolveQuerySetCommandDescriptor): ResolveQuerySetCommand
    resolveQuerySetCommand(descriptor: ResolveQuerySetCommandDescriptor): ResolveQuerySetCommand
    createTextureUploadCommand(descriptor: TextureUploadCommandDescriptor): TextureUploadCommand
    textureUploadCommand(descriptor: TextureUploadCommandDescriptor): TextureUploadCommand
    createRenderPass(descriptor: RenderPassSpecDescriptor): RenderPassSpec
    renderPass(descriptor: RenderPassSpecDescriptor): RenderPassSpec
    createComputePass(descriptor?: ComputePassSpecDescriptor): ComputePassSpec
    computePass(descriptor?: ComputePassSpecDescriptor): ComputePassSpec
    createReadback(descriptor: ReadbackOperationDescriptor): ReadbackOperation
    readback(descriptor: ReadbackOperationDescriptor): ReadbackOperation
    createSubmission(options?: SubmissionBuilderOptions): SubmissionBuilder
    submission(options?: SubmissionBuilderOptions): SubmissionBuilder
    dispose(): void
}
