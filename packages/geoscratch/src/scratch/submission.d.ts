import { DrawCommand } from './command'
import { ScratchDiagnostic, ScratchDiagnosticReport } from './diagnostics'
import { RenderPassSpec } from './pass'
import { ScratchRuntime } from './runtime'

export type SubmissionValidationMode = 'off' | 'warn' | 'throw'

export type SubmissionBuilderOptions = {
    validation?: SubmissionValidationMode
}

export class SubmissionBuilder {
    constructor(runtime: ScratchRuntime, options?: SubmissionBuilderOptions)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly validation: SubmissionValidationMode
    readonly isSubmitted: boolean

    render(passSpec: RenderPassSpec, commands: DrawCommand[]): this
    submit(): SubmittedWork
}

export class SubmittedWork {
    constructor(runtime: ScratchRuntime, options?: {
        id?: string
        commandBuffers?: GPUCommandBuffer[]
        report?: ScratchDiagnosticReport
        done?: Promise<unknown>
    })

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly commandBuffers: GPUCommandBuffer[]
    readonly report: ScratchDiagnosticReport
    readonly diagnostics: ScratchDiagnostic[]
    readonly done: Promise<unknown>
}
