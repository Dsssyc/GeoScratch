import { BufferResource, BufferResourceDescriptor } from './buffer'
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
    dispose(): void
}
