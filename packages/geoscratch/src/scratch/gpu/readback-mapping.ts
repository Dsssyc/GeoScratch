import { throwScratchDiagnostic } from './diagnostics.js'
import { serializeNativeGpuError } from './gpu-operation.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import type {
    GpuNativeErrorCategory,
    ScratchGpuIncidentOutcome,
    ScratchGpuReadbackOperationTarget,
    ScratchReadbackFailureStage,
} from './gpu-operation.js'
import type { ScratchRuntime } from './runtime.js'
import type { ScratchPendingGpuOperation } from './runtime-diagnostics.js'
import type { ReadbackStagingCleanupResult } from './readback-staging.js'

type PromiseObservation<T> =
    | Readonly<{ status: 'fulfilled', value: T }>
    | Readonly<{ status: 'rejected', reason: unknown }>
    | Readonly<{ status: 'invalid', reason: TypeError }>
    | Readonly<{ status: 'not-issued' }>

type ScopeFilter = 'validation' | 'internal' | 'out-of-memory'

type MappingFailure = Readonly<{
    code: string
    category: GpuNativeErrorCategory
    cause?: unknown
    outcome: ScratchGpuIncidentOutcome
}>

export type ReadbackMappingLifecycleState = 'active' | 'cancelled' | 'disposed'

export type ReadbackMappingInput = Readonly<{
    runtime: ScratchRuntime
    target: ScratchGpuReadbackOperationTarget
    buffer: GPUBuffer
    byteLength: number
    label?: string
    lifecycleState(): ReadbackMappingLifecycleState
    subscribeLifecycle(listener: (state: Exclude<ReadbackMappingLifecycleState, 'active'>) => void): () => void
    onOperation(operationId: string): void
}>

export type ReadbackMappingResult =
    | Readonly<{ status: 'mapped', transaction: ReadbackMappingTransaction }>
    | Readonly<{ status: 'cancelled', operationId: string }>

type ReadbackMappingTransactionState = {
    runtime: ScratchRuntime
    target: ScratchGpuReadbackOperationTarget
    operation: ScratchPendingGpuOperation
    isComplete: boolean
}

const readbackMappingTransactionToken = Symbol('ReadbackMappingTransaction')
const readbackMappingTransactionStates = new WeakMap<ReadbackMappingTransaction, ReadbackMappingTransactionState>()

export class ReadbackMappingTransaction {

    private constructor(token: symbol) {

        if (token !== readbackMappingTransactionToken || new.target !== ReadbackMappingTransaction) {
            throw new TypeError('ReadbackMappingTransaction is Scratch-owned.')
        }
        Object.preventExtensions(this)
    }

    get operationId(): string {

        return mappingTransactionStateFor(this).operation.id
    }
}

export async function beginReadbackMapping(
    input: ReadbackMappingInput
): Promise<ReadbackMappingResult> {

    const controller = diagnosticsControllerFor(input.runtime)
    const operation = controller.beginOperation({
        kind: 'readback-mapping',
        target: input.target,
        descriptorSummary: { byteLength: input.byteLength, mode: 'read' },
        fullDescriptor: { byteLength: input.byteLength, mode: 'read' },
        ...(input.label !== undefined ? { nativeLabel: input.label } : {}),
    })
    input.onOperation(operation.id)

    let operationLifecycle = input.lifecycleState()
    let runtimeLifecycle: 'active' | 'device-lost' | 'runtime-disposed' = 'active'
    const unsubscribeOperation = input.subscribeLifecycle(state => {
        operationLifecycle = state
    })
    const unsubscribeRuntime = controller.subscribeLifecycle(change => {
        runtimeLifecycle = change.kind === 'device-lost' ? 'device-lost' : 'runtime-disposed'
    })

    try {
        if (operationLifecycle !== 'active' || input.runtime.isDisposed || input.runtime.isDeviceLost) {
            return cancelMappingForLifecycle(input, operation, operationLifecycle, runtimeLifecycle, [])
        }

        const issued = issueMapBoundary(input.runtime.device, input.buffer, input.byteLength)
        const [ map, validation, internal, outOfMemory ] = await Promise.all([
            issued.map,
            issued.validation,
            issued.internal,
            issued.outOfMemory,
        ])
        operationLifecycle = input.lifecycleState()
        if (input.runtime.isDeviceLost) runtimeLifecycle = 'device-lost'
        else if (input.runtime.isDisposed) runtimeLifecycle = 'runtime-disposed'

        const failures = mappingFailures({
            boundaryFailures: issued.boundaryFailures,
            synchronousMapFailure: issued.synchronousMapFailure,
            map,
            scopes: [
                { filter: 'validation', observation: validation },
                { filter: 'internal', observation: internal },
                { filter: 'out-of-memory', observation: outOfMemory },
            ],
        })
        const expectedCancellation = operationLifecycle !== 'active' &&
            failures.every(failure => failure.code === 'SCRATCH_READBACK_MAPPING_REJECTED')
        if (expectedCancellation || runtimeLifecycle !== 'active') {
            return cancelMappingForLifecycle(
                input,
                operation,
                operationLifecycle,
                runtimeLifecycle,
                failures
            )
        }
        if (failures.length > 0) {
            return throwMappingFailures(input.runtime, operation, failures)
        }
        if (map.status === 'rejected' || map.status === 'invalid') {
            return throwMappingFailures(input.runtime, operation, [ mapFailure(map) ])
        }
        if (map.status === 'not-issued') {
            return throwMappingFailures(input.runtime, operation, [ mappingStageFailure({
                stage: 'mapping',
                code: 'SCRATCH_READBACK_MAPPING_NATIVE_FAILED',
                cause: new TypeError('GPUBuffer.mapAsync() was not issued.'),
            }) ])
        }

        return Object.freeze({
            status: 'mapped',
            transaction: constructReadbackMappingTransaction({
                runtime: input.runtime,
                target: input.target,
                operation,
                isComplete: false,
            }),
        })
    } finally {
        unsubscribeOperation()
        unsubscribeRuntime()
    }
}

export function completeReadbackMapping(transaction: ReadbackMappingTransaction): void {

    const state = claimMappingTransaction(transaction)
    diagnosticsControllerFor(state.runtime).completeOperation(state.operation, { status: 'succeeded' })
}

export function cancelReadbackMapping(transaction: ReadbackMappingTransaction): void {

    const state = claimMappingTransaction(transaction)
    diagnosticsControllerFor(state.runtime).completeOperation(state.operation, { status: 'cancelled' })
}

export function failReadbackMapping(
    transaction: ReadbackMappingTransaction,
    input: Readonly<{
        stage: ScratchReadbackFailureStage
        code: string
        cause: unknown
        category?: GpuNativeErrorCategory
    }>
): never {

    const state = claimMappingTransaction(transaction)
    return throwCompletedMappingFailure(state.runtime, state.operation, [ mappingStageFailure(input) ], input.stage)
}

export function recordReadbackCleanupFailure(
    transaction: ReadbackMappingTransaction,
    cleanup: ReadbackStagingCleanupResult
): void {

    const state = claimMappingTransaction(transaction)
    const failures = cleanup.failures.map(failure => mappingStageFailure({
        stage: 'cleanup',
        code: failure.kind === 'unmap'
            ? 'SCRATCH_READBACK_UNMAP_FAILED'
            : 'SCRATCH_READBACK_STAGING_DESTROY_FAILED',
        category: 'native-exception',
        cause: failure.cause,
    }))
    if (failures.length === 0) {
        throw new TypeError('Readback cleanup failure completion requires at least one failure.')
    }
    if (cleanup.incident !== undefined) {
        diagnosticsControllerFor(state.runtime).completeOperation(state.operation, {
            status: 'failed',
            nativeErrorCategory: 'native-exception',
            incidentId: cleanup.incident.id,
        })
        return
    }
    completeMappingFailure(state.runtime, state.operation, failures, 'cleanup')
}

function issueMapBoundary(device: GPUDevice, buffer: GPUBuffer, byteLength: number) {

    const boundaryFailures: unknown[] = []
    let outOfMemoryPushed = false
    let internalPushed = false
    let validationPushed = false
    let map = notIssued<undefined>()
    let synchronousMapFailure: unknown
    const supportsScopes = device &&
        typeof device.pushErrorScope === 'function' &&
        typeof device.popErrorScope === 'function'

    if (supportsScopes) {
        try {
            device.pushErrorScope('out-of-memory')
            outOfMemoryPushed = true
        } catch (cause) {
            boundaryFailures.push(cause)
        }
        if (outOfMemoryPushed) {
            try {
                device.pushErrorScope('internal')
                internalPushed = true
            } catch (cause) {
                boundaryFailures.push(cause)
            }
        }
        if (outOfMemoryPushed && internalPushed) {
            try {
                device.pushErrorScope('validation')
                validationPushed = true
            } catch (cause) {
                boundaryFailures.push(cause)
            }
        }
    }

    if (!supportsScopes || (outOfMemoryPushed && internalPushed && validationPushed)) {
        try {
            map = observePromise<undefined>(
                buffer.mapAsync(GPUMapModeValue(), 0, byteLength),
                'GPUBuffer.mapAsync()'
            )
        } catch (cause) {
            synchronousMapFailure = cause
        }
    }

    const validation = popMapScope(device, validationPushed)
    const internal = popMapScope(device, internalPushed)
    const outOfMemory = popMapScope(device, outOfMemoryPushed)
    return {
        boundaryFailures: Object.freeze(boundaryFailures),
        ...(synchronousMapFailure !== undefined ? { synchronousMapFailure } : {}),
        map,
        validation,
        internal,
        outOfMemory,
    }
}

function mappingFailures(input: {
    boundaryFailures: readonly unknown[]
    synchronousMapFailure?: unknown
    map: PromiseObservation<undefined>
    scopes: readonly Readonly<{ filter: ScopeFilter, observation: PromiseObservation<GPUError | null> }>[]
}): MappingFailure[] {

    const failures: MappingFailure[] = []
    for (const cause of input.boundaryFailures) failures.push(scopeFailure(cause))
    for (const scope of input.scopes) {
        const observation = scope.observation
        if (observation.status === 'rejected' || observation.status === 'invalid') {
            failures.push(scopeFailure(observation.reason))
        } else if (observation.status === 'fulfilled' && observation.value !== null) {
            failures.push(capturedScopeFailure(scope.filter, observation.value))
        }
    }
    if (input.synchronousMapFailure !== undefined) {
        failures.push(mappingStageFailure({
            stage: 'mapping',
            code: 'SCRATCH_READBACK_MAPPING_NATIVE_FAILED',
            cause: input.synchronousMapFailure,
        }))
    } else if (input.map.status === 'rejected' || input.map.status === 'invalid') {
        failures.push(mapFailure(input.map))
    }
    return failures
}

function capturedScopeFailure(filter: ScopeFilter, cause: unknown): MappingFailure {

    const code = filter === 'validation'
        ? 'SCRATCH_READBACK_MAPPING_VALIDATION_FAILED'
        : filter === 'internal'
            ? 'SCRATCH_READBACK_MAPPING_INTERNAL_FAILED'
            : 'SCRATCH_READBACK_MAPPING_OUT_OF_MEMORY'
    return mappingStageFailure({ stage: 'mapping', code, category: filter, cause })
}

function scopeFailure(cause: unknown): MappingFailure {

    return mappingStageFailure({
        stage: 'mapping',
        code: 'SCRATCH_READBACK_MAPPING_SCOPE_FAILED',
        category: 'scope-failure',
        cause,
    })
}

function mapFailure(observation: Extract<PromiseObservation<undefined>, { status: 'rejected' | 'invalid' }>): MappingFailure {

    return mappingStageFailure({
        stage: 'mapping',
        code: 'SCRATCH_READBACK_MAPPING_REJECTED',
        category: 'native-exception',
        cause: observation.reason,
    })
}

function mappingStageFailure(input: Readonly<{
    stage: ScratchReadbackFailureStage
    code: string
    cause: unknown
    category?: GpuNativeErrorCategory
}>): MappingFailure {

    const category = input.category ?? 'native-exception'
    return Object.freeze({
        code: input.code,
        category,
        cause: input.cause,
        outcome: Object.freeze({
            stage: input.stage,
            diagnosticCode: input.code,
            nativeErrorCategory: category,
            nativeError: serializeNativeGpuError(input.cause),
        }),
    })
}

function throwMappingFailures(
    runtime: ScratchRuntime,
    operation: ScratchPendingGpuOperation,
    failures: readonly MappingFailure[]
): never {

    return throwCompletedMappingFailure(runtime, operation, failures, 'mapping')
}

function throwCompletedMappingFailure(
    runtime: ScratchRuntime,
    operation: ScratchPendingGpuOperation,
    failures: readonly MappingFailure[],
    stage: ScratchReadbackFailureStage
): never {

    const incident = completeMappingFailure(runtime, operation, failures, stage)
    const primary = failures[0]
    throwScratchDiagnostic({
        code: primary.code,
        severity: 'error',
        phase: 'readback',
        subject: { kind: 'GpuOperation', id: operation.id, operationKind: operation.kind },
        related: [ runtime.subject, incident.subject ],
        message: mappingFailureMessage(primary.code),
        actual: {
            operationId: operation.id,
            readbackId: operation.target.kind === 'readback' ? operation.target.readbackId : undefined,
            nativeError: primary.outcome.nativeError,
        },
    }, {
        ...(primary.cause !== undefined ? { cause: primary.cause } : {}),
        incident,
    })
}

function completeMappingFailure(
    runtime: ScratchRuntime,
    operation: ScratchPendingGpuOperation,
    failures: readonly MappingFailure[],
    stage: ScratchReadbackFailureStage
) {

    const controller = diagnosticsControllerFor(runtime)
    const primary = failures[0]
    const record = controller.completeOperation(operation, {
        status: 'failed',
        nativeErrorCategory: primary.category,
    })
    return controller.recordIncident({
        kind: 'readback-failure',
        diagnosticCode: primary.code,
        nativeErrorCategory: primary.category,
        attribution: 'exact-operation',
        target: operation.target,
        operationId: operation.id,
        triggerOperation: record,
        failureStage: stage,
        ...(primary.outcome.nativeError !== undefined ? { nativeError: primary.outcome.nativeError } : {}),
        outcomes: failures.map(failure => failure.outcome),
    })
}

function cancelMappingForLifecycle(
    input: ReadbackMappingInput,
    operation: ScratchPendingGpuOperation,
    operationLifecycle: ReadbackMappingLifecycleState,
    runtimeLifecycle: 'active' | 'device-lost' | 'runtime-disposed',
    failures: readonly MappingFailure[]
): ReadbackMappingResult {

    const controller = diagnosticsControllerFor(input.runtime)
    const deviceLost = runtimeLifecycle === 'device-lost' || input.runtime.isDeviceLost
    const deviceLostInfo = deviceLost
        ? input.runtime.deviceLostInfo ?? {
            reason: 'unknown',
            message: 'Readback mapping observed device loss.',
        }
        : undefined
    const deviceLossIncidentId = deviceLostInfo === undefined
        ? undefined
        : controller.recordDeviceLoss(deviceLostInfo as GPUDeviceLostInfo)?.id
    const record = controller.completeOperation(operation, {
        status: 'cancelled',
        ...(deviceLost
            ? { nativeErrorCategory: 'device-lost' as const }
            : {}),
        ...(failures.length === 0 && deviceLossIncidentId !== undefined
            ? { incidentId: deviceLossIncidentId }
            : {}),
    })
    if (failures.length > 0) {
        const lifecycleOutcome = mappingLifecycleOutcome(
            operationLifecycle,
            runtimeLifecycle,
            deviceLostInfo
        )
        controller.recordIncident({
            kind: 'readback-failure',
            diagnosticCode: lifecycleOutcome.diagnosticCode,
            nativeErrorCategory: lifecycleOutcome.nativeErrorCategory,
            attribution: deviceLost ? 'temporal-correlation' : 'exact-operation',
            target: operation.target,
            operationId: operation.id,
            triggerOperation: record,
            failureStage: 'lifecycle-recheck',
            ...(lifecycleOutcome.nativeError !== undefined
                ? { nativeError: lifecycleOutcome.nativeError }
                : {}),
            outcomes: [
                ...failures.map(failure => failure.outcome),
                lifecycleOutcome,
            ],
        })
    }
    return Object.freeze({ status: 'cancelled', operationId: operation.id })
}

function mappingLifecycleOutcome(
    operationLifecycle: ReadbackMappingLifecycleState,
    runtimeLifecycle: 'active' | 'device-lost' | 'runtime-disposed',
    deviceLostInfo: GPUDeviceLostInfo | undefined
): ScratchGpuIncidentOutcome {

    if (deviceLostInfo !== undefined || runtimeLifecycle === 'device-lost') {
        return Object.freeze({
            stage: 'lifecycle-recheck',
            diagnosticCode: 'SCRATCH_RUNTIME_DEVICE_LOST',
            nativeErrorCategory: 'device-lost',
            ...(deviceLostInfo !== undefined
                ? { nativeError: serializeNativeGpuError(deviceLostInfo) }
                : {}),
        })
    }
    if (runtimeLifecycle === 'runtime-disposed') {
        return Object.freeze({
            stage: 'lifecycle-recheck',
            diagnosticCode: 'SCRATCH_RUNTIME_DISPOSED',
            nativeErrorCategory: 'none',
        })
    }
    return Object.freeze({
        stage: 'lifecycle-recheck',
        diagnosticCode: operationLifecycle === 'disposed'
            ? 'SCRATCH_READBACK_OPERATION_DISPOSED'
            : 'SCRATCH_READBACK_CANCELLED',
        nativeErrorCategory: 'none',
    })
}

function constructReadbackMappingTransaction(
    state: ReadbackMappingTransactionState
): ReadbackMappingTransaction {

    const Constructor = ReadbackMappingTransaction as unknown as new (token: symbol) => ReadbackMappingTransaction
    const transaction = new Constructor(readbackMappingTransactionToken)
    readbackMappingTransactionStates.set(transaction, state)
    return transaction
}

function mappingTransactionStateFor(transaction: ReadbackMappingTransaction): ReadbackMappingTransactionState {

    const state = readbackMappingTransactionStates.get(transaction)
    if (state === undefined) throw new TypeError('ReadbackMappingTransaction is not Scratch-owned.')
    return state
}

function claimMappingTransaction(transaction: ReadbackMappingTransaction): ReadbackMappingTransactionState {

    const state = mappingTransactionStateFor(transaction)
    if (state.isComplete) throw new TypeError(`Readback mapping operation ${state.operation.id} is already complete.`)
    state.isComplete = true
    return state
}

function popMapScope(
    device: GPUDevice,
    pushed: boolean
): Promise<PromiseObservation<GPUError | null>> {

    if (!pushed) return notIssued<GPUError | null>()
    try {
        return observePromise(device.popErrorScope(), 'GPUDevice.popErrorScope()')
    } catch (reason) {
        return Promise.resolve(Object.freeze({ status: 'rejected', reason }))
    }
}

function observePromise<T>(value: unknown, name: string): Promise<PromiseObservation<T>> {

    if (value === null || (typeof value !== 'object' && typeof value !== 'function') ||
        typeof (value as { then?: unknown }).then !== 'function') {
        return Promise.resolve(Object.freeze({
            status: 'invalid',
            reason: new TypeError(`${name} did not return a Promise.`),
        }))
    }
    return Promise.resolve(value as PromiseLike<T>).then(
        result => Object.freeze({ status: 'fulfilled', value: result }),
        reason => Object.freeze({ status: 'rejected', reason })
    )
}

function notIssued<T>(): Promise<PromiseObservation<T>> {

    return Promise.resolve(Object.freeze({ status: 'not-issued' }))
}

function GPUMapModeValue(): GPUMapModeFlags {

    const value = (globalThis as { GPUMapMode?: { READ?: number } }).GPUMapMode?.READ
    return typeof value === 'number' ? value : 0x1
}

function mappingFailureMessage(code: string): string {

    if (code === 'SCRATCH_READBACK_MAPPING_VALIDATION_FAILED') return 'Readback mapping failed native validation.'
    if (code === 'SCRATCH_READBACK_MAPPING_INTERNAL_FAILED') return 'Readback mapping observed a native internal error.'
    if (code === 'SCRATCH_READBACK_MAPPING_OUT_OF_MEMORY') return 'Readback mapping observed native out-of-memory.'
    if (code === 'SCRATCH_READBACK_MAPPING_SCOPE_FAILED') return 'Readback mapping error scopes failed to settle structurally.'
    if (code === 'SCRATCH_READBACK_MAPPED_RANGE_FAILED') return 'Readback mapped-range access failed.'
    if (code === 'SCRATCH_READBACK_HOST_COPY_FAILED') return 'Readback host copy failed.'
    return 'Readback mapping Promise rejected.'
}
