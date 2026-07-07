import { RenderPipeline } from './pipeline'
import { RenderPassSpec } from './pass'
import { ScratchRuntime } from './runtime'

export type ResourceReadinessPolicy =
    | 'throw'
    | 'skip-command'
    | 'skip-pass'
    | 'use-fallback'

export type StaticDrawCount = {
    vertexCount: number
    instanceCount?: number
    firstVertex?: number
    firstInstance?: number
}

export type DrawCommandDescriptor = {
    label?: string
    pipeline: RenderPipeline
    count: StaticDrawCount
    whenMissing: ResourceReadinessPolicy
}

export class DrawCommand {
    constructor(runtime: ScratchRuntime, descriptor: DrawCommandDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly commandKind: 'draw'
    readonly pipeline: RenderPipeline
    readonly count: StaticDrawCount
    readonly whenMissing: ResourceReadinessPolicy
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    validateForPass(passSpec: RenderPassSpec): void
    encode(passEncoder: GPURenderPassEncoder): void
    dispose(): void
}
