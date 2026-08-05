import {
    PersistentCache,
    persistentCacheKey,
} from 'geoscratch/scratch'
import type {
    CacheReadOutcome,
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

async function openProofCache(namespace: string, requestPersistence: boolean) {

    return await PersistentCache.open<ProofMetadata>({
        namespace,
        maxPayloadBytes: 64,
        maxEntries: 8,
        maxHistory: 32,
        requestPersistence,
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

type DirectoryPrototype = {
    entries: (
        this: FileSystemDirectoryHandle
    ) => AsyncIterableIterator<[string, FileSystemHandle]>
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
