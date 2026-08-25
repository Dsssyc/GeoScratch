import type {
    BufferResource,
    GPURuntime,
    SubmissionBuilder,
    SubmittedWork,
    TextureResource,
    TextureUploadCommand,
    TextureViewSpec,
    UploadCommand,
} from '../scratch/index.js'
import { throwGeoDiagnostic } from './diagnostics.js'
import { uploadPagesForPublication } from './virtual-raster-residency.js'
import type { VirtualRasterPublication } from './virtual-raster-residency.js'
import { physicalPagesForSnapshot } from './virtual-raster.js'
import type {
    VirtualRasterAddressSpace,
    VirtualRasterPlane,
    VirtualRasterSnapshot,
} from './virtual-raster.js'

export type VirtualRasterGpuStateDescriptor = Readonly<{
    addressSpace: VirtualRasterAddressSpace
    plane: VirtualRasterPlane
    maxPhysicalPages: number
}>

export type VirtualRasterGpuUpdate = Readonly<{
    snapshotEpoch: number
    commands: readonly (TextureUploadCommand | UploadCommand)[]
    atlasUploads: readonly TextureUploadCommand[]
    pageTableUpload?: UploadCommand
    slotTableUpload?: UploadCommand
}>

export type VirtualRasterGpuFacts = Readonly<{
    snapshotEpoch: number
    acknowledgementSerial: number
    stagedSnapshotEpoch?: number
    maxPhysicalPages: number
    atlasWidth: number
    atlasHeight: number
    atlasColumns: number
    atlasRows: number
    pageTableEntryCount: number
    pageTableBytes: number
    slotTableBytes: number
}>

const BUFFER_COPY_DST = 0x08
const BUFFER_STORAGE = 0x80
const TEXTURE_COPY_DST = 0x02
const TEXTURE_BINDING = 0x04
const PAGE_TABLE_WORDS = 8
const SLOT_TABLE_WORDS = 12
const SLOT_INVALID = 0xffff_ffff

const residencySubmissionAuthorities = new WeakMap<
    VirtualRasterGpuState,
    ReturnType<GPURuntime['createSubmissionAuthority']>
>()
const updateOwners = new WeakMap<VirtualRasterGpuUpdate, VirtualRasterGpuState>()
const encodedUpdates = new WeakMap<
    SubmissionBuilder,
    Map<VirtualRasterGpuState, number>
>()
const submittedUpdates = new WeakMap<
    VirtualRasterGpuState,
    Readonly<{ snapshotEpoch: number; submitted: SubmittedWork }>
>()

/** Owns the finite atlas and mapping buffers that publish coherent Virtual Raster snapshots. */
export class VirtualRasterGpuState {

    readonly runtime: GPURuntime
    readonly addressSpace: VirtualRasterAddressSpace
    readonly plane: VirtualRasterPlane
    readonly maxPhysicalPages: number
    readonly atlas: TextureResource
    readonly atlasView: TextureViewSpec
    readonly pageTable: BufferResource
    readonly slotTable: BufferResource
    readonly atlasColumns: number
    readonly atlasRows: number
    readonly atlasWidth: number
    readonly atlasHeight: number
    readonly #pageTableWords: Uint32Array<ArrayBuffer>
    readonly #pageTableUpload: UploadCommand
    readonly #slotTableWords: Uint32Array<ArrayBuffer>
    readonly #slotTableUpload: UploadCommand
    #disposed = false
    #acknowledgedSnapshotEpoch = -1
    #acknowledgementSerial = 0
    #acknowledgedSnapshot: VirtualRasterSnapshot | undefined
    #stagedSnapshotEpoch: number | undefined
    #stagedSlotGenerations = new Map<number, number>()
    #uploadedSlotGenerations = new Map<number, number>()
    #stagedAtlasUploads: TextureUploadCommand[] = []
    #stagedCommandIds = new Set<string>()
    #stagedPublication: VirtualRasterPublication | undefined
    #settlingPublication: VirtualRasterPublication | undefined

    private constructor(
        runtime: GPURuntime,
        descriptor: VirtualRasterGpuStateDescriptor,
        atlas: TextureResource,
        pageTable: BufferResource,
        slotTable: BufferResource,
        pageTableWords: Uint32Array<ArrayBuffer>,
        pageTableUpload: UploadCommand,
        slotTableWords: Uint32Array<ArrayBuffer>,
        slotTableUpload: UploadCommand,
        atlasColumns: number,
        atlasRows: number
    ) {

        this.runtime = runtime
        this.addressSpace = descriptor.addressSpace
        this.plane = descriptor.plane
        this.maxPhysicalPages = descriptor.maxPhysicalPages
        this.atlas = atlas
        this.atlasView = atlas.view()
        this.pageTable = pageTable
        this.slotTable = slotTable
        this.#pageTableWords = pageTableWords
        this.#pageTableUpload = pageTableUpload
        this.#slotTableWords = slotTableWords
        this.#slotTableUpload = slotTableUpload
        this.atlasColumns = atlasColumns
        this.atlasRows = atlasRows
        this.atlasWidth = descriptor.addressSpace.pageSize[0]! * atlasColumns
        this.atlasHeight = descriptor.addressSpace.pageSize[1]! * atlasRows
        residencySubmissionAuthorities.set(this, runtime.createSubmissionAuthority({
            label: `${descriptor.addressSpace.id} residency publication`,
        }))
    }

    static async create(
        runtime: GPURuntime,
        descriptor: VirtualRasterGpuStateDescriptor
    ): Promise<VirtualRasterGpuState> {

        if (descriptor.addressSpace.dimensions !== 2 ||
            descriptor.plane.addressSpace !== descriptor.addressSpace ||
            !Number.isSafeInteger(descriptor.maxPhysicalPages) || descriptor.maxPhysicalPages <= 0) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_GPU_STATE_INVALID',
                phase: 'residency',
                subject: { kind: 'virtual-raster-gpu-state', id: descriptor.addressSpace.id },
                message: 'Virtual raster GPU state requires a 2D plane and a positive physical-page budget.',
                expected: { dimensions: 2, maxPhysicalPages: 'positive integer' },
                actual: descriptor,
            })
        }
        const atlasColumns = Math.ceil(Math.sqrt(descriptor.maxPhysicalPages))
        const atlasRows = Math.ceil(descriptor.maxPhysicalPages / atlasColumns)
        const atlas = await runtime.createTexture({
            label: `${descriptor.plane.id} virtual raster atlas`,
            size: {
                width: descriptor.addressSpace.pageSize[0]! * atlasColumns,
                height: descriptor.addressSpace.pageSize[1]! * atlasRows,
            },
            format: descriptor.plane.gpuFormat,
            usage: TEXTURE_COPY_DST | TEXTURE_BINDING,
        })
        let pageTable: BufferResource
        try {
            pageTable = await runtime.createBuffer({
                label: `${descriptor.plane.id} virtual raster page table`,
                size: descriptor.addressSpace.pageTableEntryCount * PAGE_TABLE_WORDS * 4,
                usage: BUFFER_COPY_DST | BUFFER_STORAGE,
            })
        } catch (error) {
            atlas.dispose()
            throw error
        }
        let slotTable: BufferResource
        try {
            slotTable = await runtime.createBuffer({
                label: `${descriptor.plane.id} virtual raster slot table`,
                size: descriptor.maxPhysicalPages * SLOT_TABLE_WORDS * 4,
                usage: BUFFER_COPY_DST | BUFFER_STORAGE,
            })
        } catch (error) {
            pageTable.dispose()
            atlas.dispose()
            throw error
        }
        const pageTableWords = new Uint32Array(
            descriptor.addressSpace.pageTableEntryCount * PAGE_TABLE_WORDS
        )
        const slotTableWords = new Uint32Array(descriptor.maxPhysicalPages * SLOT_TABLE_WORDS)
        const pageTableUpload = runtime.createUploadCommand({
            label: `${descriptor.plane.id} virtual raster page-table upload`,
            target: pageTable.region(),
            data: pageTableWords,
        })
        const slotTableUpload = runtime.createUploadCommand({
            label: `${descriptor.plane.id} virtual raster slot-table upload`,
            target: slotTable.region(),
            data: slotTableWords,
        })
        return new VirtualRasterGpuState(
            runtime,
            descriptor,
            atlas,
            pageTable,
            slotTable,
            pageTableWords,
            pageTableUpload,
            slotTableWords,
            slotTableUpload,
            atlasColumns,
            atlasRows
        )
    }

    stage(publication: VirtualRasterPublication): VirtualRasterGpuUpdate {

        this.#assertActive()
        const snapshot = publication.snapshot
        if (snapshot.addressSpace !== this.addressSpace) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_SNAPSHOT_MISMATCH',
                phase: 'residency',
                subject: { kind: 'virtual-raster-gpu-state', id: this.addressSpace.id },
                message: 'GPU state can only stage snapshots from its own address space.',
                expected: { addressSpaceId: this.addressSpace.id },
                actual: { addressSpaceId: snapshot.addressSpace.id },
            })
        }
        if (this.#stagedPublication !== undefined) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_GPU_PUBLICATION_PENDING',
                phase: 'residency',
                subject: { kind: 'virtual-raster-gpu-state', id: this.addressSpace.id },
                message: 'The staged publication must be acknowledged or abandoned before staging another.',
                expected: { stagedSnapshotEpoch: this.#stagedSnapshotEpoch },
                actual: { snapshotEpoch: snapshot.epoch },
            })
        }
        const publicationUploads = uploadPagesForPublication(publication)
        if (snapshot.epoch === this.#acknowledgedSnapshotEpoch) {
            if (publicationUploads.length > 0) {
                return throwGeoDiagnostic({
                    code: 'GEO_VIRTUAL_RASTER_GPU_STATE_INVALID',
                    phase: 'residency',
                    subject: { kind: 'virtual-raster-gpu-state', id: this.addressSpace.id },
                    message: 'An acknowledged snapshot epoch cannot introduce new upload payloads.',
                    actual: { snapshotEpoch: snapshot.epoch, uploadPageCount: publicationUploads.length },
                })
            }
            this.#stagedSnapshotEpoch = snapshot.epoch
            this.#stagedSlotGenerations = new Map(this.#uploadedSlotGenerations)
            this.#stagedPublication = publication
            const update = Object.freeze({
                snapshotEpoch: snapshot.epoch,
                commands: Object.freeze([]),
                atlasUploads: Object.freeze([]),
            })
            updateOwners.set(update, this)
            return update
        }
        const physicalPages = physicalPagesForSnapshot(snapshot)
        const atlasUploads: TextureUploadCommand[] = []
        const stagedGenerations = new Map<number, number>()
        const uploadsBySlot = new Map(publicationUploads.map(upload => [
            upload.facts.physicalSlot,
            upload,
        ]))
        try {
            for (const [ slot, physical ] of [ ...physicalPages.entries() ].sort((a, b) => a[0] - b[0])) {
                if (slot < 0 || slot >= this.maxPhysicalPages) {
                    return throwGeoDiagnostic({
                        code: 'GEO_VIRTUAL_RASTER_GPU_STATE_INVALID',
                        phase: 'residency',
                        subject: { kind: 'virtual-raster-gpu-state', id: this.addressSpace.id },
                        message: 'Snapshot physical slot exceeds the GPU atlas budget.',
                        expected: { maximumSlot: this.maxPhysicalPages - 1 },
                        actual: { slot },
                    })
                }
                stagedGenerations.set(slot, physical.generation)
                if (this.#uploadedSlotGenerations.get(slot) === physical.generation) continue
                const upload = uploadsBySlot.get(slot)
                if (upload === undefined ||
                    upload.facts.generation !== physical.generation ||
                    upload.facts.page.key !== physical.page.key) {
                    return throwGeoDiagnostic({
                        code: 'GEO_VIRTUAL_RASTER_UPLOAD_BYTES_UNAVAILABLE',
                        phase: 'residency',
                        subject: { kind: 'virtual-raster-page', id: physical.page.key },
                        message: 'A changed GPU slot requires matching bytes from the same publication.',
                        expected: { slot, generation: physical.generation },
                        actual: upload?.facts,
                    })
                }
                const slotX = slot % this.atlasColumns
                const slotY = Math.floor(slot / this.atlasColumns)
                const stagedData = upload.payload.data.slice()
                atlasUploads.push(this.runtime.createTextureUploadCommand({
                    label: `${this.plane.id} page ${physical.page.key} slot ${slot}`,
                    target: this.atlas,
                    data: stagedData,
                    layout: {
                        bytesPerRow: stagedData.byteLength / upload.payload.height,
                        rowsPerImage: upload.payload.height,
                    },
                    size: {
                        width: upload.payload.width,
                        height: upload.payload.height,
                    },
                    origin: {
                        x: slotX * this.addressSpace.pageSize[0]!,
                        y: slotY * this.addressSpace.pageSize[1]!,
                    },
                }))
            }
        } catch (error) {
            for (const upload of atlasUploads) upload.dispose()
            throw error
        }
        this.#encodePageTable(snapshot)
        encodeSlotTable(this.#slotTableWords, snapshot, this.maxPhysicalPages)
        this.#stagedSnapshotEpoch = snapshot.epoch
        this.#stagedSlotGenerations = stagedGenerations
        this.#stagedAtlasUploads = [ ...atlasUploads ]
        this.#stagedCommandIds = new Set(
            [ ...atlasUploads, this.#pageTableUpload, this.#slotTableUpload ].map(command => command.id)
        )
        this.#stagedPublication = publication
        const update = Object.freeze({
            snapshotEpoch: snapshot.epoch,
            commands: Object.freeze([ ...atlasUploads, this.#pageTableUpload, this.#slotTableUpload ]),
            atlasUploads: Object.freeze(atlasUploads),
            pageTableUpload: this.#pageTableUpload,
            slotTableUpload: this.#slotTableUpload,
        })
        updateOwners.set(update, this)
        return update
    }

    /** Appends one owned staged update before dependent work in the same submission. */
    encode(builder: SubmissionBuilder, update: VirtualRasterGpuUpdate): SubmissionBuilder {

        this.#assertActive()
        const encoded = encodedUpdates.get(builder)
        if (builder?.runtime !== this.runtime || builder.isSubmitted ||
            updateOwners.get(update) !== this ||
            update.snapshotEpoch !== this.#stagedSnapshotEpoch || encoded?.has(this)) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_GPU_UPDATE_INVALID',
                phase: 'residency',
                subject: { kind: 'virtual-raster-gpu-state', id: this.addressSpace.id },
                message: 'A staged Virtual Raster GPU update can be encoded once into an owned open submission.',
                expected: {
                    runtimeId: this.runtime.id,
                    stagedSnapshotEpoch: this.#stagedSnapshotEpoch,
                    encodedOnce: false,
                },
                actual: {
                    runtimeId: builder?.runtime?.id,
                    snapshotEpoch: update?.snapshotEpoch,
                    submitted: builder?.isSubmitted,
                    owned: updateOwners.get(update) === this,
                    encoded: encoded?.has(this) ?? false,
                },
            })
        }
        for (const command of update.commands) builder.upload(command)
        const byState = encoded ?? new Map<VirtualRasterGpuState, number>()
        byState.set(this, update.snapshotEpoch)
        if (encoded === undefined) encodedUpdates.set(builder, byState)
        return builder
    }

    async acknowledge(publication: VirtualRasterPublication, submitted: SubmittedWork): Promise<void> {

        this.#assertActive()
        if (this.#settlingPublication !== undefined) {
            return this.#publicationPending(publication)
        }
        const snapshot = publication.snapshot
        if (snapshot.addressSpace !== this.addressSpace ||
            this.#stagedPublication !== publication ||
            this.#stagedSnapshotEpoch !== snapshot.epoch ||
            submitted.runtime !== this.runtime) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_SNAPSHOT_MISMATCH',
                phase: 'residency',
                subject: { kind: 'virtual-raster-gpu-state', id: this.addressSpace.id },
                message: 'Only the currently staged snapshot can be acknowledged.',
                expected: {
                    stagedSnapshotEpoch: this.#stagedSnapshotEpoch,
                    runtimeId: this.runtime.id,
                },
                actual: {
                    snapshotEpoch: snapshot.epoch,
                    runtimeId: submitted.runtime?.id,
                },
            })
        }
        this.#settlingPublication = publication
        let settlementAttempted = false
        const uploadedSlotGenerations = new Map(this.#stagedSlotGenerations)
        const submissionAuthority = residencySubmissionAuthorityFor(this)
        try {
            const submittedCommandIds = new Set(
                submitted.resourceAccesses
                    .filter(access => access.stepKind === 'upload')
                    .map(access => access.commandId)
                    .filter((id): id is string => id !== undefined)
            )
            const missingCommandIds = [ ...this.#stagedCommandIds ]
                .filter(commandId => !submittedCommandIds.has(commandId))
            if (missingCommandIds.length > 0) {
                return throwGeoDiagnostic({
                    code: 'GEO_VIRTUAL_RASTER_UPLOAD_NOT_SUBMITTED',
                    phase: 'residency',
                    subject: { kind: 'virtual-raster-publication', id: String(snapshot.epoch) },
                    message: 'Publication acknowledgement requires SubmittedWork containing every staged upload.',
                    expected: { commandIds: Object.freeze([ ...this.#stagedCommandIds ]) },
                    actual: { missingCommandIds: Object.freeze(missingCommandIds) },
                })
            }
            const submittedUpdate = Object.freeze({
                snapshotEpoch: snapshot.epoch,
                submitted,
            })
            submittedUpdates.set(this, submittedUpdate)
            if (this.#stagedCommandIds.size > 0) {
                const nativeOutcome = await submitted.nativeOutcome
                this.#assertStagedPublication(publication)
                if (nativeOutcome.status !== 'observed-succeeded') {
                    return throwGeoDiagnostic({
                        code: 'GEO_VIRTUAL_RASTER_GPU_PUBLICATION_NATIVE_OUTCOME_FAILED',
                        phase: 'residency',
                        subject: { kind: 'virtual-raster-publication', id: String(snapshot.epoch) },
                        message: 'Publication acknowledgement requires a successful native outcome for its staged work.',
                        expected: { nativeOutcome: 'observed-succeeded' },
                        actual: {
                            submissionId: submitted.id,
                            snapshotEpoch: snapshot.epoch,
                            nativeOutcome: nativeOutcome.status,
                        },
                    })
                }
            }
            this.#assertStagedPublication(publication)
            submissionAuthority.stamp()
            settlementAttempted = true
            await publication.acknowledge()
            this.#assertStagedPublication(publication)
            if (publication.inspect().state !== 'acknowledged') {
                return throwGeoDiagnostic({
                    code: 'GEO_VIRTUAL_RASTER_PUBLICATION_INVALID',
                    phase: 'residency',
                    subject: { kind: 'virtual-raster-publication', id: String(snapshot.epoch) },
                    message: 'GPU publication authority requires an acknowledged residency settlement.',
                    expected: { state: 'acknowledged' },
                    actual: publication.inspect(),
                })
            }
            submissionAuthority.advance()
            this.#clearStagedPublication()
            this.#acknowledgedSnapshotEpoch = snapshot.epoch
            this.#acknowledgedSnapshot = snapshot
            this.#acknowledgementSerial++
            this.#uploadedSlotGenerations = uploadedSlotGenerations
        } catch (error) {
            if (settlementAttempted && this.#stagedPublication === publication) {
                this.#clearStagedPublication()
            }
            throw error
        } finally {
            if (submittedUpdates.get(this)?.submitted === submitted) {
                submittedUpdates.delete(this)
            }
            if (this.#settlingPublication === publication) {
                this.#settlingPublication = undefined
            }
        }
    }

    async abandon(publication: VirtualRasterPublication): Promise<void> {

        this.#assertActive()
        if (this.#settlingPublication !== undefined) {
            return this.#publicationPending(publication)
        }
        if (this.#stagedPublication !== publication) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_SNAPSHOT_MISMATCH',
                phase: 'residency',
                subject: { kind: 'virtual-raster-gpu-state', id: this.addressSpace.id },
                message: 'Only the currently staged publication can be abandoned.',
                expected: { stagedSnapshotEpoch: this.#stagedSnapshotEpoch },
                actual: { snapshotEpoch: publication.snapshot.epoch },
            })
        }
        this.#settlingPublication = publication
        try {
            await publication.abandon()
            this.#assertStagedPublication(publication)
            this.#clearStagedPublication()
        } finally {
            if (this.#settlingPublication === publication) {
                this.#settlingPublication = undefined
            }
        }
    }

    facts(): VirtualRasterGpuFacts {

        const facts: {
            snapshotEpoch: number
            acknowledgementSerial: number
            stagedSnapshotEpoch?: number
            maxPhysicalPages: number
            atlasWidth: number
            atlasHeight: number
            atlasColumns: number
            atlasRows: number
            pageTableEntryCount: number
            pageTableBytes: number
            slotTableBytes: number
        } = {
            snapshotEpoch: this.#acknowledgedSnapshotEpoch,
            acknowledgementSerial: this.#acknowledgementSerial,
            maxPhysicalPages: this.maxPhysicalPages,
            atlasWidth: this.atlasWidth,
            atlasHeight: this.atlasHeight,
            atlasColumns: this.atlasColumns,
            atlasRows: this.atlasRows,
            pageTableEntryCount: this.addressSpace.pageTableEntryCount,
            pageTableBytes: this.#pageTableWords.byteLength,
            slotTableBytes: this.#slotTableWords.byteLength,
        }
        if (this.#stagedSnapshotEpoch !== undefined) {
            facts.stagedSnapshotEpoch = this.#stagedSnapshotEpoch
        }
        return Object.freeze(facts)
    }

    acknowledges(snapshot: VirtualRasterSnapshot): boolean {

        this.#assertActive()
        return this.#acknowledgedSnapshot === snapshot
    }

    dispose(): void {

        if (this.#disposed) return
        this.#disposed = true
        this.#pageTableUpload.dispose()
        this.#slotTableUpload.dispose()
        this.pageTable.dispose()
        this.slotTable.dispose()
        this.atlas.dispose()
        this.#stagedSlotGenerations.clear()
        this.#uploadedSlotGenerations.clear()
        this.#stagedCommandIds.clear()
        this.#settlingPublication = undefined
        this.#stagedPublication = undefined
        this.#acknowledgedSnapshot = undefined
        this.#releaseStagedAtlasUploads()
        residencySubmissionAuthorityFor(this).dispose()
    }

    #encodePageTable(snapshot: VirtualRasterSnapshot): void {

        this.#pageTableWords.fill(0)
        for (const entry of snapshot.pageTable) {
            const tableIndex = this.addressSpace.tableIndex(entry.requestedPage)
            const base = tableIndex * PAGE_TABLE_WORDS
            if (entry.status === 'failed') {
                this.#pageTableWords[base] = SLOT_INVALID
                this.#pageTableWords[base + 1] = SLOT_INVALID
                this.#pageTableWords[base + 2] = entry.resolvedLevel ?? entry.requestedLevel
                this.#pageTableWords[base + 3] = 4
                this.#pageTableWords[base + 4] = entry.generation ?? 0
                this.#pageTableWords[base + 5] = entry.contentEpoch ?? 0
                this.#pageTableWords[base + 6] = entry.requestedLevel
                this.#pageTableWords[base + 7] = snapshot.epoch
                continue
            }
            if (entry.physicalSlot === undefined || entry.resolvedLevel === undefined) continue
            const slotX = entry.physicalSlot % this.atlasColumns
            const slotY = Math.floor(entry.physicalSlot / this.atlasColumns)
            this.#pageTableWords[base] = slotX
            this.#pageTableWords[base + 1] = slotY
            this.#pageTableWords[base + 2] = entry.resolvedLevel
            this.#pageTableWords[base + 3] = entry.status === 'resident' ? 1 : 2
            this.#pageTableWords[base + 4] = entry.generation ?? 0
            this.#pageTableWords[base + 5] = entry.contentEpoch ?? 0
            this.#pageTableWords[base + 6] = entry.requestedLevel
            this.#pageTableWords[base + 7] = snapshot.epoch
        }
    }

    #assertActive(): void {

        if (this.#disposed) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_GPU_STATE_DISPOSED',
                phase: 'residency',
                subject: { kind: 'virtual-raster-gpu-state', id: this.addressSpace.id },
                message: 'Virtual raster GPU state is disposed.',
            })
        }
    }

    #assertStagedPublication(publication: VirtualRasterPublication): void {

        this.#assertActive()
        if (this.#stagedPublication === publication &&
            this.#settlingPublication === publication &&
            this.#stagedSnapshotEpoch === publication.snapshot.epoch) return
        return throwGeoDiagnostic({
            code: 'GEO_VIRTUAL_RASTER_SNAPSHOT_MISMATCH',
            phase: 'residency',
            subject: { kind: 'virtual-raster-gpu-state', id: this.addressSpace.id },
            message: 'Staged GPU publication identity changed before acknowledgement commit.',
            expected: { snapshotEpoch: publication.snapshot.epoch },
            actual: {
                stagedSnapshotEpoch: this.#stagedSnapshotEpoch,
                settling: this.#settlingPublication === publication,
            },
        })
    }

    #publicationPending(publication: VirtualRasterPublication): never {

        return throwGeoDiagnostic({
            code: 'GEO_VIRTUAL_RASTER_GPU_PUBLICATION_PENDING',
            phase: 'residency',
            subject: { kind: 'virtual-raster-gpu-state', id: this.addressSpace.id },
            message: 'GPU publication settlement is already in progress.',
            expected: { settlingSnapshotEpoch: this.#settlingPublication?.snapshot.epoch },
            actual: { snapshotEpoch: publication.snapshot.epoch },
        })
    }

    #clearStagedPublication(): void {

        this.#stagedSnapshotEpoch = undefined
        this.#stagedPublication = undefined
        this.#stagedSlotGenerations.clear()
        this.#stagedCommandIds.clear()
        this.#releaseStagedAtlasUploads()
    }

    #releaseStagedAtlasUploads(): void {

        for (const upload of this.#stagedAtlasUploads) upload.dispose()
        this.#stagedAtlasUploads.length = 0
    }
}

function residencySubmissionAuthorityFor(
    gpuState: VirtualRasterGpuState
): ReturnType<GPURuntime['createSubmissionAuthority']> {

    const authority = residencySubmissionAuthorities.get(gpuState)
    if (authority === undefined) throw new TypeError('Virtual Raster residency authority is unavailable.')
    return authority
}

function encodeSlotTable(
    target: Uint32Array<ArrayBuffer>,
    snapshot: VirtualRasterSnapshot,
    maxPhysicalPages: number
): void {

    target.fill(0)
    const coverage = snapshot.addressSpace.tileCoverage
    for (const [ slot, physical ] of [ ...physicalPagesForSnapshot(snapshot).entries() ]
        .sort((a, b) => a[0] - b[0])) {
        if (slot < 0 || slot >= maxPhysicalPages) {
            throw new RangeError('Virtual raster physical slot exceeds the slot-table capacity.')
        }
        const base = slot * SLOT_TABLE_WORDS
        const tile = physical.page.tile
        target[base] = 1
        target[base + 1] = physical.page.level
        target[base + 2] = tile === undefined || coverage === undefined
            ? SLOT_INVALID
            : coverage.tileMatrixSet.tileMatrices.findIndex(matrix => matrix.id === tile.matrixId)
        target[base + 3] = tile?.tileRow ?? SLOT_INVALID
        target[base + 4] = tile?.tileCol ?? SLOT_INVALID
        target[base + 5] = tile === undefined || coverage === undefined
            ? SLOT_INVALID
            : coverage.index(tile)
        target[base + 6] = physical.physicalSlot
        target[base + 7] = physical.generation
        target[base + 8] = physical.contentEpoch
        target[base + 9] = snapshot.epoch
        target[base + 10] = snapshot.epoch
        target[base + 11] = 0
    }
}

/** Asynchronously allocates GPU residency state for one address space and physical plane. */
export function createVirtualRasterGpuState(
    runtime: GPURuntime,
    descriptor: VirtualRasterGpuStateDescriptor
): Promise<VirtualRasterGpuState> {

    return VirtualRasterGpuState.create(runtime, descriptor)
}
