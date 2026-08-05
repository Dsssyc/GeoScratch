import type { BufferResource } from '../scratch/buffer.js'
import type { TextureUploadCommand, UploadCommand } from '../scratch/command.js'
import type { ScratchRuntime } from '../scratch/runtime.js'
import type { SubmittedWork } from '../scratch/submission.js'
import type { TextureResource, TextureViewSpec } from '../scratch/texture.js'
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
}>

export type VirtualRasterGpuFacts = Readonly<{
    snapshotEpoch: number
    stagedSnapshotEpoch?: number
    maxPhysicalPages: number
    atlasWidth: number
    atlasHeight: number
    atlasColumns: number
    atlasRows: number
    pageTableEntryCount: number
    pageTableBytes: number
}>

const BUFFER_COPY_DST = 0x08
const BUFFER_STORAGE = 0x80
const TEXTURE_COPY_DST = 0x02
const TEXTURE_BINDING = 0x04
const PAGE_TABLE_WORDS = 8

export class VirtualRasterGpuState {

    readonly runtime: ScratchRuntime
    readonly addressSpace: VirtualRasterAddressSpace
    readonly plane: VirtualRasterPlane
    readonly maxPhysicalPages: number
    readonly atlas: TextureResource
    readonly atlasView: TextureViewSpec
    readonly pageTable: BufferResource
    readonly atlasColumns: number
    readonly atlasRows: number
    readonly atlasWidth: number
    readonly atlasHeight: number
    readonly #pageTableWords: Uint32Array<ArrayBuffer>
    readonly #pageTableUpload: UploadCommand
    #disposed = false
    #acknowledgedSnapshotEpoch = -1
    #stagedSnapshotEpoch: number | undefined
    #stagedSlotGenerations = new Map<number, number>()
    #uploadedSlotGenerations = new Map<number, number>()
    #stagedAtlasUploads: TextureUploadCommand[] = []
    #stagedCommandIds = new Set<string>()
    #stagedPublication: VirtualRasterPublication | undefined

    private constructor(
        runtime: ScratchRuntime,
        descriptor: VirtualRasterGpuStateDescriptor,
        atlas: TextureResource,
        pageTable: BufferResource,
        pageTableWords: Uint32Array<ArrayBuffer>,
        pageTableUpload: UploadCommand,
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
        this.#pageTableWords = pageTableWords
        this.#pageTableUpload = pageTableUpload
        this.atlasColumns = atlasColumns
        this.atlasRows = atlasRows
        this.atlasWidth = descriptor.addressSpace.pageSize[0]! * atlasColumns
        this.atlasHeight = descriptor.addressSpace.pageSize[1]! * atlasRows
    }

    static async create(
        runtime: ScratchRuntime,
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
        const pageTableWords = new Uint32Array(
            descriptor.addressSpace.pageTableEntryCount * PAGE_TABLE_WORDS
        )
        const pageTableUpload = runtime.createUploadCommand({
            label: `${descriptor.plane.id} virtual raster page-table upload`,
            target: pageTable.region(),
            data: pageTableWords,
        })
        return new VirtualRasterGpuState(
            runtime,
            descriptor,
            atlas,
            pageTable,
            pageTableWords,
            pageTableUpload,
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
            this.#stagedPublication = publication
            return Object.freeze({
                snapshotEpoch: snapshot.epoch,
                commands: Object.freeze([]),
                atlasUploads: Object.freeze([]),
            })
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
                atlasUploads.push(this.runtime.createTextureUploadCommand({
                    label: `${this.plane.id} page ${physical.page.key} slot ${slot}`,
                    target: this.atlas,
                    data: upload.payload.data,
                    layout: {
                        bytesPerRow: upload.payload.data.byteLength / upload.payload.height,
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
        this.#stagedSnapshotEpoch = snapshot.epoch
        this.#stagedSlotGenerations = stagedGenerations
        this.#stagedAtlasUploads = [ ...atlasUploads ]
        this.#stagedCommandIds = new Set([ ...atlasUploads, this.#pageTableUpload ].map(command => command.id))
        this.#stagedPublication = publication
        return Object.freeze({
            snapshotEpoch: snapshot.epoch,
            commands: Object.freeze([ ...atlasUploads, this.#pageTableUpload ]),
            atlasUploads: Object.freeze(atlasUploads),
            pageTableUpload: this.#pageTableUpload,
        })
    }

    async acknowledge(publication: VirtualRasterPublication, submitted: SubmittedWork): Promise<void> {

        this.#assertActive()
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
        this.#acknowledgedSnapshotEpoch = snapshot.epoch
        this.#uploadedSlotGenerations = new Map(this.#stagedSlotGenerations)
        this.#stagedSnapshotEpoch = undefined
        this.#stagedPublication = undefined
        this.#stagedSlotGenerations.clear()
        this.#stagedCommandIds.clear()
        this.#releaseStagedAtlasUploads()
        await publication.acknowledge()
    }

    async abandon(publication: VirtualRasterPublication): Promise<void> {

        this.#assertActive()
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
        this.#stagedSnapshotEpoch = undefined
        this.#stagedPublication = undefined
        this.#stagedSlotGenerations.clear()
        this.#stagedCommandIds.clear()
        this.#releaseStagedAtlasUploads()
        await publication.abandon()
    }

    facts(): VirtualRasterGpuFacts {

        const facts: {
            snapshotEpoch: number
            stagedSnapshotEpoch?: number
            maxPhysicalPages: number
            atlasWidth: number
            atlasHeight: number
            atlasColumns: number
            atlasRows: number
            pageTableEntryCount: number
            pageTableBytes: number
        } = {
            snapshotEpoch: this.#acknowledgedSnapshotEpoch,
            maxPhysicalPages: this.maxPhysicalPages,
            atlasWidth: this.atlasWidth,
            atlasHeight: this.atlasHeight,
            atlasColumns: this.atlasColumns,
            atlasRows: this.atlasRows,
            pageTableEntryCount: this.addressSpace.pageTableEntryCount,
            pageTableBytes: this.#pageTableWords.byteLength,
        }
        if (this.#stagedSnapshotEpoch !== undefined) {
            facts.stagedSnapshotEpoch = this.#stagedSnapshotEpoch
        }
        return Object.freeze(facts)
    }

    dispose(): void {

        if (this.#disposed) return
        this.#disposed = true
        this.#pageTableUpload.dispose()
        this.pageTable.dispose()
        this.atlas.dispose()
        this.#stagedSlotGenerations.clear()
        this.#uploadedSlotGenerations.clear()
        this.#stagedCommandIds.clear()
        this.#stagedPublication = undefined
        this.#releaseStagedAtlasUploads()
    }

    #encodePageTable(snapshot: VirtualRasterSnapshot): void {

        this.#pageTableWords.fill(0)
        for (const entry of snapshot.pageTable) {
            if (entry.physicalSlot === undefined || entry.resolvedLevel === undefined) continue
            const tableIndex = this.addressSpace.tableIndex(entry.requestedPage)
            const base = tableIndex * PAGE_TABLE_WORDS
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

    #releaseStagedAtlasUploads(): void {

        for (const upload of this.#stagedAtlasUploads) upload.dispose()
        this.#stagedAtlasUploads.length = 0
    }
}

export function createVirtualRasterGpuState(
    runtime: ScratchRuntime,
    descriptor: VirtualRasterGpuStateDescriptor
): Promise<VirtualRasterGpuState> {

    return VirtualRasterGpuState.create(runtime, descriptor)
}
