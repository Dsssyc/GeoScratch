import { isScratchDiagnosticError } from '../diagnostics/base.js'
import {
    cacheDiagnosticError,
    createCacheDiagnostic,
} from './diagnostics.js'
import type {
    CacheDiagnostic,
    CacheStorageErrorFacts,
} from './diagnostics.js'
import type {
    CacheDeleteOutcome,
    CacheEntryDescriptor,
    CacheGarbageCollectionOptions,
    CacheGarbageCollectionOutcome,
    CacheHistoryEntry,
    CacheHistoryKind,
    CacheInvalidation,
    CachePutOutcome,
    CacheReadOutcome,
    CacheRecord,
    CacheStorageFacts,
    PersistentCacheDescriptor,
    PersistentCacheFacts,
    PersistentCacheKey,
    PersistentCacheKeyDescriptor,
    PersistentCacheLifecycle,
    PersistentCacheState,
} from './types.js'

const DATABASE_NAME = 'geoscratch-persistent-cache-v1'
const DATABASE_VERSION = 1
const ENTRIES_STORE = 'entries'
const PENDING_STORE = 'pendingPayloads'
const NAMESPACE_INDEX = 'namespace'
const ROOT_DIRECTORY = 'geoscratch-persistent-cache-v1'
const PAYLOAD_DIRECTORY = 'payloads'
const DEFAULT_MAX_HISTORY = 64
const DEFAULT_RECOVERY_GRACE_MS = 5 * 60 * 1000
const MAX_NAMESPACE_LENGTH = 120
const MAX_NAMESPACE_UTF8_BYTES = 120
const MAX_KEY_ID_LENGTH = 1024
const MAX_REVISION_LENGTH = 512

type StoredCacheEntry<Metadata extends object = object> = {
    storageKey: string
    namespace: string
    key: PersistentCacheKey
    metadata: Metadata
    payloadId?: string
    byteLength: number
    storedAt: number
    lastAccessedAt: number
    accessSequence: number
}

type PendingPayload = {
    journalKey: string
    namespace: string
    payloadId: string
    createdAt: number
}

type PutCommit<Metadata extends object> = Readonly<{
    status: 'stored' | 'already-present' | 'journal-missing'
    entry?: StoredCacheEntry<Metadata>
    victims: readonly StoredCacheEntry[]
}>

type DeleteCommit = Readonly<{
    entries: readonly StoredCacheEntry[]
}>

type DirectoryWithEntries = FileSystemDirectoryHandle & Readonly<{
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}>

/** Owns one IndexedDB metadata store and OPFS payload namespace with explicit lifecycle policy. */
export class PersistentCache<Metadata extends object = Readonly<Record<string, unknown>>> {

    readonly namespace: string
    readonly maxPayloadBytes: number
    readonly maxEntries: number
    readonly maxHistory: number
    readonly lifecycle: PersistentCacheLifecycle
    readonly #database: IDBDatabase
    readonly #payloadDirectory: FileSystemDirectoryHandle
    readonly #requestPersistence: boolean
    readonly #entries = new Map<string, StoredCacheEntry<Metadata>>()
    readonly #activeOperations = new Set<Promise<unknown>>()
    readonly #history: CacheHistoryEntry[] = []
    #state: PersistentCacheState = 'active'
    #disposePromise: Promise<void> | undefined
    #sequence = 0
    #historySequence = 0
    #hitCount = 0
    #missCount = 0
    #recoveredMissCount = 0
    #putCount = 0
    #alreadyPresentCount = 0
    #evictionCount = 0
    #deletionCount = 0
    #garbageCollectionCount = 0
    #cleanupFailureCount = 0
    #quotaFailureCount = 0
    #persistenceAttempted = false
    #storageFacts: CacheStorageFacts

    private constructor(
        descriptor: PersistentCacheDescriptor,
        database: IDBDatabase,
        payloadDirectory: FileSystemDirectoryHandle
    ) {

        this.namespace = descriptor.namespace
        this.maxPayloadBytes = descriptor.maxPayloadBytes
        this.maxEntries = descriptor.maxEntries
        this.maxHistory = descriptor.maxHistory ?? DEFAULT_MAX_HISTORY
        this.lifecycle = snapshotLifecycle(descriptor.lifecycle)
        this.#requestPersistence = descriptor.requestPersistence ?? false
        this.#database = database
        this.#payloadDirectory = payloadDirectory
        this.#storageFacts = Object.freeze({
            persistenceRequested: this.#requestPersistence,
        })
    }

    static async open<Metadata extends object = Readonly<Record<string, unknown>>>(
        descriptor: PersistentCacheDescriptor
    ): Promise<PersistentCache<Metadata>> {

        validateDescriptor(descriptor)
        const indexedDb = globalThis.indexedDB
        const storage = globalThis.navigator?.storage
        if (indexedDb === undefined || storage === undefined ||
            typeof storage.getDirectory !== 'function') {
            throw cacheDiagnosticError({
                code: 'CACHE_STORAGE_UNAVAILABLE',
                severity: 'error',
                phase: 'cache-open',
                subject: { kind: 'PersistentCache', id: descriptor.namespace },
                message: 'PersistentCache requires IndexedDB and the origin-private file system.',
                expected: { indexedDB: true, opfs: true },
                actual: {
                    indexedDB: indexedDb !== undefined,
                    opfs: typeof storage?.getDirectory === 'function',
                },
                operation: 'open',
                storage: indexedDb === undefined ? 'indexeddb' : 'opfs',
                retriable: false,
            })
        }

        let database: IDBDatabase | undefined
        try {
            database = await openDatabase(indexedDb)
            const root = await storage.getDirectory()
            const cacheRoot = await root.getDirectoryHandle(ROOT_DIRECTORY, { create: true })
            const namespaceDirectory = await cacheRoot.getDirectoryHandle(
                namespaceDirectoryName(descriptor.namespace),
                { create: true }
            )
            const payloadDirectory = await namespaceDirectory.getDirectoryHandle(
                PAYLOAD_DIRECTORY,
                { create: true }
            )
            const cache = new PersistentCache<Metadata>(descriptor, database, payloadDirectory)
            await cache.#initialize()
            return cache
        } catch (error) {
            database?.close()
            if (isScratchDiagnosticError(error)) throw error
            return storageFailure(
                descriptor.namespace,
                'cache-open',
                'open',
                storageKind(error, 'indexeddb'),
                error
            )
        }
    }

    get(key: PersistentCacheKey): Promise<CacheReadOutcome<Metadata>> {

        assertCacheKey(key)
        return this.#track(() => this.#get(key))
    }

    put(
        key: PersistentCacheKey,
        descriptor: CacheEntryDescriptor<Metadata>
    ): Promise<CachePutOutcome> {

        assertCacheKey(key)
        const metadata = cloneMetadata(descriptor.metadata, this.namespace, key)
        const payload = snapshotPayload(descriptor.payload, this.namespace, key)
        return this.#track(() => this.#put(key, metadata, payload))
    }

    delete(key: PersistentCacheKey): Promise<CacheDeleteOutcome> {

        assertCacheKey(key)
        return this.#track(() => this.#delete(key))
    }

    invalidate(invalidation: CacheInvalidation): Promise<CacheDeleteOutcome> {

        if (!nonEmptyText(invalidation.idPrefix) ||
            invalidation.idPrefix.length > MAX_KEY_ID_LENGTH) {
            throw cacheDiagnosticError({
                code: 'CACHE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'cache-invalidate',
                subject: { kind: 'PersistentCache', id: this.namespace },
                message: 'Cache invalidation requires a non-empty bounded idPrefix.',
                actual: invalidation,
                operation: 'invalidate',
            })
        }
        return this.#track(() => this.#invalidate(invalidation.idPrefix))
    }

    clear(): Promise<CacheDeleteOutcome> {

        return this.#track(() => this.#clear())
    }

    collectGarbage(
        options: CacheGarbageCollectionOptions = {}
    ): Promise<CacheGarbageCollectionOutcome> {

        const minimumPendingAgeMs = options.minimumPendingAgeMs ?? DEFAULT_RECOVERY_GRACE_MS
        if (!nonNegativeSafeInteger(minimumPendingAgeMs)) {
            throw cacheDiagnosticError({
                code: 'CACHE_DESCRIPTOR_INVALID',
                severity: 'error',
                phase: 'cache-recovery',
                subject: { kind: 'PersistentCache', id: this.namespace },
                message: 'Cache garbage collection requires a non-negative pending age.',
                actual: options,
                operation: 'collect-garbage',
            })
        }
        return this.#track(() => this.#collectGarbage(minimumPendingAgeMs))
    }

    inspect(): PersistentCacheFacts {

        const values = [ ...this.#entries.values() ]
        const facts: {
            namespace: string
            observationScope: 'instance'
            state: PersistentCacheState
            lifecycle: PersistentCacheLifecycle
            maxPayloadBytes: number
            maxEntries: number
            maxHistory: number
            activeOperationCount: number
            entryCount: number
            metadataOnlyEntryCount: number
            payloadBytes: number
            hitCount: number
            missCount: number
            recoveredMissCount: number
            putCount: number
            alreadyPresentCount: number
            evictionCount: number
            deletionCount: number
            garbageCollectionCount: number
            cleanupFailureCount: number
            quotaFailureCount: number
            storageUsage?: number
            storageQuota?: number
            persistenceRequested: boolean
            persisted?: boolean
            history: readonly CacheHistoryEntry[]
        } = {
            namespace: this.namespace,
            observationScope: 'instance',
            state: this.#state,
            lifecycle: this.lifecycle,
            maxPayloadBytes: this.maxPayloadBytes,
            maxEntries: this.maxEntries,
            maxHistory: this.maxHistory,
            activeOperationCount: this.#activeOperations.size,
            entryCount: values.length,
            metadataOnlyEntryCount: values.filter(entry => entry.payloadId === undefined).length,
            payloadBytes: values.reduce((sum, entry) => sum + entry.byteLength, 0),
            hitCount: this.#hitCount,
            missCount: this.#missCount,
            recoveredMissCount: this.#recoveredMissCount,
            putCount: this.#putCount,
            alreadyPresentCount: this.#alreadyPresentCount,
            evictionCount: this.#evictionCount,
            deletionCount: this.#deletionCount,
            garbageCollectionCount: this.#garbageCollectionCount,
            cleanupFailureCount: this.#cleanupFailureCount,
            quotaFailureCount: this.#quotaFailureCount,
            persistenceRequested: this.#storageFacts.persistenceRequested,
            history: Object.freeze([ ...this.#history ]),
        }
        if (this.#storageFacts.usage !== undefined) facts.storageUsage = this.#storageFacts.usage
        if (this.#storageFacts.quota !== undefined) facts.storageQuota = this.#storageFacts.quota
        if (this.#storageFacts.persisted !== undefined) facts.persisted = this.#storageFacts.persisted
        return Object.freeze(facts)
    }

    dispose(): Promise<void> {

        if (this.#disposePromise !== undefined) return this.#disposePromise
        this.#state = 'disposing'
        this.#disposePromise = this.#dispose()
        return this.#disposePromise
    }

    async #initialize(): Promise<void> {

        const entries = await databaseOperation(
            this.namespace,
            'cache-open',
            'list-entries',
            () => listEntries(this.#database, this.namespace)
        )
        const invalid: StoredCacheEntry[] = []
        for (const entry of entries) {
            if (!validStoredEntry(entry, this.namespace)) {
                invalid.push(entry)
                continue
            }
            const typed = entry as StoredCacheEntry<Metadata>
            this.#entries.set(typed.storageKey, typed)
            this.#sequence = Math.max(this.#sequence, typed.accessSequence)
        }
        if (invalid.length > 0) {
            await databaseOperation(
                this.namespace,
                'cache-recovery',
                'delete-invalid-metadata',
                () => deleteStorageKeysIfInvalid(
                    this.#database,
                    this.namespace,
                    invalid.map(entry => entry.storageKey)
                )
            )
        }
        if (clearsOnOpen(this.lifecycle)) {
            await this.#clearLifecycle('open-lifecycle-reset')
            await this.#refreshStorageFacts()
            this.#record('opened', 'open', undefined, lifecycleDetail(this.lifecycle))
            return
        }
        const victims = await databaseOperation(
            this.namespace,
            'cache-recovery',
            'enforce-budget',
            () => enforceBudget(
                this.#database,
                this.namespace,
                this.maxPayloadBytes,
                this.maxEntries
            )
        )
        for (const victim of victims) this.#entries.delete(victim.storageKey)
        this.#evictionCount += victims.length
        await this.#cleanupEntries(victims, 'open-budget')
        await this.#collectGarbage(DEFAULT_RECOVERY_GRACE_MS)
        await this.#refreshStorageFacts()
        this.#record('opened', 'open')
    }

    async #get(key: PersistentCacheKey): Promise<CacheReadOutcome<Metadata>> {

        let entry = await databaseOperation(
            this.namespace,
            'cache-read',
            'read-metadata',
            () => readEntry(this.#database, namespacedStorageKey(this.namespace, key.storageKey))
        ) as StoredCacheEntry<Metadata> | undefined
        if (entry === undefined) {
            this.#entries.delete(namespacedStorageKey(this.namespace, key.storageKey))
            return this.#miss(key, 'absent')
        }
        if (!validStoredEntry(entry, this.namespace) || entry.key.storageKey !== key.storageKey) {
            return this.#invalidEntryMiss(
                key,
                namespacedStorageKey(this.namespace, key.storageKey)
            )
        }
        if (entry.payloadId === undefined) {
            entry = await this.#touch(entry)
            this.#hitCount++
            this.#entries.set(entry.storageKey, entry)
            this.#record('hit', 'get', key)
            return Object.freeze({ status: 'hit', record: cacheRecord(entry) })
        }

        for (let attempt = 0; attempt < 2; attempt++) {
            const payloadId = entry.payloadId
            if (payloadId === undefined) {
                entry = await this.#touch(entry)
                this.#hitCount++
                this.#entries.set(entry.storageKey, entry)
                this.#record('hit', 'get', key)
                return Object.freeze({ status: 'hit', record: cacheRecord(entry) })
            }
            let payload: ArrayBuffer
            try {
                payload = await readPayload(this.#payloadDirectory, payloadId)
            } catch (error) {
                if (!isNotFoundError(error)) {
                    return storageFailure(
                        this.namespace,
                        'cache-read',
                        'read-payload',
                        'opfs',
                        error,
                        key
                    )
                }
                const latest = await readEntry(
                    this.#database,
                    namespacedStorageKey(this.namespace, key.storageKey)
                ) as StoredCacheEntry<Metadata> | undefined
                if (latest === undefined) return this.#miss(key, 'absent')
                if (latest.payloadId !== entry.payloadId && attempt === 0) {
                    entry = latest
                    continue
                }
                return this.#repairMiss(
                    key,
                    entry,
                    'payload-missing',
                    'CACHE_PAYLOAD_MISSING'
                )
            }
            if (payload.byteLength !== entry.byteLength) {
                const latest = await readEntry(
                    this.#database,
                    namespacedStorageKey(this.namespace, key.storageKey)
                ) as StoredCacheEntry<Metadata> | undefined
                if (latest !== undefined && latest.payloadId !== entry.payloadId && attempt === 0) {
                    entry = latest
                    continue
                }
                return this.#repairMiss(
                    key,
                    entry,
                    'payload-size-mismatch',
                    'CACHE_PAYLOAD_SIZE_MISMATCH'
                )
            }
            entry = await this.#touch(entry)
            this.#hitCount++
            this.#entries.set(entry.storageKey, entry)
            this.#record('hit', 'get', key)
            return Object.freeze({ status: 'hit', record: cacheRecord(entry, payload) })
        }
        return this.#miss(key, 'absent')
    }

    async #put(
        key: PersistentCacheKey,
        metadata: Metadata,
        payload: ArrayBuffer | undefined
    ): Promise<CachePutOutcome> {

        this.#putCount++
        const byteLength = payload?.byteLength ?? 0
        if (byteLength > this.maxPayloadBytes) {
            return freezePutOutcome('too-large', byteLength, 0)
        }
        const storageKey = namespacedStorageKey(this.namespace, key.storageKey)
        const existing = await databaseOperation(
            this.namespace,
            'cache-write',
            'check-existing',
            () => readEntry(this.#database, storageKey)
        )
        if (existing !== undefined) {
            return this.#alreadyPresent(
                key,
                byteLength,
                existing as StoredCacheEntry<Metadata>
            )
        }

        const payloadId = payload === undefined ? undefined : createPayloadId()
        if (payloadId !== undefined && payload !== undefined) {
            const pending = pendingPayload(this.namespace, payloadId)
            try {
                await insertPending(this.#database, pending)
                await writePayload(this.#payloadDirectory, payloadId, payload)
            } catch (error) {
                await this.#bestEffortAbortPayload(payloadId, 'write-abort')
                if (isQuotaError(error)) return this.#quotaOutcome(key, byteLength, 'write-payload', error)
                return storageFailure(
                    this.namespace,
                    'cache-write',
                    'write-payload',
                    storageKind(error, 'opfs'),
                    error,
                    key
                )
            }
        }

        const now = Date.now()
        const entry: StoredCacheEntry<Metadata> = {
            storageKey,
            namespace: this.namespace,
            key,
            metadata,
            ...(payloadId === undefined ? {} : { payloadId }),
            byteLength,
            storedAt: now,
            lastAccessedAt: now,
            accessSequence: ++this.#sequence,
        }
        let commit: PutCommit<Metadata>
        try {
            commit = await commitEntry(
                this.#database,
                entry,
                this.maxPayloadBytes,
                this.maxEntries
            )
        } catch (error) {
            if (payloadId !== undefined) await this.#bestEffortAbortPayload(payloadId, 'commit-abort')
            if (isQuotaError(error)) return this.#quotaOutcome(key, byteLength, 'commit-metadata', error)
            return storageFailure(
                this.namespace,
                'cache-write',
                'commit-metadata',
                'indexeddb',
                error,
                key
            )
        }
        if (commit.status === 'already-present') {
            if (payloadId !== undefined) await this.#bestEffortAbortPayload(payloadId, 'race-loser')
            return this.#alreadyPresent(key, byteLength, commit.entry)
        }
        if (commit.status === 'journal-missing') {
            if (payloadId !== undefined) {
                await this.#bestEffortAbortPayload(payloadId, 'journal-reclaimed')
            }
            return storageFailure(
                this.namespace,
                'cache-write',
                'commit-reclaimed-payload',
                'coordination',
                namedError(
                    'AbortError',
                    'The pending payload journal was reclaimed before metadata commit.'
                ),
                key
            )
        }
        this.#entries.set(entry.storageKey, entry)
        for (const victim of commit.victims) this.#entries.delete(victim.storageKey)
        this.#evictionCount += commit.victims.length
        for (const victim of commit.victims) {
            this.#record('evicted', 'put-budget', victim.key)
        }
        await this.#cleanupEntries(commit.victims, 'put-budget')
        await this.#refreshStorageFacts()
        this.#record('stored', 'put', key)
        return freezePutOutcome('stored', byteLength, commit.victims.length)
    }

    async #delete(key: PersistentCacheKey): Promise<CacheDeleteOutcome> {

        const commit = await databaseOperation(
            this.namespace,
            'cache-delete',
            'delete-entry',
            () => deleteExactEntry(
                this.#database,
                namespacedStorageKey(this.namespace, key.storageKey)
            )
        )
        return this.#finalizeDeletion(commit, 'delete', key)
    }

    async #invalidate(idPrefix: string): Promise<CacheDeleteOutcome> {

        const commit = await databaseOperation(
            this.namespace,
            'cache-invalidate',
            'invalidate-prefix',
            () => deleteMatchingEntries(
                this.#database,
                this.namespace,
                entry => entry.key.id.startsWith(idPrefix)
            )
        )
        const outcome = await this.#finalizeDeletion(commit, 'invalidate')
        this.#record('invalidated', 'invalidate', undefined, `prefix:${idPrefix}`)
        return outcome
    }

    async #clear(operation = 'clear'): Promise<CacheDeleteOutcome> {

        const commit = await databaseOperation(
            this.namespace,
            'cache-clear',
            operation,
            () => deleteMatchingEntries(this.#database, this.namespace, () => true)
        )
        const outcome = await this.#finalizeDeletion(commit, operation)
        this.#record('cleared', operation, undefined, `entries:${outcome.deletedCount}`)
        return outcome
    }

    async #collectGarbage(minimumPendingAgeMs: number): Promise<CacheGarbageCollectionOutcome> {

        const stalePending = await reclaimStalePending(
            this.#database,
            this.namespace,
            Date.now() - minimumPendingAgeMs
        )
        const [ entries, pending ] = await Promise.all([
            listEntries(this.#database, this.namespace),
            listPending(this.#database, this.namespace),
        ])
        const referenced = new Set(entries.flatMap(entry => (
            entry.payloadId === undefined ? [] : [ payloadFileName(entry.payloadId) ]
        )))
        const livePending = new Set(pending
            .filter(item => !stalePending.includes(item))
            .map(item => payloadFileName(item.payloadId)))
        let removedPayloadCount = 0
        let cleanupFailureCount = 0
        try {
            for await (const [ name, handle ] of directoryEntries(this.#payloadDirectory)) {
                if (handle.kind !== 'file' || referenced.has(name) || livePending.has(name)) continue
                const payloadId = payloadIdFromFileName(name)
                if (payloadId === undefined || await payloadIsReferenced(
                    this.#database,
                    this.namespace,
                    payloadId
                )) continue
                try {
                    await this.#payloadDirectory.removeEntry(name)
                    removedPayloadCount++
                } catch (error) {
                    cleanupFailureCount++
                    this.#recordCleanupFailure('garbage-collect', error)
                }
            }
        } catch (error) {
            return storageFailure(
                this.namespace,
                'cache-recovery',
                'list-payloads',
                'opfs',
                error
            )
        }
        this.#garbageCollectionCount++
        this.#record(
            'garbage-collected',
            'collect-garbage',
            undefined,
            `payloads:${removedPayloadCount},pending:${stalePending.length}`
        )
        return Object.freeze({
            removedPayloadCount,
            removedPendingCount: stalePending.length,
            cleanupFailureCount,
        })
    }

    async #clearLifecycle(operation: string): Promise<void> {

        await this.#clear(operation)
        const garbage = await this.#collectGarbage(0)
        if (garbage.cleanupFailureCount === 0) return
        throw cacheDiagnosticError({
            code: 'CACHE_STORAGE_FAILED',
            severity: 'error',
            phase: 'cache-lifecycle',
            subject: { kind: 'PersistentCache', id: this.namespace },
            message: 'Persistent cache lifecycle cleanup left payloads for later recovery.',
            actual: {
                lifecycle: this.lifecycle,
                cleanupFailureCount: garbage.cleanupFailureCount,
            },
            operation,
            storage: 'opfs',
            retriable: true,
        })
    }

    async #repairMiss(
        key: PersistentCacheKey,
        entry: StoredCacheEntry,
        reason: 'payload-missing' | 'payload-size-mismatch',
        code: 'CACHE_ENTRY_INVALID' | 'CACHE_PAYLOAD_MISSING' | 'CACHE_PAYLOAD_SIZE_MISMATCH'
    ): Promise<CacheReadOutcome<Metadata>> {

        const deleted = await deleteEntryIfCurrent(
            this.#database,
            entry.storageKey,
            entry.payloadId
        )
        if (deleted) {
            this.#entries.delete(entry.storageKey)
            this.#deletionCount++
            await this.#cleanupEntries([ entry ], 'repair')
        }
        const diagnostic = createCacheDiagnostic({
            code,
            severity: 'warn',
            phase: 'cache-read',
            subject: { kind: 'CachePayload', id: key.id },
            message: reason === 'payload-missing'
                ? 'Persistent cache metadata referenced a missing payload and was repaired.'
                : 'Persistent cache payload length did not match metadata and was repaired.',
            expected: { byteLength: entry.byteLength },
            actual: { reason },
            operation: 'repair-read',
            keyId: key.id,
            revision: key.revision,
            storage: 'opfs',
            retriable: true,
        })
        this.#missCount++
        this.#recoveredMissCount++
        this.#record('repaired', 'get', key, reason, diagnostic)
        return Object.freeze({ status: 'miss', reason, diagnostic })
    }

    async #invalidEntryMiss(
        key: PersistentCacheKey,
        storageKey: string
    ): Promise<CacheReadOutcome<Metadata>> {

        const commit = await databaseOperation(
            this.namespace,
            'cache-recovery',
            'delete-invalid-entry',
            () => deleteStorageKeyIfInvalid(
                this.#database,
                this.namespace,
                storageKey,
                key.storageKey
            )
        )
        if (commit.status === 'current-valid') return this.#get(key)
        this.#entries.delete(storageKey)
        if (commit.status === 'missing') return this.#miss(key, 'absent')
        this.#deletionCount++
        if (nonEmptyText(commit.entry.payloadId)) {
            try {
                await removePayload(this.#payloadDirectory, commit.entry.payloadId)
            } catch (error) {
                this.#recordCleanupFailure('delete-invalid-entry', error)
            }
        }
        const diagnostic = createCacheDiagnostic({
            code: 'CACHE_ENTRY_INVALID',
            severity: 'warn',
            phase: 'cache-read',
            subject: { kind: 'CacheEntry', id: key.id },
            message: 'Persistent cache metadata was malformed and was removed.',
            actual: { storageKey },
            operation: 'repair-read',
            keyId: key.id,
            revision: key.revision,
            storage: 'indexeddb',
            retriable: true,
        })
        this.#missCount++
        this.#recoveredMissCount++
        this.#record('repaired', 'get', key, 'invalid-metadata', diagnostic)
        return Object.freeze({
            status: 'miss',
            reason: 'payload-missing',
            diagnostic,
        })
    }

    #miss(
        key: PersistentCacheKey,
        reason: 'absent'
    ): CacheReadOutcome<Metadata> {

        this.#missCount++
        this.#record('miss', 'get', key, reason)
        return Object.freeze({ status: 'miss', reason })
    }

    async #touch(entry: StoredCacheEntry<Metadata>): Promise<StoredCacheEntry<Metadata>> {

        const touched = await touchEntry(
            this.#database,
            entry,
            Date.now(),
            ++this.#sequence
        )
        return (touched ?? entry) as StoredCacheEntry<Metadata>
    }

    #alreadyPresent(
        key: PersistentCacheKey,
        byteLength: number,
        entry?: StoredCacheEntry<Metadata>
    ): CachePutOutcome {

        if (entry !== undefined) this.#entries.set(entry.storageKey, entry)
        this.#alreadyPresentCount++
        this.#record('already-present', 'put', key)
        return freezePutOutcome('already-present', byteLength, 0)
    }

    #quotaOutcome(
        key: PersistentCacheKey,
        byteLength: number,
        operation: string,
        error: unknown
    ): CachePutOutcome {

        this.#quotaFailureCount++
        const diagnostic = createCacheDiagnostic({
            code: 'CACHE_QUOTA_EXCEEDED',
            severity: 'warn',
            phase: 'cache-write',
            subject: { kind: 'CacheEntry', id: key.id },
            message: 'Persistent cache storage quota was exceeded; the entry was not committed.',
            actual: { byteLength, errorName: errorName(error) },
            operation,
            keyId: key.id,
            revision: key.revision,
            storage: operation === 'write-payload' ? 'opfs' : 'indexeddb',
            storageErrorName: errorName(error),
            retriable: true,
        })
        this.#record('quota-exceeded', operation, key, undefined, diagnostic)
        return freezePutOutcome('quota-exceeded', byteLength, 0, diagnostic)
    }

    async #finalizeDeletion(
        commit: DeleteCommit,
        operation: string,
        key?: PersistentCacheKey
    ): Promise<CacheDeleteOutcome> {

        for (const entry of commit.entries) this.#entries.delete(entry.storageKey)
        const before = this.#cleanupFailureCount
        await this.#cleanupEntries(commit.entries, operation)
        const releasedBytes = commit.entries.reduce((sum, entry) => sum + entry.byteLength, 0)
        this.#deletionCount += commit.entries.length
        await this.#refreshStorageFacts()
        if (key !== undefined && commit.entries.length > 0) this.#record('deleted', operation, key)
        return Object.freeze({
            deletedCount: commit.entries.length,
            releasedBytes,
            cleanupFailureCount: this.#cleanupFailureCount - before,
        })
    }

    async #cleanupEntries(entries: readonly StoredCacheEntry[], operation: string): Promise<void> {

        const payloadIds = new Set(entries.flatMap(entry => (
            entry.payloadId === undefined ? [] : [ entry.payloadId ]
        )))
        for (const payloadId of payloadIds) {
            try {
                await removePayload(this.#payloadDirectory, payloadId)
            } catch (error) {
                this.#recordCleanupFailure(operation, error)
            }
        }
    }

    async #bestEffortAbortPayload(payloadId: string, operation: string): Promise<void> {

        try {
            await deletePendingRows(this.#database, [ pendingJournalKey(this.namespace, payloadId) ])
        } catch (error) {
            this.#recordCleanupFailure(`${operation}-pending`, error)
        }
        try {
            await removePayload(this.#payloadDirectory, payloadId)
        } catch (error) {
            this.#recordCleanupFailure(`${operation}-payload`, error)
        }
    }

    #recordCleanupFailure(operation: string, error: unknown): void {

        if (isNotFoundError(error)) return
        this.#cleanupFailureCount++
        const diagnostic = createCacheDiagnostic({
            code: 'CACHE_STORAGE_FAILED',
            severity: 'warn',
            phase: 'cache-recovery',
            subject: { kind: 'PersistentCache', id: this.namespace },
            message: 'A committed cache operation left cleanup work for a later garbage collection.',
            actual: { errorName: errorName(error), errorMessage: errorMessage(error) },
            operation,
            storage: storageKind(error, 'opfs'),
            storageErrorName: errorName(error),
            retriable: true,
        })
        this.#record('cleanup-failed', operation, undefined, undefined, diagnostic)
    }

    async #refreshStorageFacts(): Promise<void> {

        const storage = globalThis.navigator.storage
        try {
            const estimate = await storage.estimate()
            let persisted = await storage.persisted()
            if (this.#requestPersistence && !persisted && !this.#persistenceAttempted) {
                this.#persistenceAttempted = true
                persisted = await storage.persist()
            }
            this.#storageFacts = Object.freeze({
                ...(estimate.usage === undefined ? {} : { usage: estimate.usage }),
                ...(estimate.quota === undefined ? {} : { quota: estimate.quota }),
                persisted,
                persistenceRequested: this.#requestPersistence,
            })
        } catch (error) {
            const diagnostic = createCacheDiagnostic({
                code: 'CACHE_STORAGE_FAILED',
                severity: 'warn',
                phase: 'cache-open',
                subject: { kind: 'PersistentCache', id: this.namespace },
                message: 'Storage usage or persistence facts could not be read.',
                actual: { errorName: errorName(error), errorMessage: errorMessage(error) },
                operation: 'storage-facts',
                storage: 'storage-manager',
                storageErrorName: errorName(error),
                retriable: true,
            })
            this.#record('cleanup-failed', 'storage-facts', undefined, undefined, diagnostic)
        }
    }

    #track<Result>(run: () => Promise<Result>): Promise<Result> {

        this.#assertActive()
        const operation = Promise.resolve().then(run)
        this.#activeOperations.add(operation)
        void operation.then(
            () => this.#activeOperations.delete(operation),
            () => this.#activeOperations.delete(operation)
        )
        return operation
    }

    #assertActive(): void {

        if (this.#state === 'active') return
        throw cacheDiagnosticError({
            code: 'CACHE_DISPOSED',
            severity: 'error',
            phase: 'cache-lifecycle',
            subject: { kind: 'PersistentCache', id: this.namespace },
            message: 'PersistentCache no longer accepts operations.',
            actual: { state: this.#state },
            operation: 'assert-active',
            retriable: false,
        })
    }

    async #dispose(): Promise<void> {

        await Promise.allSettled([ ...this.#activeOperations ])
        let cleanupFailure: unknown
        try {
            if (this.lifecycle.kind === 'session') {
                await this.#clearLifecycle('session-dispose')
            }
        } catch (error) {
            cleanupFailure = error
        } finally {
            this.#database.close()
            this.#state = 'disposed'
            this.#record('disposed', 'dispose')
        }
        if (cleanupFailure !== undefined) throw cleanupFailure
    }

    #record(
        kind: CacheHistoryKind,
        operation: string,
        key?: PersistentCacheKey,
        detail?: string,
        diagnostic?: CacheDiagnostic
    ): void {

        if (this.maxHistory === 0) return
        const entry: CacheHistoryEntry = Object.freeze({
            sequence: ++this.#historySequence,
            kind,
            operation,
            ...(key === undefined ? {} : { keyId: key.id, revision: key.revision }),
            ...(detail === undefined ? {} : { detail }),
            ...(diagnostic === undefined ? {} : { diagnostic }),
        })
        this.#history.push(entry)
        if (this.#history.length > this.maxHistory) this.#history.shift()
    }
}

/** Validates and freezes the logical id and revision that identify one cache record. */
export function persistentCacheKey(
    descriptor: PersistentCacheKeyDescriptor
): PersistentCacheKey {

    if (!nonEmptyText(descriptor.id) || descriptor.id.length > MAX_KEY_ID_LENGTH ||
        !nonEmptyText(descriptor.revision) || descriptor.revision.length > MAX_REVISION_LENGTH) {
        throw cacheDiagnosticError({
            code: 'CACHE_KEY_INVALID',
            severity: 'error',
            phase: 'cache-key',
            subject: { kind: 'PersistentCacheKey' },
            message: 'Persistent cache keys require bounded non-empty id and revision strings.',
            actual: descriptor,
            operation: 'create-key',
        })
    }
    return Object.freeze({
        kind: 'persistent-cache-key',
        id: descriptor.id,
        revision: descriptor.revision,
        storageKey: JSON.stringify([ descriptor.id, descriptor.revision ]),
    })
}

function validateDescriptor(descriptor: PersistentCacheDescriptor): void {

    if (!nonEmptyText(descriptor.namespace) || descriptor.namespace.length > MAX_NAMESPACE_LENGTH ||
        !wellFormedText(descriptor.namespace) ||
        new TextEncoder().encode(descriptor.namespace).byteLength > MAX_NAMESPACE_UTF8_BYTES ||
        !nonNegativeSafeInteger(descriptor.maxPayloadBytes) ||
        !positiveSafeInteger(descriptor.maxEntries) ||
        !validLifecycle(descriptor.lifecycle) ||
        (descriptor.maxHistory !== undefined && !nonNegativeSafeInteger(descriptor.maxHistory)) ||
        (descriptor.requestPersistence !== undefined &&
            typeof descriptor.requestPersistence !== 'boolean')) {
        throw cacheDiagnosticError({
            code: 'CACHE_DESCRIPTOR_INVALID',
            severity: 'error',
            phase: 'cache-open',
            subject: cacheSubject(descriptor.namespace),
            message: 'PersistentCache requires a bounded namespace, finite budgets, and an explicit lifecycle.',
            actual: descriptor,
            operation: 'validate-descriptor',
        })
    }
}

function validLifecycle(value: unknown): value is PersistentCacheLifecycle {

    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const lifecycle = value as Record<string, unknown>
    const keys = Object.keys(lifecycle).sort().join('|')
    if (lifecycle.kind === 'durable') {
        return keys === 'kind|open' &&
            (lifecycle.open === 'reuse' || lifecycle.open === 'clear-before-open')
    }
    return lifecycle.kind === 'session' && keys === 'kind'
}

function snapshotLifecycle(lifecycle: PersistentCacheLifecycle): PersistentCacheLifecycle {

    return lifecycle.kind === 'durable'
        ? Object.freeze({ kind: lifecycle.kind, open: lifecycle.open })
        : Object.freeze({ kind: lifecycle.kind })
}

function clearsOnOpen(lifecycle: PersistentCacheLifecycle): boolean {

    return lifecycle.kind === 'session' || lifecycle.open === 'clear-before-open'
}

function lifecycleDetail(lifecycle: PersistentCacheLifecycle): string {

    return lifecycle.kind === 'session'
        ? 'lifecycle:session'
        : `lifecycle:durable/${lifecycle.open}`
}

function assertCacheKey(key: PersistentCacheKey): void {

    if (key?.kind !== 'persistent-cache-key' || !nonEmptyText(key.id) ||
        !nonEmptyText(key.revision) ||
        key.storageKey !== JSON.stringify([ key.id, key.revision ])) {
        throw cacheDiagnosticError({
            code: 'CACHE_KEY_INVALID',
            severity: 'error',
            phase: 'cache-key',
            subject: { kind: 'PersistentCacheKey' },
            message: 'Cache access requires a key from persistentCacheKey().',
            actual: key,
            operation: 'validate-key',
        })
    }
}

function cloneMetadata<Metadata extends object>(
    metadata: Metadata,
    namespace: string,
    key: PersistentCacheKey
): Metadata {

    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw cacheDiagnosticError({
            code: 'CACHE_ENTRY_INVALID',
            severity: 'error',
            phase: 'cache-write',
            subject: { kind: 'CacheEntry', id: key.id },
            message: 'Cache metadata must be a structured-cloneable object.',
            actual: { metadataType: metadata === null ? 'null' : typeof metadata },
            operation: 'snapshot-metadata',
            keyId: key.id,
            revision: key.revision,
        })
    }
    try {
        return structuredClone(metadata)
    } catch (error) {
        throw cacheDiagnosticError({
            code: 'CACHE_ENTRY_INVALID',
            severity: 'error',
            phase: 'cache-write',
            subject: { kind: 'PersistentCache', id: namespace },
            message: 'Cache metadata could not be structured-cloned.',
            actual: { errorName: errorName(error), errorMessage: errorMessage(error) },
            operation: 'snapshot-metadata',
            keyId: key.id,
            revision: key.revision,
        }, error)
    }
}

function snapshotPayload(
    payload: ArrayBuffer | undefined,
    namespace: string,
    key: PersistentCacheKey
): ArrayBuffer | undefined {

    if (payload === undefined) return undefined
    if (!(payload instanceof ArrayBuffer) || payload.byteLength === 0) {
        throw cacheDiagnosticError({
            code: 'CACHE_ENTRY_INVALID',
            severity: 'error',
            phase: 'cache-write',
            subject: { kind: 'PersistentCache', id: namespace },
            message: 'Cache payload must be a non-empty whole ArrayBuffer; omit it for metadata-only entries.',
            actual: {
                payloadType: payload?.constructor?.name,
                byteLength: payload?.byteLength,
            },
            operation: 'snapshot-payload',
            keyId: key.id,
            revision: key.revision,
        })
    }
    return payload.slice(0)
}

function cacheRecord<Metadata extends object>(
    entry: StoredCacheEntry<Metadata>,
    payload?: ArrayBuffer
): CacheRecord<Metadata> {

    return Object.freeze({
        key: persistentCacheKey(entry.key),
        metadata: structuredClone(entry.metadata),
        ...(payload === undefined ? {} : { payload }),
        byteLength: entry.byteLength,
        storedAt: entry.storedAt,
        lastAccessedAt: entry.lastAccessedAt,
    })
}

function freezePutOutcome(
    status: CachePutOutcome['status'],
    byteLength: number,
    evictedCount: number,
    diagnostic?: CacheDiagnostic
): CachePutOutcome {

    return Object.freeze({
        status,
        byteLength,
        evictedCount,
        ...(diagnostic === undefined ? {} : { diagnostic }),
    })
}

async function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {

    return await new Promise((resolve, reject) => {
        const request = factory.open(DATABASE_NAME, DATABASE_VERSION)
        request.onupgradeneeded = () => {
            const database = request.result
            if (!database.objectStoreNames.contains(ENTRIES_STORE)) {
                const entries = database.createObjectStore(ENTRIES_STORE, { keyPath: 'storageKey' })
                entries.createIndex(NAMESPACE_INDEX, 'namespace', { unique: false })
            }
            if (!database.objectStoreNames.contains(PENDING_STORE)) {
                const pending = database.createObjectStore(PENDING_STORE, { keyPath: 'journalKey' })
                pending.createIndex(NAMESPACE_INDEX, 'namespace', { unique: false })
            }
        }
        request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close()
            resolve(request.result)
        }
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'))
        request.onblocked = () => reject(new Error('IndexedDB schema upgrade is blocked.'))
    })
}

async function readEntry(
    database: IDBDatabase,
    storageKey: string
): Promise<StoredCacheEntry | undefined> {

    const transaction = database.transaction(ENTRIES_STORE, 'readonly')
    const done = transactionDone(transaction)
    const entry = await requestValue<StoredCacheEntry | undefined>(
        transaction.objectStore(ENTRIES_STORE).get(storageKey)
    )
    await done
    return entry
}

async function listEntries(
    database: IDBDatabase,
    namespace: string
): Promise<readonly StoredCacheEntry[]> {

    const transaction = database.transaction(ENTRIES_STORE, 'readonly')
    const done = transactionDone(transaction)
    const entries = await requestValue<StoredCacheEntry[]>(
        transaction.objectStore(ENTRIES_STORE).index(NAMESPACE_INDEX)
            .getAll(IDBKeyRange.only(namespace))
    )
    await done
    return entries
}

async function listPending(
    database: IDBDatabase,
    namespace: string
): Promise<readonly PendingPayload[]> {

    const transaction = database.transaction(PENDING_STORE, 'readonly')
    const done = transactionDone(transaction)
    const pending = await requestValue<PendingPayload[]>(
        transaction.objectStore(PENDING_STORE).index(NAMESPACE_INDEX)
            .getAll(IDBKeyRange.only(namespace))
    )
    await done
    return pending
}

async function insertPending(database: IDBDatabase, pending: PendingPayload): Promise<void> {

    const transaction = relaxedTransaction(database, PENDING_STORE)
    const done = transactionDone(transaction)
    transaction.objectStore(PENDING_STORE).put(pending)
    transaction.commit()
    await done
}

async function deletePendingRows(database: IDBDatabase, journalKeys: readonly string[]): Promise<void> {

    if (journalKeys.length === 0) return
    const transaction = relaxedTransaction(database, PENDING_STORE)
    const done = transactionDone(transaction)
    const store = transaction.objectStore(PENDING_STORE)
    for (const key of journalKeys) store.delete(key)
    transaction.commit()
    await done
}

async function reclaimStalePending(
    database: IDBDatabase,
    namespace: string,
    createdAtOrBefore: number
): Promise<readonly PendingPayload[]> {

    const transaction = relaxedTransaction(database, PENDING_STORE)
    const done = transactionDone(transaction)
    const store = transaction.objectStore(PENDING_STORE)
    const current = await requestValue<PendingPayload[]>(
        store.index(NAMESPACE_INDEX).getAll(IDBKeyRange.only(namespace))
    )
    const stale = current.filter(item => item.createdAt <= createdAtOrBefore)
    for (const item of stale) store.delete(item.journalKey)
    transaction.commit()
    await done
    return Object.freeze(stale)
}

async function commitEntry<Metadata extends object>(
    database: IDBDatabase,
    entry: StoredCacheEntry<Metadata>,
    maxPayloadBytes: number,
    maxEntries: number
): Promise<PutCommit<Metadata>> {

    const transaction = relaxedTransaction(database, [ ENTRIES_STORE, PENDING_STORE ])
    const done = transactionDone(transaction)
    const entriesStore = transaction.objectStore(ENTRIES_STORE)
    const current = await requestValue<StoredCacheEntry[]>(
        entriesStore.index(NAMESPACE_INDEX).getAll(IDBKeyRange.only(entry.namespace))
    )
    if (current.some(candidate => candidate.storageKey === entry.storageKey)) {
        const existing = current.find(candidate => candidate.storageKey === entry.storageKey)
        if (entry.payloadId !== undefined) {
            transaction.objectStore(PENDING_STORE)
                .delete(pendingJournalKey(entry.namespace, entry.payloadId))
        }
        transaction.commit()
        await done
        return Object.freeze({
            status: 'already-present',
            entry: existing as StoredCacheEntry<Metadata>,
            victims: Object.freeze([]),
        })
    }
    if (entry.payloadId !== undefined) {
        const journal = await requestValue<PendingPayload | undefined>(
            transaction.objectStore(PENDING_STORE)
                .get(pendingJournalKey(entry.namespace, entry.payloadId))
        )
        if (journal === undefined) {
            transaction.commit()
            await done
            return Object.freeze({ status: 'journal-missing', victims: Object.freeze([]) })
        }
    }
    const victims = selectBudgetVictims(current, entry, maxPayloadBytes, maxEntries)
    for (const victim of victims) entriesStore.delete(victim.storageKey)
    entriesStore.put(entry)
    if (entry.payloadId !== undefined) {
        transaction.objectStore(PENDING_STORE)
            .delete(pendingJournalKey(entry.namespace, entry.payloadId))
    }
    transaction.commit()
    await done
    return Object.freeze({
        status: 'stored',
        entry,
        victims: Object.freeze(victims),
    })
}

async function enforceBudget(
    database: IDBDatabase,
    namespace: string,
    maxPayloadBytes: number,
    maxEntries: number
): Promise<readonly StoredCacheEntry[]> {

    const transaction = relaxedTransaction(database, ENTRIES_STORE)
    const done = transactionDone(transaction)
    const store = transaction.objectStore(ENTRIES_STORE)
    const current = await requestValue<StoredCacheEntry[]>(
        store.index(NAMESPACE_INDEX).getAll(IDBKeyRange.only(namespace))
    )
    const victims = selectExistingBudgetVictims(current, maxPayloadBytes, maxEntries)
    for (const victim of victims) store.delete(victim.storageKey)
    transaction.commit()
    await done
    return Object.freeze(victims)
}

async function deleteExactEntry(
    database: IDBDatabase,
    storageKey: string
): Promise<DeleteCommit> {

    const transaction = relaxedTransaction(database, ENTRIES_STORE)
    const done = transactionDone(transaction)
    const store = transaction.objectStore(ENTRIES_STORE)
    const entry = await requestValue<StoredCacheEntry | undefined>(store.get(storageKey))
    if (entry !== undefined) store.delete(storageKey)
    transaction.commit()
    await done
    return Object.freeze({ entries: Object.freeze(entry === undefined ? [] : [ entry ]) })
}

async function deleteMatchingEntries(
    database: IDBDatabase,
    namespace: string,
    matches: (entry: StoredCacheEntry) => boolean
): Promise<DeleteCommit> {

    const transaction = relaxedTransaction(database, ENTRIES_STORE)
    const done = transactionDone(transaction)
    const store = transaction.objectStore(ENTRIES_STORE)
    const current = await requestValue<StoredCacheEntry[]>(
        store.index(NAMESPACE_INDEX).getAll(IDBKeyRange.only(namespace))
    )
    const entries = current.filter(matches)
    for (const entry of entries) store.delete(entry.storageKey)
    transaction.commit()
    await done
    return Object.freeze({ entries: Object.freeze(entries) })
}

async function deleteEntryIfCurrent(
    database: IDBDatabase,
    storageKey: string,
    payloadId: string | undefined
): Promise<boolean> {

    const transaction = relaxedTransaction(database, ENTRIES_STORE)
    const done = transactionDone(transaction)
    const store = transaction.objectStore(ENTRIES_STORE)
    const current = await requestValue<StoredCacheEntry | undefined>(store.get(storageKey))
    const matches = current !== undefined && current.payloadId === payloadId
    if (matches) store.delete(storageKey)
    transaction.commit()
    await done
    return matches
}

type InvalidEntryCommit =
    | Readonly<{ status: 'deleted', entry: StoredCacheEntry }>
    | Readonly<{ status: 'missing' }>
    | Readonly<{ status: 'current-valid' }>

async function deleteStorageKeyIfInvalid(
    database: IDBDatabase,
    namespace: string,
    storageKey: IDBValidKey,
    expectedKeyStorageKey: string
): Promise<InvalidEntryCommit> {

    const transaction = relaxedTransaction(database, ENTRIES_STORE)
    const done = transactionDone(transaction)
    const store = transaction.objectStore(ENTRIES_STORE)
    const current = await requestValue<StoredCacheEntry | undefined>(store.get(storageKey))
    if (current === undefined) {
        transaction.commit()
        await done
        return Object.freeze({ status: 'missing' })
    }
    if (validStoredEntry(current, namespace) &&
        current.key.storageKey === expectedKeyStorageKey) {
        transaction.commit()
        await done
        return Object.freeze({ status: 'current-valid' })
    }
    store.delete(storageKey)
    transaction.commit()
    await done
    return Object.freeze({ status: 'deleted', entry: current })
}

async function deleteStorageKeysIfInvalid(
    database: IDBDatabase,
    namespace: string,
    storageKeys: readonly IDBValidKey[]
): Promise<void> {

    if (storageKeys.length === 0) return
    const transaction = relaxedTransaction(database, ENTRIES_STORE)
    const done = transactionDone(transaction)
    const store = transaction.objectStore(ENTRIES_STORE)
    const current = await Promise.all(storageKeys.map(storageKey =>
        requestValue<StoredCacheEntry | undefined>(store.get(storageKey))
    ))
    for (let index = 0; index < storageKeys.length; index++) {
        const entry = current[index]
        if (entry !== undefined && !validStoredEntry(entry, namespace)) {
            store.delete(storageKeys[index]!)
        }
    }
    transaction.commit()
    await done
}

async function payloadIsReferenced(
    database: IDBDatabase,
    namespace: string,
    payloadId: string
): Promise<boolean> {

    const transaction = database.transaction([ ENTRIES_STORE, PENDING_STORE ], 'readonly')
    const done = transactionDone(transaction)
    const entriesRequest = requestValue<StoredCacheEntry[]>(
        transaction.objectStore(ENTRIES_STORE).index(NAMESPACE_INDEX)
            .getAll(IDBKeyRange.only(namespace))
    )
    const pendingRequest = requestValue<PendingPayload | undefined>(
        transaction.objectStore(PENDING_STORE).get(pendingJournalKey(namespace, payloadId))
    )
    const [ entries, pending ] = await Promise.all([ entriesRequest, pendingRequest ])
    await done
    return pending !== undefined || entries.some(entry => entry.payloadId === payloadId)
}

async function touchEntry(
    database: IDBDatabase,
    entry: StoredCacheEntry,
    lastAccessedAt: number,
    accessSequence: number
): Promise<StoredCacheEntry | undefined> {

    const transaction = relaxedTransaction(database, ENTRIES_STORE)
    const done = transactionDone(transaction)
    const store = transaction.objectStore(ENTRIES_STORE)
    const current = await requestValue<StoredCacheEntry | undefined>(store.get(entry.storageKey))
    let touched: StoredCacheEntry | undefined
    if (current !== undefined && current.payloadId === entry.payloadId &&
        current.storedAt === entry.storedAt) {
        touched = { ...current, lastAccessedAt, accessSequence }
        store.put(touched)
    }
    transaction.commit()
    await done
    return touched
}

function selectBudgetVictims(
    current: readonly StoredCacheEntry[],
    entry: StoredCacheEntry,
    maxPayloadBytes: number,
    maxEntries: number
): StoredCacheEntry[] {

    const ordered = [ ...current ].sort(compareLru)
    let count = current.length + 1
    let bytes = current.reduce((sum, item) => sum + item.byteLength, 0) + entry.byteLength
    const victims: StoredCacheEntry[] = []
    while ((count > maxEntries || bytes > maxPayloadBytes) && ordered.length > 0) {
        const victim = ordered.shift()!
        victims.push(victim)
        count--
        bytes -= victim.byteLength
    }
    return victims
}

function selectExistingBudgetVictims(
    current: readonly StoredCacheEntry[],
    maxPayloadBytes: number,
    maxEntries: number
): StoredCacheEntry[] {

    const ordered = [ ...current ].sort(compareLru)
    let count = current.length
    let bytes = current.reduce((sum, item) => sum + item.byteLength, 0)
    const victims: StoredCacheEntry[] = []
    while ((count > maxEntries || bytes > maxPayloadBytes) && ordered.length > 0) {
        const victim = ordered.shift()!
        victims.push(victim)
        count--
        bytes -= victim.byteLength
    }
    return victims
}

function compareLru(left: StoredCacheEntry, right: StoredCacheEntry): number {

    return left.lastAccessedAt - right.lastAccessedAt ||
        left.accessSequence - right.accessSequence ||
        left.storageKey.localeCompare(right.storageKey)
}

async function writePayload(
    directory: FileSystemDirectoryHandle,
    payloadId: string,
    payload: ArrayBuffer
): Promise<void> {

    const handle = await directory.getFileHandle(payloadFileName(payloadId), { create: true })
    const writable = await handle.createWritable()
    try {
        await writable.write(payload)
        await writable.close()
    } catch (error) {
        try {
            await writable.abort(error)
        } catch {
            // The original write failure is authoritative.
        }
        throw error
    }
}

async function readPayload(
    directory: FileSystemDirectoryHandle,
    payloadId: string
): Promise<ArrayBuffer> {

    const handle = await directory.getFileHandle(payloadFileName(payloadId))
    return await (await handle.getFile()).arrayBuffer()
}

async function removePayload(
    directory: FileSystemDirectoryHandle,
    payloadId: string
): Promise<void> {

    await directory.removeEntry(payloadFileName(payloadId))
}

function directoryEntries(
    directory: FileSystemDirectoryHandle
): AsyncIterableIterator<[string, FileSystemHandle]> {

    return (directory as DirectoryWithEntries).entries()
}

function payloadFileName(payloadId: string): string {

    return `${payloadId}.bin`
}

function payloadIdFromFileName(fileName: string): string | undefined {

    return fileName.endsWith('.bin') && fileName.length > 4
        ? fileName.slice(0, -4)
        : undefined
}

function pendingPayload(namespace: string, payloadId: string): PendingPayload {

    return {
        journalKey: pendingJournalKey(namespace, payloadId),
        namespace,
        payloadId,
        createdAt: Date.now(),
    }
}

function pendingJournalKey(namespace: string, payloadId: string): string {

    return `${namespace}\u0000${payloadId}`
}

function namespacedStorageKey(namespace: string, storageKey: string): string {

    return `${namespace}\u0000${storageKey}`
}

function namespaceDirectoryName(namespace: string): string {

    const bytes = new TextEncoder().encode(namespace)
    return `n-${[ ...bytes ].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function createPayloadId(): string {

    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    return [ ...bytes ].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function namedError(name: string, message: string): Error {

    const error = new Error(message)
    error.name = name
    return error
}

function validStoredEntry(entry: unknown, namespace: string): entry is StoredCacheEntry {

    if (entry === null || typeof entry !== 'object') return false
    const value = entry as Partial<StoredCacheEntry>
    return value.namespace === namespace && nonEmptyText(value.storageKey) &&
        value.key?.kind === 'persistent-cache-key' && nonEmptyText(value.key.id) &&
        nonEmptyText(value.key.revision) && nonEmptyText(value.key.storageKey) &&
        value.key.storageKey === JSON.stringify([ value.key.id, value.key.revision ]) &&
        value.storageKey === namespacedStorageKey(namespace, value.key.storageKey) &&
        value.metadata !== null && typeof value.metadata === 'object' &&
        (value.payloadId === undefined || nonEmptyText(value.payloadId)) &&
        nonNegativeSafeInteger(value.byteLength) &&
        (value.payloadId === undefined ? value.byteLength === 0 : value.byteLength > 0) &&
        nonNegativeSafeInteger(value.storedAt) && nonNegativeSafeInteger(value.lastAccessedAt) &&
        nonNegativeSafeInteger(value.accessSequence)
}

function relaxedTransaction(
    database: IDBDatabase,
    stores: string | string[]
): IDBTransaction {

    return database.transaction(stores, 'readwrite', { durability: 'relaxed' })
}

function requestValue<Value>(request: IDBRequest<Value>): Promise<Value> {

    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
    })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {

    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(
            transaction.error ?? new Error('IndexedDB transaction failed.')
        )
        transaction.onabort = () => reject(
            transaction.error ?? new Error('IndexedDB transaction aborted.')
        )
    })
}

async function databaseOperation<Result>(
    namespace: string,
    phase: 'cache-open' | 'cache-read' | 'cache-write' | 'cache-delete' |
        'cache-invalidate' | 'cache-clear' | 'cache-recovery',
    operation: string,
    run: () => Promise<Result>
): Promise<Result> {

    try {
        return await run()
    } catch (error) {
        if (isScratchDiagnosticError(error)) throw error
        return storageFailure(namespace, phase, operation, 'indexeddb', error)
    }
}

function storageFailure(
    namespace: string,
    phase: 'cache-open' | 'cache-read' | 'cache-write' | 'cache-delete' |
        'cache-invalidate' | 'cache-clear' | 'cache-recovery',
    operation: string,
    storage: CacheStorageErrorFacts['storage'],
    error: unknown,
    key?: PersistentCacheKey
): never {

    if (isScratchDiagnosticError(error)) throw error
    const facts: CacheStorageErrorFacts = Object.freeze({
        operation,
        storage,
        errorName: errorName(error),
        errorMessage: errorMessage(error),
        retriable: isRetriableStorageError(error),
    })
    throw cacheDiagnosticError({
        code: 'CACHE_STORAGE_FAILED',
        severity: 'error',
        phase,
        subject: { kind: 'PersistentCache', id: namespace },
        message: `Persistent cache ${operation} failed.`,
        actual: facts,
        operation,
        ...(key === undefined ? {} : { keyId: key.id, revision: key.revision }),
        storage,
        storageErrorName: errorName(error),
        retriable: facts.retriable,
    }, error, facts)
}

function storageKind(
    error: unknown,
    fallback: CacheStorageErrorFacts['storage']
): CacheStorageErrorFacts['storage'] {

    const name = errorName(error)
    return name === 'NotFoundError' || name === 'NoModificationAllowedError' ? 'opfs' : fallback
}

function isQuotaError(error: unknown): boolean {

    return errorName(error) === 'QuotaExceededError'
}

function isNotFoundError(error: unknown): boolean {

    return errorName(error) === 'NotFoundError'
}

function isRetriableStorageError(error: unknown): boolean {

    return [ 'AbortError', 'InvalidStateError', 'NotReadableError', 'UnknownError' ]
        .includes(errorName(error))
}

function errorName(error: unknown): string {

    return error instanceof Error ? error.name : typeof error
}

function errorMessage(error: unknown): string {

    return error instanceof Error ? error.message : String(error)
}

function textOrUndefined(value: unknown): string | undefined {

    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function cacheSubject(value: unknown): Readonly<{
    kind: 'PersistentCache'
    id?: string
}> {

    const id = textOrUndefined(value)
    return id === undefined ? Object.freeze({ kind: 'PersistentCache' }) :
        Object.freeze({ kind: 'PersistentCache', id })
}

function nonEmptyText(value: unknown): value is string {

    return typeof value === 'string' && value.length > 0
}

function wellFormedText(value: string): boolean {

    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index)
        if (unit >= 0xd800 && unit <= 0xdbff) {
            if (index + 1 >= value.length) return false
            const next = value.charCodeAt(index + 1)
            if (next < 0xdc00 || next > 0xdfff) return false
            index++
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return false
        }
    }
    return true
}

function nonNegativeSafeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) >= 0
}

function positiveSafeInteger(value: unknown): value is number {

    return Number.isSafeInteger(value) && Number(value) > 0
}
