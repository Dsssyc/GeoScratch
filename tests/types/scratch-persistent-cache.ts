import {
    PersistentCache,
    persistentCacheDescriptor,
    persistentCacheKey,
} from 'geoscratch/scratch'
import type {
    CacheDiagnostic,
    CacheReadOutcome,
    CacheRecord,
    PersistentCacheLifecycle,
    ScratchDiagnostic,
} from 'geoscratch/scratch'
import {
    virtualRasterCacheAddress,
    virtualRasterCacheMetadataMatches,
} from 'geoscratch/geo'

type RasterMetadata = Readonly<{
    format: 'r8uint'
    width: number
    height: number
}>

const key = persistentCacheKey({
    id: 'typed-cache/resource-a',
    revision: 'revision-1',
})
const descriptor = persistentCacheDescriptor({
    namespace: 'typed-cache',
    maxPayloadBytes: 1024,
    maxEntries: 4,
    maxHistory: 8,
    lifecycle: { kind: 'durable', open: 'reuse' },
})
const cache = await PersistentCache.open<RasterMetadata>(descriptor)
const write = await cache.put(key, {
    metadata: { format: 'r8uint', width: 16, height: 16 },
    payload: new Uint8Array(256).buffer,
})
const read: CacheReadOutcome<RasterMetadata> = await cache.get(key)
if (read.status === 'hit') {
    const record: CacheRecord<RasterMetadata> = read.record
    const width: number = record.metadata.width
    const payload: ArrayBuffer | undefined = record.payload
    void width
    void payload
}
await cache.put(persistentCacheKey({ id: 'metadata-only', revision: 'v1' }), {
    metadata: { format: 'r8uint', width: 0, height: 0 },
})
await cache.invalidate({ idPrefix: 'typed-cache/' })
await cache.clear()
await cache.collectGarbage()
const facts = cache.inspect()
const observationScope: 'instance' = facts.observationScope
const lifecycle: PersistentCacheLifecycle = facts.lifecycle
await cache.dispose()

const address = virtualRasterCacheAddress({
    sourceId: 'typed-dem',
    tileMatrixSetId: 'WebMercatorQuad',
    tileMatrixSetUri: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad',
    matrixId: '10',
    tileRow: 418,
    tileColumn: 855,
    plane: 'height',
    coherence: { mode: 'immutable', contentVersion: 'dem-v1' },
    sourceRepresentation: 'image/png',
    payloadRepresentation: 'raw/uint8',
    decoderVersion: 'dem-r8-v2',
    sampleType: 'uint8',
    schemaVersion: 2,
})
const addressKey: typeof key = address.key
const metadataMatches: boolean = virtualRasterCacheMetadataMatches(address, address.metadata)

declare const diagnostic: ScratchDiagnostic
if (diagnostic.domain === 'cache') {
    const narrowed: CacheDiagnostic = diagnostic
    void narrowed
}

// @ts-expect-error Cache payloads are raw ArrayBuffer snapshots, not GPU resources
cache.put(key, { metadata: {}, payload: { kind: 'TextureResource' } })
// @ts-expect-error Cache identity always requires an immutable revision
persistentCacheKey({ id: 'missing-revision' })
// @ts-expect-error The removed Geo cache runtime is not a public API
import('geoscratch/geo').then(module => module.createVirtualRasterCache)

void write
void facts
void observationScope
void lifecycle
void addressKey
void metadataMatches
