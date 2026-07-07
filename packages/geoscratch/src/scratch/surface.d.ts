import { ScratchRuntime } from './runtime'

export type SurfaceSize = {
    width: number
    height: number
}

export type SurfaceFormat = GPUTextureFormat | 'preferred'

export type SurfaceOptions = {
    label?: string
    format?: SurfaceFormat
    alphaMode?: GPUCanvasAlphaMode
    size?: SurfaceSize
}

export class Surface {
    constructor(runtime: ScratchRuntime, canvas: HTMLCanvasElement | OffscreenCanvas, options?: SurfaceOptions)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly canvas: HTMLCanvasElement | OffscreenCanvas
    readonly context: GPUCanvasContext
    readonly format: GPUTextureFormat
    readonly alphaMode: GPUCanvasAlphaMode
    readonly size: SurfaceSize
    readonly isConfigured: boolean
    readonly isDisposed: boolean

    assertUsable(): void
    configure(options?: SurfaceOptions): void
    resize(size: SurfaceSize): void
    resize(width: number, height: number): void
    getCurrentTexture(): GPUTexture
    dispose(): void
}
