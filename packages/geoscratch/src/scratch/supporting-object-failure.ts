import { throwScratchDiagnostic } from './diagnostics.js'
import { serializeNativeGpuError } from './gpu-operation.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import { destroySupportingObjectCandidate } from './supporting-object-creation.js'
import type { DiagnosticPhase, DiagnosticSubject } from './diagnostics.js'
import type {
    GpuNativeErrorCategory,
    ScratchGpuIncidentOutcome,
    ScratchSupportingObjectFailureStage,
} from './gpu-operation.js'
import type { ScratchPendingGpuOperation } from './runtime-diagnostics.js'
import type { ScratchRuntime } from './runtime.js'
import type {
    SupportingObjectCreationOutcome,
    SupportingObjectFailureKind,
    SupportingObjectObservedFailure,
} from './supporting-object-creation.js'

export type SupportingObjectDiagnosticCodes = Readonly<{
    validation: string
    internal: string
    outOfMemory: string
    nativeException: string
}>

export function throwSupportingObjectCreationFailure<T>(
    runtime: ScratchRuntime,
    operation: ScratchPendingGpuOperation,
    outcome: SupportingObjectCreationOutcome<T>,
    codes: SupportingObjectDiagnosticCodes,
    input: Readonly<{
        operationName: string
        phase: DiagnosticPhase
        subject: DiagnosticSubject
        related?: readonly DiagnosticSubject[]
    }>
): never {

    destroySupportingObjectCandidate(outcome.candidate)
    const failures = outcome.failures.length > 0
        ? outcome.failures
        : Object.freeze([ Object.freeze({
            kind: 'native-exception' as const,
            cause: new TypeError('Supporting-object creation produced no acknowledged candidate.'),
        }) ])
    const primary = selectPrimaryFailure(failures)
    const controller = diagnosticsControllerFor(runtime)

    if (primary.kind === 'device-lost') {
        const info = primary.deviceLostInfo ?? runtime.deviceLostInfo ?? {
            reason: 'unknown',
            message: 'GPU device was lost while supporting-object scopes were settling.',
        }
        const incident = controller.recordDeviceLoss(info as GPUDeviceLostInfo)
        controller.completeOperation(operation, {
            status: 'cancelled',
            nativeErrorCategory: 'device-lost',
            ...(incident !== undefined ? { incidentId: incident.id } : {}),
        })
        throwScratchDiagnostic({
            code: 'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION',
            severity: 'error',
            phase: 'runtime',
            subject: { kind: 'GpuOperation', id: operation.id, operationKind: operation.kind },
            related: [ runtime.subject, input.subject, ...(input.related ?? []) ],
            message: `GPU device was lost while ${input.operationName} was pending.`,
            actual: { operationId: operation.id },
        }, { ...(incident !== undefined ? { incident } : {}) })
    }

    if (primary.kind === 'runtime-disposed') {
        controller.completeOperation(operation, { status: 'cancelled' })
        throwScratchDiagnostic({
            code: 'SCRATCH_RUNTIME_DISPOSED',
            severity: 'error',
            phase: 'runtime',
            subject: { kind: 'GpuOperation', id: operation.id, operationKind: operation.kind },
            related: [ runtime.subject, input.subject, ...(input.related ?? []) ],
            message: `ScratchRuntime was disposed while ${input.operationName} was pending.`,
            actual: { operationId: operation.id },
        })
    }

    const code = failureCode(primary.kind, codes)
    const nativeErrorCategory = failureNativeCategory(primary.kind)
    const record = controller.completeOperation(operation, {
        status: 'failed',
        nativeErrorCategory,
    })
    const incidentOutcomes = Object.freeze(failures
        .filter(failure => failure.kind !== 'runtime-disposed' && failure.kind !== 'device-lost')
        .map(failure => incidentOutcome(failure, codes, input.subject)))
    const incident = controller.recordIncident({
        kind: 'supporting-object-failure',
        diagnosticCode: code,
        nativeErrorCategory,
        attribution: 'exact-operation',
        target: operation.target,
        operationId: operation.id,
        triggerOperation: record,
        related: [ input.subject, ...(input.related ?? []) ],
        ...(primary.cause !== undefined
            ? { nativeError: serializeNativeGpuError(primary.cause) }
            : {}),
        failureStage: failureStage(primary.kind),
        outcomes: incidentOutcomes,
    })

    throwScratchDiagnostic({
        code,
        severity: 'error',
        phase: input.phase,
        subject: { kind: 'GpuOperation', id: operation.id, operationKind: operation.kind },
        related: [ runtime.subject, input.subject, ...(input.related ?? []), incident.subject ],
        message: failureMessage(primary.kind, input.operationName),
        actual: {
            operationId: operation.id,
            failures: incidentOutcomes,
        },
    }, {
        ...(primary.cause !== undefined ? { cause: primary.cause } : {}),
        incident,
    })
}

function selectPrimaryFailure(
    failures: readonly SupportingObjectObservedFailure[]
): SupportingObjectObservedFailure {

    const priority: Record<SupportingObjectFailureKind, number> = {
        'device-lost': 0,
        'runtime-disposed': 1,
        'scope-failure': 2,
        'native-exception': 3,
        validation: 4,
        internal: 5,
        'out-of-memory': 6,
    }
    return [ ...failures ].sort((left, right) => priority[left.kind] - priority[right.kind])[0]!
}

function incidentOutcome(
    failure: SupportingObjectObservedFailure,
    codes: SupportingObjectDiagnosticCodes,
    subject: DiagnosticSubject
): ScratchGpuIncidentOutcome {

    return Object.freeze({
        stage: failureStage(failure.kind),
        diagnosticCode: failureCode(failure.kind, codes),
        nativeErrorCategory: failureNativeCategory(failure.kind),
        subject,
        ...(failure.cause !== undefined
            ? { nativeError: serializeNativeGpuError(failure.cause) }
            : {}),
    })
}

function failureStage(kind: SupportingObjectFailureKind): ScratchSupportingObjectFailureStage {

    if (kind === 'device-lost' || kind === 'runtime-disposed') return 'lifecycle-recheck'
    if (kind === 'native-exception') return 'native-issue'
    return 'scope-settlement'
}

function failureCode(
    kind: SupportingObjectFailureKind,
    codes: SupportingObjectDiagnosticCodes
): string {

    if (kind === 'validation') return codes.validation
    if (kind === 'internal') return codes.internal
    if (kind === 'out-of-memory') return codes.outOfMemory
    if (kind === 'scope-failure') return 'SCRATCH_GPU_ERROR_SCOPE_FAILED'
    if (kind === 'runtime-disposed') return 'SCRATCH_RUNTIME_DISPOSED'
    if (kind === 'device-lost') return 'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION'
    return codes.nativeException
}

function failureNativeCategory(kind: SupportingObjectFailureKind): GpuNativeErrorCategory {

    if (
        kind === 'validation' ||
        kind === 'internal' ||
        kind === 'out-of-memory' ||
        kind === 'scope-failure' ||
        kind === 'device-lost'
    ) return kind
    if (kind === 'runtime-disposed') return 'none'
    return 'native-exception'
}

function failureMessage(kind: SupportingObjectFailureKind, operationName: string): string {

    if (kind === 'validation') return `${operationName} failed native validation.`
    if (kind === 'internal') return `${operationName} observed a native internal error.`
    if (kind === 'out-of-memory') return `${operationName} observed native out-of-memory.`
    if (kind === 'scope-failure') return `${operationName} error scopes failed to settle structurally.`
    if (kind === 'runtime-disposed') return `ScratchRuntime was disposed while ${operationName} was pending.`
    if (kind === 'device-lost') return `GPU device was lost while ${operationName} was pending.`
    return `${operationName} failed with a synchronous native exception.`
}
