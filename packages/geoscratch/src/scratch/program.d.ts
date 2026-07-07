import { ScratchRuntime } from './runtime'

export type ProgramEntryPoints = {
    vertex?: string
    fragment?: string
    compute?: string
}

export type ProgramDescriptor = {
    label?: string
    modules: string[]
    entryPoints?: ProgramEntryPoints
    requiredFeatures?: Iterable<GPUFeatureName>
}

export class Program {
    constructor(runtime: ScratchRuntime, descriptor: ProgramDescriptor)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly label?: string
    readonly modules: string[]
    readonly entryPoints: ProgramEntryPoints
    readonly requiredFeatures: GPUFeatureName[]
    readonly isDisposed: boolean

    assertRuntime(runtime: ScratchRuntime): void
    assertUsable(): void
    dispose(): void
}
