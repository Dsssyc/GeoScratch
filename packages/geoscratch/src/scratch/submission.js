import { UUID } from '../core/utils/uuid.js'
import {
    createScratchDiagnosticReport,
    throwScratchDiagnostic,
} from './diagnostics.js'

export class SubmissionBuilder {

    constructor(runtime, options = {}) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-submission-builder-${UUID()}`
        this.validation = options.validation ?? 'throw'
        this.steps = []
        this.isSubmitted = false
    }

    render(passSpec, commands = []) {

        this.steps.push({
            kind: 'render',
            passSpec,
            commands: [ ...commands ],
        })

        return this
    }

    compute(passSpec, commands = []) {

        this.steps.push({
            kind: 'compute',
            passSpec,
            commands: [ ...commands ],
        })

        return this
    }

    upload(command) {

        this.steps.push({
            kind: 'upload',
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
        const commandBuffers = []
        const encoder = this.runtime.device.createCommandEncoder({
            label: submittedId,
        })

        for (const step of this.steps) {
            if (step.kind === 'upload') {
                validateUploadStep(this, step)
                step.command.execute(this.runtime.queue)
                continue
            }

            if (step.kind === 'compute') {
                validateComputeStep(this, step)

                if (step.commands.length === 0) continue

                const passEncoder = encoder.beginComputePass(step.passSpec.createComputePassDescriptor())
                for (const command of step.commands) {
                    command.encode(passEncoder)
                }
                passEncoder.end()
                continue
            }

            validateRenderStep(this, step)

            if (step.commands.length === 0) continue

            const passEncoder = encoder.beginRenderPass(step.passSpec.createRenderPassDescriptor())
            for (const command of step.commands) {
                command.encode(passEncoder)
            }
            passEncoder.end()
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

function validateUploadStep(builder, step) {

    const command = step.command

    if (!command || typeof command.assertRuntime !== 'function' || command.commandKind !== 'upload') {
        throwScratchDiagnostic({
            code: 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE',
            severity: 'error',
            phase: 'submission',
            subject: builder.subject,
            message: 'Submission upload step requires an UploadCommand.',
            expected: { command: 'UploadCommand' },
            actual: { command: command === undefined || command === null ? String(command) : typeof command },
        })
    }

    command.assertRuntime(builder.runtime)
}

export class SubmittedWork {

    constructor(runtime, options = {}) {

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

function validateRenderStep(builder, step) {

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
        command.assertRuntime(builder.runtime)
        command.validateForPass(passSpec)
        validatePipelineTargets(command, passSpec)
    }
}

function validateComputeStep(builder, step) {

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

function validatePipelineTargets(command, passSpec) {

    const targetFormats = command.pipeline.targetFormats
    for (let index = 0; index < passSpec.color.length; index++) {
        const expected = passSpec.color[index].format
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

function createDonePromise(queue) {

    if (queue && typeof queue.onSubmittedWorkDone === 'function') {
        return queue.onSubmittedWorkDone()
    }

    return Promise.resolve()
}
