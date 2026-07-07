import { UUID } from '../core/utils/uuid.js'
import { throwScratchDiagnostic } from './diagnostics.js'
import type { BufferResource } from './buffer.js'
import type { ScratchRuntime } from './runtime.js'
import type { SubmittedWork } from './submission.js'

const BUFFER_USAGE_MAP_READ = 0x1
const BUFFER_USAGE_COPY_SRC = 0x4
const BUFFER_USAGE_COPY_DST = 0x8
const MAP_MODE_READ = globalThis.GPUMapMode?.READ ?? 0x1

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

export type ReadbackOperationDescriptor = {
    label?: string
    source: BufferResource
    after?: SubmittedWork
    range?: ReadbackRange
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
    range: {
        offset: number
        byteLength: number
    }
    after?: SubmittedWork
    contentEpoch: number
    allocationVersion: number
    isDisposed: boolean
    isCancelled: boolean
    cancelReason?: string
    stagingBuffer?: GPUBuffer
}

export class ReadbackOperation {

    constructor(runtime: ScratchRuntime, descriptor: ReadbackOperationDescriptor) {

        runtime.assertActive()

        this.runtime = runtime
        this.id = `scratch-readback-${UUID()}`
        this.label = descriptor.label
        this.state = 'requested'
        this.source = normalizeSource(this, descriptor.source)
        this.range = normalizeRange(this, descriptor.range)
        this.after = normalizeAfter(this, descriptor.after)
        this.contentEpoch = this.source.contentEpoch
        this.allocationVersion = this.source.allocationVersion
        this.isDisposed = false
        this.isCancelled = false
        this.stagingBuffer = undefined
    }

    get subject() {

        const subject: any = {
            kind: 'ReadbackOperation',
            id: this.id,
        }
        if (this.label !== undefined) subject.label = this.label

        return subject
    }

    async toBytes(): Promise<Uint8Array> {

        return this._consumeBytes()
    }

    async toArray<T extends ArrayBufferView>(
        TypedArrayConstructor: TypedArrayConstructor<T> = Uint8Array as unknown as TypedArrayConstructor<T>
    ): Promise<T> {

        const bytes = await this._consumeBytes()
        const elementSize = TypedArrayConstructor.BYTES_PER_ELEMENT

        if (!Number.isInteger(elementSize) || elementSize <= 0 || bytes.byteLength % elementSize !== 0) {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_VIEW_INVALID',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject ],
                message: 'ReadbackOperation typed array view does not evenly divide the byte range.',
                expected: { byteLength: `multiple of ${TypedArrayConstructor.name}.BYTES_PER_ELEMENT` },
                actual: { byteLength: bytes.byteLength, bytesPerElement: elementSize },
            })
        }

        return new TypedArrayConstructor(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength / elementSize
        )
    }

    cancel(reason?: string) {

        if (this.state === 'consumed' || this.state === 'disposed') return

        this.isCancelled = true
        this.cancelReason = reason
        this.state = 'cancelled'
    }

    dispose() {

        if (this.state === 'disposed') return

        this.isDisposed = true
        if (this.stagingBuffer && typeof this.stagingBuffer.destroy === 'function') {
            this.stagingBuffer.destroy()
        }
        this.state = 'disposed'
    }

    async _consumeBytes(): Promise<Uint8Array> {

        this._assertConsumable()

        try {
            if (this.after?.done) {
                await this.after.done
            }

            this.state = 'scheduled'
            const device = this.runtime.device
            const queue = this.runtime.queue
            this.stagingBuffer = device.createBuffer({
                label: labelWithSuffix(this.label, 'staging'),
                size: this.range.byteLength,
                usage: BUFFER_USAGE_MAP_READ | BUFFER_USAGE_COPY_DST,
            })

            const encoder = device.createCommandEncoder({
                label: labelWithSuffix(this.label, 'copy'),
            })
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

            this.state = 'mapping'
            await this.stagingBuffer.mapAsync(MAP_MODE_READ, 0, this.range.byteLength)
            const mapped = this.stagingBuffer.getMappedRange(0, this.range.byteLength)
            const bytes = new Uint8Array(mapped.slice(0))

            if (typeof this.stagingBuffer.unmap === 'function') {
                this.stagingBuffer.unmap()
            }
            if (typeof this.stagingBuffer.destroy === 'function') {
                this.stagingBuffer.destroy()
            }
            this.stagingBuffer = undefined

            this.state = 'consumed'
            return bytes
        } catch (error: any) {
            this.state = 'failed'
            if (this.stagingBuffer && typeof this.stagingBuffer.destroy === 'function') {
                this.stagingBuffer.destroy()
                this.stagingBuffer = undefined
            }
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_MAP_FAILED',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject ],
                message: 'ReadbackOperation failed while copying or mapping staging data.',
                actual: {
                    state: this.state,
                    error: error?.message ?? String(error),
                },
            })
        }
    }

    _assertConsumable() {

        this.runtime.assertActive()
        this.source.assertUsable()

        if (this.isDisposed || this.state === 'disposed') {
            throwScratchDiagnostic({
                code: 'SCRATCH_READBACK_OPERATION_DISPOSED',
                severity: 'error',
                phase: 'readback',
                subject: this.subject,
                related: [ this.source.subject ],
                message: 'ReadbackOperation has been disposed.',
                actual: { state: this.state },
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
                actual: { state: this.state, reason: this.cancelReason },
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
                actual: { state: this.state },
            })
        }
    }
}

function normalizeSource(operation: ReadbackOperation, source: any): BufferResource {

    if (!source || typeof source.assertRuntime !== 'function' || !source.gpuBuffer) {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_SOURCE_INVALID',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            message: 'ReadbackOperation requires a BufferResource source.',
            expected: { source: 'BufferResource' },
            actual: { source: source === undefined || source === null ? String(source) : typeof source },
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

function normalizeAfter(operation, after) {

    if (after === undefined) return undefined

    if (!after || after.runtime !== operation.runtime || typeof after.done?.then !== 'function') {
        throwScratchDiagnostic({
            code: 'SCRATCH_READBACK_AFTER_INVALID',
            severity: 'error',
            phase: 'readback',
            subject: operation.subject,
            message: 'ReadbackOperation after must be a SubmittedWork from the same ScratchRuntime.',
            expected: { after: 'SubmittedWork' },
            actual: { after: after === undefined || after === null ? String(after) : typeof after },
        })
    }

    return after
}

function labelWithSuffix(label, suffix) {

    return label === undefined ? undefined : `${label} ${suffix}`
}
