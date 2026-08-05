import { expect } from 'chai'
import {
    createVirtualRasterCache,
    virtualRasterCacheKey,
} from 'geoscratch/geo'

describe('virtual raster cache policy and coherence', () => {

    it('builds collision-resistant revision and representation keys', () => {

        const first = key({ revision: 'r1' })
        const nextRevision = key({ revision: 'r2' })
        const nextDecoder = key({ revision: 'r1', decoderVersion: 'png-v2' })

        expect(first.id).not.to.equal(nextRevision.id)
        expect(first.id).not.to.equal(nextDecoder.id)
        expect(first).to.deep.include({
            sourceId: 'dem-source',
            tileMatrixSetId: 'WebMercatorQuad',
            matrixId: '12',
            tileRow: 1674,
            tileColumn: 3431,
            plane: 'height',
            schemaVersion: 1,
        })
    })

    it('retains no completed bytes in the none tier', async() => {

        const cache = await createVirtualRasterCache({ policy: { tier: 'none' } })
        const outcome = await cache.put(key(), record([ 1, 2, 3, 4 ]))

        expect(outcome.status).to.equal('not-retained')
        expect(await cache.get(key())).to.equal(undefined)
        expect(cache.inspect()).to.deep.include({
            tier: 'none',
            memoryEntryCount: 0,
            memoryBytes: 0,
            missCount: 1,
        })
        await cache.dispose()
    })

    it('uses deterministic byte-bounded memory LRU without exposing mutable cache bytes', async() => {

        const cache = await createVirtualRasterCache({
            policy: { tier: 'memory', maxBytes: 8 },
        })
        const first = key({ tileColumn: 1 })
        const second = key({ tileColumn: 2 })
        const third = key({ tileColumn: 3 })

        await cache.put(first, record([ 1, 1, 1, 1 ]))
        await cache.put(second, record([ 2, 2, 2, 2 ]))
        const firstHit = await cache.get(first)
        new Uint8Array(firstHit.data)[0] = 9
        expect([ ...new Uint8Array((await cache.get(first)).data) ]).to.deep.equal([ 1, 1, 1, 1 ])
        await cache.put(third, record([ 3, 3, 3, 3 ]))

        expect(await cache.get(second)).to.equal(undefined)
        expect(await cache.get(first)).not.to.equal(undefined)
        expect(await cache.get(third)).not.to.equal(undefined)
        expect(cache.inspect()).to.deep.include({
            tier: 'memory',
            memoryEntryCount: 2,
            memoryBytes: 8,
            evictionCount: 1,
        })
        await cache.dispose()
    })

    it('uses a bounded persistent L2, reports storage facts, and clears explicitly', async() => {

        const store = new FakePersistentStore({ quota: 64, persisted: false })
        const cache = await createVirtualRasterCache({
            policy: {
                tier: 'persistent',
                memoryMaxBytes: 4,
                persistentMaxBytes: 8,
                backend: 'indexeddb',
                namespace: 'cache-test',
            },
            persistentStore: store,
            requestPersistence: true,
        })
        const first = key({ tileColumn: 1 })
        const second = key({ tileColumn: 2 })
        const third = key({ tileColumn: 3 })
        await cache.put(first, record([ 1, 1, 1, 1 ]))
        await cache.put(second, record([ 2, 2, 2, 2 ]))
        expect([ ...new Uint8Array((await cache.get(first)).data) ])
            .to.deep.equal([ 1, 1, 1, 1 ])
        await cache.put(third, record([ 3, 3, 3, 3 ]))

        expect(store.entries.size).to.equal(2)
        expect(cache.inspect()).to.deep.include({
            tier: 'persistent',
            persistentEntryCount: 2,
            persistentBytes: 8,
            storageQuota: 64,
            persistenceRequested: true,
            persisted: false,
        })
        expect(await cache.invalidate({ sourceId: 'dem-source' })).to.deep.equal({
            deletedCount: 2,
            releasedBytes: 8,
        })
        expect(cache.inspect()).to.deep.include({ persistentEntryCount: 0, persistentBytes: 0 })
        await cache.put(first, record([ 1, 1, 1, 1 ]))
        expect((await cache.clear()).deletedCount).to.equal(1)
        await cache.dispose()
    })

    it('returns a structured quota result and keeps editable base revisions isolated', async() => {

        const store = new FakePersistentStore({ quota: 4, quotaFailure: true })
        const cache = await createVirtualRasterCache({
            policy: {
                tier: 'persistent',
                memoryMaxBytes: 0,
                persistentMaxBytes: 8,
                backend: 'indexeddb',
                namespace: 'quota-test',
            },
            persistentStore: store,
        })
        const editableA = key({ coherence: { mode: 'editable', baseRevision: 'base-a' } })
        const editableB = key({ coherence: { mode: 'editable', baseRevision: 'base-b' } })
        expect(editableA.id).not.to.equal(editableB.id)
        expect((await cache.put(editableA, record([ 1, 2, 3, 4 ]))).status)
            .to.equal('quota-exceeded')
        expect(cache.inspect().quotaFailureCount).to.equal(1)
        expect(await cache.get(editableB)).to.equal(undefined)
        await cache.dispose()
    })

    it('wraps persistent storage failures in the Geo diagnostic envelope', async() => {

        const store = new FakePersistentStore({ quota: 64, storageFailure: true })

        try {
            await createVirtualRasterCache({
                policy: {
                    tier: 'persistent',
                    memoryMaxBytes: 0,
                    persistentMaxBytes: 8,
                    backend: 'indexeddb',
                    namespace: 'storage-failure-test',
                },
                persistentStore: store,
            })
            expect.fail('persistent storage failure unexpectedly succeeded')
        } catch (error) {
            expect(error.diagnostic).to.deep.include({
                code: 'GEO_VIRTUAL_RASTER_CACHE_STORAGE_FAILED',
                phase: 'cache',
            })
        }
    })
})

function key(options = {}) {

    return virtualRasterCacheKey({
        sourceId: 'dem-source',
        tileMatrixSetId: 'WebMercatorQuad',
        tileMatrixSetUri: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
        matrixId: '12',
        tileRow: 1674,
        tileColumn: options.tileColumn ?? 3431,
        plane: 'height',
        coherence: options.coherence ?? {
            mode: 'revisioned',
            revision: options.revision ?? 'r1',
            validator: '"etag-r1"',
        },
        encodedRepresentation: 'image/png',
        decoderVersion: options.decoderVersion ?? 'png-v1',
        sampleType: 'unorm8',
        schemaVersion: 1,
    })
}

function record(values) {

    return {
        data: Uint8Array.from(values).buffer,
        contentType: 'image/png',
        validator: '"etag-r1"',
    }
}

class FakePersistentStore {

    kind = 'virtual-raster-persistent-store'
    entries = new Map()
    options

    constructor(options) {
        this.options = options
    }

    async get(id) {
        return clone(this.entries.get(id))
    }

    async put(entry) {
        if (this.options.quotaFailure) {
            throw new DOMException('quota', 'QuotaExceededError')
        }
        this.entries.set(entry.key.id, clone(entry))
    }

    async delete(id) {
        return this.entries.delete(id)
    }

    async list() {
        return [ ...this.entries.values() ].map(clone)
    }

    async clear() {
        const count = this.entries.size
        this.entries.clear()
        return count
    }

    async storageFacts({ requestPersistence }) {
        if (this.options.storageFailure) throw new Error('storage estimate unavailable')
        return {
            usage: [ ...this.entries.values() ].reduce((sum, entry) => sum + entry.byteLength, 0),
            quota: this.options.quota,
            persisted: this.options.persisted ?? false,
            persistenceRequested: requestPersistence,
        }
    }

    async dispose() {}
}

function clone(value) {

    return value === undefined ? undefined : structuredClone(value)
}
