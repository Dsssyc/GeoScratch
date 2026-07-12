import { UUID } from '../core/utils/uuid.js'
import { ScratchDiagnosticError, throwScratchDiagnostic } from './diagnostics.js'
import { createLayoutReadbackView } from './layout-codec.js'
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
import { describeValue, getGlobalConstant } from './type-utils.js'
import type { BufferResource } from './buffer.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { LayoutArtifact, LayoutReadbackView } from './layout-codec.js'
import type { ReadbackStagingSlot } from './readback-staging.js'
import type { ScratchRuntime } from './runtime.js'
import type { ScratchRuntimeReadbackOperationFact } from './runtime-diagnostics.js'
import type { SubmittedResourceEpoch, SubmittedWork } from './submission.js'

const BUFFER_USAGE_COPY_SRC = 0x4
const MAP_MODE_READ = getGlobalConstant('GPUMapMode', 'READ', 0x1)
const readbackOperationToken = Symbol('ReadbackOperation')

export type ReadbackRange = {
    offset?: number
    byteLength?: number
}

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
    source: BufferResource
    after?: SubmittedWork
    range?: ReadbackRange
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
    release(options: Readonly<{ unmap: boolean, gpuUseComplete: boolean }>): void
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
    source: BufferResource
    layout: LayoutArtifact | undefined
    range: Readonly<{ offset: number, byteLength: number }>
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
            range: Object.freeze({ offset: 0, byteLength: 0 }),
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
        }
        readbackOperationStates.set(this, state)
        state.source = normalizeSource(this, descriptor.source)
        state.layout = state.source.layout
        state.range = Object.freeze(normalizeRange(this, descriptor.range))
        const after = normalizeAfter(this, descriptor.after)
        state.after = after
        state.producerEpoch = construction.producerEpoch ?? findSourceProducerEpoch(after, state.source)
        state.contentEpoch = construction.contentEpoch ?? state.producerEpoch?.contentEpoch ?? state.source.contentEpoch
        state.allocationVersion = construction.allocationVersion ?? state.producerEpoch?.allocationVersion ?? state.source.allocationVersion
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

    get source(): BufferResource {

        return readbackStateFor(this).source
    }

    get layout(): LayoutArtifact | undefined {

        return readbackStateFor(this).layout
    }

    get range(): Readonly<{ offset: number, byteLength: number }> {

        return readbackStateFor(this).range
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

    async toBytes(): Promise<Uint8Array> {

        return this._readBytes()
    }

    async toArray(): Promise<Uint8Array>

    async toArray<T extends ArrayBufferView>(TypedArrayConstructor: TypedArrayConstructor<T>): Promise<T>

    async toArray<T extends ArrayBufferView>(
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

    async toLayoutView(): Promise<LayoutReadbackView> {

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
        this._releaseStagingBuffer(true)
        const state = readbackStateFor(this)
        state.isCancelled = true
        if (reason !== undefined) state.cancelReason = reason
        this._setState('cancelled')
        this._unregister()
    }

    dispose() {

        if (this.state === 'disposed') return

        this._clearRetainedBytes()
        this._releaseStagingBuffer(true)
        readbackStateFor(this).isDisposed = true
        this._setState('disposed')
        this._unregister()
    }

    async _readBytes(): Promise<Uint8Array> {

        this._assertReadableLifecycle()

        const retainedBytes = readbackStateFor(this).retainedBytes
        if (retainedBytes !== undefined) {
            return cloneBytes(retainedBytes)
        }

        try {
            const isScheduled = scheduledReadbackOperations.has(this)
            this._assertBeforeMaterialization()

            if (!isScheduled) {
                this._setState('scheduled')
                const device = this.runtime.device
                const queue = this.runtime.queue
                const stagingLabel = labelWithSuffix(this.label, 'staging')
                const slot = await allocateReadbackStaging({
                    runtime: this.runtime,
                    target: readbackTarget(this),
                    source: this.source,
                    byteLength: this.range.byteLength,
                    ...(stagingLabel !== undefined ? { label: stagingLabel } : {}),
                })
                directReadbackStaging.set(this, slot)
                this._updateFact({
                    stagingBytes: slot.byteLength,
                    lastStagingOperationId: slot.allocationOperationId,
                })

                this._assertBeforeMaterialization()
                const stagingBuffer = readbackStagingBuffer(slot)

                const encoderDescriptor: GPUCommandEncoderDescriptor = {}
                const encoderLabel = labelWithSuffix(this.label, 'copy')
                if (encoderLabel !== undefined) encoderDescriptor.label = encoderLabel
                const encoder = device.createCommandEncoder(encoderDescriptor)
                encoder.copyBufferToBuffer(
                    this.source.gpuBuffer,
                    this.range.offset,
                    stagingBuffer,
                    0,
                    this.range.byteLength
                )

                this._setState('submitted')
                queue.submit([ encoder.finish() ])
            }

            this._assertReadableLifecycle()
            scheduledReadbackStaging.get(this)?.markMapping()
            this._setState('mapping', { isMapping: true })
            const stagingBuffer = this._stagingBuffer()
            await stagingBuffer.mapAsync(MAP_MODE_READ, 0, this.range.byteLength)
            readbackStateFor(this).mappingCompleted = true
            this._assertReadableLifecycle()
            const mapped = stagingBuffer.getMappedRange(0, this.range.byteLength)
            const bytes = new Uint8Array(mapped.slice(0))

            this._releaseStagingBuffer(true)

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
                return cloneBytes(bytes)
            }

            this._clearRetainedBytes()
            this._setState('consumed', { isMapping: false, stagingBytes: 0 })
            this._unregister()
            return bytes
        } catch (error: unknown) {
            if (error instanceof ScratchDiagnosticError) {
                this._releaseStagingBuffer(true)
                if (this.state !== 'cancelled' && this.state !== 'disposed') {
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
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_MAP_FAILED',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject ],
                message: 'ReadbackOperation failed while copying or mapping staging data.',
                actual,
            })
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
                code: 'SCRATCH_READBACK_MAP_FAILED',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject ],
                message: 'ReadbackOperation has already failed.',
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

    _releaseStagingBuffer(unmap = false) {

        const slot = directReadbackStaging.get(this)
        if (slot !== undefined) {
            directReadbackStaging.delete(this)
            releaseReadbackStaging(slot, unmap)
            this._updateFact({ stagingBytes: 0, isMapping: false })
            return
        }

        const owner = scheduledReadbackStaging.get(this)
        if (owner === undefined) return

        scheduledReadbackStaging.delete(this)
        owner.release({
            unmap,
            gpuUseComplete: readbackStateFor(this).mappingCompleted,
        })
        this._updateFact({ stagingBytes: 0, isMapping: false })
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
        sourceResourceId: operation.source.id,
        allocationVersion: operation.allocationVersion,
        contentEpoch: operation.contentEpoch,
        byteLength: operation.range.byteLength,
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
        sourceResourceId: operation.source.id,
        allocationVersion: operation.allocationVersion,
        contentEpoch: operation.contentEpoch,
        byteLength: operation.range.byteLength,
        stagingBytes: scheduledReadbackStaging.has(operation) ? operation.range.byteLength : 0,
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

    if (operation.source.contentEpoch !== operation.contentEpoch) {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_SOURCE_EPOCH_STALE',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            related: readbackRelatedSubjects(operation),
            message: 'ReadbackOperation source content epoch no longer matches the captured readback epoch.',
            expected: { contentEpoch: operation.contentEpoch },
            actual: readbackDiagnosticActual(operation, {
                contentEpoch: operation.source.contentEpoch,
                capturedContentEpoch: operation.contentEpoch,
                producerEpoch: operation.producerEpoch?.contentEpoch,
            }),
        })
    }

    if (operation.source.allocationVersion !== operation.allocationVersion) {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_SOURCE_ALLOCATION_STALE',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            related: readbackRelatedSubjects(operation),
            message: 'ReadbackOperation source allocation version no longer matches the captured readback allocation.',
            expected: { allocationVersion: operation.allocationVersion },
            actual: readbackDiagnosticActual(operation, {
                allocationVersion: operation.source.allocationVersion,
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

function normalizeSource(operation: ReadbackOperation, source: BufferResource): BufferResource {

    if (!source || typeof source.assertRuntime !== 'function' || !source.gpuBuffer) {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_SOURCE_INVALID',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            message: 'ReadbackOperation requires a BufferResource source.',
            expected: { source: 'BufferResource' },
            actual: { source: describeValue(source) },
        })
    }

    source.assertRuntime(operation.runtime)

    if (typeof source.usage === 'number' && (source.usage & BUFFER_USAGE_COPY_SRC) === 0) {
        throwScratchDiagnostic({
            code: 'SCRATCH_RESOURCE_USAGE_MISSING',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            related: [ source.subject ],
            message: 'ReadbackOperation source must be created with copy source usage.',
            expected: { usage: 'copySrc' },
            actual: { usage: source.usage },
        })
    }

    return source
}

function normalizeRange(operation: ReadbackOperation, range?: ReadbackRange) {

    const offset = range?.offset ?? 0
    const byteLength = range?.byteLength ?? operation.source.size - offset

    if (
        !Number.isInteger(offset) ||
        !Number.isInteger(byteLength) ||
        offset < 0 ||
        byteLength <= 0 ||
        offset + byteLength > operation.source.size
    ) {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_RANGE_INVALID',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            related: [ operation.source.subject ],
            message: 'ReadbackOperation range must fit inside the source buffer.',
            expected: { offset: 'non-negative integer', byteLength: 'positive byte length within source' },
            actual: { offset, byteLength, sourceSize: operation.source.size },
        })
    }

    return { offset, byteLength }
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

function readbackDiagnosticActual(
    operation: ReadbackOperation,
    actual: Record<string, unknown> = {}
): Record<string, unknown> {

    const result: Record<string, unknown> = {
        state: operation.state,
        retain: operation.retain,
        sourceId: operation.source.id,
        range: operation.range,
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
        result.stagingBytes = operation.range.byteLength
    }
    if (operation.cancelReason !== undefined) {
        result.reason = operation.cancelReason
    }

    return { ...result, ...actual }
}
