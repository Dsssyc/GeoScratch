import { BeginOcclusionQueryCommand, CopyCommand, DispatchCommand, DrawCommand, EndOcclusionQueryCommand, ResolveQuerySetCommand, TextureUploadCommand, UploadCommand } from './command'
import { ScratchDiagnostic, ScratchDiagnosticReport } from './diagnostics'
import { ComputePassSpec, RenderPassSpec } from './pass'
import { ScratchRuntime } from './runtime'

export type SubmissionValidationMode = 'off' | 'warn' | 'throw'

export type SubmissionBuilderOptions = {
    validation?: SubmissionValidationMode
}

export type RenderCommand = DrawCommand | BeginOcclusionQueryCommand | EndOcclusionQueryCommand

export class SubmissionBuilder {
    constructor(runtime: ScratchRuntime, options?: SubmissionBuilderOptions)

    readonly runtime: ScratchRuntime
    readonly id: string
    readonly validation: SubmissionValidationMode
    readonly isSubmitted: boolean

    render(passSpec: RenderPassSpec, commands: RenderCommand[]): this
    compute(passSpec: ComputePassSpec, commands: DispatchCommand[]): this
    upload(command: UploadCommand | TextureUploadCommand): this
    copy(command: CopyCommand): this
    resolve(command: ResolveQuerySetCommand): this
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
