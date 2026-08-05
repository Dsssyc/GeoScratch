import {
    createVirtualRasterCache,
    virtualRasterCacheKey,
} from 'geoscratch/geo'
import type {
    VirtualRasterCache,
    VirtualRasterPersistentEntry,
    VirtualRasterPersistentStorageFacts,
    VirtualRasterPersistentStore,
} from 'geoscratch/geo'

const NETWORK_COUNT_KEY = 'geoscratch.virtual-raster-cache.network-count'

export async function prepareGeoVirtualRasterCacheProof(namespace: string) {

    sessionStorage.setItem(NETWORK_COUNT_KEY, '0')
    const none = await createVirtualRasterCache({ policy: { tier: 'none' } })
    const noneKey = key('none-v1', 1)
    await load(none, noneKey)
    await load(none, noneKey)
    const noneFacts = none.inspect()
    await none.dispose()

    const memory = await createVirtualRasterCache({
        policy: { tier: 'memory', maxBytes: 8 },
    })
    const memoryKey = key('memory-v1', 2)
    await load(memory, memoryKey)
    const memoryHit = await load(memory, memoryKey)
    await load(memory, key('memory-v1', 3))
    await load(memory, key('memory-v1', 4))
    const memoryFacts = memory.inspect()
    await memory.dispose()

    const persistent = await persistentCache(namespace, true)
    await persistent.clear()
    const persistentFirst = await load(persistent, key('persistent-v1', 5))
    const persistentFacts = persistent.inspect()
    await persistent.dispose()

    return Object.freeze({
        none: {
            networkLoads: 2,
            facts: noneFacts,
        },
        memory: {
            secondLoad: memoryHit.source,
            facts: memoryFacts,
        },
        persistent: {
            firstLoad: persistentFirst.source,
            facts: persistentFacts,
        },
        networkCount: Number(sessionStorage.getItem(NETWORK_COUNT_KEY)),
    })
}

export async function finishGeoVirtualRasterCacheProof(namespace: string) {

    const before = Number(sessionStorage.getItem(NETWORK_COUNT_KEY))
    const persistent = await persistentCache(namespace, false)
    const cached = await load(persistent, key('persistent-v1', 5))
    const afterHit = Number(sessionStorage.getItem(NETWORK_COUNT_KEY))
    const revised = await load(persistent, key('persistent-v2', 5))
    const beforeClear = persistent.inspect()
    const cleared = await persistent.clear()
    const afterClear = persistent.inspect()
    await persistent.dispose()

    const quotaStore = new BrowserPersistentStore('quota')
    const quotaCache = await createVirtualRasterCache({
        policy: {
            tier: 'persistent',
            memoryMaxBytes: 0,
            persistentMaxBytes: 16,
            backend: 'indexeddb',
            namespace: `${namespace}.quota`,
        },
        persistentStore: quotaStore,
    })
    const quota = await quotaCache.put(key('quota-v1', 6), record(6))
    const quotaFacts = quotaCache.inspect()
    await quotaCache.dispose()

    const storageFailure = await captureStorageFailure(namespace)
    return Object.freeze({
        before,
        cachedLoad: cached.source,
        networkCountAfterHit: afterHit,
        revisedLoad: revised.source,
        networkCountAfterRevision: Number(sessionStorage.getItem(NETWORK_COUNT_KEY)),
        beforeClear,
        cleared,
        afterClear,
        quota,
        quotaFacts,
        storageFailure,
    })
}

async function persistentCache(namespace: string, requestPersistence: boolean) {

    return await createVirtualRasterCache({
        policy: {
            tier: 'persistent',
            memoryMaxBytes: 0,
            persistentMaxBytes: 64,
            backend: 'indexeddb',
            namespace,
        },
        requestPersistence,
    })
}

async function load(cache: VirtualRasterCache, cacheKey: ReturnType<typeof key>) {

    const cached = await cache.get(cacheKey)
    if (cached !== undefined) return Object.freeze({ source: 'cache', bytes: cached.byteLength })
    const nextCount = Number(sessionStorage.getItem(NETWORK_COUNT_KEY)) + 1
    sessionStorage.setItem(NETWORK_COUNT_KEY, String(nextCount))
    const payload = record(cacheKey.tileColumn)
    await cache.put(cacheKey, payload)
    return Object.freeze({ source: 'network', bytes: payload.data.byteLength })
}

function key(contentVersion: string, tileColumn: number) {

    return virtualRasterCacheKey({
        sourceId: 'browser-cache-proof',
        tileMatrixSetId: 'WebMercatorQuad',
        tileMatrixSetUri: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
        matrixId: '10',
        tileRow: 418,
        tileColumn,
        plane: 'height',
        coherence: { mode: 'immutable', contentVersion },
        encodedRepresentation: 'image/png',
        decoderVersion: 'browser-proof-v1',
        sampleType: 'unorm8',
        schemaVersion: 1,
    })
}

function record(seed: number) {

    return {
        data: Uint8Array.of(seed, seed + 1, seed + 2, seed + 3).buffer,
        contentType: 'image/png',
    }
}

async function captureStorageFailure(namespace: string) {

    try {
        await createVirtualRasterCache({
            policy: {
                tier: 'persistent',
                memoryMaxBytes: 0,
                persistentMaxBytes: 16,
                backend: 'indexeddb',
                namespace: `${namespace}.storage-failure`,
            },
            persistentStore: new BrowserPersistentStore('storage-failure'),
        })
        return Object.freeze({ code: 'unexpected-success' })
    } catch (error) {
        return Object.freeze({
            code: (error as { diagnostic?: { code?: string } }).diagnostic?.code,
        })
    }
}

class BrowserPersistentStore implements VirtualRasterPersistentStore {

    readonly kind = 'virtual-raster-persistent-store' as const
    readonly mode: 'quota' | 'storage-failure'
    readonly entries = new Map<string, VirtualRasterPersistentEntry>()

    constructor(mode: 'quota' | 'storage-failure') {

        this.mode = mode
    }

    async get(id: string) {
        return this.entries.get(id)
    }

    async put(entry: VirtualRasterPersistentEntry) {
        if (this.mode === 'quota') throw new DOMException('quota proof', 'QuotaExceededError')
        this.entries.set(entry.key.id, entry)
    }

    async delete(id: string) {
        return this.entries.delete(id)
    }

    async list() {
        return Object.freeze([ ...this.entries.values() ])
    }

    async clear() {
        const count = this.entries.size
        this.entries.clear()
        return count
    }

    async storageFacts(): Promise<VirtualRasterPersistentStorageFacts> {
        if (this.mode === 'storage-failure') throw new Error('storage estimate unavailable')
        return Object.freeze({
            usage: 0,
            quota: 8,
            persisted: false,
            persistenceRequested: false,
        })
    }

    async dispose() {}
}
