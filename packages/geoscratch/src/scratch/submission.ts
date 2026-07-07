import { UUID } from '../core/utils/uuid.js'
import {
    createScratchDiagnosticReport,
    throwScratchDiagnostic,
} from './diagnostics.js'
import { TextureResource } from './texture.js'
import { diagnosticSubjectOf, isDefined, isRecord } from './type-utils.js'
import type { BeginOcclusionQueryCommand, CopyCommand, DispatchCommand, DrawCommand, EndOcclusionQueryCommand, ResolveQuerySetCommand, TextureUploadCommand, UploadCommand } from './command.js'
import type { ScratchDiagnostic, ScratchDiagnosticReport } from './diagnostics.js'
import type { ComputePassSpec, RenderPassSpec } from './pass.js'
import type { ScratchRuntime } from './runtime.js'

export type SubmissionValidationMode = 'off' | 'warn' | 'throw'

export type SubmissionBuilderOptions = {
    validation?: SubmissionValidationMode
}

export type RenderCommand = DrawCommand | BeginOcclusionQueryCommand | EndOcclusionQueryCommand

type RenderStep = {
    kind: 'render'
    passSpec: RenderPassSpec
    commands: RenderCommand[]
}

type ComputeStep = {
    kind: 'compute'
    passSpec: ComputePassSpec
    commands: DispatchCommand[]
}

type UploadStep = {
    kind: 'upload'
    command: UploadCommand | TextureUploadCommand
}

type CopyStep = {
    kind: 'copy'
    command: CopyCommand
}

type ResolveStep = {
    kind: 'resolve'
    command: ResolveQuerySetCommand
}

type SubmissionStep = RenderStep | ComputeStep | UploadStep | CopyStep | ResolveStep

export interface SubmissionBuilder {
    runtime: ScratchRuntime
    id: string
    validation: SubmissionValidationMode
    steps: SubmissionStep[]
    isSubmitted: boolean
}

export class SubmissionBuilder {

    constructor(runtime: ScratchRuntime, options: SubmissionBuilderOptions = {}) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-submission-builder-${UUID()}`
        this.validation = options.validation ?? 'throw'
        this.steps = []
        this.isSubmitted = false
    }

    render(passSpec: RenderPassSpec, commands: RenderCommand[] = []) {

        this.steps.push({
            kind: 'render',
            passSpec,
            commands: [ ...commands ],
        })

        return this
    }

    compute(passSpec: ComputePassSpec, commands: DispatchCommand[] = []) {

        this.steps.push({
            kind: 'compute',
            passSpec,
            commands: [ ...commands ],
        })

        return this
    }

    upload(command: UploadCommand | TextureUploadCommand) {

        this.steps.push({
            kind: 'upload',
            command,
        })

        return this
    }

    copy(command: CopyCommand) {

        this.steps.push({
            kind: 'copy',
            command,
        })

        return this
    }

    resolve(command: ResolveQuerySetCommand) {

        this.steps.push({
            kind: 'resolve',
            command,
        })

        return this
    }

    submit() {

        this.runtime.assertActive()

        if (this.isSubmitted) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SUBMISSION_WORK_ALREADY_SUBMITTED',
                severity: 'error',
                phase: 'submission',
                subject: this.subject,
                message: 'SubmissionBuilder has already submitted work.',
            })
        }

        const submittedId = `scratch-submitted-${UUID()}`
        const commandBuffers: GPUCommandBuffer[] = []
        const encoder = this.runtime.device.createCommandEncoder({
            label: submittedId,
        })

        for (const step of this.steps) {
            if (step.kind === 'upload') {
                validateUploadStep(this, step)
                step.command.execute(this.runtime.queue)
                continue
            }

            if (step.kind === 'copy') {
                validateCopyStep(this, step)
                step.command.encode(encoder)
                continue
            }

            if (step.kind === 'resolve') {
                validateResolveStep(this, step)
                step.command.encode(encoder)
                continue
            }

            if (step.kind === 'compute') {
                validateComputeStep(this, step)

                if (step.commands.length === 0 && !step.passSpec.hasEncoderSideEffects()) continue

                const passEncoder = encoder.beginComputePass(step.passSpec.createComputePassDescriptor())
                for (const command of step.commands) {
                    command.encode(passEncoder)
                }
                passEncoder.end()
                step.passSpec.advanceTimestampWriteEpochs()
                continue
            }

            validateRenderStep(this, step)

            if (step.commands.length === 0 && !step.passSpec.hasEncoderSideEffects()) continue

            const passEncoder = encoder.beginRenderPass(step.passSpec.createRenderPassDescriptor())
            let activeOcclusionQueryCommand: BeginOcclusionQueryCommand | undefined
            for (const command of step.commands) {
                command.encode(passEncoder)
                if (command.commandKind === 'begin-occlusion-query') {
                    activeOcclusionQueryCommand = command
                } else if (command.commandKind === 'end-occlusion-query') {
                    activeOcclusionQueryCommand?.querySet._advanceSlotContentEpoch(activeOcclusionQueryCommand.index)
                    activeOcclusionQueryCommand = undefined
                }
            }
            passEncoder.end()
            step.passSpec.advanceTimestampWriteEpochs()
            advanceRenderAttachmentEpochs(step.passSpec)
        }

        const commandBuffer = encoder.finish()
        commandBuffers.push(commandBuffer)
        this.runtime.queue.submit(commandBuffers)
        this.isSubmitted = true

        return new SubmittedWork(this.runtime, {
            id: submittedId,
            commandBuffers,
            report: createScratchDiagnosticReport([]),
            done: createDonePromise(this.runtime.queue),
        })
    }

    get subject() {

        return {
            kind: 'Submission',
            id: this.id,
        }
    }
}

function validateUploadStep(builder: SubmissionBuilder, step: UploadStep) {

    const command = step.command

    if (!command || typeof command.assertRuntime !== 'function' || command.commandKind !== 'upload') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: builder.subject,
            message: 'Submission upload step requires an upload command.',
            expected: { command: 'UploadCommand or TextureUploadCommand' },
            actual: { command: command === undefined || command === null ? String(command) : typeof command },
        })
    }

    command.assertRuntime(builder.runtime)
}

function validateCopyStep(builder: SubmissionBuilder, step: CopyStep) {

    const command = step.command

    if (!command || typeof command.assertRuntime !== 'function' || command.commandKind !== 'copy') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: builder.subject,
            message: 'Submission copy step requires a CopyCommand.',
            expected: { command: 'CopyCommand' },
            actual: { command: command === undefined || command === null ? String(command) : typeof command },
        })
    }

    command.assertRuntime(builder.runtime)
}

function validateResolveStep(builder: SubmissionBuilder, step: ResolveStep) {

    const command = step.command

    if (!command || typeof command.assertRuntime !== 'function' || command.commandKind !== 'resolve-query-set') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: builder.subject,
            message: 'Submission resolve step requires a ResolveQuerySetCommand.',
            expected: { command: 'ResolveQuerySetCommand' },
            actual: { command: command === undefined || command === null ? String(command) : typeof command },
        })
    }

    command.assertRuntime(builder.runtime)
}

export class SubmittedWork {

    runtime: ScratchRuntime
    id: string
    commandBuffers: GPUCommandBuffer[]
    report: ScratchDiagnosticReport
    diagnostics: ScratchDiagnostic[]
    done: Promise<unknown>

    constructor(runtime: ScratchRuntime, options: {
        id?: string
        commandBuffers?: GPUCommandBuffer[]
        report?: ScratchDiagnosticReport
        done?: Promise<unknown>
    } = {}) {

        this.runtime = runtime
        this.id = options.id ?? `scratch-submitted-${UUID()}`
        this.commandBuffers = options.commandBuffers ?? []
        this.report = options.report ?? createScratchDiagnosticReport([])
        this.diagnostics = this.report.diagnostics
        this.done = options.done ?? Promise.resolve()
    }

    get subject() {

        return {
            kind: 'Submission',
            id: this.id,
        }
    }
}

function validateRenderStep(builder: SubmissionBuilder, step: RenderStep) {

    const passSpec = step.passSpec

    if (!passSpec || typeof passSpec.assertRuntime !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: builder.subject,
            message: 'Submission render step requires a PassSpec.',
            expected: { passSpec: 'RenderPassSpec' },
            actual: { passSpec: passSpec === undefined || passSpec === null ? String(passSpec) : typeof passSpec },
        })
    }

    passSpec.assertRuntime(builder.runtime)

    if (passSpec.passKind !== 'render') {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_PASS_KIND_MISMATCH',
            severity: 'error',
            phase: 'command',
            subject: step.commands[0]?.subject ?? builder.subject,
            related: [ passSpec.subject ].filter(Boolean),
            message: 'Render submission step requires a render pass.',
            expected: { passKind: 'render' },
            actual: { passKind: passSpec.passKind },
        })
    }

    for (const command of step.commands) {
        if (!isRenderCommand(command)) {
            throwScratchDiagnostic({
                code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
                severity: 'error',
                phase: 'submission',
                subject: builder.subject,
                message: 'Submission render step requires render commands.',
                expected: { command: 'DrawCommand, BeginOcclusionQueryCommand, or EndOcclusionQueryCommand' },
                actual: { command: command === undefined || command === null ? String(command) : typeof command },
            })
        }

        command.assertRuntime(builder.runtime)
        command.validateForPass(passSpec)
        if (command.commandKind === 'draw') {
            validatePipelineTargets(command, passSpec)
        }
    }

    validateRenderOcclusionQueryOrder(builder, step)
}

function validateComputeStep(builder: SubmissionBuilder, step: ComputeStep) {

    const passSpec = step.passSpec

    if (!passSpec || typeof passSpec.assertRuntime !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: builder.subject,
            message: 'Submission compute step requires a PassSpec.',
            expected: { passSpec: 'ComputePassSpec' },
            actual: { passSpec: passSpec === undefined || passSpec === null ? String(passSpec) : typeof passSpec },
        })
    }

    passSpec.assertRuntime(builder.runtime)

    if (passSpec.passKind !== 'compute') {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_PASS_KIND_MISMATCH',
            severity: 'error',
            phase: 'command',
            subject: step.commands[0]?.subject ?? builder.subject,
            related: [ passSpec.subject ].filter(Boolean),
            message: 'Compute submission step requires a compute pass.',
            expected: { passKind: 'compute' },
            actual: { passKind: passSpec.passKind },
        })
    }

    for (const command of step.commands) {
        command.assertRuntime(builder.runtime)
        command.validateForPass(passSpec)
    }
}

function validatePipelineTargets(command: DrawCommand, passSpec: RenderPassSpec) {

    const targetFormats = command.pipeline.targetFormats
    for (let index = 0; index < passSpec.color.length; index++) {
        const expected = passSpec.color[index]?.format
        const actual = targetFormats[index]

        if (expected !== actual) {
            throwScratchDiagnostic({
                code: 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH',
                severity: 'error',
                phase: 'pipeline',
                subject: command.pipeline.subject,
                related: [
                    command.subject,
                    passSpec.subject,
                ],
                message: 'RenderPipeline target format does not match RenderPassSpec attachment format.',
                expected: { format: expected },
                actual: { format: actual },
            })
        }
    }
}

function validateRenderOcclusionQueryOrder(builder: SubmissionBuilder, step: RenderStep) {

    const passSpec = step.passSpec
    const writtenIndices = new Set<number>()
    let activeCommand: BeginOcclusionQueryCommand | undefined

    for (const command of step.commands) {
        if (command.commandKind === 'begin-occlusion-query') {
            if (passSpec.occlusionQuerySet === undefined) {
                throwOcclusionQueryStateDiagnostic(builder, step, command, 'missingPassQuerySet')
            }

            if (command.querySet !== passSpec.occlusionQuerySet) {
                throwOcclusionQueryStateDiagnostic(builder, step, command, 'querySetMismatch')
            }

            if (activeCommand !== undefined) {
                throwOcclusionQueryStateDiagnostic(builder, step, command, 'nestedBegin', activeCommand)
            }

            if (writtenIndices.has(command.index)) {
                throwOcclusionQueryStateDiagnostic(builder, step, command, 'queryIndexAlreadyWritten')
            }

            activeCommand = command
            continue
        }

        if (command.commandKind !== 'end-occlusion-query') continue

        if (activeCommand === undefined) {
            throwOcclusionQueryStateDiagnostic(builder, step, command, 'endWithoutBegin')
        }

        writtenIndices.add(activeCommand!.index)
        activeCommand = undefined
    }

    if (activeCommand !== undefined) {
        throwOcclusionQueryStateDiagnostic(builder, step, activeCommand, 'unclosedBegin', activeCommand)
    }
}

function isRenderCommand(command: unknown): command is RenderCommand {

    if (!isRecord(command)) return false

    return Boolean(
        typeof command.assertRuntime === 'function' &&
        typeof command.validateForPass === 'function' &&
        new Set([ 'draw', 'begin-occlusion-query', 'end-occlusion-query' ]).has(String(command.commandKind))
    )
}

function throwOcclusionQueryStateDiagnostic(
    builder: SubmissionBuilder,
    step: RenderStep,
    command: unknown,
    reason: string,
    activeCommand?: BeginOcclusionQueryCommand
) {

    const commandRecord = isRecord(command) ? command : {}
    const querySet = commandRecord.querySet

    throwScratchDiagnostic({
        code: 'SCRATCH_SUBMISSION_OCCLUSION_QUERY_STATE_INVALID',
        severity: 'error',
        phase: 'submission',
        subject: diagnosticSubjectOf(command) ?? builder.subject,
        related: [
            builder.subject,
            step.passSpec?.subject,
            diagnosticSubjectOf(querySet),
            step.passSpec?.occlusionQuerySet?.subject,
            activeCommand?.subject,
        ].filter(isDefined),
        message: 'Render submission occlusion query commands must form non-nested begin/end pairs against the pass occlusionQuerySet.',
        expected: {
            pass: 'RenderPassSpec with matching occlusionQuerySet',
            commands: 'begin/end pairs in explicit order with one active query at a time',
        },
        actual: {
            reason,
            commandKind: commandRecord.commandKind,
            queryIndex: commandRecord.index,
            hasPassQuerySet: step.passSpec?.occlusionQuerySet !== undefined,
            passQuerySetId: step.passSpec?.occlusionQuerySet?.id,
            commandQuerySetId: isRecord(querySet) ? querySet.id : undefined,
            activeQueryIndex: activeCommand?.index,
        },
    })
}

function advanceRenderAttachmentEpochs(passSpec: RenderPassSpec) {

    const writtenTargets = new Set<TextureResource>()

    for (const attachment of passSpec.color) {
        const target = attachment.target
        if (!(target instanceof TextureResource) || writtenTargets.has(target)) continue

        target._advanceContentEpoch()
        writtenTargets.add(target)
    }
}

function createDonePromise(queue: GPUQueue): Promise<unknown> {

    if (queue && typeof queue.onSubmittedWorkDone === 'function') {
        return queue.onSubmittedWorkDone()
    }

    return Promise.resolve()
}
