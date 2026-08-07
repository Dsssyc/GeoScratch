import {
    PersistentCache,
    persistentCacheKey,
} from 'geoscratch/scratch'
import type {
    CacheReadOutcome,
    PersistentCacheLifecycle,
    PersistentCacheKey,
} from 'geoscratch/scratch'

type ProofMetadata = Readonly<{
    kind: 'raw' | 'metadata-only'
    seed?: number
}>

const RAW_KEY = persistentCacheKey({ id: 'proof/raw', revision: 'v1' })
const METADATA_KEY = persistentCacheKey({ id: 'proof/metadata', revision: 'v1' })

export async function prepareScratchPersistentCacheProof(namespace: string) {

    const cache = await openProofCache(namespace, true)
    await cache.clear()
    const source = Uint8Array.of(1, 2, 3, 4).buffer
    const stored = await cache.put(RAW_KEY, {
        metadata: { kind: 'raw', seed: 1 },
        payload: source,
    })
    new Uint8Array(source)[0] = 99
    const immutable = await cache.put(RAW_KEY, {
        metadata: { kind: 'raw', seed: 9 },
        payload: Uint8Array.of(9, 9, 9, 9).buffer,
    })
    const metadataOnly = await cache.put(METADATA_KEY, {
        metadata: { kind: 'metadata-only' },
    })
    const oversize = await cache.put(
        persistentCacheKey({ id: 'proof/oversize', revision: 'v1' }),
        {
            metadata: { kind: 'raw', seed: 8 },
            payload: new Uint8Array(65).buffer,
        }
    )
    const immediate = serializeRead(await cache.get(RAW_KEY))
    const beforeDispose = cache.inspect()
    const firstDispose = cache.dispose()
    const secondDispose = cache.dispose()
    await Promise.all([ firstDispose, secondDispose ])
    const afterDispose = cache.inspect()

    const budgetNamespace = `${namespace}.budget`
    const budget = await PersistentCache.open<ProofMetadata>({
        namespace: budgetNamespace,
        maxPayloadBytes: 8,
        maxEntries: 2,
        maxHistory: 16,
        lifecycle: { kind: 'durable', open: 'reuse' },
    })
    await budget.clear()
    const first = key('budget/first')
    const second = key('budget/second')
    const third = key('budget/third')
    await budget.put(first, raw(1))
    await budget.put(second, raw(2))
    await budget.get(first)
    const thirdWrite = await budget.put(third, raw(3))
    const budgetProof = {
        first: serializeRead(await budget.get(first)),
        second: serializeRead(await budget.get(second)),
        third: serializeRead(await budget.get(third)),
        thirdWrite,
        facts: budget.inspect(),
    }
    await budget.clear()
    await budget.dispose()
    const lifecycle = await prepareLifecycleProof(namespace)

    return Object.freeze({
        stored,
        immutable,
        metadataOnly,
        oversize,
        immediate,
        beforeDispose,
        afterDispose,
        disposeIdentity: firstDispose === secondDispose,
        budget: budgetProof,
        lifecycle,
    })
}

export async function finishScratchPersistentCacheProof(namespace: string) {

    const cache = await openProofCache(namespace, false)
    const rawReload = serializeRead(await cache.get(RAW_KEY))
    const metadataReload = serializeRead(await cache.get(METADATA_KEY))
    const revisionMiss = serializeRead(await cache.get(
        persistentCacheKey({ id: RAW_KEY.id, revision: 'v2' })
    ))

    await cache.put(key('proof/group/a'), raw(5))
    await cache.put(key('proof/group/b'), raw(6))
    await cache.put(key('proof/other'), raw(7))
    const invalidated = await cache.invalidate({ idPrefix: 'proof/group/' })

    await createOrphanPayload(namespace)
    const garbage = await cache.collectGarbage({ minimumPendingAgeMs: 0 })
    const beforeClear = cache.inspect()
    const cleared = await cache.clear()
    const afterClear = cache.inspect()
    await cache.dispose()

    const crossContext = await proveCrossContextGarbageCollection(namespace)
    const reclaimedJournal = await proveReclaimedJournalCannotCommit(namespace)
    const repairedMetadata = await proveConcurrentInvalidMetadataRepair(namespace)
    const lifecycle = await finishLifecycleProof(namespace)
    const sessionCleanupFailure = await proveSessionCleanupFailure(namespace)

    let disposedCode: string | undefined
    try {
        await cache.get(RAW_KEY)
    } catch (error) {
        disposedCode = (error as { diagnostic?: { code?: string } }).diagnostic?.code
    }

    return Object.freeze({
        rawReload,
        metadataReload,
        revisionMiss,
        invalidated,
        garbage,
        beforeClear,
        cleared,
        afterClear,
        disposedCode,
        crossContext,
        reclaimedJournal,
        repairedMetadata,
        lifecycle,
        sessionCleanupFailure,
    })
}

async function prepareLifecycleProof(namespace: string) {

    const resetNamespace = `${namespace}.reset-on-open`
    const resetKey = key('lifecycle/reset')
    const resetSeed = await openProofCache(resetNamespace, false)
    await resetSeed.clear()
    await resetSeed.put(resetKey, raw(41))
    await resetSeed.dispose()
    const reset = await openProofCache(resetNamespace, false, {
        kind: 'durable',
        open: 'clear-before-open',
    })
    const resetRead = serializeRead(await reset.get(resetKey))
    const resetFacts = reset.inspect()
    await reset.dispose()

    const sessionNamespace = `${namespace}.session`
    const sessionKey = key('lifecycle/session')
    const staleSeed = await openProofCache(sessionNamespace, false)
    await staleSeed.clear()
    await staleSeed.put(sessionKey, raw(51))
    await staleSeed.dispose()
    const session = await openProofCache(sessionNamespace, false, { kind: 'session' })
    const staleRead = serializeRead(await session.get(sessionKey))
    await session.put(sessionKey, raw(52))

    return Object.freeze({
        resetRead,
        resetFacts,
        staleRead,
        sessionFacts: session.inspect(),
    })
}

async function finishLifecycleProof(namespace: string) {

    const sessionNamespace = `${namespace}.session`
    const sessionKey = key('lifecycle/session')
    const session = await openProofCache(sessionNamespace, false, { kind: 'session' })
    const reloadRead = serializeRead(await session.get(sessionKey))
    await session.put(sessionKey, raw(61))
    const activeRead = serializeRead(await session.get(sessionKey))
    await session.dispose()

    const durable = await openProofCache(sessionNamespace, false)
    const disposedRead = serializeRead(await durable.get(sessionKey))
    await durable.clear()
    await durable.dispose()
    return Object.freeze({ reloadRead, activeRead, disposedRead })
}

async function proveSessionCleanupFailure(namespace: string) {

    const failureNamespace = `${namespace}.session-cleanup-failure`
    const cache = await openProofCache(failureNamespace, false, { kind: 'session' })
    await cache.put(key('lifecycle/cleanup-failure'), raw(71))
    const payloads = await getPayloadDirectory(failureNamespace)
    const prototype = Object.getPrototypeOf(payloads) as DirectoryPrototype
    const originalRemoveEntry = prototype.removeEntry
    let interceptedCount = 0
    prototype.removeEntry = async function(
        this: FileSystemDirectoryHandle,
        name: string,
        options?: FileSystemRemoveOptions
    ) {

        if (name.endsWith('.bin')) {
            interceptedCount++
            throw new DOMException('Injected session payload cleanup failure', 'NotAllowedError')
        }
        return await originalRemoveEntry.call(this, name, options)
    }

    let disposal
    try {
        disposal = await cache.dispose().then(
            () => ({ status: 'resolved' as const }),
            error => ({
                status: 'rejected' as const,
                code: (error as { diagnostic?: { code?: string } }).diagnostic?.code,
            })
        )
    } finally {
        prototype.removeEntry = originalRemoveEntry
    }
    const state = cache.inspect().state
    const recovery = await openProofCache(failureNamespace, false)
    const recoveryRead = serializeRead(await recovery.get(key('lifecycle/cleanup-failure')))
    const payloadFileCount = await countPayloadFiles(failureNamespace)
    const garbage = await recovery.collectGarbage({ minimumPendingAgeMs: 0 })
    await recovery.dispose()
    return Object.freeze({
        interceptedCount,
        disposal,
        state,
        recoveryRead,
        payloadFileCount,
        garbage,
    })
}

async function proveCrossContextGarbageCollection(namespace: string) {

    const raceNamespace = `${namespace}.cross-context`
    const collector = await openProofCache(raceNamespace, false)
    const writer = await openProofCache(raceNamespace, false)
    await collector.clear()
    const liveKey = key('race/live')
    const payloads = await getPayloadDirectory(raceNamespace)
    const prototype = Object.getPrototypeOf(payloads) as DirectoryPrototype
    const originalEntries = prototype.entries
    let writeOutcome: Awaited<ReturnType<typeof writer.put>> | undefined
    let triggered = false
    prototype.entries = function(this: FileSystemDirectoryHandle) {

        const directory = this
        return (async function*() {
            if (!triggered) {
                triggered = true
                writeOutcome = await writer.put(liveKey, raw(11))
            }
            yield* originalEntries.call(directory)
        })()
    }

    let garbage
    try {
        garbage = await collector.collectGarbage({ minimumPendingAgeMs: 0 })
    } finally {
        prototype.entries = originalEntries
    }
    const read = serializeRead(await collector.get(liveKey))
    const facts = collector.inspect()
    await collector.clear()
    await Promise.all([ collector.dispose(), writer.dispose() ])
    return Object.freeze({
        triggered,
        writeOutcome,
        garbage,
        read,
        facts,
    })
}

async function proveReclaimedJournalCannotCommit(namespace: string) {

    const raceNamespace = `${namespace}.reclaimed-journal`
    const collector = await openProofCache(raceNamespace, false)
    const writer = await openProofCache(raceNamespace, false)
    await collector.clear()
    const liveKey = key('race/reclaimed')
    const payloads = await getPayloadDirectory(raceNamespace)
    const probe = await payloads.getFileHandle('writable-prototype-probe.bin', { create: true })
    const probeWritable = await probe.createWritable()
    const prototype = Object.getPrototypeOf(probeWritable) as WritablePrototype
    const originalClose = prototype.close
    await probeWritable.close()
    await payloads.removeEntry('writable-prototype-probe.bin')

    let enteredResolve!: () => void
    let releaseResolve!: () => void
    const entered = new Promise<void>(resolve => { enteredResolve = resolve })
    const release = new Promise<void>(resolve => { releaseResolve = resolve })
    let blocked = false
    prototype.close = async function(this: FileSystemWritableFileStream) {

        await originalClose.call(this)
        if (blocked) return
        blocked = true
        enteredResolve()
        await release
    }

    let garbage
    let writeResult
    try {
        const pendingWrite = writer.put(liveKey, raw(21)).then(
            value => ({ status: 'resolved' as const, value }),
            error => ({
                status: 'rejected' as const,
                code: (error as { diagnostic?: { code?: string } }).diagnostic?.code,
                storage: (error as { diagnostic?: { storage?: string } }).diagnostic?.storage,
                retriable: (error as { diagnostic?: { retriable?: boolean } }).diagnostic?.retriable,
            })
        )
        await withProofTimeout(entered, 'writer did not reach the pre-commit close boundary')
        garbage = await collector.collectGarbage({ minimumPendingAgeMs: 0 })
        releaseResolve()
        writeResult = await pendingWrite
    } finally {
        releaseResolve()
        prototype.close = originalClose
    }
    const read = serializeRead(await collector.get(liveKey))
    await collector.clear()
    await Promise.all([ collector.dispose(), writer.dispose() ])
    return Object.freeze({ blocked, garbage, writeResult, read })
}

async function proveConcurrentInvalidMetadataRepair(namespace: string) {

    const raceNamespace = `${namespace}.invalid-metadata`
    const writer = await openProofCache(raceNamespace, false)
    await writer.clear()
    const liveKey = key('race/repaired-metadata')
    await seedInvalidMetadata(raceNamespace, liveKey)
    const indexPrototype = IDBIndex.prototype
    const originalGetAll = indexPrototype.getAll
    let intercepted = false
    let repairFailure: unknown
    indexPrototype.getAll = function(this: IDBIndex, query?: IDBValidKey | IDBKeyRange | null) {

        const request = originalGetAll.call(this, query)
        if (intercepted || this.name !== 'namespace' || this.objectStore.name !== 'entries') {
            return request
        }
        intercepted = true
        let successHandler: ((this: IDBRequest, event: Event) => unknown) | null = null
        Object.defineProperty(request, 'onsuccess', {
            configurable: true,
            get: () => successHandler,
            set: handler => { successHandler = handler },
        })
        request.addEventListener('success', event => {
            void (async() => {
                try {
                    await writer.delete(liveKey)
                    await writer.put(liveKey, raw(31))
                } catch (error) {
                    repairFailure = error
                }
                successHandler?.call(request, event)
            })()
        }, { once: true })
        return request
    }

    let reader: Awaited<ReturnType<typeof openProofCache>> | undefined
    try {
        reader = await withProofTimeout(
            openProofCache(raceNamespace, false),
            'reader did not complete invalid-metadata recovery'
        )
    } finally {
        indexPrototype.getAll = originalGetAll
    }
    if (repairFailure !== undefined) throw repairFailure
    const read = serializeRead(await reader.get(liveKey))
    const facts = reader.inspect()
    await reader.clear()
    await Promise.all([ reader.dispose(), writer.dispose() ])
    return Object.freeze({ intercepted, read, facts })
}

async function openProofCache(
    namespace: string,
    requestPersistence: boolean,
    lifecycle: PersistentCacheLifecycle = { kind: 'durable', open: 'reuse' }
) {

    return await PersistentCache.open<ProofMetadata>({
        namespace,
        maxPayloadBytes: 64,
        maxEntries: 8,
        maxHistory: 32,
        requestPersistence,
        lifecycle,
    })
}

function key(id: string): PersistentCacheKey {

    return persistentCacheKey({ id, revision: 'v1' })
}

function raw(seed: number) {

    return {
        metadata: { kind: 'raw' as const, seed },
        payload: Uint8Array.of(seed, seed + 1, seed + 2, seed + 3).buffer,
    }
}

function serializeRead(outcome: CacheReadOutcome<ProofMetadata>) {

    if (outcome.status === 'miss') {
        return Object.freeze({
            status: outcome.status,
            reason: outcome.reason,
            diagnosticCode: outcome.diagnostic?.code,
        })
    }
    return Object.freeze({
        status: outcome.status,
        metadata: outcome.record.metadata,
        byteLength: outcome.record.byteLength,
        payload: outcome.record.payload === undefined
            ? undefined
            : [ ...new Uint8Array(outcome.record.payload) ],
    })
}

async function createOrphanPayload(namespace: string): Promise<void> {

    const payloads = await getPayloadDirectory(namespace)
    const file = await payloads.getFileHandle('orphan-proof.bin', { create: true })
    const writable = await file.createWritable()
    await writable.write(Uint8Array.of(9, 8, 7, 6))
    await writable.close()
}

async function getPayloadDirectory(namespace: string): Promise<FileSystemDirectoryHandle> {

    const root = await navigator.storage.getDirectory()
    const cacheRoot = await root.getDirectoryHandle('geoscratch-persistent-cache-v1', {
        create: true,
    })
    const namespaceDirectory = await cacheRoot.getDirectoryHandle(
        namespaceDirectoryName(namespace),
        { create: true }
    )
    return await namespaceDirectory.getDirectoryHandle('payloads', { create: true })
}

async function countPayloadFiles(namespace: string): Promise<number> {

    const payloads = await getPayloadDirectory(namespace)
    let count = 0
    for await (const [ name, handle ] of (payloads as unknown as DirectoryPrototype).entries()) {
        if (handle.kind === 'file' && name.endsWith('.bin')) count++
    }
    return count
}

async function seedInvalidMetadata(
    namespace: string,
    cacheKey: PersistentCacheKey
): Promise<void> {

    const database = await openRawCacheDatabase()
    try {
        const transaction = database.transaction('entries', 'readwrite')
        const done = transactionCompletion(transaction)
        transaction.objectStore('entries').put({
            storageKey: `${namespace}\u0000${cacheKey.storageKey}`,
            namespace,
            key: cacheKey,
            metadata: null,
            byteLength: 0,
            storedAt: 0,
            lastAccessedAt: 0,
            accessSequence: 0,
        })
        transaction.commit()
        await done
    } finally {
        database.close()
    }
}

async function openRawCacheDatabase(): Promise<IDBDatabase> {

    return await new Promise((resolve, reject) => {
        const request = indexedDB.open('geoscratch-persistent-cache-v1', 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('raw cache database open failed'))
    })
}

async function transactionCompletion(transaction: IDBTransaction): Promise<void> {

    return await new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(
            transaction.error ?? new Error('raw cache transaction failed')
        )
        transaction.onabort = () => reject(
            transaction.error ?? new Error('raw cache transaction aborted')
        )
    })
}

type DirectoryPrototype = {
    entries: (
        this: FileSystemDirectoryHandle
    ) => AsyncIterableIterator<[string, FileSystemHandle]>
    removeEntry: (
        this: FileSystemDirectoryHandle,
        name: string,
        options?: FileSystemRemoveOptions
    ) => Promise<void>
}

type WritablePrototype = {
    close: (this: FileSystemWritableFileStream) => Promise<void>
}

async function withProofTimeout<Value>(promise: Promise<Value>, message: string): Promise<Value> {

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), 5_000)
            }),
        ])
    } finally {
        if (timeout !== undefined) clearTimeout(timeout)
    }
}

function namespaceDirectoryName(namespace: string): string {

    const bytes = new TextEncoder().encode(namespace)
    return `n-${[ ...bytes ].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}
