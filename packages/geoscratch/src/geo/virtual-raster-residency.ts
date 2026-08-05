import { throwGeoDiagnostic } from './diagnostics.js'
import {
    VirtualRasterSnapshot,
} from './virtual-raster.js'
import type {
    VirtualRasterAddressSpace,
    VirtualRasterPageIdentity,
    VirtualRasterPagePayload,
    VirtualRasterPageTableEntry,
    VirtualRasterPhysicalPage,
    VirtualRasterPlane,
    VirtualRasterSource,
} from './virtual-raster.js'

export type VirtualRasterRequestStatus =
    | 'staged'
    | 'resident'
    | 'pending'
    | 'stale'
    | 'failed'
    | 'disposed'

export type VirtualRasterRequestOutcome = Readonly<{
    status: VirtualRasterRequestStatus
    page: VirtualRasterPageIdentity
    error?: string
}>

export type VirtualRasterResidencyDescriptor = Readonly<{
    addressSpace: VirtualRasterAddressSpace
    plane: VirtualRasterPlane
    source: VirtualRasterSource
    maxPhysicalPages: number
    maxCpuBytes: number
    maxHistory?: number
}>

export type VirtualRasterHistoryEntry = Readonly<{
    sequence: number
    kind: 'request' | 'staged' | 'resident' | 'fallback' | 'eviction' | 'failed' | 'stale' | 'dispose'
    pageKey: string
    detail?: string
}>

export type VirtualRasterResidencyFacts = Readonly<{
    disposed: boolean
    snapshotEpoch: number
    pendingCount: number
    stagedCount: number
    residentCount: number
    cpuBytes: number
    maxCpuBytes: number
    maxPhysicalPages: number
    pageRequestCount: number
    fallbackCount: number
    evictionCount: number
    failedCount: number
    staleResponseCount: number
    history: readonly VirtualRasterHistoryEntry[]
}>

type PendingRequest = {
    token: number
    controller: AbortController
    promise: Promise<VirtualRasterRequestOutcome>
}

type StagedPage = {
    page: VirtualRasterPageIdentity
    payload: VirtualRasterPagePayload
    sequence: number
}

type ResidentPage = {
    page: VirtualRasterPageIdentity
    physicalSlot: number
    generation: number
    contentEpoch: number
    payload: VirtualRasterPagePayload
    lastUsed: number
}

export class VirtualRasterResidency {

    readonly addressSpace: VirtualRasterAddressSpace
    readonly plane: VirtualRasterPlane
    readonly source: VirtualRasterSource
    readonly maxPhysicalPages: number
    readonly maxCpuBytes: number
    readonly maxHistory: number
    #disposed = false
    #sequence = 0
    #snapshotEpoch = 0
    #requestToken = 0
    #pending = new Map<string, PendingRequest>()
    #activeRequests = new Set<Promise<VirtualRasterRequestOutcome>>()
    #staged = new Map<string, StagedPage>()
    #resident = new Map<string, ResidentPage>()
    #failed = new Set<string>()
    #slotGenerations: number[]
    #pageEpochs = new Map<string, number>()
    #history: VirtualRasterHistoryEntry[] = []
    #pageRequestCount = 0
    #fallbackCount = 0
    #evictionCount = 0
    #failedCount = 0
    #staleResponseCount = 0
    #currentSnapshot: VirtualRasterSnapshot

    constructor(descriptor: VirtualRasterResidencyDescriptor) {

        if (descriptor.addressSpace.dimensions !== 2 ||
            descriptor.plane.addressSpace !== descriptor.addressSpace ||
            !Number.isSafeInteger(descriptor.maxPhysicalPages) || descriptor.maxPhysicalPages <= 0 ||
            !Number.isSafeInteger(descriptor.maxCpuBytes) || descriptor.maxCpuBytes <= 0 ||
            (descriptor.maxHistory !== undefined &&
                (!Number.isSafeInteger(descriptor.maxHistory) || descriptor.maxHistory < 0))) {
            throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_RESIDENCY_INVALID',
                phase: 'residency',
                subject: { kind: 'virtual-raster-residency', id: descriptor.addressSpace.id },
                message: 'Virtual raster residency requires a 2D plane and finite positive budgets.',
                expected: { dimensions: 2, maxPhysicalPages: 'positive integer', maxCpuBytes: 'positive integer' },
                actual: descriptor,
            })
        }
        this.addressSpace = descriptor.addressSpace
        this.plane = descriptor.plane
        this.source = descriptor.source
        this.maxPhysicalPages = descriptor.maxPhysicalPages
        this.maxCpuBytes = descriptor.maxCpuBytes
        this.maxHistory = descriptor.maxHistory ?? 32
        this.#slotGenerations = Array.from({ length: this.maxPhysicalPages }, () => 0)
        this.#currentSnapshot = this.#createSnapshot()
    }

    get currentSnapshot(): VirtualRasterSnapshot {

        return this.#currentSnapshot
    }

    request(page: VirtualRasterPageIdentity): Promise<VirtualRasterRequestOutcome> {

        this.addressSpace.assertPage(page)
        if (this.#disposed) return Promise.resolve(Object.freeze({ status: 'disposed', page }))
        if (this.#resident.has(page.key)) {
            this.markUsed(page)
            return Promise.resolve(Object.freeze({ status: 'resident', page }))
        }
        if (this.#staged.has(page.key)) {
            return Promise.resolve(Object.freeze({ status: 'staged', page }))
        }
        const existing = this.#pending.get(page.key)
        if (existing !== undefined) return existing.promise

        const token = ++this.#requestToken
        const controller = new AbortController()
        this.#pageRequestCount++
        this.#record('request', page)
        let promise: Promise<VirtualRasterRequestOutcome>
        promise = Promise.resolve()
            .then(() => {
                if (this.#disposed || controller.signal.aborted) {
                    throw new VirtualRasterRequestCancelled()
                }
                return this.source.loadPage(page, { signal: controller.signal })
            })
            .then(payload => this.#acceptResponse(page, token, payload))
            .catch(error => this.#acceptFailure(page, token, error))
            .finally(() => {
                const current = this.#pending.get(page.key)
                if (current?.token === token) this.#pending.delete(page.key)
                this.#activeRequests.delete(promise)
            })
        this.#pending.set(page.key, { token, controller, promise })
        this.#activeRequests.add(promise)
        return promise
    }

    cancel(page: VirtualRasterPageIdentity): void {

        this.addressSpace.assertPage(page)
        const pending = this.#pending.get(page.key)
        if (pending === undefined) return
        this.#pending.delete(page.key)
        pending.controller.abort()
    }

    markUsed(page: VirtualRasterPageIdentity): void {

        this.addressSpace.assertPage(page)
        const resident = this.#resident.get(page.key)
        if (resident !== undefined) resident.lastUsed = ++this.#sequence
    }

    publishSnapshot(): VirtualRasterSnapshot {

        this.#assertActive()
        const staged = [ ...this.#staged.values() ].sort((a, b) =>
            a.sequence - b.sequence || a.page.key.localeCompare(b.page.key),
        )
        this.#staged.clear()
        for (const candidate of staged) this.#install(candidate)
        this.#snapshotEpoch++
        this.#currentSnapshot = this.#createSnapshot()
        return this.#currentSnapshot
    }

    inspect(): VirtualRasterResidencyFacts {

        return Object.freeze({
            disposed: this.#disposed,
            snapshotEpoch: this.#snapshotEpoch,
            pendingCount: this.#pending.size,
            stagedCount: this.#staged.size,
            residentCount: this.#resident.size,
            cpuBytes: this.#cpuBytes(),
            maxCpuBytes: this.maxCpuBytes,
            maxPhysicalPages: this.maxPhysicalPages,
            pageRequestCount: this.#pageRequestCount,
            fallbackCount: this.#fallbackCount,
            evictionCount: this.#evictionCount,
            failedCount: this.#failedCount,
            staleResponseCount: this.#staleResponseCount,
            history: Object.freeze([ ...this.#history ]),
        })
    }

    async whenIdle(): Promise<void> {

        while (this.#activeRequests.size > 0) {
            await Promise.allSettled([ ...this.#activeRequests ])
        }
    }

    dispose(): void {

        if (this.#disposed) return
        this.#disposed = true
        const pending = [ ...this.#pending.values() ]
        this.#pending.clear()
        for (const request of pending) request.controller.abort()
        this.#staged.clear()
        this.#resident.clear()
        this.#failed.clear()
        this.#record('dispose', this.addressSpace.page({ level: this.addressSpace.levelCount - 1, x: 0, y: 0 }))
        this.#snapshotEpoch++
        this.#currentSnapshot = this.#createSnapshot()
    }

    #acceptResponse(
        page: VirtualRasterPageIdentity,
        token: number,
        payload: VirtualRasterPagePayload
    ): VirtualRasterRequestOutcome {

        if (this.#disposed) return Object.freeze({ status: 'disposed', page })
        const pending = this.#pending.get(page.key)
        if (pending?.token !== token) {
            this.#staleResponseCount++
            this.#record('stale', page)
            return Object.freeze({ status: 'stale', page })
        }
        this.#validatePayload(page, payload)
        this.#staged.set(page.key, {
            page,
            payload: clonePayload(payload),
            sequence: ++this.#sequence,
        })
        this.#failed.delete(page.key)
        this.#record('staged', page)
        return Object.freeze({ status: 'staged', page })
    }

    #acceptFailure(
        page: VirtualRasterPageIdentity,
        token: number,
        error: unknown
    ): VirtualRasterRequestOutcome {

        if (this.#disposed) return Object.freeze({ status: 'disposed', page })
        const pending = this.#pending.get(page.key)
        if (pending?.token !== token) {
            this.#staleResponseCount++
            this.#record('stale', page)
            return Object.freeze({ status: 'stale', page })
        }
        this.#failed.add(page.key)
        this.#failedCount++
        const message = error instanceof Error ? error.message : String(error)
        this.#record('failed', page, message)
        return Object.freeze({ status: 'failed', page, error: message })
    }

    #validatePayload(page: VirtualRasterPageIdentity, payload: VirtualRasterPagePayload): void {

        const expectedBytes = this.addressSpace.pageSize[0]! *
            this.addressSpace.pageSize[1]! *
            this.plane.channels *
            (this.plane.sampleType === 'unorm8' ? 1 : 4)
        if (payload.page.key !== page.key ||
            payload.width !== this.addressSpace.pageSize[0] ||
            payload.height !== this.addressSpace.pageSize[1] ||
            payload.channels !== this.plane.channels ||
            payload.data.byteLength !== expectedBytes ||
            (this.plane.sampleType === 'unorm8' && !(payload.data instanceof Uint8Array)) ||
            (this.plane.sampleType === 'float32' && !(payload.data instanceof Float32Array))) {
            return throwGeoDiagnostic({
                code: 'GEO_VIRTUAL_RASTER_PAGE_PAYLOAD_INVALID',
                phase: 'source',
                subject: { kind: 'virtual-raster-page', id: page.key },
                message: 'Loaded page payload does not match the plane and fixed physical page shape.',
                expected: {
                    pageKey: page.key,
                    width: this.addressSpace.pageSize[0],
                    height: this.addressSpace.pageSize[1],
                    channels: this.plane.channels,
                    byteLength: expectedBytes,
                    sampleType: this.plane.sampleType,
                },
                actual: {
                    pageKey: payload.page.key,
                    width: payload.width,
                    height: payload.height,
                    channels: payload.channels,
                    byteLength: payload.data.byteLength,
                    dataType: payload.data.constructor.name,
                },
            })
        }
    }

    #install(candidate: StagedPage): void {

        if (candidate.payload.data.byteLength > this.maxCpuBytes) {
            this.#failed.add(candidate.page.key)
            this.#failedCount++
            this.#record('failed', candidate.page, 'page-exceeds-cpu-budget')
            return
        }
        const existing = this.#resident.get(candidate.page.key)
        if (existing !== undefined) {
            existing.payload = candidate.payload
            existing.contentEpoch++
            existing.lastUsed = ++this.#sequence
            this.#pageEpochs.set(candidate.page.key, existing.contentEpoch)
            this.#record('resident', candidate.page, 'updated')
            return
        }
        while (this.#resident.size >= this.maxPhysicalPages ||
            this.#cpuBytes() + candidate.payload.data.byteLength > this.maxCpuBytes) {
            if (!this.#evictOne()) break
        }
        if (this.#resident.size >= this.maxPhysicalPages ||
            this.#cpuBytes() + candidate.payload.data.byteLength > this.maxCpuBytes) {
            this.#failed.add(candidate.page.key)
            this.#failedCount++
            this.#record('failed', candidate.page, 'residency-budget-unavailable')
            return
        }
        const physicalSlot = this.#firstFreeSlot()
        const generation = ++this.#slotGenerations[physicalSlot]!
        const contentEpoch = (this.#pageEpochs.get(candidate.page.key) ?? 0) + 1
        this.#pageEpochs.set(candidate.page.key, contentEpoch)
        this.#resident.set(candidate.page.key, {
            page: candidate.page,
            payload: candidate.payload,
            physicalSlot,
            generation,
            contentEpoch,
            lastUsed: ++this.#sequence,
        })
        this.#record('resident', candidate.page, `slot:${physicalSlot}`)
    }

    #evictOne(): boolean {

        const victim = [ ...this.#resident.values() ].sort((a, b) =>
            a.lastUsed - b.lastUsed ||
            a.physicalSlot - b.physicalSlot ||
            a.page.key.localeCompare(b.page.key),
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

        const physicalPages = new Map<number, VirtualRasterPhysicalPage>()
        for (const resident of this.#resident.values()) {
            physicalPages.set(resident.physicalSlot, Object.freeze({
                page: resident.page,
                payload: resident.payload,
                physicalSlot: resident.physicalSlot,
                generation: resident.generation,
                contentEpoch: resident.contentEpoch,
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
            const root = this.addressSpace.page({ level: this.addressSpace.levelCount - 1, x: 0, y: 0 })
            this.#record('fallback', root, `entries:${fallbackEntries}`)
        }
        return new VirtualRasterSnapshot(
            this.addressSpace,
            this.#snapshotEpoch,
            table,
            physicalPages
        )
    }

    #cpuBytes(): number {

        return [ ...this.#resident.values() ].reduce(
            (sum, resident) => sum + resident.payload.data.byteLength,
            0
        )
    }

    #record(kind: VirtualRasterHistoryEntry['kind'], page: VirtualRasterPageIdentity, detail?: string): void {

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

class VirtualRasterRequestCancelled extends Error {}

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

function clonePayload(payload: VirtualRasterPagePayload): VirtualRasterPagePayload {

    const data = payload.data instanceof Uint8Array
        ? Uint8Array.from(payload.data)
        : Float32Array.from(payload.data)
    return Object.freeze({
        page: payload.page,
        width: payload.width,
        height: payload.height,
        channels: payload.channels,
        data,
        contentVersion: payload.contentVersion,
    })
}
