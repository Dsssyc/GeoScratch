import { throwGeoDiagnostic } from './diagnostics.js'
import { VirtualRasterSnapshot } from './virtual-raster.js'
import type {
    VirtualRasterAddressSpace,
    VirtualRasterPageIdentity,
    VirtualRasterPageTableEntry,
    VirtualRasterPhysicalPage,
    VirtualRasterPlane,
} from './virtual-raster.js'
import {
    assertOwnedVirtualRasterPagePayloadOwner,
    claimOwnedVirtualRasterPagePayload,
    moveOwnedVirtualRasterPagePayload,
    releaseOwnedVirtualRasterPagePayload,
} from './virtual-raster-transfer.js'
import type { OwnedVirtualRasterPagePayload } from './virtual-raster-transfer.js'

export type VirtualRasterStageStatus =
    | 'staged'
    | 'resident'
    | 'stale'
    | 'failed'
    | 'disposed'

export type VirtualRasterStageOutcome = Readonly<{
    status: VirtualRasterStageStatus
    page: VirtualRasterPageIdentity
    generation: number
    detail?: string
}>

export type VirtualRasterStageOptions = Readonly<{
    generation: number
}>

export type VirtualRasterPageAvailability = 'staged' | 'resident' | 'missing'

export type VirtualRasterResidencyDescriptor = Readonly<{
    addressSpace: VirtualRasterAddressSpace
    plane: VirtualRasterPlane
    maxPhysicalPages: number
    maxStagingBytes: number
    maxHistory?: number
}>

export type VirtualRasterHistoryEntry = Readonly<{
    sequence: number
    kind: 'staged' | 'resident' | 'fallback' | 'eviction' | 'failed' | 'stale' |
        'pin' | 'unpin' | 'publish' | 'acknowledge' | 'abandon' | 'dispose'
    pageKey: string
    detail?: string
}>

export type VirtualRasterResidencyFacts = Readonly<{
    disposed: boolean
    demandGeneration: number
    snapshotEpoch: number
    stagedCount: number
    stagingBytes: number
    residentCount: number
    residentGpuBytes: number
    pinnedCount: number
    maxStagingBytes: number
    maxPhysicalPages: number
    fallbackCount: number
    evictionCount: number
    failedCount: number
    staleResponseCount: number
    history: readonly VirtualRasterHistoryEntry[]
}>

export type VirtualRasterPublicationState =
    | 'pending'
    | 'settling'
    | 'acknowledged'
    | 'abandoned'

export type VirtualRasterPublicationFacts = Readonly<{
    epoch: number
    state: VirtualRasterPublicationState
    stagingBytes: number
    uploadPageCount: number
}>

export type VirtualRasterUploadPage = Readonly<{
    page: VirtualRasterPageIdentity
    physicalSlot: number
    generation: number
    contentEpoch: number
    byteLength: number
    width: number
    height: number
    channels: number
    contentVersion: string
}>

type StagedPage = {
    page: VirtualRasterPageIdentity
    payload: OwnedVirtualRasterPagePayload
    demandGeneration: number
    sequence: number
}

type ResidentPage = {
    page: VirtualRasterPageIdentity
    physicalSlot: number
    generation: number
    contentEpoch: number
    byteLength: number
    width: number
    height: number
    channels: number
    contentVersion: string
    lastUsed: number
}

type PublicationUpload = Readonly<{
    facts: VirtualRasterUploadPage
    payload: OwnedVirtualRasterPagePayload
}>

type PublicationSettlement = 'acknowledged' | 'abandoned'
type PublicationSettler = (
    publication: VirtualRasterPublication,
    settlement: PublicationSettlement
) => Promise<void>

const publicationUploads = new WeakMap<
    VirtualRasterPublication,
    readonly PublicationUpload[]
>()
const publications = new WeakSet<VirtualRasterPublication>()

export class VirtualRasterPublication {

    readonly kind = 'virtual-raster-publication'
    readonly snapshot: VirtualRasterSnapshot
    readonly uploads: readonly VirtualRasterUploadPage[]
    readonly #settler: PublicationSettler
    #state: VirtualRasterPublicationState = 'pending'
    #requestedSettlement: PublicationSettlement | undefined
    #settlement: Promise<void> | undefined

    private constructor(
        snapshot: VirtualRasterSnapshot,
        uploads: readonly PublicationUpload[],
        currentOwner: object,
        settler: PublicationSettler
    ) {

        this.snapshot = snapshot
        this.uploads = Object.freeze(uploads.map(upload => upload.facts))
        this.#settler = settler
        publicationUploads.set(this, Object.freeze([ ...uploads ]))
        publications.add(this)
        for (const upload of uploads) {
            moveOwnedVirtualRasterPagePayload(upload.payload, currentOwner, this)
        }
        Object.freeze(this)
    }

    /** @internal */
    static create(
        snapshot: VirtualRasterSnapshot,
        uploads: readonly PublicationUpload[],
        currentOwner: object,
        settler: PublicationSettler
    ): VirtualRasterPublication {

        return new VirtualRasterPublication(snapshot, uploads, currentOwner, settler)
    }

    inspect(): VirtualRasterPublicationFacts {

        const uploads = uploadPagesForPublication(this)
        return Object.freeze({
            epoch: this.snapshot.epoch,
            state: this.#state,
            stagingBytes: this.#state === 'pending' || this.#state === 'settling'
                ? uploads.reduce((sum, upload) => sum + upload.payload.data.byteLength, 0)
                : 0,
            uploadPageCount: uploads.length,
        })
    }

    acknowledge(): Promise<void> {

        return this.#settle('acknowledged')
    }

    abandon(): Promise<void> {

        return this.#settle('abandoned')
    }

    #settle(settlement: PublicationSettlement): Promise<void> {

        if (this.#settlement !== undefined) {
            if (this.#requestedSettlement !== settlement) {
                return Promise.reject(publicationStateError(this, settlement))
            }
            return this.#settlement
        }
        if (this.#state !== 'pending') return Promise.reject(publicationStateError(this, settlement))
        this.#requestedSettlement = settlement
        this.#state = 'settling'
        this.#settlement = this.#settler(this, settlement).then(() => {
            this.#state = settlement
            publicationUploads.delete(this)
        })
        return this.#settlement
    }
}

/** @internal */
export function uploadPagesForPublication(
    publication: VirtualRasterPublication
): readonly PublicationUpload[] {

    if (!publications.has(publication)) {
        return throwGeoDiagnostic({
            code: 'GEO_VIRTUAL_RASTER_PUBLICATION_INVALID',
            phase: 'residency',
            subject: { kind: 'virtual-raster-publication' },
            message: 'GPU upload bytes require an authentic Geo publication.',
        })
    }
    return publicationUploads.get(publication) ?? Object.freeze([])
}

export class VirtualRasterResidency {

    readonly addressSpace: VirtualRasterAddressSpace
    readonly plane: VirtualRasterPlane
    readonly maxPhysicalPages: number
    readonly maxStagingBytes: number
    readonly maxHistory: number
    #disposed = false
    #sequence = 0
    #snapshotEpoch = 0
    #demandGeneration = 0
    #requiredGenerations = new Map<string, number>()
    #staged = new Map<string, StagedPage>()
    #resident = new Map<string, ResidentPage>()
    #pinned = new Set<string>()
    #failed = new Set<string>()
    #slotGenerations: number[]
    #pageEpochs = new Map<string, number>()
    #history: VirtualRasterHistoryEntry[] = []
    #fallbackCount = 0
    #evictionCount = 0
    #failedCount = 0
    #staleResponseCount = 0
    #snapshotDirty = false
    #currentSnapshot: VirtualRasterSnapshot
    #activePublication: VirtualRasterPublication | undefined

    constructor(descriptor: VirtualRasterResidencyDescriptor) {

        if (descriptor.addressSpace.dimensions !== 2 ||
            descriptor.plane.addressSpace !== descriptor.addressSpace ||
            !positiveInteger(descriptor.maxPhysicalPages) ||
            !positiveInteger(descriptor.maxStagingBytes) ||
            (descriptor.maxHistory !== undefined &&
                (!Number.isSafeInteger(descriptor.maxHistory) || descriptor.maxHistory < 0))) {
            throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_RESIDENCY_INVALID',
                phase: 'residency',
                subject: { kind: 'virtual-raster-residency', id: descriptor.addressSpace.id },
                message: 'Virtual raster residency requires a 2D plane and separate finite GPU and staging budgets.',
                expected: {
                    dimensions: 2,
                    maxPhysicalPages: 'positive integer',
                    maxStagingBytes: 'positive integer',
                },
                actual: descriptor,
            })
        }
        this.addressSpace = descriptor.addressSpace
        this.plane = descriptor.plane
        this.maxPhysicalPages = descriptor.maxPhysicalPages
        this.maxStagingBytes = descriptor.maxStagingBytes
        this.maxHistory = descriptor.maxHistory ?? 32
        this.#slotGenerations = Array.from({ length: this.maxPhysicalPages }, () => 0)
        this.#currentSnapshot = this.#createSnapshot()
    }

    get currentSnapshot(): VirtualRasterSnapshot {

        return this.#currentSnapshot
    }

    reconcileGeneration(
        generation: number,
        requiredPages: readonly VirtualRasterPageIdentity[] = []
    ): void {

        this.#assertActive()
        if (!nonNegativeInteger(generation) || generation < this.#demandGeneration) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_GENERATION_INVALID',
                phase: 'residency',
                subject: { kind: 'virtual-raster-residency', id: this.addressSpace.id },
                message: 'Demand generations must be monotonic non-negative integers.',
                expected: { minimum: this.#demandGeneration },
                actual: { generation },
            })
        }
        const required = new Map<string, number>()
        for (const page of requiredPages) {
            this.addressSpace.assertPage(page)
            required.set(page.key, generation)
        }
        this.#demandGeneration = generation
        this.#requiredGenerations = required
        for (const [ key, staged ] of this.#staged) {
            if (required.has(key)) {
                staged.demandGeneration = generation
                continue
            }
            this.#staged.delete(key)
            releaseOwnedVirtualRasterPagePayload(staged.payload, this)
            this.#staleResponseCount++
            this.#record('stale', staged.page, `generation:${staged.demandGeneration}`)
        }
    }

    availability(page: VirtualRasterPageIdentity): VirtualRasterPageAvailability {

        this.addressSpace.assertPage(page)
        if (this.#staged.has(page.key)) return 'staged'
        if (this.#resident.has(page.key)) return 'resident'
        return 'missing'
    }

    stage(
        payload: OwnedVirtualRasterPagePayload,
        options: VirtualRasterStageOptions
    ): VirtualRasterStageOutcome {

        this.addressSpace.assertPage(payload.page)
        if (!nonNegativeInteger(options.generation)) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_GENERATION_INVALID',
                phase: 'residency',
                subject: { kind: 'virtual-raster-page', id: payload.page.key },
                message: 'A staged page requires a non-negative demand generation.',
                actual: options,
            })
        }
        this.#validatePayload(payload)
        claimOwnedVirtualRasterPagePayload(payload, this)
        if (this.#disposed) {
            releaseOwnedVirtualRasterPagePayload(payload, this)
            return freezeOutcome('disposed', payload.page, options.generation)
        }
        const requiredGeneration = this.#requiredGenerations.get(payload.page.key)
        if (requiredGeneration !== undefined && requiredGeneration !== options.generation) {
            releaseOwnedVirtualRasterPagePayload(payload, this)
            this.#staleResponseCount++
            this.#record('stale', payload.page, `generation:${options.generation}`)
            return freezeOutcome('stale', payload.page, options.generation)
        }
        const resident = this.#resident.get(payload.page.key)
        if (resident?.contentVersion === payload.contentVersion) {
            resident.lastUsed = ++this.#sequence
            releaseOwnedVirtualRasterPagePayload(payload, this)
            return freezeOutcome('resident', payload.page, options.generation)
        }
        const existing = this.#staged.get(payload.page.key)
        if (existing !== undefined && existing.demandGeneration > options.generation) {
            releaseOwnedVirtualRasterPagePayload(payload, this)
            this.#staleResponseCount++
            this.#record('stale', payload.page, `generation:${options.generation}`)
            return freezeOutcome('stale', payload.page, options.generation)
        }
        const existingBytes = existing?.payload.data.byteLength ?? 0
        const nextBytes = this.#stagingBytes() - existingBytes + payload.data.byteLength
        if (payload.data.byteLength > this.maxStagingBytes || nextBytes > this.maxStagingBytes) {
            releaseOwnedVirtualRasterPagePayload(payload, this)
            this.#failed.add(payload.page.key)
            this.#failedCount++
            this.#snapshotDirty = true
            this.#record('failed', payload.page, 'staging-budget-unavailable')
            return freezeOutcome('failed', payload.page, options.generation, 'staging-budget-unavailable')
        }
        if (existing !== undefined) releaseOwnedVirtualRasterPagePayload(existing.payload, this)
        this.#staged.set(payload.page.key, {
            page: payload.page,
            payload,
            demandGeneration: options.generation,
            sequence: ++this.#sequence,
        })
        if (this.#failed.delete(payload.page.key)) this.#snapshotDirty = true
        this.#record('staged', payload.page, `generation:${options.generation}`)
        return freezeOutcome('staged', payload.page, options.generation)
    }

    markUsed(page: VirtualRasterPageIdentity): void {

        this.addressSpace.assertPage(page)
        const resident = this.#resident.get(page.key)
        if (resident !== undefined) resident.lastUsed = ++this.#sequence
    }

    pin(page: VirtualRasterPageIdentity): void {

        this.#assertActive()
        this.addressSpace.assertPage(page)
        if (this.#pinned.has(page.key)) return
        this.#pinned.add(page.key)
        this.#record('pin', page)
    }

    unpin(page: VirtualRasterPageIdentity): void {

        this.#assertActive()
        this.addressSpace.assertPage(page)
        if (!this.#pinned.delete(page.key)) return
        this.#record('unpin', page)
    }

    publish(): VirtualRasterPublication {

        this.#assertActive()
        if (this.#activePublication !== undefined) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_PUBLICATION_PENDING',
                phase: 'residency',
                subject: { kind: 'virtual-raster-residency', id: this.addressSpace.id },
                message: 'A publication must be acknowledged or abandoned before publishing again.',
                actual: this.#activePublication.inspect(),
            })
        }
        const staged = [ ...this.#staged.values() ].sort((left, right) =>
            left.sequence - right.sequence || left.page.key.localeCompare(right.page.key)
        )
        this.#staged.clear()
        const uploads: PublicationUpload[] = []
        for (const candidate of staged) {
            const upload = this.#install(candidate)
            if (upload !== undefined) uploads.push(upload)
        }
        if (staged.length > 0 || this.#snapshotDirty) {
            this.#snapshotEpoch++
            this.#currentSnapshot = this.#createSnapshot()
            this.#snapshotDirty = false
        }
        const publication = VirtualRasterPublication.create(
            this.#currentSnapshot,
            uploads,
            this,
            (candidate, settlement) => this.#settlePublication(candidate, settlement)
        )
        this.#activePublication = publication
        this.#record(
            'publish',
            this.#historyAnchor(),
            `epoch:${this.#snapshotEpoch},uploads:${uploads.length}`
        )
        return publication
    }

    inspect(): VirtualRasterResidencyFacts {

        return Object.freeze({
            disposed: this.#disposed,
            demandGeneration: this.#demandGeneration,
            snapshotEpoch: this.#snapshotEpoch,
            stagedCount: this.#staged.size,
            stagingBytes: this.#stagingBytes(),
            residentCount: this.#resident.size,
            residentGpuBytes: this.#residentGpuBytes(),
            pinnedCount: this.#pinned.size,
            maxStagingBytes: this.maxStagingBytes,
            maxPhysicalPages: this.maxPhysicalPages,
            fallbackCount: this.#fallbackCount,
            evictionCount: this.#evictionCount,
            failedCount: this.#failedCount,
            staleResponseCount: this.#staleResponseCount,
            history: Object.freeze([ ...this.#history ]),
        })
    }

    dispose(): void {

        if (this.#disposed) return
        this.#disposed = true
        for (const staged of this.#staged.values()) {
            releaseOwnedVirtualRasterPagePayload(staged.payload, this)
        }
        this.#staged.clear()
        const publication = this.#activePublication
        if (publication !== undefined) void publication.abandon()
        this.#resident.clear()
        this.#pinned.clear()
        this.#failed.clear()
        this.#requiredGenerations.clear()
        this.#record('dispose', this.#historyAnchor())
        this.#snapshotEpoch++
        this.#currentSnapshot = this.#createSnapshot()
    }

    #validatePayload(payload: OwnedVirtualRasterPagePayload): void {

        const expectedBytes = this.addressSpace.pageSize[0]! *
            this.addressSpace.pageSize[1]! * this.plane.channels *
            (this.plane.sampleType === 'unorm8' ? 1 : 4)
        if (payload.width !== this.addressSpace.pageSize[0] ||
            payload.height !== this.addressSpace.pageSize[1] ||
            payload.channels !== this.plane.channels ||
            payload.data.byteLength !== expectedBytes ||
            (this.plane.sampleType === 'unorm8' && !(payload.data instanceof Uint8Array)) ||
            (this.plane.sampleType === 'float32' && !(payload.data instanceof Float32Array))) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_PAGE_PAYLOAD_INVALID',
                phase: 'source',
                subject: { kind: 'virtual-raster-page', id: payload.page.key },
                message: 'Owned page bytes must match the plane and fixed physical page shape.',
                expected: {
                    width: this.addressSpace.pageSize[0],
                    height: this.addressSpace.pageSize[1],
                    channels: this.plane.channels,
                    byteLength: expectedBytes,
                    sampleType: this.plane.sampleType,
                },
                actual: {
                    width: payload.width,
                    height: payload.height,
                    channels: payload.channels,
                    byteLength: payload.data.byteLength,
                    dataType: payload.data.constructor.name,
                },
            })
        }
    }

    #install(candidate: StagedPage): PublicationUpload | undefined {

        const existing = this.#resident.get(candidate.page.key)
        if (existing !== undefined) {
            existing.generation = ++this.#slotGenerations[existing.physicalSlot]!
            existing.contentEpoch++
            existing.byteLength = candidate.payload.data.byteLength
            existing.width = candidate.payload.width
            existing.height = candidate.payload.height
            existing.channels = candidate.payload.channels
            existing.contentVersion = candidate.payload.contentVersion
            existing.lastUsed = ++this.#sequence
            this.#pageEpochs.set(candidate.page.key, existing.contentEpoch)
            this.#record('resident', candidate.page, 'updated')
            return freezeUpload(existing, candidate.payload)
        }
        while (this.#resident.size >= this.maxPhysicalPages) {
            if (!this.#evictOne()) break
        }
        if (this.#resident.size >= this.maxPhysicalPages) {
            releaseOwnedVirtualRasterPagePayload(candidate.payload, this)
            this.#failed.add(candidate.page.key)
            this.#failedCount++
            this.#snapshotDirty = true
            this.#record('failed', candidate.page, 'residency-budget-unavailable')
            return undefined
        }
        const physicalSlot = this.#firstFreeSlot()
        const generation = ++this.#slotGenerations[physicalSlot]!
        const contentEpoch = (this.#pageEpochs.get(candidate.page.key) ?? 0) + 1
        this.#pageEpochs.set(candidate.page.key, contentEpoch)
        const resident: ResidentPage = {
            page: candidate.page,
            physicalSlot,
            generation,
            contentEpoch,
            byteLength: candidate.payload.data.byteLength,
            width: candidate.payload.width,
            height: candidate.payload.height,
            channels: candidate.payload.channels,
            contentVersion: candidate.payload.contentVersion,
            lastUsed: ++this.#sequence,
        }
        this.#resident.set(candidate.page.key, resident)
        this.#record('resident', candidate.page, `slot:${physicalSlot}`)
        return freezeUpload(resident, candidate.payload)
    }

    #evictOne(): boolean {

        const victim = [ ...this.#resident.values() ]
            .filter(candidate => !this.#pinned.has(candidate.page.key))
            .sort((left, right) =>
                left.lastUsed - right.lastUsed ||
                left.physicalSlot - right.physicalSlot ||
                left.page.key.localeCompare(right.page.key)
            )[0]
        if (victim === undefined) return false
        this.#resident.delete(victim.page.key)
        this.#evictionCount++
        this.#record('eviction', victim.page, `slot:${victim.physicalSlot}`)
        return true
    }

    #firstFreeSlot(): number {

        const used = new Set([ ...this.#resident.values() ].map(page => page.physicalSlot))
        for (let slot = 0; slot < this.maxPhysicalPages; slot++) {
            if (!used.has(slot)) return slot
        }
        throw new TypeError('Virtual raster physical slot budget is inconsistent.')
    }

    #createSnapshot(): VirtualRasterSnapshot {

        const physicalMappings = new Map<number, VirtualRasterPhysicalPage>()
        for (const resident of this.#resident.values()) {
            physicalMappings.set(resident.physicalSlot, Object.freeze({
                page: resident.page,
                physicalSlot: resident.physicalSlot,
                generation: resident.generation,
                contentEpoch: resident.contentEpoch,
                byteLength: resident.byteLength,
                width: resident.width,
                height: resident.height,
                channels: resident.channels,
                contentVersion: resident.contentVersion,
            }))
        }
        let fallbackEntries = 0
        const table = this.addressSpace.pages().map(page => {
            const exact = this.#resident.get(page.key)
            if (exact !== undefined) return freezeEntry(page, exact, 'resident')
            let parent = this.addressSpace.parent(page)
            while (parent !== undefined) {
                const ancestor = this.#resident.get(parent.key)
                if (ancestor !== undefined) {
                    fallbackEntries++
                    return freezeEntry(page, ancestor, 'fallback')
                }
                parent = this.addressSpace.parent(parent)
            }
            return Object.freeze({
                requestedPage: page,
                status: this.#failed.has(page.key) ? 'failed' : 'missing',
                requestedLevel: page.level,
            })
        })
        if (fallbackEntries > 0) {
            this.#fallbackCount += fallbackEntries
            this.#record('fallback', this.#historyAnchor(), `entries:${fallbackEntries}`)
        }
        return new VirtualRasterSnapshot(
            this.addressSpace,
            this.#snapshotEpoch,
            table,
            physicalMappings
        )
    }

    async #settlePublication(
        publication: VirtualRasterPublication,
        settlement: PublicationSettlement
    ): Promise<void> {

        if (this.#activePublication !== publication) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_PUBLICATION_INVALID',
                phase: 'residency',
                subject: { kind: 'virtual-raster-publication', id: String(publication.snapshot.epoch) },
                message: 'Only the active residency publication can settle.',
            })
        }
        for (const upload of uploadPagesForPublication(publication)) {
            assertOwnedVirtualRasterPagePayloadOwner(upload.payload, publication)
            if (settlement === 'abandoned') {
                const resident = this.#resident.get(upload.facts.page.key)
                if (resident?.physicalSlot === upload.facts.physicalSlot &&
                    resident.generation === upload.facts.generation) {
                    this.#resident.delete(resident.page.key)
                }
            }
            releaseOwnedVirtualRasterPagePayload(upload.payload, publication)
        }
        this.#activePublication = undefined
        this.#record(settlement === 'acknowledged' ? 'acknowledge' : 'abandon', this.#historyAnchor(),
            `epoch:${publication.snapshot.epoch}`)
        if (settlement === 'abandoned') {
            this.#snapshotEpoch++
            this.#currentSnapshot = this.#createSnapshot()
        }
    }

    #stagingBytes(): number {

        const staged = [ ...this.#staged.values() ].reduce(
            (sum, page) => sum + page.payload.data.byteLength,
            0
        )
        return staged + (this.#activePublication?.inspect().stagingBytes ?? 0)
    }

    #residentGpuBytes(): number {

        return [ ...this.#resident.values() ].reduce((sum, page) => sum + page.byteLength, 0)
    }

    #record(
        kind: VirtualRasterHistoryEntry['kind'],
        page: VirtualRasterPageIdentity,
        detail?: string
    ): void {

        if (this.maxHistory === 0) return
        const entry: {
            sequence: number
            kind: VirtualRasterHistoryEntry['kind']
            pageKey: string
            detail?: string
        } = { sequence: ++this.#sequence, kind, pageKey: page.key }
        if (detail !== undefined) entry.detail = detail
        this.#history.push(Object.freeze(entry))
        if (this.#history.length > this.maxHistory) {
            this.#history.splice(0, this.#history.length - this.maxHistory)
        }
    }

    #historyAnchor(): VirtualRasterPageIdentity {

        return this.addressSpace.rootPage()
    }

    #assertActive(): void {

        if (this.#disposed) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_RESIDENCY_DISPOSED',
                phase: 'residency',
                subject: { kind: 'virtual-raster-residency', id: this.addressSpace.id },
                message: 'Virtual raster residency is disposed.',
            })
        }
    }
}

function freezeOutcome(
    status: VirtualRasterStageStatus,
    page: VirtualRasterPageIdentity,
    generation: number,
    detail?: string
): VirtualRasterStageOutcome {

    return Object.freeze({ status, page, generation, ...(detail === undefined ? {} : { detail }) })
}

function freezeUpload(
    resident: ResidentPage,
    payload: OwnedVirtualRasterPagePayload
): PublicationUpload {

    return Object.freeze({
        facts: Object.freeze({
            page: resident.page,
            physicalSlot: resident.physicalSlot,
            generation: resident.generation,
            contentEpoch: resident.contentEpoch,
            byteLength: resident.byteLength,
            width: resident.width,
            height: resident.height,
            channels: resident.channels,
            contentVersion: resident.contentVersion,
        }),
        payload,
    })
}

function freezeEntry(
    requestedPage: VirtualRasterPageIdentity,
    resident: ResidentPage,
    status: 'resident' | 'fallback'
): VirtualRasterPageTableEntry {

    return Object.freeze({
        requestedPage,
        status,
        requestedLevel: requestedPage.level,
        resolvedLevel: resident.page.level,
        resolvedPage: resident.page,
        physicalSlot: resident.physicalSlot,
        generation: resident.generation,
        contentEpoch: resident.contentEpoch,
    })
}

function publicationStateError(
    publication: VirtualRasterPublication,
    requested: PublicationSettlement
): Error {

    try {
        throwGeoDiagnostic({
            code: 'GEO_VIRTUAL_RASTER_PUBLICATION_SETTLED',
            phase: 'residency',
            subject: { kind: 'virtual-raster-publication', id: String(publication.snapshot.epoch) },
            message: 'A publication has exactly one terminal settlement.',
            expected: { requested },
            actual: publication.inspect(),
        })
    } catch (error) {
        return error as Error
    }
}

function positiveInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) >= 0
}
