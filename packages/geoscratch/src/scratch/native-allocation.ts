import { throwScratchDiagnostic } from './diagnostics.js'
import { serializeNativeGpuError } from './gpu-operation.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import type { ScratchPendingGpuOperation } from './runtime-diagnostics.js'
import type { ScratchRuntime } from './runtime.js'

export type ScopedNativeAllocationFailureKind =
    | 'validation'
    | 'out-of-memory'
    | 'native-exception'
    | 'scope-failure'
    | 'device-lost'
    | 'runtime-disposed'

export type ScopedNativeAllocationOutcome<T> =
    | Readonly<{
        ok: true
        candidate: T
    }>
    | Readonly<{
        ok: false
        kind: ScopedNativeAllocationFailureKind
        candidate?: T
        cause?: unknown
        deviceLostInfo?: GPUDeviceLostInfo
    }>

export type ScopedAllocationDiagnosticCodes = Readonly<{
    validation: string
    outOfMemory: string
    nativeException: string
}>

type SettledScope =
    | Readonly<{ status: 'fulfilled', value: GPUError | null }>
    | Readonly<{ status: 'rejected', reason: unknown }>

type ScopeSettlement = Readonly<{
    kind: 'scopes-settled'
    validation: SettledScope
    outOfMemory: SettledScope
}>

type LifecycleSettlement =
    | Readonly<{ kind: 'device-lost', info: GPUDeviceLostInfo }>
    | Readonly<{ kind: 'runtime-disposed' }>

export function issueScopedNativeAllocation<T>(
    runtime: ScratchRuntime,
    issue: () => T
): Promise<ScopedNativeAllocationOutcome<T>> {

    const device = runtime.device
    const boundaryFailures: unknown[] = []
    let outOfMemoryPushed = false
    let validationPushed = false
    let candidate: T | undefined
    let nativeException: unknown

    if (
        !device ||
        typeof device.pushErrorScope !== 'function' ||
        typeof device.popErrorScope !== 'function'
    ) {
        return Promise.resolve(Object.freeze({
            ok: false,
            kind: 'scope-failure',
            cause: new TypeError('GPUDevice error-scope methods are unavailable.'),
        }))
    }

    try {
        device.pushErrorScope('out-of-memory')
        outOfMemoryPushed = true
    } catch (error) {
        boundaryFailures.push(error)
    }

    if (outOfMemoryPushed) {
        try {
            device.pushErrorScope('validation')
            validationPushed = true
        } catch (error) {
            boundaryFailures.push(error)
        }
    }

    if (outOfMemoryPushed && validationPushed) {
        try {
            candidate = issue()
        } catch (error) {
            nativeException = error
        }
    }

    const validationPop = validationPushed
        ? popScope(device)
        : Promise.resolve<SettledScope>({ status: 'fulfilled', value: null })
    const outOfMemoryPop = outOfMemoryPushed
        ? popScope(device)
        : Promise.resolve<SettledScope>({ status: 'fulfilled', value: null })

    const scopeSettlement: Promise<ScopeSettlement> = Promise.all([
        validationPop,
        outOfMemoryPop,
    ]).then(([ validation, outOfMemory ]) => ({
        kind: 'scopes-settled',
        validation,
        outOfMemory,
    }))
    const deviceLoss: Promise<LifecycleSettlement> = device.lost.then(info => ({
        kind: 'device-lost',
        info,
    }))
    const runtimeDisposal: Promise<LifecycleSettlement> = diagnosticsControllerFor(runtime)
        .whenDisposed.then(() => ({ kind: 'runtime-disposed' }))

    return settleScopedNativeAllocation(
        runtime,
        candidate,
        nativeException,
        boundaryFailures,
        scopeSettlement,
        deviceLoss,
        runtimeDisposal
    )
}

export function createScratchNativeLabel(label: string | undefined, resourceId: string): string {

    return label === undefined
        ? `scratch:${resourceId}`
        : `${label} [scratch:${resourceId}]`
}

export function destroyNativeCandidate(candidate: unknown): void {

    if (
        candidate !== null &&
        (typeof candidate === 'object' || typeof candidate === 'function') &&
        typeof (candidate as { destroy?: unknown }).destroy === 'function'
    ) {
        try {
            (candidate as { destroy(): void }).destroy()
        } catch {
            // Candidate cleanup is best effort after the primary allocation failure.
        }
    }
}

export function throwScopedAllocationFailure<T>(
    runtime: ScratchRuntime,
    operation: ScratchPendingGpuOperation,
    outcome: Extract<ScopedNativeAllocationOutcome<T>, { ok: false }>,
    codes: ScopedAllocationDiagnosticCodes,
    operationName: string
): never {

    destroyNativeCandidate(outcome.candidate)
    const controller = diagnosticsControllerFor(runtime)

    if (outcome.kind === 'device-lost') {
        const info = outcome.deviceLostInfo ?? runtime.deviceLostInfo ?? {
            reason: 'unknown',
            message: 'GPU device was lost while allocation scopes were settling.',
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
            related: [
                runtime.subject,
                { kind: 'Resource', id: operation.resourceId, resourceKind: operation.resourceKind },
                ...(incident !== undefined ? [ incident.subject ] : []),
            ],
            message: `GPU device was lost while ${operationName} was pending.`,
            actual: { operationId: operation.id, resourceId: operation.resourceId },
        }, { ...(incident !== undefined ? { incident } : {}) })
    }

    const status = outcome.kind === 'runtime-disposed' ? 'cancelled' : 'failed'
    const nativeErrorCategory = failureNativeCategory(outcome.kind)
    const record = controller.completeOperation(operation, {
        status,
        ...(nativeErrorCategory !== 'none' ? { nativeErrorCategory } : {}),
    })
    const code = failureCode(outcome.kind, codes)
    const incident = controller.recordIncident({
        kind: 'allocation-failure',
        diagnosticCode: code,
        nativeErrorCategory,
        attribution: 'exact-operation',
        resourceId: operation.resourceId,
        operationId: operation.id,
        triggerOperation: record,
        ...(outcome.cause !== undefined
            ? { nativeError: serializeNativeGpuError(outcome.cause) }
            : {}),
        triggerLogicalFootprintBytes: operation.logicalFootprintBytes,
    })

    throwScratchDiagnostic({
        code,
        severity: 'error',
        phase: outcome.kind === 'runtime-disposed' ? 'runtime' : 'resource',
        subject: { kind: 'GpuOperation', id: operation.id, operationKind: operation.kind },
        related: [
            runtime.subject,
            { kind: 'Resource', id: operation.resourceId, resourceKind: operation.resourceKind },
            incident.subject,
        ],
        message: failureMessage(outcome.kind, operationName),
        actual: {
            operationId: operation.id,
            resourceId: operation.resourceId,
            ...(outcome.cause !== undefined
                ? { nativeError: serializeNativeGpuError(outcome.cause) }
                : {}),
        },
    }, {
        ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
        incident,
    })
}

async function settleScopedNativeAllocation<T>(
    runtime: ScratchRuntime,
    candidate: T | undefined,
    nativeException: unknown,
    boundaryFailures: unknown[],
    scopeSettlement: Promise<ScopeSettlement>,
    deviceLoss: Promise<LifecycleSettlement>,
    runtimeDisposal: Promise<LifecycleSettlement>
): Promise<ScopedNativeAllocationOutcome<T>> {

    const settlement = await Promise.race([
        scopeSettlement,
        deviceLoss,
        runtimeDisposal,
    ])

    if (settlement.kind === 'device-lost') {
        return Object.freeze({
            ok: false,
            kind: 'device-lost',
            ...(candidate !== undefined ? { candidate } : {}),
            deviceLostInfo: settlement.info,
        })
    }
    if (settlement.kind === 'runtime-disposed') {
        return Object.freeze({
            ok: false,
            kind: 'runtime-disposed',
            ...(candidate !== undefined ? { candidate } : {}),
        })
    }

    if (runtime.isDisposed) {
        return Object.freeze({
            ok: false,
            kind: 'runtime-disposed',
            ...(candidate !== undefined ? { candidate } : {}),
        })
    }
    if (runtime.isDeviceLost) {
        return Object.freeze({
            ok: false,
            kind: 'device-lost',
            ...(candidate !== undefined ? { candidate } : {}),
            ...(runtime.deviceLostInfo !== undefined ? { deviceLostInfo: runtime.deviceLostInfo } : {}),
        })
    }

    if (
        boundaryFailures.length > 0 ||
        settlement.validation.status === 'rejected' ||
        settlement.outOfMemory.status === 'rejected'
    ) {
        const cause = boundaryFailures.length > 0
            ? boundaryFailures[0]
            : settlement.validation.status === 'rejected'
                ? settlement.validation.reason
                : settlement.outOfMemory.status === 'rejected'
                    ? settlement.outOfMemory.reason
                    : undefined
        return Object.freeze({
            ok: false,
            kind: 'scope-failure',
            ...(candidate !== undefined ? { candidate } : {}),
            ...(cause !== undefined ? { cause } : {}),
        })
    }

    if (nativeException !== undefined) {
        return Object.freeze({
            ok: false,
            kind: 'native-exception',
            cause: nativeException,
        })
    }

    const validationError = settlement.validation.value
    const outOfMemoryError = settlement.outOfMemory.value
    if (validationError !== null && outOfMemoryError !== null) {
        return Object.freeze({
            ok: false,
            kind: 'scope-failure',
            ...(candidate !== undefined ? { candidate } : {}),
            cause: validationError,
        })
    }
    if (validationError !== null) {
        return Object.freeze({
            ok: false,
            kind: 'validation',
            ...(candidate !== undefined ? { candidate } : {}),
            cause: validationError,
        })
    }
    if (outOfMemoryError !== null) {
        return Object.freeze({
            ok: false,
            kind: 'out-of-memory',
            ...(candidate !== undefined ? { candidate } : {}),
            cause: outOfMemoryError,
        })
    }
    if (candidate === undefined) {
        return Object.freeze({
            ok: false,
            kind: 'native-exception',
            cause: new TypeError('Native allocation returned undefined.'),
        })
    }

    return Object.freeze({ ok: true, candidate })
}

function popScope(device: GPUDevice): Promise<SettledScope> {

    try {
        return Promise.resolve(device.popErrorScope()).then(
            value => ({ status: 'fulfilled', value }),
            reason => ({ status: 'rejected', reason })
        )
    } catch (reason) {
        return Promise.resolve({ status: 'rejected', reason })
    }
}

function failureCode(
    kind: ScopedNativeAllocationFailureKind,
    codes: ScopedAllocationDiagnosticCodes
): string {

    if (kind === 'validation') return codes.validation
    if (kind === 'out-of-memory') return codes.outOfMemory
    if (kind === 'scope-failure') return 'SCRATCH_GPU_ERROR_SCOPE_FAILED'
    if (kind === 'runtime-disposed') return 'SCRATCH_RUNTIME_DISPOSED'
    return codes.nativeException
}

function failureNativeCategory(
    kind: ScopedNativeAllocationFailureKind
): 'validation' | 'out-of-memory' | 'native-exception' | 'scope-failure' | 'none' {

    if (kind === 'validation' || kind === 'out-of-memory' || kind === 'scope-failure') return kind
    if (kind === 'runtime-disposed') return 'none'
    return 'native-exception'
}

function failureMessage(kind: ScopedNativeAllocationFailureKind, operationName: string): string {

    if (kind === 'validation') return `${operationName} failed native validation.`
    if (kind === 'out-of-memory') return `${operationName} observed native out-of-memory.`
    if (kind === 'scope-failure') return `${operationName} error scopes failed to settle structurally.`
    if (kind === 'runtime-disposed') return `ScratchRuntime was disposed while ${operationName} was pending.`
    return `${operationName} failed with a synchronous native exception.`
}
