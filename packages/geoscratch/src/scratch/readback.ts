import { UUID } from '../core/utils/uuid.js'
import { BufferRegion, isBufferRegion } from './buffer.js'
import { isScratchDiagnosticError, throwScratchDiagnostic } from './diagnostics.js'
import { serializeNativeGpuError } from './gpu-operation.js'
import { createLayoutReadbackView } from './layout-codec.js'
import {
    beginReadbackMapping,
    cancelReadbackMapping,
    completeReadbackMapping,
    failReadbackMapping,
    recordReadbackCleanupFailure,
} from './readback-mapping.js'
import {
    adoptRuntimeReadbackOperation,
    registerRuntimeReadbackOperation,
    unregisterRuntimeReadbackOperation,
    updateRuntimeReadbackOperation,
} from './readback-ownership.js'
import {
    allocateReadbackStaging,
    readbackStagingBuffer,
    releaseReadbackStaging,
} from './readback-staging.js'
import { diagnosticsControllerFor } from './runtime-diagnostics.js'
import { beginReadbackNativeObservation } from './submission-native-observation.js'
import { describeValue } from './type-utils.js'
import type { BufferResource } from './buffer.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type {
    ScratchReadbackFailureStage,
    ScratchSubmissionNativeOutcome,
} from './gpu-operation.js'
import type { LayoutArtifact, LayoutReadbackView } from './layout-codec.js'
import type { ReadbackMappingTransaction } from './readback-mapping.js'
import type { ReadbackStagingCleanupResult, ReadbackStagingSlot } from './readback-staging.js'
import type { ScratchRuntime } from './runtime.js'
import type { ScratchRuntimeReadbackOperationFact } from './runtime-diagnostics.js'
import type { SubmittedResourceEpoch, SubmittedWork } from './submission.js'
import type { ReadbackNativeSettlement } from './submission-native-observation.js'

const BUFFER_USAGE_COPY_SRC = 0x4
const readbackOperationToken = Symbol('ReadbackOperation')

export type ReadbackState =
    | 'requested'
    | 'scheduled'
    | 'submitted'
    | 'mapping'
    | 'ready'
    | 'consumed'
    | 'cancelled'
    | 'failed'
    | 'disposed'

export type ReadbackRetentionPolicy =
    | 'consume-on-read'
    | 'until-dispose'

export type ReadbackOperationDescriptor = {
    label?: string
    source: BufferRegion
    after?: SubmittedWork
    retain?: ReadbackRetentionPolicy
}

export type ScheduledReadbackOperationDescriptor = ReadbackOperationDescriptor & {
    id: string
    after: SubmittedWork
    commandId: string
    stepIndex: number
    stagingAllocationOperationId: string
    staging: ScheduledReadbackStagingOwner
    contentEpoch: number
    allocationVersion: number
    producerEpoch?: SubmittedResourceEpoch
}

export type ScheduledReadbackStagingOwner = Readonly<{
    buffer: GPUBuffer
    markMapping(): void
    release(options: Readonly<{
        unmap: boolean
        gpuUseComplete: boolean
    }>): ReadbackStagingCleanupResult
}>

export type TypedArrayConstructor<T extends ArrayBufferView = ArrayBufferView> = {
    readonly BYTES_PER_ELEMENT: number
    readonly name: string
    new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): T
}

type ReadbackOperationConstruction = Readonly<{
    path: 'direct' | 'ordered'
    id?: string
    contentEpoch?: number
    allocationVersion?: number
    producerEpoch?: SubmittedResourceEpoch
    commandId?: string
    stepIndex?: number
    stagingAllocationOperationId?: string
    staging?: ScheduledReadbackStagingOwner
    factReserved?: boolean
}>

type ReadbackOperationPrivateState = {
    runtime: ScratchRuntime
    id: string
    label: string | undefined
    state: ReadbackState
    source: BufferRegion
    layout: LayoutArtifact | undefined
    after: SubmittedWork | undefined
    producerEpoch: SubmittedResourceEpoch | undefined
    contentEpoch: number
    allocationVersion: number
    retain: ReadbackRetentionPolicy
    retainedBytes: Uint8Array | undefined
    retainedByteLength: number | undefined
    isResultRetained: boolean
    isDisposed: boolean
    isCancelled: boolean
    cancelReason: string | undefined
    commandId: string | undefined
    stepIndex: number | undefined
    stagingAllocationOperationId: string | undefined
    mappingCompleted: boolean
    materialization: Promise<Uint8Array> | undefined
    lifecycleSubscribers: Set<(state: 'cancelled' | 'disposed') => void>
    failureCode: string | undefined
}

const directReadbackStaging = new WeakMap<ReadbackOperation, ReadbackStagingSlot>()
const scheduledReadbackStaging = new WeakMap<ReadbackOperation, ScheduledReadbackStagingOwner>()
const readbackOperationPaths = new WeakMap<ReadbackOperation, 'direct' | 'ordered'>()
const registeredReadbackOperations = new WeakSet<ReadbackOperation>()
const readbackOperationStates = new WeakMap<ReadbackOperation, ReadbackOperationPrivateState>()

export class ReadbackOperation {

    private constructor(
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: ReadbackOperationDescriptor,
        construction: ReadbackOperationConstruction
    ) {

        if (token !== readbackOperationToken || new.target !== ReadbackOperation) {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_OPERATION_CONSTRUCTOR_PRIVATE',
                severity: 'error',
                phase: 'readback',
                subject: { kind: 'ReadbackOperation' },
                message: 'ReadbackOperation must be created by ScratchRuntime.',
                hints: [ 'Use runtime.createReadback(descriptor).' ],
            })
        }

        runtime.assertActive()

        const state: ReadbackOperationPrivateState = {
            runtime,
            id: construction.id ?? `scratch-readback-${UUID()}`,
            label: descriptor.label,
            state: 'requested',
            source: descriptor.source,
            layout: undefined,
            after: undefined,
            producerEpoch: undefined,
            contentEpoch: 0,
            allocationVersion: 0,
            retain: 'consume-on-read',
            retainedBytes: undefined,
            retainedByteLength: undefined,
            isResultRetained: false,
            isDisposed: false,
            isCancelled: false,
            cancelReason: undefined,
            commandId: construction.commandId,
            stepIndex: construction.stepIndex,
            stagingAllocationOperationId: construction.stagingAllocationOperationId,
            mappingCompleted: false,
            materialization: undefined,
            lifecycleSubscribers: new Set(),
            failureCode: undefined,
        }
        readbackOperationStates.set(this, state)
        state.source = normalizeSource(this, descriptor.source)
        state.layout = state.source.layout
        const after = normalizeAfter(this, descriptor.after)
        state.after = after
        state.producerEpoch = construction.producerEpoch ?? findSourceProducerEpoch(after, state.source.buffer)
        state.contentEpoch = construction.contentEpoch ?? state.producerEpoch?.contentEpoch ?? state.source.buffer.contentEpoch
        state.allocationVersion = construction.allocationVersion ?? state.producerEpoch?.allocationVersion ?? state.source.buffer.allocationVersion
        state.retain = normalizeRetentionPolicy(this, descriptor.retain)
        if (construction.path === 'direct') assertReadbackSourceCurrent(this)
        readbackOperationPaths.set(this, construction.path)
        if (construction.staging !== undefined) {
            scheduledReadbackStaging.set(this, construction.staging)
            state.state = 'submitted'
        }
        if (construction.factReserved) adoptRuntimeReadbackOperation(this.runtime, this)
        else registerRuntimeReadbackOperation(this.runtime, this, readbackFact(this))
        registeredReadbackOperations.add(this)
        Object.preventExtensions(this)
    }

    get runtime(): ScratchRuntime {

        return readbackStateFor(this).runtime
    }

    get id(): string {

        return readbackStateFor(this).id
    }

    get label(): string | undefined {

        return readbackStateFor(this).label
    }

    get state(): ReadbackState {

        return readbackStateFor(this).state
    }

    get source(): BufferRegion {

        return readbackStateFor(this).source
    }

    get layout(): LayoutArtifact | undefined {

        return readbackStateFor(this).layout
    }

    get after(): SubmittedWork | undefined {

        return readbackStateFor(this).after
    }

    get producerEpoch(): SubmittedResourceEpoch | undefined {

        return readbackStateFor(this).producerEpoch
    }

    get contentEpoch(): number {

        return readbackStateFor(this).contentEpoch
    }

    get allocationVersion(): number {

        return readbackStateFor(this).allocationVersion
    }

    get retain(): ReadbackRetentionPolicy {

        return readbackStateFor(this).retain
    }

    get isResultRetained(): boolean {

        return readbackStateFor(this).isResultRetained
    }

    get retainedByteLength(): number | undefined {

        return readbackStateFor(this).retainedByteLength
    }

    get isDisposed(): boolean {

        return readbackStateFor(this).isDisposed
    }

    get isCancelled(): boolean {

        return readbackStateFor(this).isCancelled
    }

    get cancelReason(): string | undefined {

        return readbackStateFor(this).cancelReason
    }

    get subject(): DiagnosticSubject {

        const subject: DiagnosticSubject = {
            kind: 'ReadbackOperation',
            id: this.id,
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    toBytes(): Promise<Uint8Array> {

        return observeReadbackPromise(this._readBytes())
    }

    async toArray(): Promise<Uint8Array>

    async toArray<T extends ArrayBufferView>(TypedArrayConstructor: TypedArrayConstructor<T>): Promise<T>

    toArray<T extends ArrayBufferView>(
        TypedArrayConstructor?: TypedArrayConstructor<T>
    ): Promise<T | Uint8Array> {

        return observeReadbackPromise(this.#toArray(TypedArrayConstructor))
    }

    async #toArray<T extends ArrayBufferView>(
        TypedArrayConstructor?: TypedArrayConstructor<T>
    ): Promise<T | Uint8Array> {

        const bytes = await this._readBytes()
        const ViewConstructor = TypedArrayConstructor ?? Uint8Array
        const elementSize = ViewConstructor.BYTES_PER_ELEMENT

        if (!Number.isInteger(elementSize) || elementSize <= 0 || bytes.byteLength % elementSize !== 0) {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_VIEW_INVALID',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject ],
                message: 'ReadbackOperation typed array view does not evenly divide the byte range.',
                expected: { byteLength: `multiple of ${ViewConstructor.name}.BYTES_PER_ELEMENT` },
                actual: readbackDiagnosticActual(this, { byteLength: bytes.byteLength, bytesPerElement: elementSize }),
            })
        }

        return new ViewConstructor(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength / elementSize
        )
    }

    toLayoutView(): Promise<LayoutReadbackView> {

        return observeReadbackPromise(this.#toLayoutView())
    }

    async #toLayoutView(): Promise<LayoutReadbackView> {

        this._assertReadableLifecycle()

        if (this.layout === undefined) {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_LAYOUT_MISSING',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject ],
                message: 'ReadbackOperation requires source layout metadata to create a layout view.',
                expected: { layout: 'LayoutArtifact' },
                actual: readbackDiagnosticActual(this, { layout: undefined }),
            })
        }

        const bytes = await this._readBytes()
        return createLayoutReadbackView(this.layout, bytes)
    }

    cancel(reason?: string) {

        if (this.state === 'consumed' || this.state === 'disposed') return

        this._clearRetainedBytes()
        const state = readbackStateFor(this)
        state.isCancelled = true
        if (reason !== undefined) state.cancelReason = reason
        this._setState('cancelled')
        publishReadbackLifecycle(this, 'cancelled')
        this._releaseStagingBuffer(true)
        this._unregister()
    }

    dispose() {

        if (this.state === 'disposed') return

        this._clearRetainedBytes()
        readbackStateFor(this).isDisposed = true
        this._setState('disposed')
        publishReadbackLifecycle(this, 'disposed')
        this._releaseStagingBuffer(true)
        this._unregister()
    }

    async _readBytes(): Promise<Uint8Array> {

        this._assertReadableLifecycle()
        const state = readbackStateFor(this)
        const retainedBytes = state.retainedBytes
        if (retainedBytes !== undefined) {
            return cloneBytes(retainedBytes)
        }

        if (state.materialization !== undefined) {
            if (this.retain === 'until-dispose') {
                return cloneBytes(await state.materialization)
            }
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_IN_PROGRESS',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject ],
                message: 'ReadbackOperation already has a consume-on-read materialization owner.',
                expected: { materializationOwners: 1 },
                actual: readbackDiagnosticActual(this, { materializationOwners: 1 }),
            })
        }

        const materialization = this._materializeBytes()
        state.materialization = materialization
        try {
            const bytes = await materialization
            return this.retain === 'until-dispose' ? cloneBytes(bytes) : bytes
        } finally {
            if (state.materialization === materialization) state.materialization = undefined
        }
    }

    async _materializeBytes(): Promise<Uint8Array> {

        let mappingTransaction: ReadbackMappingTransaction | undefined
        let directNativeSettlement: Promise<ReadbackNativeSettlement> | undefined
        let failureStage: ScratchReadbackFailureStage = 'lifecycle-recheck'

        try {
            const isScheduled = scheduledReadbackOperations.has(this)
            failureStage = isScheduled ? 'mapping' : 'staging-allocation'
            this._assertBeforeMaterialization()

            if (!isScheduled) {
                this._setState('scheduled')
                const device = this.runtime.device
                const queue = this.runtime.queue
                const stagingLabel = labelWithSuffix(this.label, 'staging')
                const slot = await allocateReadbackStaging({
                    runtime: this.runtime,
                    target: readbackTarget(this),
                    source: this.source.buffer,
                    byteLength: this.source.size,
                    ...(stagingLabel !== undefined ? { label: stagingLabel } : {}),
                })
                directReadbackStaging.set(this, slot)
                this._updateFact({
                    stagingBytes: slot.byteLength,
                    lastStagingOperationId: slot.allocationOperationId,
                })

                this._assertBeforeMaterialization()
                failureStage = 'copy-issue'
                const stagingBuffer = readbackStagingBuffer(slot)
                const nativeObservation = beginReadbackNativeObservation({
                    runtime: this.runtime,
                    target: readbackTarget(this),
                    plan: [
                        'encoder-create',
                        'command-encode',
                        'encoder-finish',
                        'queue-submit',
                    ],
                })
                directNativeSettlement = nativeObservation.settlement
                let issueFailed = false
                let issueFailure: unknown
                try {
                    const encoderDescriptor: GPUCommandEncoderDescriptor = {}
                    const encoderLabel = labelWithSuffix(this.label, 'copy')
                    if (encoderLabel !== undefined) encoderDescriptor.label = encoderLabel
                    const encoder = nativeObservation.issue(
                        'encoder-create',
                        () => device.createCommandEncoder(encoderDescriptor)
                    )
                    nativeObservation.issue('command-encode', () => encoder.copyBufferToBuffer(
                        this.source.buffer.gpuBuffer,
                        this.source.offset,
                        stagingBuffer,
                        0,
                        this.source.size
                    ))
                    const commandBuffer = nativeObservation.issue(
                        'encoder-finish',
                        () => encoder.finish()
                    )

                    this._setState('submitted')
                    nativeObservation.issue('queue-submit', () => queue.submit([ commandBuffer ]))
                } catch (cause) {
                    issueFailed = true
                    issueFailure = cause
                } finally {
                    nativeObservation.finish()
                }
                if (issueFailed) {
                    const settlement = await directNativeSettlement
                    assertDirectReadbackNativeSettlement(this, settlement, issueFailure)
                }
            }

            this._assertReadableLifecycle()
            scheduledReadbackStaging.get(this)?.markMapping()
            this._setState('mapping', { isMapping: true })
            failureStage = 'mapping'
            const stagingBuffer = this._stagingBuffer()
            const mapping = await beginReadbackMapping({
                runtime: this.runtime,
                target: readbackTarget(this),
                buffer: stagingBuffer,
                byteLength: this.source.size,
                ...(this.label !== undefined ? { label: `${this.label} mapping` } : {}),
                lifecycleState: () => readbackLifecycleState(this),
                subscribeLifecycle: listener => subscribeReadbackLifecycle(this, listener),
                onOperation: operationId => this._updateFact({ lastMappingOperationId: operationId }),
            })
            if (mapping.status === 'cancelled') {
                this._assertReadableLifecycle()
                throw new TypeError('Cancelled readback mapping remained readable.')
            }
            mappingTransaction = mapping.transaction
            readbackStateFor(this).mappingCompleted = true
            try {
                this._assertReadableLifecycle()
            } catch (error) {
                cancelReadbackMapping(mappingTransaction)
                mappingTransaction = undefined
                throw error
            }
            failureStage = 'mapped-range'
            let mapped: ArrayBuffer
            try {
                mapped = stagingBuffer.getMappedRange(0, this.source.size)
            } catch (cause) {
                const transaction = mappingTransaction
                mappingTransaction = undefined
                return failReadbackMapping(transaction, {
                    stage: 'mapped-range',
                    code: 'SCRATCH_READBACK_MAPPED_RANGE_FAILED',
                    cause,
                })
            }
            failureStage = 'host-copy'
            let bytes: Uint8Array
            try {
                bytes = new Uint8Array(mapped.slice(0))
            } catch (cause) {
                const transaction = mappingTransaction
                mappingTransaction = undefined
                return failReadbackMapping(transaction, {
                    stage: 'host-copy',
                    code: 'SCRATCH_READBACK_HOST_COPY_FAILED',
                    cause,
                })
            }

            failureStage = 'cleanup'
            const cleanup = this._releaseStagingBuffer(true)
            if (cleanup !== undefined && cleanup.failures.length > 0) {
                recordReadbackCleanupFailure(mappingTransaction, cleanup)
            } else {
                completeReadbackMapping(mappingTransaction)
            }
            mappingTransaction = undefined

            if (isScheduled) {
                const after = readbackStateFor(this).after
                if (after === undefined) {
                    throw new TypeError('Ordered readback is missing its SubmittedWork owner.')
                }
                assertOrderedReadbackNativeOutcome(this, await after.nativeOutcome)
            } else {
                if (directNativeSettlement === undefined) {
                    throw new TypeError('Direct readback is missing its native observation.')
                }
                assertDirectReadbackNativeSettlement(this, await directNativeSettlement)
            }

            if (this.retain === 'until-dispose') {
                const state = readbackStateFor(this)
                state.retainedBytes = bytes
                state.isResultRetained = true
                state.retainedByteLength = bytes.byteLength
                this._setState('ready', {
                    isMapping: false,
                    stagingBytes: 0,
                    retainedHostBytes: bytes.byteLength,
                })
                return bytes
            }

            this._clearRetainedBytes()
            this._setState('consumed', { isMapping: false, stagingBytes: 0 })
            this._unregister()
            return bytes
        } catch (error: unknown) {
            if (mappingTransaction !== undefined) {
                cancelReadbackMapping(mappingTransaction)
                mappingTransaction = undefined
            }
            if (isScratchDiagnosticError(error)) {
                this._releaseStagingBuffer(true)
                if (this.state !== 'cancelled' && this.state !== 'disposed') {
                    readbackStateFor(this).failureCode = error.diagnostic.code
                    this._clearRetainedBytes()
                    this._setState('failed', {
                        isMapping: false,
                        stagingBytes: 0,
                        retainedHostBytes: 0,
                    })
                    this._unregister()
                }
                throw error
            }

            const failureCode = unexpectedReadbackFailureCode(failureStage)
            readbackStateFor(this).failureCode = failureCode
            this._setState('failed', {
                isMapping: false,
                stagingBytes: 0,
                retainedHostBytes: 0,
            })
            const actual = readbackDiagnosticActual(this, {
                error: error instanceof Error ? error.message : String(error),
            })
            this._clearRetainedBytes()
            this._releaseStagingBuffer(true)
            this._unregister()
            const nativeError = serializeNativeGpuError(error)
            const controller = diagnosticsControllerFor(this.runtime)
            const incident = controller.recordIncident({
                kind: 'readback-failure',
                diagnosticCode: failureCode,
                nativeErrorCategory: 'native-exception',
                attribution: 'exact-operation',
                target: readbackTarget(this),
                failureStage,
                nativeError,
                outcomes: [ Object.freeze({
                    stage: failureStage,
                    diagnosticCode: failureCode,
                    nativeErrorCategory: 'native-exception',
                    nativeError,
                }) ],
            })
            throwScratchDiagnostic({
                code: failureCode,
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject, incident.subject ],
                message: unexpectedReadbackFailureMessage(failureStage),
                actual: { ...actual, failureStage, nativeError },
            }, { cause: error, incident })
        }
    }

    _assertReadableLifecycle() {

        this.runtime.assertActive()

        if (this.isDisposed || this.state === 'disposed') {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_OPERATION_DISPOSED',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject ],
                message: 'ReadbackOperation has been disposed.',
                actual: readbackDiagnosticActual(this),
            })
        }

        if (this.isCancelled || this.state === 'cancelled') {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_CANCELLED',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject ],
                message: 'ReadbackOperation has been cancelled.',
                actual: readbackDiagnosticActual(this),
            })
        }

        if (this.state === 'consumed') {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_ALREADY_CONSUMED',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject ],
                message: 'ReadbackOperation has already been consumed.',
                actual: readbackDiagnosticActual(this),
            })
        }

        if (this.state === 'failed') {
            throwScratchDiagnostic({
                code: readbackStateFor(this).failureCode ?? 'SCRATCH_READBACK_FAILED',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject ],
                message: 'ReadbackOperation failed during an earlier materialization attempt.',
                actual: readbackDiagnosticActual(this),
            })
        }
    }

    _assertBeforeMaterialization() {

        this._assertReadableLifecycle()
        if (scheduledReadbackOperations.has(this)) return
        this.source.assertUsable()
        assertReadbackSourceCurrent(this)
    }

    _clearRetainedBytes() {

        const state = readbackStateFor(this)
        state.retainedBytes = undefined
        state.isResultRetained = false
        state.retainedByteLength = undefined
        this._updateFact({ retainedHostBytes: 0 })
    }

    _releaseStagingBuffer(unmap = false): ReadbackStagingCleanupResult | undefined {

        const slot = directReadbackStaging.get(this)
        if (slot !== undefined) {
            directReadbackStaging.delete(this)
            const cleanup = releaseReadbackStaging(slot, { unmap })
            this._updateFact({ stagingBytes: 0, isMapping: false })
            return cleanup
        }

        const owner = scheduledReadbackStaging.get(this)
        if (owner === undefined) return undefined

        scheduledReadbackStaging.delete(this)
        const cleanup = owner.release({
            unmap,
            gpuUseComplete: readbackStateFor(this).mappingCompleted,
        })
        this._updateFact({ stagingBytes: 0, isMapping: false })
        return cleanup
    }

    _stagingBuffer(): GPUBuffer {

        const slot = directReadbackStaging.get(this)
        if (slot !== undefined) return readbackStagingBuffer(slot)
        const owner = scheduledReadbackStaging.get(this)
        if (owner !== undefined) return owner.buffer
        throw new TypeError(`Readback operation ${this.id} does not own staging.`)
    }

    _setState(
        state: ReadbackState,
        update: Partial<Omit<ScratchRuntimeReadbackOperationFact, 'id'>> = {}
    ): void {

        readbackStateFor(this).state = state
        this._updateFact({ state, ...update })
    }

    _updateFact(update: Partial<Omit<ScratchRuntimeReadbackOperationFact, 'id'>>): void {

        if (!registeredReadbackOperations.has(this)) return
        updateRuntimeReadbackOperation(this.runtime, this.id, update)
    }

    _unregister(): void {

        if (!registeredReadbackOperations.has(this)) return
        registeredReadbackOperations.delete(this)
        unregisterRuntimeReadbackOperation(this.runtime, this)
    }
}

function readbackStateFor(operation: ReadbackOperation): ReadbackOperationPrivateState {

    const state = readbackOperationStates.get(operation)
    if (state === undefined) throw new TypeError('ReadbackOperation is not Scratch-owned.')
    return state
}

function readbackLifecycleState(operation: ReadbackOperation): 'active' | 'cancelled' | 'disposed' {

    if (operation.isDisposed || operation.state === 'disposed') return 'disposed'
    if (operation.isCancelled || operation.state === 'cancelled') return 'cancelled'
    return 'active'
}

function subscribeReadbackLifecycle(
    operation: ReadbackOperation,
    listener: (state: 'cancelled' | 'disposed') => void
): () => void {

    const state = readbackLifecycleState(operation)
    if (state !== 'active') {
        listener(state)
        return () => {}
    }
    const subscribers = readbackStateFor(operation).lifecycleSubscribers
    subscribers.add(listener)
    return () => subscribers.delete(listener)
}

function publishReadbackLifecycle(
    operation: ReadbackOperation,
    lifecycle: 'cancelled' | 'disposed'
): void {

    const subscribers = readbackStateFor(operation).lifecycleSubscribers
    for (const subscriber of [ ...subscribers ]) subscriber(lifecycle)
    subscribers.clear()
}

function assertDirectReadbackNativeSettlement(
    operation: ReadbackOperation,
    settlement: ReadbackNativeSettlement,
    fallbackCause?: unknown
): void {

    const primary = settlement.primaryFailure
    if (primary === undefined) {
        if (fallbackCause !== undefined) throw fallbackCause
        return
    }
    const incident = primary.incident
    throwScratchDiagnostic({
        code: primary.fact.diagnosticCode,
        severity: 'error',
        phase: 'readback',
        subject: operation.subject,
        related: [
            operation.source.subject,
            ...(incident !== undefined ? [ incident.subject ] : []),
        ],
        message: 'Direct readback copy issue produced a captured native failure.',
        actual: readbackDiagnosticActual(operation, {
            failureStage: 'copy-issue',
            nativeOutcome: settlement.outcome,
            primary: primary.fact,
        }),
    }, {
        ...(primary.cause !== undefined
            ? { cause: primary.cause }
            : fallbackCause !== undefined
                ? { cause: fallbackCause }
                : {}),
        ...(incident !== undefined ? { incident } : {}),
    })
}

function assertOrderedReadbackNativeOutcome(
    operation: ReadbackOperation,
    outcome: ScratchSubmissionNativeOutcome
): void {

    if (outcome.status === 'observed-succeeded' || outcome.status === 'unobserved') return

    const primary = outcome.outcomes[0]
    const nativeErrorCategory = primary?.nativeErrorCategory ?? 'none'
    const controller = diagnosticsControllerFor(operation.runtime)
    const incident = controller.recordIncident({
        kind: 'readback-failure',
        diagnosticCode: 'SCRATCH_READBACK_ORDERED_COPY_UNTRUSTED',
        nativeErrorCategory,
        attribution: 'enclosing-operation-family',
        target: readbackTarget(operation),
        failureStage: 'copy-issue',
        related: [ { kind: 'Submission', id: outcome.submissionId } ],
        ...(primary?.nativeError !== undefined ? { nativeError: primary.nativeError } : {}),
        outcomes: outcome.outcomes.map(failure => ({
            stage: failure.stage,
            diagnosticCode: failure.diagnosticCode ?? 'SCRATCH_SUBMISSION_NATIVE_OBSERVATION_FAILED',
            nativeErrorCategory: failure.nativeErrorCategory,
            location: failure.location,
            ...(failure.nativeError !== undefined ? { nativeError: failure.nativeError } : {}),
        })),
        omittedOutcomeCount: outcome.omittedOutcomeCount,
    })
    throwScratchDiagnostic({
        code: 'SCRATCH_READBACK_ORDERED_COPY_UNTRUSTED',
        severity: 'error',
        phase: 'readback',
        subject: operation.subject,
        related: [
            operation.source.subject,
            { kind: 'Submission', id: outcome.submissionId },
            incident.subject,
        ],
        message: 'Ordered readback bytes are not exposed after the associated submission reports a native failure.',
        actual: readbackDiagnosticActual(operation, {
            submissionId: outcome.submissionId,
            failureStage: 'copy-issue',
            copyTrust: 'indeterminate',
            nativeOutcome: outcome,
        }),
    }, {
        incident,
    })
}

function unexpectedReadbackFailureCode(stage: ScratchReadbackFailureStage): string {

    if (stage === 'staging-allocation') return 'SCRATCH_READBACK_STAGING_NATIVE_FAILED'
    if (stage === 'copy-issue') return 'SCRATCH_READBACK_COPY_ISSUE_FAILED'
    if (stage === 'mapping') return 'SCRATCH_READBACK_MAPPING_NATIVE_FAILED'
    if (stage === 'mapped-range') return 'SCRATCH_READBACK_MAPPED_RANGE_FAILED'
    if (stage === 'host-copy') return 'SCRATCH_READBACK_HOST_COPY_FAILED'
    if (stage === 'cleanup') return 'SCRATCH_READBACK_CLEANUP_FAILED'
    return 'SCRATCH_READBACK_FAILED'
}

function unexpectedReadbackFailureMessage(stage: ScratchReadbackFailureStage): string {

    if (stage === 'staging-allocation') return 'Readback staging allocation failed unexpectedly.'
    if (stage === 'copy-issue') return 'Readback copy issue failed before mapping.'
    if (stage === 'mapping') return 'Readback mapping failed unexpectedly.'
    if (stage === 'mapped-range') return 'Readback mapped-range access failed unexpectedly.'
    if (stage === 'host-copy') return 'Readback host copy failed unexpectedly.'
    if (stage === 'cleanup') return 'Readback staging cleanup failed unexpectedly.'
    return 'Readback materialization failed unexpectedly.'
}

const scheduledReadbackOperations = new WeakSet<ReadbackOperation>()

export function createScheduledReadbackOperation(
    runtime: ScratchRuntime,
    descriptor: ScheduledReadbackOperationDescriptor
): ReadbackOperation {

    const {
        id,
        commandId,
        stepIndex,
        stagingAllocationOperationId,
        staging,
        contentEpoch,
        allocationVersion,
        producerEpoch,
        ...operationDescriptor
    } = descriptor
    const operation = constructReadbackOperation(runtime, operationDescriptor, {
        path: 'ordered',
        id,
        commandId,
        stepIndex,
        stagingAllocationOperationId,
        staging,
        factReserved: true,
        contentEpoch,
        allocationVersion,
        ...(producerEpoch !== undefined ? { producerEpoch } : {}),
    })
    scheduledReadbackOperations.add(operation)

    return operation
}

export function createReadbackOperation(
    runtime: ScratchRuntime,
    descriptor: ReadbackOperationDescriptor
): ReadbackOperation {

    return constructReadbackOperation(runtime, descriptor, { path: 'direct' })
}

function constructReadbackOperation(
    runtime: ScratchRuntime,
    descriptor: ReadbackOperationDescriptor,
    construction: ReadbackOperationConstruction
): ReadbackOperation {

    const Constructor = ReadbackOperation as unknown as new (
        token: symbol,
        runtime: ScratchRuntime,
        descriptor: ReadbackOperationDescriptor,
        construction: ReadbackOperationConstruction
    ) => ReadbackOperation
    return new Constructor(readbackOperationToken, runtime, descriptor, construction)
}

function readbackTarget(operation: ReadbackOperation) {

    const state = readbackStateFor(operation)
    return {
        kind: 'readback' as const,
        readbackId: operation.id,
        path: readbackOperationPaths.get(operation) ?? 'direct',
        sourceResourceId: operation.source.buffer.id,
        allocationVersion: operation.allocationVersion,
        contentEpoch: operation.contentEpoch,
        byteLength: operation.source.size,
        ...(state.commandId !== undefined ? { commandId: state.commandId } : {}),
        ...(operation.after !== undefined ? { submissionId: operation.after.id } : {}),
        ...(state.stepIndex !== undefined ? { stepIndex: state.stepIndex } : {}),
    }
}

function readbackFact(operation: ReadbackOperation): ScratchRuntimeReadbackOperationFact {

    const path = readbackOperationPaths.get(operation) ?? 'direct'
    const state = readbackStateFor(operation)
    return {
        id: operation.id,
        ...(operation.label !== undefined ? { label: operation.label } : {}),
        path,
        state: operation.state,
        retain: operation.retain,
        sourceResourceId: operation.source.buffer.id,
        allocationVersion: operation.allocationVersion,
        contentEpoch: operation.contentEpoch,
        byteLength: operation.source.size,
        stagingBytes: scheduledReadbackStaging.has(operation) ? operation.source.size : 0,
        retainedHostBytes: operation.retainedByteLength ?? 0,
        isMapping: operation.state === 'mapping',
        ...(state.commandId !== undefined ? { commandId: state.commandId } : {}),
        ...(operation.after !== undefined ? { submissionId: operation.after.id } : {}),
        ...(state.stepIndex !== undefined ? { stepIndex: state.stepIndex } : {}),
        ...(state.stagingAllocationOperationId !== undefined
            ? { lastStagingOperationId: state.stagingAllocationOperationId }
            : {}),
    }
}

function findSourceProducerEpoch(after: SubmittedWork | undefined, source: BufferResource): SubmittedResourceEpoch | undefined {

    if (after === undefined) return undefined

    for (let index = after.producerEpochs.length - 1; index >= 0; index--) {
        const producerEpoch = after.producerEpochs[index]
        if (producerEpoch.resourceId === source.id) return producerEpoch
    }

    return undefined
}

function assertReadbackSourceCurrent(operation: ReadbackOperation): void {

    if (operation.source.buffer.state === 'indeterminate') {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_SOURCE_CONTENT_INDETERMINATE',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            related: readbackRelatedSubjects(operation),
            message: 'ReadbackOperation cannot read source content whose current value is indeterminate.',
            expected: { state: 'ready' },
            actual: readbackDiagnosticActual(operation, {
                state: operation.source.buffer.state,
                contentEpoch: operation.source.buffer.contentEpoch,
                capturedContentEpoch: operation.contentEpoch,
                recovery: 'explicit later producer before direct readback',
            }),
        })
    }

    if (operation.source.buffer.contentEpoch !== operation.contentEpoch) {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_SOURCE_EPOCH_STALE',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            related: readbackRelatedSubjects(operation),
            message: 'ReadbackOperation source content epoch no longer matches the captured readback epoch.',
            expected: { contentEpoch: operation.contentEpoch },
            actual: readbackDiagnosticActual(operation, {
                contentEpoch: operation.source.buffer.contentEpoch,
                capturedContentEpoch: operation.contentEpoch,
                producerEpoch: operation.producerEpoch?.contentEpoch,
            }),
        })
    }

    if (operation.source.buffer.allocationVersion !== operation.allocationVersion) {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_SOURCE_ALLOCATION_STALE',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            related: readbackRelatedSubjects(operation),
            message: 'ReadbackOperation source allocation version no longer matches the captured readback allocation.',
            expected: { allocationVersion: operation.allocationVersion },
            actual: readbackDiagnosticActual(operation, {
                allocationVersion: operation.source.buffer.allocationVersion,
                capturedAllocationVersion: operation.allocationVersion,
                producerAllocationVersion: operation.producerEpoch?.allocationVersion,
            }),
        })
    }
}

function readbackRelatedSubjects(operation: ReadbackOperation): DiagnosticSubject[] {

    return [
        operation.source.subject,
        operation.after?.subject,
    ].filter((subject): subject is DiagnosticSubject => subject !== undefined)
}

function normalizeSource(operation: ReadbackOperation, source: BufferRegion): BufferRegion {

    if (!isBufferRegion(source) || source.size <= 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_SOURCE_INVALID',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            message: 'ReadbackOperation requires a non-empty BufferRegion source.',
            expected: { source: 'non-empty BufferRegion' },
            actual: { source: describeValue(source) },
        })
    }

    source.buffer.assertRuntime(operation.runtime)
    source.assertUsable()

    if (source.offset % 4 !== 0 || source.size % 4 !== 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_SOURCE_INVALID',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            related: [ source.subject, source.buffer.subject ],
            message: 'ReadbackOperation source must satisfy copyBufferToBuffer alignment.',
            expected: { offset: 'multiple of 4 bytes', size: 'multiple of 4 bytes' },
            actual: { offset: source.offset, size: source.size },
        })
    }

    if ((source.buffer.usage & BUFFER_USAGE_COPY_SRC) === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            related: [ source.subject, source.buffer.subject ],
            message: 'ReadbackOperation source must be created with copy source usage.',
            expected: { usage: 'copySrc' },
            actual: { usage: source.buffer.usage },
        })
    }

    return source
}

function normalizeRetentionPolicy(operation: ReadbackOperation, retain: unknown): ReadbackRetentionPolicy {

    if (retain === undefined) return 'consume-on-read'
    if (retain === 'consume-on-read' || retain === 'until-dispose') return retain

    throwScratchDiagnostic({
        code: 'SCRATCH_READBACK_RETAIN_INVALID',
        severity: 'error',
        phase: 'readback',
        subject: operation.subject,
        related: [ operation.source.subject ],
        message: 'ReadbackOperation retain must be consume-on-read or until-dispose.',
        expected: { retain: [ 'consume-on-read', 'until-dispose' ] },
        actual: readbackDiagnosticActual(operation, { retain }),
    })
}

function normalizeAfter(operation: ReadbackOperation, after?: SubmittedWork): SubmittedWork | undefined {

    if (after === undefined) return undefined

    if (!after || after.runtime !== operation.runtime || typeof after.done?.then !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_AFTER_INVALID',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            message: 'ReadbackOperation after must be a SubmittedWork from the same ScratchRuntime.',
            expected: { after: 'SubmittedWork' },
            actual: { after: describeValue(after) },
        })
    }

    return after
}

function labelWithSuffix(label: string | undefined, suffix: string): string | undefined {

    return label === undefined ? undefined : `${label} ${suffix}`
}

function cloneBytes(bytes: Uint8Array): Uint8Array {

    return new Uint8Array(bytes)
}

function observeReadbackPromise<T>(promise: Promise<T>): Promise<T> {

    void promise.catch(() => {})
    return promise
}

function readbackDiagnosticActual(
    operation: ReadbackOperation,
    actual: Record<string, unknown> = {}
): Record<string, unknown> {

    const result: Record<string, unknown> = {
        state: operation.state,
        retain: operation.retain,
        sourceId: operation.source.buffer.id,
        sourceRegion: {
            offset: operation.source.offset,
            size: operation.source.size,
        },
        contentEpoch: operation.contentEpoch,
        allocationVersion: operation.allocationVersion,
    }

    if (operation.producerEpoch !== undefined && operation.after !== undefined) {
        result.producerSubmissionId = operation.after.id
    }
    if (operation.retainedByteLength !== undefined) {
        result.retainedByteLength = operation.retainedByteLength
    }
    if (directReadbackStaging.has(operation) || scheduledReadbackStaging.has(operation)) {
        result.stagingBytes = operation.source.size
    }
    if (operation.cancelReason !== undefined) {
        result.reason = operation.cancelReason
    }

    return { ...result, ...actual }
}
