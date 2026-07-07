import { BufferResource, BufferResourceDescriptor } from './buffer'
import { BindLayout, BindLayoutDescriptor, BindSet, BindSetBindings, BindSetOptions } from './binding'
import { DrawCommand, DrawCommandDescriptor, UploadCommand, UploadCommandDescriptor } from './command'
import { RenderPassSpec, RenderPassSpecDescriptor } from './pass'
import { RenderPipeline, RenderPipelineDescriptor } from './pipeline'
import { Program, ProgramDescriptor } from './program'
import { SubmissionBuilder, SubmissionBuilderOptions } from './submission'
import { Surface, SurfaceOptions } from './surface'

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
    createBindLayout(descriptor: BindLayoutDescriptor): BindLayout
    bindLayout(descriptor: BindLayoutDescriptor): BindLayout
    createBindSet(layout: BindLayout, bindings: BindSetBindings, options?: BindSetOptions): BindSet
    bindSet(layout: BindLayout, bindings: BindSetBindings, options?: BindSetOptions): BindSet
    createProgram(descriptor: ProgramDescriptor): Program
    program(descriptor: ProgramDescriptor): Program
    createRenderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline
    renderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline
    createDrawCommand(descriptor: DrawCommandDescriptor): DrawCommand
    drawCommand(descriptor: DrawCommandDescriptor): DrawCommand
    createUploadCommand(descriptor: UploadCommandDescriptor): UploadCommand
    uploadCommand(descriptor: UploadCommandDescriptor): UploadCommand
    createRenderPass(descriptor: RenderPassSpecDescriptor): RenderPassSpec
    renderPass(descriptor: RenderPassSpecDescriptor): RenderPassSpec
    createSubmission(options?: SubmissionBuilderOptions): SubmissionBuilder
    submission(options?: SubmissionBuilderOptions): SubmissionBuilder
    dispose(): void
}
