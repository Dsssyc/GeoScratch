import { throwGeoDiagnostic } from './diagnostics.js'

export type VirtualRasterCachePolicy =
    | Readonly<{ tier: 'none' }>
    | Readonly<{ tier: 'memory', maxBytes: number }>
    | Readonly<{
        tier: 'persistent'
        memoryMaxBytes: number
        persistentMaxBytes: number
        backend: 'indexeddb'
        namespace: string
    }>

export type VirtualRasterCacheCoherence =
    | Readonly<{ mode: 'immutable', contentVersion: string }>
    | Readonly<{ mode: 'revisioned', revision: string, validator?: string }>
    | Readonly<{ mode: 'editable', baseRevision: string }>

export type VirtualRasterCacheKeyDescriptor = Readonly<{
    sourceId: string
    tileMatrixSetId: string
    tileMatrixSetUri: string
    matrixId: string
    tileRow: number
    tileColumn: number
    plane: string
    coherence: VirtualRasterCacheCoherence
    encodedRepresentation: string
    decoderVersion: string
    sampleType: string
    schemaVersion: number
}>

export type VirtualRasterCacheKey = Readonly<{
    kind: 'virtual-raster-cache-key'
    id: string
    sourceId: string
    tileMatrixSetId: string
    tileMatrixSetUri: string
    matrixId: string
    tileRow: number
    tileColumn: number
    plane: string
    coherence: VirtualRasterCacheCoherence
    encodedRepresentation: string
    decoderVersion: string
    sampleType: string
    schemaVersion: number
}>

export type VirtualRasterCacheRecordDescriptor = Readonly<{
    data: ArrayBuffer
    contentType: string
    validator?: string
    lastModified?: string
}>

export type VirtualRasterCacheRecord = Readonly<{
    data: ArrayBuffer
    byteLength: number
    contentType: string
    validator?: string
    lastModified?: string
}>

export type VirtualRasterCachePutStatus =
    | 'stored'
    | 'not-retained'
    | 'too-large'
    | 'quota-exceeded'

export type VirtualRasterCachePutOutcome = Readonly<{
    status: VirtualRasterCachePutStatus
    tier: VirtualRasterCachePolicy['tier']
    byteLength: number
    evictedCount: number
}>

export type VirtualRasterCacheDeleteOutcome = Readonly<{
    deletedCount: number
    releasedBytes: number
}>

export type VirtualRasterCacheInvalidation = Readonly<{
    sourceId?: string
    tileMatrixSetId?: string
    matrixId?: string
    plane?: string
}>

export type VirtualRasterCacheFacts = Readonly<{
    tier: VirtualRasterCachePolicy['tier']
    disposed: boolean
    memoryEntryCount: number
    memoryBytes: number
    persistentEntryCount: number
    persistentBytes: number
    hitCount: number
    memoryHitCount: number
    persistentHitCount: number
    missCount: number
    putCount: number
    evictionCount: number
    invalidationCount: number
    quotaFailureCount: number
    storageUsage?: number
    storageQuota?: number
    persistenceRequested: boolean
    persisted?: boolean
}>

export type VirtualRasterPersistentStorageFacts = Readonly<{
    usage?: number
    quota?: number
    persisted?: boolean
    persistenceRequested: boolean
}>

export type VirtualRasterPersistentEntry = Readonly<{
    key: VirtualRasterCacheKey
    data: ArrayBuffer
    byteLength: number
    contentType: string
    validator?: string
    lastModified?: string
    accessSequence: number
}>

export type VirtualRasterPersistentStore = Readonly<{
    kind: 'virtual-raster-persistent-store'
    get(id: string): Promise<VirtualRasterPersistentEntry | undefined>
    put(entry: VirtualRasterPersistentEntry): Promise<void>
    delete(id: string): Promise<boolean>
    list(): Promise<readonly VirtualRasterPersistentEntry[]>
    clear(): Promise<number>
    storageFacts(options: Readonly<{
        requestPersistence: boolean
    }>): Promise<VirtualRasterPersistentStorageFacts>
    dispose(): Promise<void>
}>

export type VirtualRasterCacheDescriptor = Readonly<{
    policy: VirtualRasterCachePolicy
    persistentStore?: VirtualRasterPersistentStore
    requestPersistence?: boolean
}>

type CacheEntry = {
    key: VirtualRasterCacheKey
    data: ArrayBuffer
    byteLength: number
    contentType: string
    validator?: string
    lastModified?: string
    accessSequence: number
}

export class VirtualRasterCache {

    readonly policy: VirtualRasterCachePolicy
    readonly #persistentStore: VirtualRasterPersistentStore | undefined
    readonly #requestPersistence: boolean
    readonly #memory = new Map<string, CacheEntry>()
    readonly #persistent = new Map<string, Omit<CacheEntry, 'data'>>()
    #storageFacts: VirtualRasterPersistentStorageFacts = Object.freeze({
        persistenceRequested: false,
    })
    #disposed = false
    #sequence = 0
    #hitCount = 0
    #memoryHitCount = 0
    #persistentHitCount = 0
    #missCount = 0
    #putCount = 0
    #evictionCount = 0
    #invalidationCount = 0
    #quotaFailureCount = 0
    #disposePromise: Promise<void> | undefined

    private constructor(
        descriptor: VirtualRasterCacheDescriptor,
        persistentStore?: VirtualRasterPersistentStore
    ) {

        this.policy = freezePolicy(descriptor.policy)
        this.#persistentStore = persistentStore
        this.#requestPersistence = descriptor.requestPersistence ?? false
    }

    /** @internal */
    static async create(descriptor: VirtualRasterCacheDescriptor): Promise<VirtualRasterCache> {

        validatePolicy(descriptor.policy)
        let persistentStore: VirtualRasterPersistentStore | undefined
        if (descriptor.policy.tier === 'persistent') {
            persistentStore = descriptor.persistentStore ??
                await openIndexedDbVirtualRasterPersistentStore({
                    namespace: descriptor.policy.namespace,
                })
            if (persistentStore.kind !== 'virtual-raster-persistent-store') {
                return throwCacheDiagnostic(
                    'GEO_VIRTUAL_RASTER_CACHE_STORE_INVALID',
                    'A persistent cache requires an explicit IndexedDB-compatible store.',
                    persistentStore
                )
            }
        } else if (descriptor.persistentStore !== undefined) {
            return throwCacheDiagnostic(
                'GEO_VIRTUAL_RASTER_CACHE_POLICY_INVALID',
                'A persistent store is only valid with the persistent cache tier.',
                descriptor.policy
            )
        }
        const cache = new VirtualRasterCache(descriptor, persistentStore)
        await cache.#initialize()
        return cache
    }

    async get(key: VirtualRasterCacheKey): Promise<VirtualRasterCacheRecord | undefined> {

        this.#assertActive()
        assertCacheKey(key)
        const memory = this.#memory.get(key.id)
        if (memory !== undefined) {
            memory.accessSequence = ++this.#sequence
            this.#hitCount++
            this.#memoryHitCount++
            return cloneRecord(memory)
        }
        if (this.policy.tier === 'persistent' && this.#persistentStore !== undefined) {
            const persistent = await cacheStorageOperation(
                'get',
                () => this.#persistentStore!.get(key.id)
            )
            if (persistent !== undefined) {
                assertPersistentEntry(persistent, key)
                const touched = cloneEntry(persistent, ++this.#sequence)
                try {
                    await this.#persistentStore.put(freezePersistentEntry(touched))
                } catch (error) {
                    if (isQuotaError(error)) this.#quotaFailureCount++
                    else return cacheStorageFailure('touch', error)
                }
                this.#persistent.set(key.id, metadataFor(touched))
                this.#retainMemory(touched, this.policy.memoryMaxBytes)
                this.#hitCount++
                this.#persistentHitCount++
                return cloneRecord(touched)
            }
        }
        this.#missCount++
        return undefined
    }

    async put(
        key: VirtualRasterCacheKey,
        descriptor: VirtualRasterCacheRecordDescriptor
    ): Promise<VirtualRasterCachePutOutcome> {

        this.#assertActive()
        assertCacheKey(key)
        validateRecord(descriptor)
        this.#putCount++
        if (this.policy.tier === 'none') {
            return freezePutOutcome('not-retained', 'none', descriptor.data.byteLength, 0)
        }
        const entry = createEntry(key, descriptor, ++this.#sequence)
        if (this.policy.tier === 'memory') {
            if (entry.byteLength > this.policy.maxBytes) {
                return freezePutOutcome('too-large', 'memory', entry.byteLength, 0)
            }
            const evictedCount = this.#retainMemory(entry, this.policy.maxBytes)
            return freezePutOutcome('stored', 'memory', entry.byteLength, evictedCount)
        }
        const memoryEvictions = this.#retainMemory(entry, this.policy.memoryMaxBytes)
        if (entry.byteLength > this.policy.persistentMaxBytes) {
            return freezePutOutcome('too-large', 'persistent', entry.byteLength, memoryEvictions)
        }
        const persistentEvictions = await this.#makePersistentRoom(
            key.id,
            entry.byteLength,
            this.policy.persistentMaxBytes
        )
        try {
            await this.#persistentStore!.put(freezePersistentEntry(cloneEntry(entry)))
        } catch (error) {
            if (!isQuotaError(error)) return cacheStorageFailure('put', error)
            this.#quotaFailureCount++
            return freezePutOutcome(
                'quota-exceeded',
                'persistent',
                entry.byteLength,
                memoryEvictions + persistentEvictions
            )
        }
        this.#persistent.set(key.id, metadataFor(entry))
        this.#storageFacts = await this.#readStorageFacts(false)
        return freezePutOutcome(
            'stored',
            'persistent',
            entry.byteLength,
            memoryEvictions + persistentEvictions
        )
    }

    async invalidate(
        invalidation: VirtualRasterCacheInvalidation
    ): Promise<VirtualRasterCacheDeleteOutcome> {

        this.#assertActive()
        if (Object.keys(invalidation).length === 0) {
            return throwCacheDiagnostic(
                'GEO_VIRTUAL_RASTER_CACHE_INVALIDATION_INVALID',
                'Cache invalidation requires at least one stable key field.',
                invalidation
            )
        }
        const ids = new Set<string>()
        const releasedById = new Map<string, number>()
        for (const [ id, entry ] of this.#memory) {
            if (!matchesInvalidation(entry.key, invalidation)) continue
            ids.add(id)
            releasedById.set(id, entry.byteLength)
            this.#memory.delete(id)
        }
        if (this.#persistentStore !== undefined) {
            for (const [ id, entry ] of this.#persistent) {
                if (!matchesInvalidation(entry.key, invalidation)) continue
                ids.add(id)
                releasedById.set(id, Math.max(releasedById.get(id) ?? 0, entry.byteLength))
                await cacheStorageOperation(
                    'delete',
                    () => this.#persistentStore!.delete(id)
                )
                this.#persistent.delete(id)
            }
            this.#storageFacts = await this.#readStorageFacts(false)
        }
        this.#invalidationCount += ids.size
        return Object.freeze({
            deletedCount: ids.size,
            releasedBytes: [ ...releasedById.values() ].reduce((sum, bytes) => sum + bytes, 0),
        })
    }

    async clear(): Promise<VirtualRasterCacheDeleteOutcome> {

        this.#assertActive()
        const ids = new Set([ ...this.#memory.keys(), ...this.#persistent.keys() ])
        const releasedBytes = this.policy.tier === 'persistent'
            ? this.#persistentBytes()
            : this.#memoryBytes()
        this.#memory.clear()
        if (this.#persistentStore !== undefined) {
            await cacheStorageOperation('clear', () => this.#persistentStore!.clear())
            this.#persistent.clear()
            this.#storageFacts = await this.#readStorageFacts(false)
        }
        this.#invalidationCount += ids.size
        return Object.freeze({ deletedCount: ids.size, releasedBytes })
    }

    inspect(): VirtualRasterCacheFacts {

        const facts: {
            tier: VirtualRasterCachePolicy['tier']
            disposed: boolean
            memoryEntryCount: number
            memoryBytes: number
            persistentEntryCount: number
            persistentBytes: number
            hitCount: number
            memoryHitCount: number
            persistentHitCount: number
            missCount: number
            putCount: number
            evictionCount: number
            invalidationCount: number
            quotaFailureCount: number
            storageUsage?: number
            storageQuota?: number
            persistenceRequested: boolean
            persisted?: boolean
        } = {
            tier: this.policy.tier,
            disposed: this.#disposed,
            memoryEntryCount: this.#memory.size,
            memoryBytes: this.#memoryBytes(),
            persistentEntryCount: this.#persistent.size,
            persistentBytes: this.#persistentBytes(),
            hitCount: this.#hitCount,
            memoryHitCount: this.#memoryHitCount,
            persistentHitCount: this.#persistentHitCount,
            missCount: this.#missCount,
            putCount: this.#putCount,
            evictionCount: this.#evictionCount,
            invalidationCount: this.#invalidationCount,
            quotaFailureCount: this.#quotaFailureCount,
            persistenceRequested: this.#storageFacts.persistenceRequested,
        }
        if (this.#storageFacts.usage !== undefined) facts.storageUsage = this.#storageFacts.usage
        if (this.#storageFacts.quota !== undefined) facts.storageQuota = this.#storageFacts.quota
        if (this.#storageFacts.persisted !== undefined) facts.persisted = this.#storageFacts.persisted
        return Object.freeze(facts)
    }

    dispose(): Promise<void> {

        if (this.#disposePromise !== undefined) return this.#disposePromise
        this.#disposePromise = this.#dispose()
        return this.#disposePromise
    }

    async #initialize(): Promise<void> {

        if (this.#persistentStore === undefined) return
        const entries = await cacheStorageOperation('list', () => this.#persistentStore!.list())
        for (const entry of entries) {
            assertPersistentEntry(entry)
            this.#persistent.set(entry.key.id, metadataFor(entry))
            this.#sequence = Math.max(this.#sequence, entry.accessSequence)
        }
        if (this.policy.tier === 'persistent') {
            await this.#enforcePersistentBudget(this.policy.persistentMaxBytes)
        }
        this.#storageFacts = await this.#readStorageFacts(this.#requestPersistence)
    }

    #retainMemory(entry: CacheEntry, maxBytes: number): number {

        if (maxBytes === 0 || entry.byteLength > maxBytes) {
            this.#memory.delete(entry.key.id)
            return 0
        }
        const stored = cloneEntry(entry)
        const existing = this.#memory.get(entry.key.id)
        if (existing !== undefined) this.#memory.delete(entry.key.id)
        this.#memory.set(entry.key.id, stored)
        let evictedCount = 0
        while (this.#memoryBytes() > maxBytes) {
            const victim = oldestEntry(this.#memory, entry.key.id)
            if (victim === undefined) break
            this.#memory.delete(victim.key.id)
            this.#evictionCount++
            evictedCount++
        }
        return evictedCount
    }

    async #makePersistentRoom(
        replacingId: string,
        byteLength: number,
        maxBytes: number
    ): Promise<number> {

        const existing = this.#persistent.get(replacingId)
        let projected = this.#persistentBytes() - (existing?.byteLength ?? 0) + byteLength
        let evictedCount = 0
        while (projected > maxBytes) {
            const victim = oldestMetadata(this.#persistent, replacingId)
            if (victim === undefined) break
            await cacheStorageOperation(
                'evict',
                () => this.#persistentStore!.delete(victim.key.id)
            )
            this.#persistent.delete(victim.key.id)
            this.#memory.delete(victim.key.id)
            projected -= victim.byteLength
            this.#evictionCount++
            evictedCount++
        }
        return evictedCount
    }

    async #enforcePersistentBudget(maxBytes: number): Promise<void> {

        while (this.#persistentBytes() > maxBytes) {
            const victim = oldestMetadata(this.#persistent)
            if (victim === undefined) return
            await cacheStorageOperation(
                'evict',
                () => this.#persistentStore!.delete(victim.key.id)
            )
            this.#persistent.delete(victim.key.id)
            this.#evictionCount++
        }
    }

    async #readStorageFacts(requestPersistence: boolean): Promise<VirtualRasterPersistentStorageFacts> {

        if (this.#persistentStore === undefined) {
            return Object.freeze({ persistenceRequested: false })
        }
        const facts = await cacheStorageOperation(
            'storage-facts',
            () => this.#persistentStore!.storageFacts({ requestPersistence })
        )
        return Object.freeze({
            ...facts,
            persistenceRequested: this.#storageFacts.persistenceRequested || requestPersistence,
        })
    }

    #memoryBytes(): number {

        return [ ...this.#memory.values() ].reduce((sum, entry) => sum + entry.byteLength, 0)
    }

    #persistentBytes(): number {

        return [ ...this.#persistent.values() ].reduce((sum, entry) => sum + entry.byteLength, 0)
    }

    async #dispose(): Promise<void> {

        if (this.#disposed) return
        this.#disposed = true
        this.#memory.clear()
        this.#persistent.clear()
        if (this.#persistentStore !== undefined) {
            await cacheStorageOperation('dispose', () => this.#persistentStore!.dispose())
        }
    }

    #assertActive(): void {

        if (this.#disposed) {
            return throwCacheDiagnostic(
                'GEO_VIRTUAL_RASTER_CACHE_DISPOSED',
                'Virtual raster cache is disposed.',
                { tier: this.policy.tier }
            )
        }
    }
}

export function createVirtualRasterCache(
    descriptor: VirtualRasterCacheDescriptor
): Promise<VirtualRasterCache> {

    return VirtualRasterCache.create(descriptor)
}

export function virtualRasterCacheKey(
    descriptor: VirtualRasterCacheKeyDescriptor
): VirtualRasterCacheKey {

    validateKeyDescriptor(descriptor)
    const coherence = freezeCoherence(descriptor.coherence)
    const id = JSON.stringify([
        descriptor.schemaVersion,
        descriptor.sourceId,
        descriptor.tileMatrixSetId,
        descriptor.tileMatrixSetUri,
        descriptor.matrixId,
        descriptor.tileRow,
        descriptor.tileColumn,
        descriptor.plane,
        coherenceIdentity(coherence),
        descriptor.encodedRepresentation,
        descriptor.decoderVersion,
        descriptor.sampleType,
    ])
    return Object.freeze({
        kind: 'virtual-raster-cache-key',
        id,
        sourceId: descriptor.sourceId,
        tileMatrixSetId: descriptor.tileMatrixSetId,
        tileMatrixSetUri: descriptor.tileMatrixSetUri,
        matrixId: descriptor.matrixId,
        tileRow: descriptor.tileRow,
        tileColumn: descriptor.tileColumn,
        plane: descriptor.plane,
        coherence,
        encodedRepresentation: descriptor.encodedRepresentation,
        decoderVersion: descriptor.decoderVersion,
        sampleType: descriptor.sampleType,
        schemaVersion: descriptor.schemaVersion,
    })
}

export type IndexedDbVirtualRasterPersistentStoreDescriptor = Readonly<{
    namespace: string
    databaseName?: string
}>

export async function openIndexedDbVirtualRasterPersistentStore(
    descriptor: IndexedDbVirtualRasterPersistentStoreDescriptor
): Promise<VirtualRasterPersistentStore> {

    requireText(descriptor.namespace, 'namespace')
    const factory = globalThis.indexedDB
    if (factory === undefined) {
        return throwCacheDiagnostic(
            'GEO_VIRTUAL_RASTER_INDEXEDDB_UNAVAILABLE',
            'The persistent cache tier requires IndexedDB in this execution context.',
            { namespace: descriptor.namespace }
        )
    }
    const databaseName = descriptor.databaseName ?? 'geoscratch-virtual-raster-cache-v1'
    const database = await cacheStorageOperation(
        'open',
        () => openDatabase(factory, databaseName)
    )
    return new IndexedDbVirtualRasterPersistentStore(database, descriptor.namespace)
}

type IndexedDbEntry = VirtualRasterPersistentEntry & Readonly<{
    storageKey: string
    namespace: string
}>

class IndexedDbVirtualRasterPersistentStore implements VirtualRasterPersistentStore {

    readonly kind = 'virtual-raster-persistent-store' as const
    readonly #database: IDBDatabase
    readonly #namespace: string
    #disposed = false

    constructor(database: IDBDatabase, namespace: string) {

        this.#database = database
        this.#namespace = namespace
    }

    async get(id: string): Promise<VirtualRasterPersistentEntry | undefined> {

        this.#assertActive()
        const transaction = this.#database.transaction('entries', 'readonly')
        const value = await requestValue<IndexedDbEntry | undefined>(
            transaction.objectStore('entries').get(this.#storageKey(id))
        )
        await transactionDone(transaction)
        return value === undefined ? undefined : stripIndexedDbEntry(value)
    }

    async put(entry: VirtualRasterPersistentEntry): Promise<void> {

        this.#assertActive()
        const transaction = this.#database.transaction('entries', 'readwrite')
        transaction.objectStore('entries').put({
            ...entry,
            storageKey: this.#storageKey(entry.key.id),
            namespace: this.#namespace,
        } satisfies IndexedDbEntry)
        await transactionDone(transaction)
    }

    async delete(id: string): Promise<boolean> {

        this.#assertActive()
        const transaction = this.#database.transaction('entries', 'readwrite')
        const store = transaction.objectStore('entries')
        const storageKey = this.#storageKey(id)
        const existing = await requestValue(store.getKey(storageKey))
        if (existing !== undefined) store.delete(storageKey)
        await transactionDone(transaction)
        return existing !== undefined
    }

    async list(): Promise<readonly VirtualRasterPersistentEntry[]> {

        this.#assertActive()
        const transaction = this.#database.transaction('entries', 'readonly')
        const index = transaction.objectStore('entries').index('namespace')
        const values = await requestValue<IndexedDbEntry[]>(
            index.getAll(IDBKeyRange.only(this.#namespace))
        )
        await transactionDone(transaction)
        return Object.freeze(values.map(stripIndexedDbEntry))
    }

    async clear(): Promise<number> {

        this.#assertActive()
        const transaction = this.#database.transaction('entries', 'readwrite')
        const store = transaction.objectStore('entries')
        const keys = await requestValue<IDBValidKey[]>(
            store.index('namespace').getAllKeys(IDBKeyRange.only(this.#namespace))
        )
        for (const key of keys) store.delete(key)
        await transactionDone(transaction)
        return keys.length
    }

    async storageFacts(
        options: Readonly<{ requestPersistence: boolean }>
    ): Promise<VirtualRasterPersistentStorageFacts> {

        const storage = globalThis.navigator?.storage
        let usage: number | undefined
        let quota: number | undefined
        let persisted: boolean | undefined
        if (storage !== undefined) {
            const estimate = await storage.estimate()
            usage = estimate.usage
            quota = estimate.quota
            persisted = await storage.persisted()
            if (options.requestPersistence && !persisted) persisted = await storage.persist()
        }
        return Object.freeze({
            ...(usage === undefined ? {} : { usage }),
            ...(quota === undefined ? {} : { quota }),
            ...(persisted === undefined ? {} : { persisted }),
            persistenceRequested: options.requestPersistence,
        })
    }

    async dispose(): Promise<void> {

        if (this.#disposed) return
        this.#disposed = true
        this.#database.close()
    }

    #storageKey(id: string): string {

        return `${this.#namespace}\u0000${id}`
    }

    #assertActive(): void {

        if (this.#disposed) {
            throw new TypeError('IndexedDB virtual raster cache store is disposed.')
        }
    }
}

function createEntry(
    key: VirtualRasterCacheKey,
    descriptor: VirtualRasterCacheRecordDescriptor,
    accessSequence: number
): CacheEntry {

    return {
        key,
        data: descriptor.data.slice(0),
        byteLength: descriptor.data.byteLength,
        contentType: descriptor.contentType,
        ...(descriptor.validator === undefined ? {} : { validator: descriptor.validator }),
        ...(descriptor.lastModified === undefined ? {} : { lastModified: descriptor.lastModified }),
        accessSequence,
    }
}

function cloneEntry(entry: CacheEntry | VirtualRasterPersistentEntry, accessSequence?: number): CacheEntry {

    return {
        key: entry.key,
        data: entry.data.slice(0),
        byteLength: entry.byteLength,
        contentType: entry.contentType,
        ...(entry.validator === undefined ? {} : { validator: entry.validator }),
        ...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
        accessSequence: accessSequence ?? entry.accessSequence,
    }
}

function cloneRecord(entry: CacheEntry | VirtualRasterPersistentEntry): VirtualRasterCacheRecord {

    return Object.freeze({
        data: entry.data.slice(0),
        byteLength: entry.byteLength,
        contentType: entry.contentType,
        ...(entry.validator === undefined ? {} : { validator: entry.validator }),
        ...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
    })
}

function metadataFor(entry: CacheEntry | VirtualRasterPersistentEntry): Omit<CacheEntry, 'data'> {

    return {
        key: entry.key,
        byteLength: entry.byteLength,
        contentType: entry.contentType,
        ...(entry.validator === undefined ? {} : { validator: entry.validator }),
        ...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
        accessSequence: entry.accessSequence,
    }
}

function freezePersistentEntry(entry: CacheEntry): VirtualRasterPersistentEntry {

    return Object.freeze({ ...entry })
}

function freezePutOutcome(
    status: VirtualRasterCachePutStatus,
    tier: VirtualRasterCachePolicy['tier'],
    byteLength: number,
    evictedCount: number
): VirtualRasterCachePutOutcome {

    return Object.freeze({ status, tier, byteLength, evictedCount })
}

function oldestEntry(entries: ReadonlyMap<string, CacheEntry>, exceptId?: string): CacheEntry | undefined {

    return [ ...entries.values() ]
        .filter(entry => entry.key.id !== exceptId)
        .sort(compareEntries)[0]
}

function oldestMetadata(
    entries: ReadonlyMap<string, Omit<CacheEntry, 'data'>>,
    exceptId?: string
): Omit<CacheEntry, 'data'> | undefined {

    return [ ...entries.values() ]
        .filter(entry => entry.key.id !== exceptId)
        .sort(compareEntries)[0]
}

function compareEntries(
    left: Pick<CacheEntry, 'accessSequence' | 'key'>,
    right: Pick<CacheEntry, 'accessSequence' | 'key'>
): number {

    return left.accessSequence - right.accessSequence || left.key.id.localeCompare(right.key.id)
}

function matchesInvalidation(
    key: VirtualRasterCacheKey,
    invalidation: VirtualRasterCacheInvalidation
): boolean {

    return (invalidation.sourceId === undefined || key.sourceId === invalidation.sourceId) &&
        (invalidation.tileMatrixSetId === undefined ||
            key.tileMatrixSetId === invalidation.tileMatrixSetId) &&
        (invalidation.matrixId === undefined || key.matrixId === invalidation.matrixId) &&
        (invalidation.plane === undefined || key.plane === invalidation.plane)
}

function freezePolicy(policy: VirtualRasterCachePolicy): VirtualRasterCachePolicy {

    return Object.freeze({ ...policy })
}

function freezeCoherence(coherence: VirtualRasterCacheCoherence): VirtualRasterCacheCoherence {

    return Object.freeze({ ...coherence })
}

function coherenceIdentity(coherence: VirtualRasterCacheCoherence): readonly unknown[] {

    switch (coherence.mode) {
        case 'immutable': return [ 'immutable', coherence.contentVersion ]
        case 'revisioned': return [ 'revisioned', coherence.revision, coherence.validator ?? null ]
        case 'editable': return [ 'editable-base', coherence.baseRevision ]
    }
}

function validatePolicy(policy: VirtualRasterCachePolicy): void {

    const valid = policy.tier === 'none' ||
        (policy.tier === 'memory' && nonNegativeSafeInteger(policy.maxBytes)) ||
        (policy.tier === 'persistent' &&
            nonNegativeSafeInteger(policy.memoryMaxBytes) &&
            positiveSafeInteger(policy.persistentMaxBytes) &&
            policy.backend === 'indexeddb' &&
            typeof policy.namespace === 'string' && policy.namespace.length > 0)
    if (!valid) {
        return throwCacheDiagnostic(
            'GEO_VIRTUAL_RASTER_CACHE_POLICY_INVALID',
            'Cache budgets must be finite bytes and persistent caches require an IndexedDB namespace.',
            policy
        )
    }
}

function validateKeyDescriptor(descriptor: VirtualRasterCacheKeyDescriptor): void {

    const textFields = [
        descriptor.sourceId,
        descriptor.tileMatrixSetId,
        descriptor.tileMatrixSetUri,
        descriptor.matrixId,
        descriptor.plane,
        descriptor.encodedRepresentation,
        descriptor.decoderVersion,
        descriptor.sampleType,
    ]
    if (textFields.some(value => typeof value !== 'string' || value.length === 0) ||
        !nonNegativeSafeInteger(descriptor.tileRow) ||
        !nonNegativeSafeInteger(descriptor.tileColumn) ||
        !positiveSafeInteger(descriptor.schemaVersion) ||
        !validCoherence(descriptor.coherence)) {
        return throwCacheDiagnostic(
            'GEO_VIRTUAL_RASTER_CACHE_KEY_INVALID',
            'Cache keys require complete source, standard tile, coherence, representation, and schema facts.',
            descriptor
        )
    }
}

function validCoherence(coherence: VirtualRasterCacheCoherence): boolean {

    if (coherence === null || typeof coherence !== 'object') return false
    switch (coherence.mode) {
        case 'immutable': return nonEmptyText(coherence.contentVersion)
        case 'revisioned': return nonEmptyText(coherence.revision) &&
            (coherence.validator === undefined || nonEmptyText(coherence.validator))
        case 'editable': return nonEmptyText(coherence.baseRevision)
        default: return false
    }
}

function validateRecord(descriptor: VirtualRasterCacheRecordDescriptor): void {

    if (!(descriptor.data instanceof ArrayBuffer) || descriptor.data.byteLength === 0 ||
        !nonEmptyText(descriptor.contentType) ||
        (descriptor.validator !== undefined && !nonEmptyText(descriptor.validator)) ||
        (descriptor.lastModified !== undefined && !nonEmptyText(descriptor.lastModified))) {
        return throwCacheDiagnostic(
            'GEO_VIRTUAL_RASTER_CACHE_RECORD_INVALID',
            'Cache records require non-empty source-neutral encoded bytes and content metadata.',
            descriptor
        )
    }
}

function assertCacheKey(key: VirtualRasterCacheKey): void {

    if (key.kind !== 'virtual-raster-cache-key' || key.id.length === 0) {
        return throwCacheDiagnostic(
            'GEO_VIRTUAL_RASTER_CACHE_KEY_INVALID',
            'Cache access requires a key from virtualRasterCacheKey().',
            key
        )
    }
}

function assertPersistentEntry(
    entry: VirtualRasterPersistentEntry,
    expectedKey?: VirtualRasterCacheKey
): void {

    if (entry.key.kind !== 'virtual-raster-cache-key' ||
        (expectedKey !== undefined && entry.key.id !== expectedKey.id) ||
        !(entry.data instanceof ArrayBuffer) || entry.data.byteLength !== entry.byteLength ||
        !nonNegativeSafeInteger(entry.accessSequence)) {
        return throwCacheDiagnostic(
            'GEO_VIRTUAL_RASTER_CACHE_RECORD_INVALID',
            'Persistent cache entries must preserve their complete key and encoded byte length.',
            { expectedKeyId: expectedKey?.id, entry }
        )
    }
}

function isQuotaError(error: unknown): boolean {

    return error !== null && typeof error === 'object' &&
        (error as { name?: unknown }).name === 'QuotaExceededError'
}

function nonEmptyText(value: unknown): value is string {

    return typeof value === 'string' && value.length > 0
}

function requireText(value: unknown, field: string): asserts value is string {

    if (!nonEmptyText(value)) throw new TypeError(`${field} must be a non-empty string.`)
}

function nonNegativeSafeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) >= 0
}

function positiveSafeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}

function throwCacheDiagnostic(code: string, message: string, actual: unknown): never {

    return throwGeoDiagnostic({
        code,
        phase: 'cache',
        subject: { kind: 'virtual-raster-cache' },
        message,
        actual,
    })
}

async function cacheStorageOperation<T>(
    operation: string,
    run: () => Promise<T>
): Promise<T> {

    try {
        return await run()
    } catch (error) {
        return cacheStorageFailure(operation, error)
    }
}

function cacheStorageFailure(operation: string, error: unknown): never {

    if (hasCacheDiagnostic(error)) throw error
    return throwCacheDiagnostic(
        'GEO_VIRTUAL_RASTER_CACHE_STORAGE_FAILED',
        `Virtual raster persistent storage ${operation} failed.`,
        {
            operation,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
        }
    )
}

function hasCacheDiagnostic(error: unknown): boolean {

    return error !== null && typeof error === 'object' &&
        (error as { diagnostic?: { phase?: unknown } }).diagnostic?.phase === 'cache'
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {

    return new Promise((resolve, reject) => {
        const request = factory.open(name, 1)
        request.onupgradeneeded = () => {
            const database = request.result
            const store = database.createObjectStore('entries', { keyPath: 'storageKey' })
            store.createIndex('namespace', 'namespace', { unique: false })
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'))
        request.onblocked = () => reject(new Error('IndexedDB schema upgrade is blocked.'))
    })
}

function requestValue<T = unknown>(request: IDBRequest<T>): Promise<T> {

    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
    })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {

    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
    })
}

function stripIndexedDbEntry(entry: IndexedDbEntry): VirtualRasterPersistentEntry {

    return Object.freeze({
        key: entry.key,
        data: entry.data,
        byteLength: entry.byteLength,
        contentType: entry.contentType,
        ...(entry.validator === undefined ? {} : { validator: entry.validator }),
        ...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
        accessSequence: entry.accessSequence,
    })
}
