import {
    activateBufferMappingAuthority,
    claimBufferMappingAuthority,
    releaseBufferMappingAuthority,
} from './buffer-mapping-authority.js'
import type { BufferMappingLifecycleReason } from './buffer-mapping-authority.js'
import {
    isBufferRegion,
} from './buffer.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import { serializeNativeGpuError } from './gpu-operation.js'
import {
    advanceResourceContentEpoch,
    setResourceContentState,
} from './resource.js'
import { assertScratchRuntimeActive } from './runtime-authority.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import { isRecord } from './type-utils.js'
import type { BufferRegion, BufferResource } from './buffer.js'
import type {
    GpuNativeErrorCategory,
    ScratchBufferMappingFailureStage,
    ScratchGpuIncidentOutcome,
} from './gpu-operation.js'
import type { ScratchRuntime } from './runtime.js'
import type {
    ScratchPendingGpuOperation,
    ScratchRuntimeBufferMappingFact,
    ScratchRuntimeDiagnosticsController,
} from './runtime-diagnostics.js'

export type BufferMappingMode = 'read' | 'write'

export type BufferMappingDescriptor = Readonly<{
    region: BufferRegion
    mode: BufferMappingMode
    signal?: AbortSignal
}>

export type MappedBufferLeaseState =
    | 'mapped'
    | 'released'
    | 'failed'
    | 'disposed'

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

type MappingCancellation = Readonly<{
    reason: 'abort' | BufferMappingLifecycleReason
    code: string
}>

type MappingContext = {
    id: string
    runtime: ScratchRuntime
    buffer: BufferResource
    region: BufferRegion
    mode: BufferMappingMode
    allocationVersion: number
    contentEpoch: number
    controller: ScratchRuntimeDiagnosticsController
    operation: ScratchPendingGpuOperation
    phase: 'pending' | 'mapped' | 'terminal'
    nativeMapIssued: boolean
    unmapIssued: boolean
    unmapFailure?: unknown
    cancellation?: MappingCancellation
    factRegistered: boolean
    unsubscribeRuntime: () => void
    removeAbortListener: () => void
    lease?: MappedBufferLease
}

type MappedBufferLeaseFacts = {
    context: MappingContext
    state: MappedBufferLeaseState
    view: ArrayBuffer
}

const mappedBufferLeaseToken = Symbol('MappedBufferLease')
const mappedBufferLeaseFacts = new WeakMap<MappedBufferLease, MappedBufferLeaseFacts>()
let mappingSequence = 0

export class MappedBufferLease {

    private constructor(token: symbol) {

        if (token !== mappedBufferLeaseToken || new.target !== MappedBufferLease) {
            throw new TypeError('MappedBufferLease must be created by ScratchRuntime.')
        }
        Object.preventExtensions(this)
    }

    get id(): string {

        return leaseFactsFor(this).context.id
    }

    get buffer(): BufferResource {

        return leaseFactsFor(this).context.buffer
    }

    get region(): BufferRegion {

        return leaseFactsFor(this).context.region
    }

    get mode(): BufferMappingMode {

        return leaseFactsFor(this).context.mode
    }

    get state(): MappedBufferLeaseState {

        return leaseFactsFor(this).state
    }

    get allocationVersion(): number {

        return leaseFactsFor(this).context.allocationVersion
    }

    get contentEpoch(): number {

        return leaseFactsFor(this).context.contentEpoch
    }

    get view(): ArrayBuffer {

        const facts = leaseFactsFor(this)
        if (facts.state !== 'mapped') {
            throwScratchDiagnostic({
                code: 'SCRATCH_BUFFER_MAPPING_LEASE_INACTIVE',
                severity: 'error',
                phase: 'buffer-mapping',
                subject: mappingSubject(facts.context),
                related: [ facts.context.buffer.subject, facts.context.region.subject ],
                message: 'MappedBufferLease view is unavailable after the mapping has ended.',
                expected: { state: 'mapped' },
                actual: { state: facts.state },
            })
        }
        return facts.view
    }

    dispose(): void {

        releaseMappedBufferLease(this)
    }
}

export async function mapBufferResource(
    runtime: ScratchRuntime,
    descriptor: BufferMappingDescriptor
): Promise<MappedBufferLease> {

    assertScratchRuntimeActive(runtime)
    const normalized = normalizeBufferMappingDescriptor(runtime, descriptor)
    const { buffer } = normalized.region
    const id = `${buffer.id}/buffer-mapping-${++mappingSequence}`
    const controller = diagnosticsControllerFor(runtime)
    let context!: MappingContext

    claimBufferMappingAuthority(buffer, {
        id,
        mode: normalized.mode,
        region: normalized.region,
        onLifecycle: reason => requestMappingCancellation(context, reason),
    })

    let operation: ScratchPendingGpuOperation
    try {
        operation = controller.beginOperation({
            kind: 'buffer-mapping',
            target: bufferOperationTarget(buffer),
            descriptorSummary: {
                offset: normalized.region.offset,
                size: normalized.region.size,
                mode: normalized.mode,
            },
            fullDescriptor: {
                offset: normalized.region.offset,
                size: normalized.region.size,
                mode: normalized.mode,
            },
            ...(buffer.label !== undefined ? { nativeLabel: buffer.label } : {}),
        })
    } catch (cause) {
        releaseBufferMappingAuthority(buffer, id)
        throw cause
    }

    context = {
        id,
        runtime,
        buffer,
        region: normalized.region,
        mode: normalized.mode,
        allocationVersion: buffer.allocationVersion,
        contentEpoch: buffer.contentEpoch,
        controller,
        operation,
        phase: 'pending',
        nativeMapIssued: false,
        unmapIssued: false,
        factRegistered: false,
        unsubscribeRuntime: () => {},
        removeAbortListener: () => {},
    }

    registerMappingFact(context, 'pending')
    context.unsubscribeRuntime = controller.subscribeLifecycle(change => {
        requestMappingCancellation(
            context,
            change.kind === 'device-lost' ? 'device-lost' : 'runtime-disposed'
        )
    })
    context.removeAbortListener = subscribeAbort(normalized.signal, () => {
        requestMappingCancellation(context, 'abort')
    })

    if (normalized.signal?.aborted === true) {
        requestMappingCancellation(context, 'abort')
        return throwCancelledMapping(context)
    }

    const issued = issueMapBoundary(
        runtime.device,
        buffer.gpuBuffer,
        normalized.mode,
        normalized.region.offset,
        normalized.region.size
    )
    context.nativeMapIssued = issued.mapIssued
    const [ map, validation, internal, outOfMemory ] = await Promise.all([
        issued.map,
        issued.validation,
        issued.internal,
        issued.outOfMemory,
    ])

    if (context.cancellation !== undefined) {
        return throwCancelledMapping(context)
    }

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
    if (failures.length > 0) {
        if (map.status === 'fulfilled') unmapContextOnce(context)
        return throwMappingFailures(context, failures, 'mapping')
    }
    if (map.status !== 'fulfilled') {
        return throwMappingFailures(context, [ mappingStageFailure({
            stage: 'mapping',
            code: 'SCRATCH_BUFFER_MAPPING_NATIVE_FAILED',
            cause: new TypeError('GPUBuffer.mapAsync() was not issued.'),
        }) ], 'mapping')
    }

    let view: ArrayBuffer
    try {
        view = buffer.gpuBuffer.getMappedRange(normalized.region.offset, normalized.region.size)
    } catch (cause) {
        unmapContextOnce(context)
        return throwMappingFailures(context, [ mappingStageFailure({
            stage: 'mapped-range',
            code: 'SCRATCH_BUFFER_MAPPING_MAPPED_RANGE_FAILED',
            cause,
        }) ], 'mapped-range')
    }
    if (!(view instanceof ArrayBuffer)) {
        unmapContextOnce(context)
        return throwMappingFailures(context, [ mappingStageFailure({
            stage: 'mapped-range',
            code: 'SCRATCH_BUFFER_MAPPING_MAPPED_RANGE_FAILED',
            cause: new TypeError('GPUBuffer.getMappedRange() did not return an ArrayBuffer.'),
        }) ], 'mapped-range')
    }

    if (context.cancellation !== undefined) {
        unmapContextOnce(context)
        return throwCancelledMapping(context)
    }

    activateBufferMappingAuthority(buffer, id)
    context.phase = 'mapped'
    context.removeAbortListener()
    context.removeAbortListener = () => {}
    controller.updateBufferMapping(id, 'mapped')
    const lease = constructMappedBufferLease(context, view)
    context.lease = lease
    return lease
}

function releaseMappedBufferLease(lease: MappedBufferLease): void {

    const facts = leaseFactsFor(lease)
    const context = facts.context
    if (facts.state !== 'mapped') return

    const unmap = unmapContextOnce(context)
    if (!unmap.ok) {
        if (context.mode === 'write' && !context.buffer.isDisposed) {
            setResourceContentState(
                context.buffer,
                'indeterminate',
                context.buffer.contentEpoch + 1
            )
        }
        facts.state = 'failed'
        context.phase = 'terminal'
        const failure = mappingStageFailure({
            stage: 'release',
            code: 'SCRATCH_BUFFER_MAPPING_RELEASE_FAILED',
            cause: unmap.cause,
        })
        const incident = completeMappingFailure(context, [ failure ], 'release')
        cleanupMappingContext(context)
        throwScratchDiagnostic({
            code: failure.code,
            severity: 'error',
            phase: 'buffer-mapping',
            subject: mappingSubject(context),
            related: [ context.buffer.subject, context.region.subject, incident.subject ],
            message: 'MappedBufferLease release failed while unmapping the native buffer.',
            actual: {
                mappingId: context.id,
                nativeError: failure.outcome.nativeError,
            },
        }, { cause: unmap.cause, incident })
    }

    if (context.mode === 'write') advanceResourceContentEpoch(context.buffer)
    facts.state = 'released'
    context.phase = 'terminal'
    context.controller.completeOperation(context.operation, { status: 'succeeded' })
    cleanupMappingContext(context)
}

function requestMappingCancellation(
    context: MappingContext | undefined,
    reason: 'abort' | BufferMappingLifecycleReason
): void {

    if (context === undefined || context.phase === 'terminal') return
    if (context.cancellation === undefined) {
        context.cancellation = Object.freeze({
            reason,
            code: cancellationCode(reason),
        })
    }
    if (context.phase === 'pending' && context.nativeMapIssued) {
        unmapContextOnce(context)
        return
    }
    if (reason === 'abort') return
    finalizeMappedLifecycle(context, reason)
}

function finalizeMappedLifecycle(
    context: MappingContext,
    reason: BufferMappingLifecycleReason
): void {

    const facts = context.lease === undefined
        ? undefined
        : mappedBufferLeaseFacts.get(context.lease)
    if (facts === undefined || facts.state !== 'mapped' || context.phase !== 'mapped') return

    const unmap = unmapContextOnce(context)
    if (context.mode === 'write' && !context.buffer.isDisposed) {
        setResourceContentState(
            context.buffer,
            'indeterminate',
            context.buffer.contentEpoch + 1
        )
    }
    facts.state = 'disposed'
    context.phase = 'terminal'
    const failure = lifecycleFailure(reason, unmap.ok ? undefined : unmap.cause)
    const incident = completeMappingCancellation(context, failure, reason)
    cleanupMappingContext(context)
    if (incident !== undefined && unmap.ok) {
        context.controller.linkOperationIncident(context.operation.id, incident.id)
    }
}

function throwCancelledMapping(context: MappingContext): never {

    const cancellation = context.cancellation
    if (cancellation === undefined) throw new TypeError('Buffer mapping cancellation is unavailable.')
    context.phase = 'terminal'
    const failure = lifecycleFailure(
        cancellation.reason,
        context.unmapFailure
    )
    const incident = cancellation.reason === 'abort' && context.unmapFailure === undefined
        ? undefined
        : completeMappingCancellation(context, failure, cancellation.reason)
    if (incident === undefined) {
        context.controller.completeOperation(context.operation, { status: 'cancelled' })
    }
    cleanupMappingContext(context)
    throwScratchDiagnostic({
        code: cancellation.code,
        severity: 'error',
        phase: 'buffer-mapping',
        subject: mappingSubject(context),
        related: [
            context.buffer.subject,
            context.region.subject,
            ...(incident !== undefined ? [ incident.subject ] : []),
        ],
        message: cancellationMessage(cancellation.reason),
        actual: {
            mappingId: context.id,
            reason: cancellation.reason,
            ...(context.unmapFailure !== undefined
                ? { cleanupError: serializeNativeGpuError(context.unmapFailure) }
                : {}),
        },
    }, {
        ...(context.unmapFailure !== undefined ? { cause: context.unmapFailure } : {}),
        ...(incident !== undefined ? { incident } : {}),
    })
}

function completeMappingCancellation(
    context: MappingContext,
    failure: MappingFailure,
    reason: 'abort' | BufferMappingLifecycleReason
) {

    const nativeErrorCategory = reason === 'device-lost'
        ? 'device-lost'
        : failure.category
    const record = context.controller.completeOperation(context.operation, {
        status: 'cancelled',
        ...(nativeErrorCategory !== 'none' ? { nativeErrorCategory } : {}),
    })
    return context.controller.recordIncident({
        kind: 'buffer-mapping-failure',
        diagnosticCode: failure.code,
        nativeErrorCategory,
        attribution: reason === 'device-lost' ? 'temporal-correlation' : 'exact-operation',
        target: context.operation.target,
        operationId: context.operation.id,
        triggerOperation: record,
        failureStage: 'lifecycle-recheck',
        ...(failure.outcome.nativeError !== undefined
            ? { nativeError: failure.outcome.nativeError }
            : {}),
        outcomes: [ failure.outcome ],
    })
}

function throwMappingFailures(
    context: MappingContext,
    failures: readonly MappingFailure[],
    stage: ScratchBufferMappingFailureStage
): never {

    context.phase = 'terminal'
    const allFailures = context.unmapFailure === undefined
        ? failures
        : [
            ...failures,
            mappingStageFailure({
                stage: 'release',
                code: 'SCRATCH_BUFFER_MAPPING_RELEASE_FAILED',
                cause: context.unmapFailure,
            }),
        ]
    const incident = completeMappingFailure(context, allFailures, stage)
    cleanupMappingContext(context)
    const primary = allFailures[0]
    throwScratchDiagnostic({
        code: primary.code,
        severity: 'error',
        phase: 'buffer-mapping',
        subject: mappingSubject(context),
        related: [ context.buffer.subject, context.region.subject, incident.subject ],
        message: mappingFailureMessage(primary.code),
        actual: {
            mappingId: context.id,
            nativeError: primary.outcome.nativeError,
        },
    }, {
        ...(primary.cause !== undefined ? { cause: primary.cause } : {}),
        incident,
    })
}

function completeMappingFailure(
    context: MappingContext,
    failures: readonly MappingFailure[],
    stage: ScratchBufferMappingFailureStage
) {

    const primary = failures[0]
    const record = context.controller.completeOperation(context.operation, {
        status: 'failed',
        nativeErrorCategory: primary.category,
    })
    return context.controller.recordIncident({
        kind: 'buffer-mapping-failure',
        diagnosticCode: primary.code,
        nativeErrorCategory: primary.category,
        attribution: 'exact-operation',
        target: context.operation.target,
        operationId: context.operation.id,
        triggerOperation: record,
        failureStage: stage,
        ...(primary.outcome.nativeError !== undefined
            ? { nativeError: primary.outcome.nativeError }
            : {}),
        outcomes: failures.map(failure => failure.outcome),
    })
}

function cleanupMappingContext(context: MappingContext): void {

    context.removeAbortListener()
    context.unsubscribeRuntime()
    if (context.factRegistered) {
        context.controller.unregisterBufferMapping(context.id)
        context.factRegistered = false
    }
    releaseBufferMappingAuthority(context.buffer, context.id)
}

function unmapContextOnce(
    context: MappingContext
): Readonly<{ ok: true }> | Readonly<{ ok: false, cause: unknown }> {

    if (context.unmapIssued) {
        return context.unmapFailure === undefined
            ? Object.freeze({ ok: true })
            : Object.freeze({ ok: false, cause: context.unmapFailure })
    }
    context.unmapIssued = true
    try {
        context.buffer.gpuBuffer.unmap()
        return Object.freeze({ ok: true })
    } catch (cause) {
        context.unmapFailure = cause
        return Object.freeze({ ok: false, cause })
    }
}

function registerMappingFact(
    context: MappingContext,
    state: ScratchRuntimeBufferMappingFact['state']
): void {

    context.controller.registerBufferMapping(Object.freeze({
        id: context.id,
        resourceId: context.buffer.id,
        offset: context.region.offset,
        size: context.region.size,
        mode: context.mode,
        state,
        allocationVersion: context.allocationVersion,
        contentEpoch: context.contentEpoch,
        operationId: context.operation.id,
    }))
    context.factRegistered = true
}

function normalizeBufferMappingDescriptor(
    runtime: ScratchRuntime,
    descriptor: unknown
): BufferMappingDescriptor {

    if (!isRecord(descriptor)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BUFFER_MAPPING_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'buffer-mapping',
            subject: runtime.subject,
            message: 'Buffer mapping requires a descriptor object.',
            expected: { descriptor: 'object with region, mode, and optional signal' },
            actual: { descriptor: typeof descriptor },
        })
    }
    if (!isBufferRegion(descriptor.region)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BUFFER_MAPPING_REGION_INVALID',
            severity: 'error',
            phase: 'buffer-mapping',
            subject: runtime.subject,
            message: 'Buffer mapping requires a Scratch BufferRegion.',
            expected: { region: 'BufferRegion' },
            actual: { region: typeof descriptor.region },
        })
    }
    const region = descriptor.region
    region.assertUsable()
    if (region.buffer.runtime !== runtime) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BUFFER_MAPPING_RUNTIME_MISMATCH',
            severity: 'error',
            phase: 'buffer-mapping',
            subject: region.subject,
            related: [ runtime.subject, region.buffer.subject ],
            message: 'BufferRegion belongs to another ScratchRuntime.',
            expected: { runtimeId: runtime.id },
            actual: { runtimeId: region.buffer.runtime.id },
        })
    }
    if (descriptor.mode !== 'read' && descriptor.mode !== 'write') {
        throwScratchDiagnostic({
            code: 'SCRATCH_BUFFER_MAPPING_MODE_INVALID',
            severity: 'error',
            phase: 'buffer-mapping',
            subject: region.subject,
            related: [ region.buffer.subject ],
            message: 'Buffer mapping mode must be read or write.',
            expected: { mode: [ 'read', 'write' ] },
            actual: { mode: descriptor.mode },
        })
    }
    validateMappingUsage(region.buffer, descriptor.mode)
    if (region.offset % 8 !== 0 || region.size % 4 !== 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BUFFER_MAPPING_RANGE_INVALID',
            severity: 'error',
            phase: 'buffer-mapping',
            subject: region.subject,
            related: [ region.buffer.subject ],
            message: 'Buffer mapping range does not satisfy WebGPU alignment requirements.',
            expected: { offsetMultiple: 8, sizeMultiple: 4 },
            actual: { offset: region.offset, size: region.size },
        })
    }
    if (descriptor.signal !== undefined && !isAbortSignal(descriptor.signal)) {
        throwScratchDiagnostic({
            code: 'SCRATCH_BUFFER_MAPPING_SIGNAL_INVALID',
            severity: 'error',
            phase: 'buffer-mapping',
            subject: region.subject,
            message: 'Buffer mapping signal must be an AbortSignal.',
            expected: { signal: 'AbortSignal or undefined' },
            actual: { signal: typeof descriptor.signal },
        })
    }
    return Object.freeze({
        region,
        mode: descriptor.mode,
        ...(descriptor.signal !== undefined
            ? { signal: descriptor.signal as AbortSignal }
            : {}),
    })
}

function validateMappingUsage(buffer: BufferResource, mode: BufferMappingMode): void {

    const required = mode === 'read' ? GPUBufferUsageValue('MAP_READ') : GPUBufferUsageValue('MAP_WRITE')
    const allowed = mode === 'read'
        ? required | GPUBufferUsageValue('COPY_DST')
        : required | GPUBufferUsageValue('COPY_SRC')
    if ((buffer.usage & required) !== 0 && (buffer.usage & ~allowed) === 0) return
    throwScratchDiagnostic({
        code: 'SCRATCH_BUFFER_MAPPING_USAGE_INVALID',
        severity: 'error',
        phase: 'buffer-mapping',
        subject: buffer.subject,
        message: `BufferResource usage is incompatible with ${mode} host mapping.`,
        expected: {
            requiredUsage: mode === 'read' ? 'MAP_READ' : 'MAP_WRITE',
            allowedCompanion: mode === 'read' ? 'COPY_DST' : 'COPY_SRC',
        },
        actual: { usage: buffer.usage },
    })
}

function issueMapBoundary(
    device: GPUDevice,
    buffer: GPUBuffer,
    mode: BufferMappingMode,
    offset: number,
    size: number
) {

    const boundaryFailures: unknown[] = []
    let outOfMemoryPushed = false
    let internalPushed = false
    let validationPushed = false
    let mapIssued = false
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
                buffer.mapAsync(GPUMapModeValue(mode), offset, size),
                'GPUBuffer.mapAsync()'
            )
            mapIssued = true
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
        mapIssued,
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
    for (const cause of input.boundaryFailures) {
        failures.push(mappingStageFailure({
            stage: 'mapping',
            code: 'SCRATCH_BUFFER_MAPPING_SCOPE_FAILED',
            category: 'scope-failure',
            cause,
        }))
    }
    for (const scope of input.scopes) {
        const observation = scope.observation
        if (observation.status === 'rejected' || observation.status === 'invalid') {
            failures.push(mappingStageFailure({
                stage: 'mapping',
                code: 'SCRATCH_BUFFER_MAPPING_SCOPE_FAILED',
                category: 'scope-failure',
                cause: observation.reason,
            }))
        } else if (observation.status === 'fulfilled' && observation.value !== null) {
            failures.push(capturedScopeFailure(scope.filter, observation.value))
        }
    }
    if (input.synchronousMapFailure !== undefined) {
        failures.push(mappingStageFailure({
            stage: 'mapping',
            code: 'SCRATCH_BUFFER_MAPPING_NATIVE_FAILED',
            cause: input.synchronousMapFailure,
        }))
    } else if (input.map.status === 'rejected' || input.map.status === 'invalid') {
        failures.push(mappingStageFailure({
            stage: 'mapping',
            code: 'SCRATCH_BUFFER_MAPPING_REJECTED',
            cause: input.map.reason,
        }))
    }
    return failures
}

function capturedScopeFailure(filter: ScopeFilter, cause: unknown): MappingFailure {

    const code = filter === 'validation'
        ? 'SCRATCH_BUFFER_MAPPING_VALIDATION_FAILED'
        : filter === 'internal'
            ? 'SCRATCH_BUFFER_MAPPING_INTERNAL_FAILED'
            : 'SCRATCH_BUFFER_MAPPING_OUT_OF_MEMORY'
    return mappingStageFailure({
        stage: 'mapping',
        code,
        category: filter,
        cause,
    })
}

function lifecycleFailure(
    reason: 'abort' | BufferMappingLifecycleReason,
    cleanupCause: unknown
): MappingFailure {

    const code = cleanupCause === undefined
        ? cancellationCode(reason)
        : 'SCRATCH_BUFFER_MAPPING_RELEASE_FAILED'
    const category: GpuNativeErrorCategory = reason === 'device-lost'
        ? 'device-lost'
        : cleanupCause === undefined ? 'none' : 'native-exception'
    return mappingStageFailure({
        stage: 'lifecycle-recheck',
        code,
        category,
        cause: cleanupCause ?? new Error(reason),
    })
}

function mappingStageFailure(input: Readonly<{
    stage: ScratchBufferMappingFailureStage
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

function constructMappedBufferLease(
    context: MappingContext,
    view: ArrayBuffer
): MappedBufferLease {

    const Constructor = MappedBufferLease as unknown as new (token: symbol) => MappedBufferLease
    const lease = new Constructor(mappedBufferLeaseToken)
    mappedBufferLeaseFacts.set(lease, {
        context,
        state: 'mapped',
        view,
    })
    return lease
}

function leaseFactsFor(lease: MappedBufferLease): MappedBufferLeaseFacts {

    const facts = mappedBufferLeaseFacts.get(lease)
    if (facts === undefined) throw new TypeError('MappedBufferLease is not Scratch-owned.')
    return facts
}

function mappingSubject(context: MappingContext) {

    return {
        kind: 'BufferMapping',
        id: context.id,
        resourceId: context.buffer.id,
        offset: context.region.offset,
        size: context.region.size,
        mode: context.mode,
    }
}

function bufferOperationTarget(buffer: BufferResource) {

    return Object.freeze({
        kind: 'resource' as const,
        resourceId: buffer.id,
        resourceKind: 'BufferResource' as const,
        allocationVersion: buffer.allocationVersion,
        contentEpoch: buffer.contentEpoch,
        logicalFootprintBytes: buffer.size,
    })
}

function subscribeAbort(signal: AbortSignal | undefined, listener: () => void): () => void {

    if (signal === undefined) return () => {}
    signal.addEventListener('abort', listener, { once: true })
    return () => signal.removeEventListener('abort', listener)
}

function isAbortSignal(value: unknown): value is AbortSignal {

    return typeof value === 'object' &&
        value !== null &&
        typeof (value as AbortSignal).aborted === 'boolean' &&
        typeof (value as AbortSignal).addEventListener === 'function' &&
        typeof (value as AbortSignal).removeEventListener === 'function'
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

    if (
        value === null ||
        (typeof value !== 'object' && typeof value !== 'function') ||
        typeof (value as { then?: unknown }).then !== 'function'
    ) {
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

function GPUMapModeValue(mode: BufferMappingMode): GPUMapModeFlags {

    const mapMode = (globalThis as {
        GPUMapMode?: { READ?: number, WRITE?: number }
    }).GPUMapMode
    const value = mode === 'read' ? mapMode?.READ : mapMode?.WRITE
    return typeof value === 'number' ? value : mode === 'read' ? 0x1 : 0x2
}

function GPUBufferUsageValue(
    name: 'MAP_READ' | 'MAP_WRITE' | 'COPY_SRC' | 'COPY_DST'
): GPUBufferUsageFlags {

    const values = (globalThis as {
        GPUBufferUsage?: Partial<Record<typeof name, number>>
    }).GPUBufferUsage
    const fallback = {
        MAP_READ: 0x1,
        MAP_WRITE: 0x2,
        COPY_SRC: 0x4,
        COPY_DST: 0x8,
    }[name]
    return values?.[name] ?? fallback
}

function cancellationCode(reason: 'abort' | BufferMappingLifecycleReason): string {

    if (reason === 'abort') return 'SCRATCH_BUFFER_MAPPING_ABORTED'
    if (reason === 'device-lost') return 'SCRATCH_BUFFER_MAPPING_DEVICE_LOST'
    if (reason === 'runtime-disposed') return 'SCRATCH_BUFFER_MAPPING_RUNTIME_DISPOSED'
    return 'SCRATCH_BUFFER_MAPPING_RESOURCE_DISPOSED'
}

function cancellationMessage(reason: 'abort' | BufferMappingLifecycleReason): string {

    if (reason === 'abort') return 'Pending buffer mapping was cancelled by AbortSignal.'
    if (reason === 'device-lost') return 'Buffer mapping ended because the GPU device was lost.'
    if (reason === 'runtime-disposed') return 'Buffer mapping ended because ScratchRuntime was disposed.'
    return 'Buffer mapping ended because BufferResource was disposed.'
}

function mappingFailureMessage(code: string): string {

    if (code === 'SCRATCH_BUFFER_MAPPING_VALIDATION_FAILED') return 'Buffer mapping failed native validation.'
    if (code === 'SCRATCH_BUFFER_MAPPING_INTERNAL_FAILED') return 'Buffer mapping observed a native internal error.'
    if (code === 'SCRATCH_BUFFER_MAPPING_OUT_OF_MEMORY') return 'Buffer mapping observed native out-of-memory.'
    if (code === 'SCRATCH_BUFFER_MAPPING_SCOPE_FAILED') return 'Buffer mapping error scopes failed to settle structurally.'
    if (code === 'SCRATCH_BUFFER_MAPPING_MAPPED_RANGE_FAILED') return 'Buffer mapped-range access failed.'
    if (code === 'SCRATCH_BUFFER_MAPPING_RELEASE_FAILED') return 'Buffer mapping cleanup failed.'
    return 'Buffer mapping Promise rejected.'
}

Object.freeze(MappedBufferLease.prototype)
