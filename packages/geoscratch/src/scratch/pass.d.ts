import { Surface } from './surface'
import { ScratchRuntime } from './runtime'

export type RenderPassColorAttachmentSpec = {
    target: Surface
    format?: GPUTextureFormat
    load?: GPULoadOp
    store?: GPUStoreOp
    clear?: GPUColor
    viewDescriptor?: GPUTextureViewDescriptor
}

export type RenderPassSpecDescriptor = {
    label?: string
    color: RenderPassColorAttachmentSpec[]
}

export class RenderPassSpec {
    constructor(runtime: ScratchRuntime, descriptor: RenderPassSpecDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly passKind: 'render'
    readonly color: RenderPassColorAttachmentSpec[]
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    createRenderPassDescriptor(): GPURenderPassDescriptor
    dispose(): void
}
