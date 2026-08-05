export type PersistentCacheKeyDescriptor = Readonly<{
    id: string
    revision: string
}>

export type PersistentCacheKey = Readonly<{
    kind: 'persistent-cache-key'
    id: string
    revision: string
    storageKey: string
}>

export type PersistentCacheState = 'active' | 'disposing' | 'disposed'

export type PersistentCacheDescriptor = Readonly<{
    namespace: string
    maxPayloadBytes: number
    maxEntries: number
    maxHistory?: number
    requestPersistence?: boolean
}>

export type CacheEntryDescriptor<Metadata extends object> = Readonly<{
    metadata: Metadata
    payload?: ArrayBuffer
}>

export type CacheRecord<Metadata extends object> = Readonly<{
    key: PersistentCacheKey
    metadata: Metadata
    payload?: ArrayBuffer
    byteLength: number
    storedAt: number
    lastAccessedAt: number
}>

export type CacheMissReason =
    | 'absent'
    | 'payload-missing'
    | 'payload-size-mismatch'

export type CacheReadOutcome<Metadata extends object> =
    | Readonly<{
        status: 'hit'
        record: CacheRecord<Metadata>
    }>
    | Readonly<{
        status: 'miss'
        reason: CacheMissReason
        diagnostic?: import('./diagnostics.js').CacheDiagnostic
    }>

export type CachePutStatus =
    | 'stored'
    | 'already-present'
    | 'too-large'
    | 'quota-exceeded'

export type CachePutOutcome = Readonly<{
    status: CachePutStatus
    byteLength: number
    evictedCount: number
    diagnostic?: import('./diagnostics.js').CacheDiagnostic
}>

export type CacheDeleteOutcome = Readonly<{
    deletedCount: number
    releasedBytes: number
    cleanupFailureCount: number
}>

export type CacheInvalidation = Readonly<{
    idPrefix: string
}>

export type CacheGarbageCollectionOptions = Readonly<{
    minimumPendingAgeMs?: number
}>

export type CacheGarbageCollectionOutcome = Readonly<{
    removedPayloadCount: number
    removedPendingCount: number
    cleanupFailureCount: number
}>

export type CacheHistoryKind =
    | 'opened'
    | 'hit'
    | 'miss'
    | 'stored'
    | 'already-present'
    | 'quota-exceeded'
    | 'evicted'
    | 'deleted'
    | 'invalidated'
    | 'cleared'
    | 'repaired'
    | 'garbage-collected'
    | 'cleanup-failed'
    | 'disposed'

export type CacheHistoryEntry = Readonly<{
    sequence: number
    kind: CacheHistoryKind
    operation: string
    keyId?: string
    revision?: string
    detail?: string
    diagnostic?: import('./diagnostics.js').CacheDiagnostic
}>

export type PersistentCacheFacts = Readonly<{
    namespace: string
    observationScope: 'instance'
    state: PersistentCacheState
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
}>

export type CacheStorageFacts = Readonly<{
    usage?: number
    quota?: number
    persisted?: boolean
    persistenceRequested: boolean
}>
