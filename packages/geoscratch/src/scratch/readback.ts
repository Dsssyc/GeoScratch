import { UUID } from '../core/utils/uuid.js'
import { ScratchDiagnosticError, throwScratchDiagnostic } from './diagnostics.js'
import { createLayoutReadbackView } from './layout-codec.js'
import { describeValue, getGlobalConstant } from './type-utils.js'
import type { BufferResource } from './buffer.js'
import type { DiagnosticSubject } from './diagnostics.js'
import type { LayoutArtifact, LayoutReadbackView } from './layout-codec.js'
import type { ScratchRuntime } from './runtime.js'
import type { SubmittedResourceEpoch, SubmittedWork } from './submission.js'

const BUFFER_USAGE_MAP_READ = 0x1
const BUFFER_USAGE_COPY_SRC = 0x4
const BUFFER_USAGE_COPY_DST = 0x8
const MAP_MODE_READ = getGlobalConstant('GPUMapMode', 'READ', 0x1)

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
    after: SubmittedWork
    stagingBuffer: GPUBuffer
    contentEpoch: number
    allocationVersion: number
    producerEpoch?: SubmittedResourceEpoch
}

export type TypedArrayConstructor<T extends ArrayBufferView = ArrayBufferView> = {
    readonly BYTES_PER_ELEMENT: number
    readonly name: string
    new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): T
}

export interface ReadbackOperation {
    runtime: ScratchRuntime
    id: string
    label?: string
    state: ReadbackState
    source: BufferResource
    layout?: LayoutArtifact
    range: {
        offset: number
        byteLength: number
    }
    after?: SubmittedWork
    producerEpoch?: SubmittedResourceEpoch
    contentEpoch: number
    allocationVersion: number
    retain: ReadbackRetentionPolicy
    isResultRetained: boolean
    retainedByteLength?: number
    isDisposed: boolean
    isCancelled: boolean
    cancelReason?: string
    stagingBuffer?: GPUBuffer
}

export class ReadbackOperation {

    private _retainedBytes?: Uint8Array

    constructor(runtime: ScratchRuntime, descriptor: ReadbackOperationDescriptor) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-readback-${UUID()}`
        if (descriptor.label !== undefined) this.label = descriptor.label
        this.state = 'requested'
        this.source = normalizeSource(this, descriptor.source)
        if (this.source.layout !== undefined) this.layout = this.source.layout
        this.range = normalizeRange(this, descriptor.range)
        const after = normalizeAfter(this, descriptor.after)
        if (after !== undefined) this.after = after
        const producerEpoch = findSourceProducerEpoch(after, this.source)
        if (producerEpoch !== undefined) this.producerEpoch = producerEpoch
        this.contentEpoch = producerEpoch?.contentEpoch ?? this.source.contentEpoch
        this.allocationVersion = producerEpoch?.allocationVersion ?? this.source.allocationVersion
        this.isDisposed = false
        this.isCancelled = false
        this.isResultRetained = false
        this.retain = normalizeRetentionPolicy(this, descriptor.retain)
        assertReadbackSourceCurrent(this)
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
        this.isCancelled = true
        if (reason !== undefined) this.cancelReason = reason
        this.state = 'cancelled'
    }

    dispose() {

        if (this.state === 'disposed') return

        this._clearRetainedBytes()
        this._releaseStagingBuffer(true)
        this.isDisposed = true
        this.state = 'disposed'
    }

    async _readBytes(): Promise<Uint8Array> {

        this._assertReadableLifecycle()

        if (this._retainedBytes !== undefined) {
            return cloneBytes(this._retainedBytes)
        }

        try {
            const isScheduled = scheduledReadbackOperations.has(this)
            this._assertBeforeMaterialization()

            if (this.after?.done) {
                await this.after.done
            }

            this._assertBeforeMaterialization()
            if (!isScheduled) {
                this.state = 'scheduled'
                const device = this.runtime.device
                const queue = this.runtime.queue
                const stagingDescriptor: GPUBufferDescriptor = {
                    size: this.range.byteLength,
                    usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
                }
                const stagingLabel = labelWithSuffix(this.label, 'staging')
                if (stagingLabel !== undefined) stagingDescriptor.label = stagingLabel
                this.stagingBuffer = device.createBuffer(stagingDescriptor)

                const encoderDescriptor: GPUCommandEncoderDescriptor = {}
                const encoderLabel = labelWithSuffix(this.label, 'copy')
                if (encoderLabel !== undefined) encoderDescriptor.label = encoderLabel
                const encoder = device.createCommandEncoder(encoderDescriptor)
                encoder.copyBufferToBuffer(
                    this.source.gpuBuffer,
                    this.range.offset,
                    this.stagingBuffer,
                    0,
                    this.range.byteLength
                )

                this.state = 'submitted'
                queue.submit([ encoder.finish() ])
                if (typeof queue.onSubmittedWorkDone === 'function') {
                    await queue.onSubmittedWorkDone()
                }
            }

            this._assertReadableLifecycle()
            this.state = 'mapping'
            const stagingBuffer = this.stagingBuffer!
            await stagingBuffer.mapAsync(MAP_MODE_READ, 0, this.range.byteLength)
            this._assertReadableLifecycle()
            const mapped = stagingBuffer.getMappedRange(0, this.range.byteLength)
            const bytes = new Uint8Array(mapped.slice(0))

            this._releaseStagingBuffer(true)

            if (this.retain === 'until-dispose') {
                this._retainedBytes = bytes
                this.isResultRetained = true
                this.retainedByteLength = bytes.byteLength
                this.state = 'ready'
                return cloneBytes(bytes)
            }

            this._clearRetainedBytes()
            this.state = 'consumed'
            return bytes
        } catch (error: unknown) {
            if (error instanceof ScratchDiagnosticError) {
                this._releaseStagingBuffer(true)
                if (this.state !== 'cancelled' && this.state !== 'disposed') this._clearRetainedBytes()
                throw error
            }

            this.state = 'failed'
            const actual = readbackDiagnosticActual(this, {
                error: error instanceof Error ? error.message : String(error),
            })
            this._clearRetainedBytes()
            this._releaseStagingBuffer(true)
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

        delete this._retainedBytes
        this.isResultRetained = false
        delete this.retainedByteLength
    }

    _releaseStagingBuffer(unmap = false) {

        if (this.stagingBuffer === undefined) return

        const stagingBuffer = this.stagingBuffer
        delete this.stagingBuffer
        if (unmap && typeof stagingBuffer.unmap === 'function') {
            try {
                stagingBuffer.unmap()
            } catch {}
        }
        if (typeof stagingBuffer.destroy === 'function') {
            try {
                stagingBuffer.destroy()
            } catch {}
        }
    }
}

const scheduledReadbackOperations = new WeakSet<ReadbackOperation>()

export function createScheduledReadbackOperation(
    runtime: ScratchRuntime,
    descriptor: ScheduledReadbackOperationDescriptor
): ReadbackOperation {

    const {
        stagingBuffer,
        contentEpoch,
        allocationVersion,
        producerEpoch,
        ...operationDescriptor
    } = descriptor
    const operation = new ReadbackOperation(runtime, operationDescriptor)
    operation.stagingBuffer = stagingBuffer
    operation.contentEpoch = contentEpoch
    operation.allocationVersion = allocationVersion
    if (producerEpoch === undefined) {
        delete operation.producerEpoch
    } else {
        operation.producerEpoch = producerEpoch
    }
    operation.state = 'submitted'
    scheduledReadbackOperations.add(operation)

    return operation
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
    if (operation.stagingBuffer !== undefined) {
        result.stagingBytes = operation.range.byteLength
    }
    if (operation.cancelReason !== undefined) {
        result.reason = operation.cancelReason
    }

    return { ...result, ...actual }
}
