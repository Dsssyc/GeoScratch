import {
    SubmittedWork,
    type BufferResource, type GPURuntime, type SubmissionAuthority,
    type SubmissionAuthorityStamp, type SubmissionBuilder, type UploadCommand,
} from '../scratch/index.js'
import {
    appendSubmissionBuilderOpaqueSteps,
    type SubmissionBuilderOpaqueSequence,
} from '../scratch/gpu/submission.js'
import { createGeoDiagnostic, GeoDiagnosticError, isGeoDiagnosticError, throwGeoDiagnostic } from './diagnostics.js'
import { gpuWebMercatorQuadCoverMapMetaCodec } from './gpu-web-mercator-quad-cover-layout.js'
import {
    isWebMercatorQuadCover, webMercatorQuadCoverSelectionData,
    type WebMercatorQuadCover, type WebMercatorQuadCoverSelection,
} from './web-mercator-quad-cover.js'

export type WebMercatorQuadCoverUploadDescriptor = Readonly<{ cover: WebMercatorQuadCover }>
export type WebMercatorQuadCoverUploadTemplate = Readonly<{
    uploadId: string
    coverId: string
    parity: 0 | 1
    mapMeta: BufferResource
    patches: BufferResource
    coverLookup: BufferResource
}>

/** Owned prepared upload attempt; disposing unsubmitted work releases its private bytes/commands. */
export type WebMercatorQuadCoverUploadFrame = Readonly<{
    kind: 'web-mercator-quad-cover-upload-frame'
    uploadId: string
    coverId: string
    selectionId: string
    selectionRevision: number
    frameEpoch: number
    residencySnapshotEpoch: number
    parity: 0 | 1
    readonly isDisposed: boolean
    dispose(): void
}>

export type WebMercatorQuadCoverUploadResourceFact = Readonly<{
    name: 'mapMeta' | 'patches' | 'coverLookup'
    resourceId: string
    commandId: string
    allocationVersion: number
    contentEpoch: number
    stepIndex: number
}>

/** Immutable evidence of queued CPU geometry uploads, never a certificate of native success. */
export type WebMercatorQuadCoverUploadReceipt = Readonly<{
    kind: 'web-mercator-quad-cover-upload-receipt'
    uploadId: string
    coverId: string
    selectionId: string
    selectionRevision: number
    viewId: string
    frameEpoch: number
    residencySnapshotEpoch: number
    runtimeId: string
    submissionId: string
    parity: 0 | 1
    resources: readonly WebMercatorQuadCoverUploadResourceFact[]
}>

export type WebMercatorQuadCoverUploadFacts = Readonly<{
    id: string
    runtimeId: string
    coverId: string
    disposed: boolean
    poisoned: boolean
    preparedFrameCount: number
    acceptedReceiptCount: number
    persistentBufferBytes: number
    parity: readonly Readonly<{ parity: 0 | 1, mapMetaBufferId: string, patchBufferId: string, lookupBufferId: string }>[]
}>

type UploadEntry = Readonly<{
    name: WebMercatorQuadCoverUploadResourceFact['name']
    resource: BufferResource
    command: UploadCommand
    allocationVersion: number
    contentEpochBefore: number
}>
type FrameRecord = {
    owner: WebMercatorQuadCoverUpload
    frame: WebMercatorQuadCoverUploadFrame
    viewId: string
    viewStamp: SubmissionAuthorityStamp
    sequenceStamp: SubmissionAuthorityStamp
    entries: readonly UploadEntry[]
    disposed: boolean
    builder?: SubmissionBuilder
    sequence?: SubmissionBuilderOpaqueSequence
    submitted?: SubmittedWork
    receipt?: WebMercatorQuadCoverUploadReceipt
}

const token = Symbol('WebMercatorQuadCoverUpload')
const frames = new WeakMap<WebMercatorQuadCoverUploadFrame, FrameRecord>()
let nextUploadId = 1

/** Lowers certified CPU selections to owned parity buffers through explicit, revisioned Scratch uploads. */
export class WebMercatorQuadCoverUpload {
    #id = `geo-web-mercator-quad-cover-upload-${nextUploadId++}`
    #runtime: GPURuntime
    #cover: WebMercatorQuadCover
    #templates: readonly WebMercatorQuadCoverUploadTemplate[]
    #resources: readonly BufferResource[]
    #viewAuthority: SubmissionAuthority
    #sequenceAuthority: SubmissionAuthority
    #frames = new Set<FrameRecord>()
    #builders = new WeakSet<SubmissionBuilder>()
    #disposed = false
    #poisoned = false
    #acceptedReceiptCount = 0

    private constructor(key: symbol, runtime: GPURuntime, cover: WebMercatorQuadCover, resources: readonly BufferResource[]) {
        if (key !== token) invalidUpload('uninitialized', 'constructor', {})
        this.#runtime = runtime
        this.#cover = cover
        this.#resources = Object.freeze([...resources])
        this.#templates = Object.freeze(([0, 1] as const).map(parity => Object.freeze({
            uploadId: this.id, coverId: cover.id, parity,
            mapMeta: resources[parity * 3], patches: resources[parity * 3 + 1], coverLookup: resources[parity * 3 + 2],
        })))
        this.#viewAuthority = runtime.createSubmissionAuthority({ label: `${this.id} prepared selection` })
        this.#sequenceAuthority = runtime.createSubmissionAuthority({ label: `${this.id} upload sequence` })
        Object.preventExtensions(this)
    }

    static async create(runtime: GPURuntime, input: WebMercatorQuadCoverUploadDescriptor): Promise<WebMercatorQuadCoverUpload> {
        if (!isWebMercatorQuadCover(input?.cover)) return invalidUpload('uninitialized', 'foreign-cover', {})
        if (typeof runtime?.createBuffer !== 'function' || typeof runtime.createSubmissionAuthority !== 'function')
            return invalidUpload('uninitialized', 'runtime', {})
        const cover = input.cover, facts = cover.facts()
        const owned: BufferResource[] = []
        try {
            // Sequential acquisition keeps every possible allocation failure local.
            for (const parity of [0, 1]) {
                for (const [name, size, binding] of [
                    ['mapMeta', gpuWebMercatorQuadCoverMapMetaCodec.byteLength(), 0x40],
                    ['patches', facts.policy.maximumPatches * 12, 0x80],
                    ['lookup', facts.lookupCapacity * 20, 0x80],
                ] as const) owned.push(await runtime.createBuffer({
                    label: `CPU WebMercatorQuad ${name} ${parity}`, size, usage: 0x08 | 0x04 | binding,
                }))
            }
            return new WebMercatorQuadCoverUpload(token, runtime, cover, owned)
        } catch (cause) {
            const failures: unknown[] = [cause]
            for (const resource of owned.reverse()) {
                try { resource.dispose() } catch (error) { failures.push(error) }
            }
            if (failures.length > 1) throw new AggregateError(failures, 'CPU cover upload creation and cleanup failed')
            throw cause
        }
    }

    get id(): string { return this.#id }
    get runtime(): GPURuntime { return this.#runtime }
    get isDisposed(): boolean { return this.#disposed }

    templates(): readonly WebMercatorQuadCoverUploadTemplate[] { return this.#templates }
    resources(): readonly BufferResource[] { return this.#resources }

    prepare(selection: WebMercatorQuadCoverSelection): WebMercatorQuadCoverUploadFrame {
        this.#assertActive()
        const data = webMercatorQuadCoverSelectionData(selection, this.#cover)
        for (const previous of this.#frames) {
            if (this.#wasIssued(previous) && previous.receipt === undefined)
                return invalidUpload(this.id, 'pending-receipt', { selectionId: previous.frame.selectionId })
        }
        const sequenceStamp = this.#sequenceAuthority.stamp()
        const parity = (sequenceStamp.revision & 1) as 0 | 1
        const template = this.#templates[parity]
        const entries: UploadEntry[] = []
        let viewStamp: SubmissionAuthorityStamp
        try {
            for (const [name, resource, bytes] of [
                ['mapMeta', template.mapMeta, data.mapMeta.slice()],
                ['patches', template.patches, data.patches.length ? data.patches.slice() : new Uint32Array(3)],
                ['coverLookup', template.coverLookup, data.lookup.slice()],
            ] as const) {
                const command = this.runtime.createUploadCommand({
                    label: `Upload CPU cover ${name} ${selection.id}`,
                    target: resource.region({ size: bytes.byteLength }), data: bytes,
                })
                entries.push({ name, resource, command, allocationVersion: resource.allocationVersion,
                    contentEpochBefore: resource.contentEpoch })
            }
            viewStamp = this.#viewAuthority.advance()
        } catch (cause) {
            for (const entry of entries) entry.command.dispose()
            throw cause
        }
        for (const previous of [...this.#frames]) this.#release(previous)
        const frame: WebMercatorQuadCoverUploadFrame = Object.freeze({
            kind: 'web-mercator-quad-cover-upload-frame', uploadId: this.id, coverId: selection.coverId,
            selectionId: selection.id, selectionRevision: selection.revision,
            frameEpoch: selection.view.frameEpoch, residencySnapshotEpoch: selection.view.residencySnapshotEpoch,
            parity, get isDisposed() { return record.disposed }, dispose: () => this.#release(record),
        })
        const record: FrameRecord = { owner: this, frame, viewId: selection.view.id,
            viewStamp, sequenceStamp, entries: Object.freeze(entries), disposed: false }
        frames.set(frame, record)
        this.#frames.add(record)
        return frame
    }

    encode(builder: SubmissionBuilder, frame: WebMercatorQuadCoverUploadFrame): SubmissionBuilder {
        this.#assertActive()
        const record = this.#record(frame)
        if (record.disposed || record.builder !== undefined || this.#builders.has(builder) ||
            builder?.runtime !== this.runtime || builder.isSubmitted ||
            record.viewStamp.revision !== this.#viewAuthority.revision ||
            record.sequenceStamp.revision !== this.#sequenceAuthority.revision)
            return invalidUpload(this.id, 'stale-or-encoded-frame', { selectionId: frame.selectionId })
        builder.require(record.viewStamp)
        builder.require(record.sequenceStamp)
        const sequence = appendSubmissionBuilderOpaqueSteps(builder, record.entries.map(entry => ({
            label: entry.command.label!, step: { kind: 'upload' as const, command: entry.command },
        })))
        builder.consume(record.sequenceStamp)
        record.builder = builder
        record.sequence = sequence
        this.#builders.add(builder)
        return builder
    }

    receipt(frame: WebMercatorQuadCoverUploadFrame, submitted: SubmittedWork): WebMercatorQuadCoverUploadReceipt {
        const record = this.#record(frame)
        if (record.receipt !== undefined && record.submitted === submitted) return record.receipt
        this.#assertActive()
        if (record.disposed || record.builder === undefined || record.sequence === undefined)
            return invalidUpload(this.id, 'unsubmitted-frame', { selectionId: frame.selectionId })
        try {
            // Invoke a frozen prototype getter to require the actual private
            // SubmittedWork brand, even for objects shadowing public properties.
            if (Reflect.get(SubmittedWork.prototype, 'runtime', submitted) !== this.runtime)
                return invalidUpload(this.id, 'receipt-mismatch', { selectionId: frame.selectionId })
            const lastUploadStep = record.sequence.firstStepIndex + record.entries.length - 1
            const resources = record.entries.map((entry, offset): WebMercatorQuadCoverUploadResourceFact => {
                const writes = submitted.resourceAccesses.filter(access => access.resourceId === entry.resource.id && access.access === 'write')
                const write = writes[0]
                const stepIndex = record.sequence!.firstStepIndex + offset
                const producer = submitted.producerEpochs.find(epoch => epoch.resourceId === entry.resource.id &&
                    epoch.producedBy.commandId === entry.command.id && epoch.producedBy.stepIndex === stepIndex)
                if (writes.length !== 1 || write?.commandId !== entry.command.id || write.stepIndex !== stepIndex ||
                    write.stepKind !== 'upload' || write.allocationVersion !== entry.allocationVersion ||
                    producer?.allocationVersion !== entry.allocationVersion || producer.contentEpoch !== write.contentEpochAfter ||
                    submitted.resourceAccesses.some(access => access.resourceId === entry.resource.id && access.access === 'read' &&
                        (access.stepIndex <= lastUploadStep || access.contentEpochBefore !== producer.contentEpoch ||
                            access.allocationVersion !== producer.allocationVersion)))
                    return invalidUpload(this.id, 'receipt-mismatch', { resourceId: entry.resource.id, commandId: entry.command.id })
                return Object.freeze({ name: entry.name, resourceId: entry.resource.id, commandId: entry.command.id,
                    allocationVersion: producer.allocationVersion, contentEpoch: producer.contentEpoch, stepIndex })
            })
            const receipt: WebMercatorQuadCoverUploadReceipt = Object.freeze({
                kind: 'web-mercator-quad-cover-upload-receipt', uploadId: this.id, coverId: frame.coverId,
                selectionId: frame.selectionId, selectionRevision: frame.selectionRevision,
                viewId: record.viewId, frameEpoch: frame.frameEpoch, residencySnapshotEpoch: frame.residencySnapshotEpoch,
                runtimeId: this.runtime.id, submissionId: submitted.id, parity: frame.parity,
                resources: Object.freeze(resources),
            })
            record.submitted = submitted
            record.receipt = receipt
            this.#acceptedReceiptCount++
            this.#release(record)
            return receipt
        } catch (cause) {
            this.#poisoned = this.#wasIssued(record)
            this.#release(record)
            if (isGeoDiagnosticError(cause)) throw cause
            throw new GeoDiagnosticError(createGeoDiagnostic({
                code: 'GEO_WEB_MERCATOR_COVER_UPLOAD_INVALID', phase: 'selection',
                subject: { kind: 'web-mercator-quad-cover-upload', id: this.id },
                message: 'CPU cover submission receipt could not be authenticated.',
                actual: { reason: 'receipt-mismatch', selectionId: frame.selectionId },
            }), { cause })
        }
    }

    facts(): WebMercatorQuadCoverUploadFacts {
        return Object.freeze({ id: this.id, runtimeId: this.runtime.id, coverId: this.#cover.id,
            disposed: this.#disposed, poisoned: this.#poisoned, preparedFrameCount: this.#frames.size,
            acceptedReceiptCount: this.#acceptedReceiptCount,
            persistentBufferBytes: this.#resources.reduce((sum, resource) => sum + (resource.isDisposed ? 0 : resource.size), 0),
            parity: Object.freeze(this.#templates.map(t => Object.freeze({ parity: t.parity,
                mapMetaBufferId: t.mapMeta.id, patchBufferId: t.patches.id, lookupBufferId: t.coverLookup.id }))) })
    }

    dispose(): void {
        if (this.#disposed) return
        this.#disposed = true
        const failures: unknown[] = []
        for (const record of [...this.#frames]) {
            try { this.#release(record) } catch (error) { failures.push(error) }
        }
        for (const resource of [...this.#resources].reverse()) {
            try { resource.dispose() } catch (error) { failures.push(error) }
        }
        this.#viewAuthority.dispose()
        this.#sequenceAuthority.dispose()
        if (failures.length) throw new AggregateError(failures, 'CPU cover upload disposal failed')
    }

    #record(frame: WebMercatorQuadCoverUploadFrame): FrameRecord {
        const record = frames.get(frame)
        if (record?.owner !== this) return invalidUpload(this.id, 'foreign-frame', {})
        return record
    }

    #release(record: FrameRecord): void {
        if (record.disposed) return
        if (this.#wasIssued(record) && record.receipt === undefined) this.#poisoned = true
        record.disposed = true
        this.#frames.delete(record)
        for (const entry of record.entries) entry.command.dispose()
        record.entries = []
    }

    #assertActive(): void {
        if (this.#disposed || this.#poisoned) invalidUpload(this.id, this.#disposed ? 'disposed' : 'poisoned', {})
        if (this.runtime.isDisposed || this.runtime.isDeviceLost)
            invalidUpload(this.id, 'runtime', { disposed: this.runtime.isDisposed, deviceLost: this.runtime.isDeviceLost })
    }

    #wasIssued(record: FrameRecord): boolean {
        return record.builder !== undefined && (record.builder.isSubmitted ||
            this.#sequenceAuthority.revision !== record.sequenceStamp.revision ||
            record.entries.some(entry => entry.resource.contentEpoch !== entry.contentEpochBefore))
    }
}

Object.freeze(WebMercatorQuadCoverUpload.prototype)

function invalidUpload(id: string, reason: string, actual: Record<string, unknown>): never {
    return throwGeoDiagnostic({ code: 'GEO_WEB_MERCATOR_COVER_UPLOAD_INVALID', phase: 'selection',
        subject: { kind: 'web-mercator-quad-cover-upload', id },
        message: 'CPU cover upload requires a current owned attempt and its complete submission receipt.',
        actual: { reason, ...actual } })
}
