import { ScratchDiagnosticError, throwScratchDiagnostic } from './diagnostics.js'
import { serializeNativeGpuError } from './gpu-operation.js'
import {
    createScratchNativeLabel,
    destroyNativeCandidate,
    issueScopedNativeAllocation,
    recheckScopedNativeAllocationLifecycle,
} from './native-allocation.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import type { BufferResource } from './buffer.js'
import type {
    GpuAttributionConfidence,
    GpuNativeErrorCategory,
    ScratchGpuCommandOperationTarget,
    ScratchGpuReadbackOperationTarget,
} from './gpu-operation.js'
import type { ScopedNativeAllocationFailureKind, ScopedNativeAllocationOutcome } from './native-allocation.js'
import type { ScratchRuntime } from './runtime.js'
import type { ScratchPendingGpuOperation, ScratchReadbackStagingReservation } from './runtime-diagnostics.js'

const BUFFER_USAGE_MAP_READ = 0x1
const BUFFER_USAGE_COPY_DST = 0x8
const readbackStagingSlotToken = Symbol('ReadbackStagingSlot')

export type ReadbackStagingTarget =
    | ScratchGpuCommandOperationTarget
    | ScratchGpuReadbackOperationTarget

export type ReadbackStagingAllocationInput = Readonly<{
    runtime: ScratchRuntime
    target: ReadbackStagingTarget
    source: BufferResource
    byteLength: number
    label?: string
}>

type ReadbackStagingSlotState = {
    runtime: ScratchRuntime
    id: string
    byteLength: number
    allocationOperationId: string
    target: ReadbackStagingTarget
    buffer: GPUBuffer
    reservation: ScratchReadbackStagingReservation
    isReleased: boolean
}

const readbackStagingSlotStates = new WeakMap<ReadbackStagingSlot, ReadbackStagingSlotState>()

export class ReadbackStagingSlot {

    private constructor(token: symbol) {

        if (token !== readbackStagingSlotToken || new.target !== ReadbackStagingSlot) {
            throw new TypeError('ReadbackStagingSlot is Scratch-owned.')
        }
        Object.preventExtensions(this)
    }

    get id(): string {

        return stagingStateFor(this).id
    }

    get byteLength(): number {

        return stagingStateFor(this).byteLength
    }

    get allocationOperationId(): string {

        return stagingStateFor(this).allocationOperationId
    }

    get isReleased(): boolean {

        return stagingStateFor(this).isReleased
    }
}

export async function allocateReadbackStaging(
    input: ReadbackStagingAllocationInput
): Promise<ReadbackStagingSlot> {

    const { runtime, target, source, byteLength } = input
    runtime.assertActive()
    source.assertRuntime(runtime)
    source.assertUsable()
    const controller = diagnosticsControllerFor(runtime)
    const nativeLabel = createScratchNativeLabel(input.label, stagingTargetId(target))
    const nativeDescriptor: GPUBufferDescriptor = {
        label: nativeLabel,
        size: byteLength,
        usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
    }
    const operation = controller.beginOperation({
        kind: 'readback-staging-allocation',
        target,
        descriptorSummary: {
            byteLength,
            usage: nativeDescriptor.usage,
        },
        fullDescriptor: { ...nativeDescriptor },
        nativeLabel,
    })
    let reservation: ScratchReadbackStagingReservation
    try {
        reservation = controller.reserveReadbackStaging(operation.id, byteLength)
    } catch (cause) {
        return throwReadbackStagingBudgetFailure(runtime, operation, cause)
    }

    let outcome = await issueScopedNativeAllocation(
        runtime,
        () => runtime.device.createBuffer(nativeDescriptor),
        source
    )
    outcome = recheckScopedNativeAllocationLifecycle(runtime, outcome, source)
    if (outcome.ok && !isGpuBuffer(outcome.candidate)) {
        outcome = Object.freeze({
            ok: false,
            kind: 'native-exception',
            candidate: outcome.candidate,
            cause: new TypeError('GPUDevice.createBuffer() returned an invalid staging buffer.'),
        })
    }
    if (!outcome.ok) {
        reservation.release()
        return throwReadbackStagingAllocationFailure(runtime, operation, outcome)
    }

    const record = controller.completeOperation(operation, { status: 'succeeded' })
    try {
        return constructReadbackStagingSlot({
            runtime,
            id: `${stagingTargetId(target)}/staging`,
            byteLength,
            allocationOperationId: record.id,
            target,
            buffer: outcome.candidate,
            reservation,
            isReleased: false,
        })
    } catch (cause) {
        destroyNativeCandidate(outcome.candidate)
        reservation.release()
        throw cause
    }
}

export function readbackStagingBuffer(slot: ReadbackStagingSlot): GPUBuffer {

    const state = stagingStateFor(slot)
    if (state.isReleased) throw new TypeError(`Readback staging slot ${state.id} has been released.`)
    return state.buffer
}

export function releaseReadbackStaging(slot: ReadbackStagingSlot, unmap = false): void {

    const state = stagingStateFor(slot)
    if (state.isReleased) return
    state.isReleased = true

    if (unmap && typeof state.buffer.unmap === 'function') {
        try {
            state.buffer.unmap()
        } catch {
            // Mapping cleanup receives structured evidence in the mapping transaction phase.
        }
    }
    if (typeof state.buffer.destroy === 'function') {
        try {
            state.buffer.destroy()
        } catch {
            // Staging release remains idempotent even when native cleanup throws.
        }
    }
    state.reservation.release()
}

export function resetReadbackStaging(slot: ReadbackStagingSlot, unmap = false): void {

    const state = stagingStateFor(slot)
    if (state.isReleased) throw new TypeError(`Readback staging slot ${state.id} has been released.`)
    if (!unmap || typeof state.buffer.unmap !== 'function') return
    try {
        state.buffer.unmap()
    } catch {
        // Mapping cleanup receives structured evidence in the mapping transaction phase.
    }
}

function constructReadbackStagingSlot(state: ReadbackStagingSlotState): ReadbackStagingSlot {

    const Constructor = ReadbackStagingSlot as unknown as new (token: symbol) => ReadbackStagingSlot
    const slot = new Constructor(readbackStagingSlotToken)
    readbackStagingSlotStates.set(slot, state)
    return slot
}

function stagingStateFor(slot: ReadbackStagingSlot): ReadbackStagingSlotState {

    const state = readbackStagingSlotStates.get(slot)
    if (state === undefined) throw new TypeError('Readback staging slot is not Scratch-owned.')
    return state
}

function stagingTargetId(target: ReadbackStagingTarget): string {

    return target.kind === 'command' ? target.commandId : target.readbackId
}

function throwReadbackStagingBudgetFailure(
    runtime: ScratchRuntime,
    operation: ScratchPendingGpuOperation,
    cause: unknown
): never {

    const controller = diagnosticsControllerFor(runtime)
    const record = controller.completeOperation(operation, { status: 'failed' })
    const incident = controller.recordIncident({
        kind: 'readback-failure',
        diagnosticCode: 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED',
        nativeErrorCategory: 'none',
        attribution: 'exact-operation',
        target: operation.target,
        operationId: operation.id,
        triggerOperation: record,
        failureStage: 'budget',
    })
    const actual = cause instanceof ScratchDiagnosticError
        ? cause.diagnostic.actual
        : undefined
    throwScratchDiagnostic({
        code: 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED',
        severity: 'error',
        phase: 'readback',
        subject: gpuOperationSubject(operation),
        related: [ runtime.subject, stagingTargetSubject(operation.target) ],
        message: 'ScratchRuntime readback staging budget is exhausted.',
        ...(actual !== undefined ? { actual } : {}),
    }, { cause, incident })
}

function throwReadbackStagingAllocationFailure(
    runtime: ScratchRuntime,
    operation: ScratchPendingGpuOperation,
    outcome: Extract<ScopedNativeAllocationOutcome<GPUBuffer>, { ok: false }>
): never {

    destroyNativeCandidate(outcome.candidate)
    const controller = diagnosticsControllerFor(runtime)
    const nativeErrorCategory = stagingFailureNativeCategory(outcome.kind)
    const status = isLifecycleFailure(outcome.kind) ? 'cancelled' : 'failed'
    const record = controller.completeOperation(operation, {
        status,
        ...(nativeErrorCategory !== 'none' ? { nativeErrorCategory } : {}),
    })
    const code = stagingFailureCode(outcome.kind)
    const incident = controller.recordIncident({
        kind: 'readback-failure',
        diagnosticCode: code,
        nativeErrorCategory,
        attribution: stagingFailureAttribution(outcome.kind),
        target: operation.target,
        operationId: operation.id,
        triggerOperation: record,
        failureStage: isLifecycleFailure(outcome.kind)
            ? 'lifecycle-recheck'
            : 'staging-allocation',
        ...(outcome.cause !== undefined
            ? { nativeError: serializeNativeGpuError(outcome.cause) }
            : outcome.deviceLostInfo !== undefined
                ? { nativeError: serializeNativeGpuError(outcome.deviceLostInfo) }
                : {}),
    })

    throwScratchDiagnostic({
        code,
        severity: 'error',
        phase: outcome.kind === 'runtime-disposed' || outcome.kind === 'device-lost'
            ? 'runtime'
            : 'readback',
        subject: gpuOperationSubject(operation),
        related: [ runtime.subject, stagingTargetSubject(operation.target), incident.subject ],
        message: stagingFailureMessage(outcome.kind),
        actual: {
            operationId: operation.id,
            ...(outcome.cause !== undefined
                ? { nativeError: serializeNativeGpuError(outcome.cause) }
                : {}),
        },
    }, {
        ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
        incident,
    })
}

function isGpuBuffer(value: unknown): value is GPUBuffer {

    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
    const candidate = value as Partial<GPUBuffer>
    return typeof candidate.mapAsync === 'function' &&
        typeof candidate.getMappedRange === 'function' &&
        typeof candidate.unmap === 'function' &&
        typeof candidate.destroy === 'function'
}

function isLifecycleFailure(kind: ScopedNativeAllocationFailureKind): boolean {

    return kind === 'device-lost' || kind === 'runtime-disposed' || kind === 'resource-disposed'
}

function stagingFailureCode(kind: ScopedNativeAllocationFailureKind): string {

    if (kind === 'validation') return 'SCRATCH_READBACK_STAGING_VALIDATION_FAILED'
    if (kind === 'out-of-memory') return 'SCRATCH_READBACK_STAGING_OUT_OF_MEMORY'
    if (kind === 'scope-failure') return 'SCRATCH_READBACK_STAGING_SCOPE_FAILED'
    if (kind === 'device-lost') return 'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION'
    if (kind === 'runtime-disposed') return 'SCRATCH_RUNTIME_DISPOSED'
    if (kind === 'resource-disposed') return 'SCRATCH_RESOURCE_DISPOSED'
    return 'SCRATCH_READBACK_STAGING_NATIVE_FAILED'
}

function stagingFailureNativeCategory(kind: ScopedNativeAllocationFailureKind): GpuNativeErrorCategory {

    if (kind === 'validation' || kind === 'out-of-memory' || kind === 'scope-failure') return kind
    if (kind === 'device-lost') return 'device-lost'
    if (kind === 'runtime-disposed' || kind === 'resource-disposed') return 'none'
    return 'native-exception'
}

function stagingFailureAttribution(kind: ScopedNativeAllocationFailureKind): GpuAttributionConfidence {

    return kind === 'device-lost' ? 'temporal-correlation' : 'exact-operation'
}

function stagingFailureMessage(kind: ScopedNativeAllocationFailureKind): string {

    if (kind === 'validation') return 'Readback staging allocation failed native validation.'
    if (kind === 'out-of-memory') return 'Readback staging allocation observed native out-of-memory.'
    if (kind === 'scope-failure') return 'Readback staging allocation error scopes failed to settle structurally.'
    if (kind === 'device-lost') return 'GPU device was lost while readback staging allocation was pending.'
    if (kind === 'runtime-disposed') return 'ScratchRuntime was disposed while readback staging allocation was pending.'
    if (kind === 'resource-disposed') return 'Readback source was disposed while staging allocation was pending.'
    return 'Readback staging allocation failed with a synchronous native exception.'
}

function gpuOperationSubject(operation: ScratchPendingGpuOperation) {

    return {
        kind: 'GpuOperation',
        id: operation.id,
        operationKind: operation.kind,
    }
}

function stagingTargetSubject(target: ScratchPendingGpuOperation['target']) {

    if (target.kind === 'command') {
        return { kind: 'Command', id: target.commandId, commandKind: target.commandKind }
    }
    if (target.kind === 'readback') {
        return { kind: 'ReadbackOperation', id: target.readbackId }
    }
    throw new TypeError('Readback staging requires a command or readback target.')
}
