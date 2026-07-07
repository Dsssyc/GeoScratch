import { BufferResource, BufferResourceDescriptor } from './buffer'
import { DrawCommand, DrawCommandDescriptor } from './command'
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
    createProgram(descriptor: ProgramDescriptor): Program
    program(descriptor: ProgramDescriptor): Program
    createRenderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline
    renderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline
    createDrawCommand(descriptor: DrawCommandDescriptor): DrawCommand
    drawCommand(descriptor: DrawCommandDescriptor): DrawCommand
    createRenderPass(descriptor: RenderPassSpecDescriptor): RenderPassSpec
    renderPass(descriptor: RenderPassSpecDescriptor): RenderPassSpec
    createSubmission(options?: SubmissionBuilderOptions): SubmissionBuilder
    submission(options?: SubmissionBuilderOptions): SubmissionBuilder
    dispose(): void
}
