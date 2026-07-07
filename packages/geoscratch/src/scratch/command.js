import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'

export class DrawCommand {

    constructor(runtime, descriptor = {}) {

        runtime.assertActive()

        const pipeline = descriptor.pipeline
        if (!pipeline || typeof pipeline.assertRuntime !== 'function') {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE',
                severity: 'error',
                phase: 'command',
                subject: { kind: 'Command', commandKind: 'draw' },
                message: 'DrawCommand requires a render pipeline.',
                expected: { pipeline: 'RenderPipeline' },
                actual: { pipeline: pipeline === undefined || pipeline === null ? String(pipeline) : typeof pipeline },
            })
        }

        pipeline.assertRuntime(runtime)

        this.runtime = runtime
        this.id = `scratch-command-${UUID()}`
        this.label = descriptor.label
        this.commandKind = 'draw'
        this.pipeline = pipeline
        this.count = normalizeDrawCount(this, descriptor.count)
        this.whenMissing = normalizeReadinessPolicy(this, descriptor.whenMissing)
        this.isDisposed = false
    }

    get subject() {

        const subject = {
            kind: 'Command',
            id: this.id,
            commandKind: 'draw',
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    assertRuntime(runtime) {

        this.assertUsable()

        if (runtime !== this.runtime) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_WRONG_RUNTIME',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    this.runtime.subject,
                    runtime?.subject,
                ].filter(Boolean),
                message: 'Command belongs to a different ScratchRuntime.',
                expected: { runtimeId: this.runtime.id },
                actual: { runtimeId: runtime?.id },
            })
        }
    }

    assertUsable() {

        if (this.isDisposed) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_DISPOSED',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                message: 'Command has been disposed.',
            })
        }

        this.runtime.assertActive()
        this.pipeline.assertUsable()
    }

    validateForPass(passSpec) {

        this.assertUsable()

        if (passSpec.passKind !== 'render') {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_PASS_KIND_MISMATCH',
                severity: 'error',
                phase: 'command',
                subject: this.subject,
                related: [
                    passSpec.subject,
                    this.pipeline.subject,
                ].filter(Boolean),
                message: 'DrawCommand can only be recorded into a render pass.',
                expected: { passKind: 'render' },
                actual: { passKind: passSpec.passKind },
            })
        }
    }

    encode(passEncoder) {

        this.assertUsable()

        passEncoder.setPipeline(this.pipeline.gpuPipeline)
        passEncoder.draw(
            this.count.vertexCount,
            this.count.instanceCount ?? 1,
            this.count.firstVertex ?? 0,
            this.count.firstInstance ?? 0
        )
    }

    dispose() {

        this.isDisposed = true
    }
}

function normalizeDrawCount(command, count) {

    if (!count || typeof count !== 'object') {
        throwCountDiagnostic(command, count)
    }

    if (!isPositiveFinite(count.vertexCount)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_COUNT_INVALID',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
            message: 'DrawCommand vertexCount must be a positive finite number.',
            expected: { vertexCount: 'positive finite number' },
            actual: { vertexCount: count.vertexCount },
        })
    }

    for (const key of [ 'instanceCount', 'firstVertex', 'firstInstance' ]) {
        if (count[key] !== undefined && !isNonNegativeFinite(count[key])) {
            throwScratchDiagnostic({
                code: 'SCRATCH_COMMAND_COUNT_INVALID',
                severity: 'error',
                phase: 'command',
                subject: command.subject,
                message: `DrawCommand ${key} must be a non-negative finite number.`,
                expected: { [key]: 'non-negative finite number' },
                actual: { [key]: count[key] },
            })
        }
    }

    return { ...count }
}

function normalizeReadinessPolicy(command, whenMissing) {

    const allowed = new Set([ 'throw', 'skip-command', 'skip-pass', 'use-fallback' ])

    if (!allowed.has(whenMissing)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_COMMAND_READINESS_POLICY_MISSING',
            severity: 'error',
            phase: 'command',
            subject: command.subject,
            message: 'DrawCommand requires an explicit readiness policy.',
            expected: { whenMissing: [ ...allowed ] },
            actual: { whenMissing },
        })
    }

    return whenMissing
}

function throwCountDiagnostic(command, count) {

    throwScratchDiagnostic({
        code: 'SCRATCH_COMMAND_COUNT_INVALID',
        severity: 'error',
        phase: 'command',
        subject: command.subject,
        message: 'DrawCommand requires a static draw count for this slice.',
        expected: { count: '{ vertexCount: number }' },
        actual: { count },
    })
}

function isPositiveFinite(value) {

    return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonNegativeFinite(value) {

    return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
