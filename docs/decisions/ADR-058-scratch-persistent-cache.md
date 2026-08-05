# ADR-058: Use IndexedDB Metadata And OPFS Raw Payloads For Scratch Persistent Cache

## Status

Accepted

## Date

2026-08-06

## Context

ADR-057 made Cache an independent Scratch capability but did not define it. The
predecessor `VirtualRasterCache` mixed Geo address semantics, application memory
retention, IndexedDB storage, and Worker lifecycle. It stored encoded raster data,
so a retained DEM tile still required image decode after GPU eviction. It also made
the cache unusable for non-Geo data.

The browser storage APIs do not offer one transaction spanning IndexedDB and the
origin-private file system. A correct cache must therefore expose a recoverable
commit protocol rather than claim cross-engine atomicity.

Normative sources used by this decision are:

- Indexed Database API 3.0: https://w3c.github.io/IndexedDB/
- File System Living Standard: https://fs.spec.whatwg.org/
- Storage Standard: https://storage.spec.whatwg.org/

IndexedDB provides the authoritative metadata transaction. OPFS writable streams
publish a file on successful close. Storage estimates and persistence grants remain
browser-controlled observations, not guarantees.

## Decision

### Independent capability

`PersistentCache` is exported only from `geoscratch/scratch`. It has no GPU,
Worker, Geo, raster, Buffer, or Texture dependency. Consumers explicitly open and
dispose only the cache instances they need:

```ts
const cache = await PersistentCache.open<Metadata>({
    namespace: 'application.dataset.v1',
    maxPayloadBytes: 128 * 1024 * 1024,
    maxEntries: 4096,
    maxHistory: 64,
    requestPersistence: false,
})

await cache.dispose()
```

There is no no-op cache and no Scratch-owned JavaScript memory tier. Absence of a
cache instance means no completed-result retention. Application memory caches remain
application policy.

### Immutable identity and records

`persistentCacheKey({ id, revision })` creates the only accepted key shape. `id`
identifies a logical object and `revision` identifies immutable content. The first
successful writer for a pair wins; later writes return `already-present` and never
overwrite committed content.

Metadata is structured-cloned into IndexedDB. A payload is an optional, non-empty,
whole `ArrayBuffer` snapshotted at `put()` and stored as an immutable OPFS `.bin`
file. A metadata-only entry is valid. `get()` returns a fresh caller-owned buffer,
which may be transferred without changing the cache. Cache APIs do not convert
payloads to or from GPU resources.

### Commit and recovery protocol

Each payload has a random internal ID unrelated to the public key. A write proceeds
as follows:

1. write a `pendingPayloads` journal row in IndexedDB;
2. create and close the immutable OPFS payload;
3. in one relaxed-durability IndexedDB readwrite transaction, check first-writer
   identity, select LRU victims, publish metadata, and delete the pending row;
4. treat transaction completion as the only cache-entry commit point;
5. clean obsolete payload files on a best-effort basis.

Open-time recovery removes stale pending rows and unreferenced payload files.
Missing or size-mismatched committed payloads become structured repair misses and
their metadata is removed. Cleanup failures are retained in bounded diagnostics for
later garbage collection; they do not reverse a committed metadata transaction.

The implementation does not claim IndexedDB plus OPFS atomicity. Immutable payload
IDs, the pending journal, the IndexedDB commit point, conditional repair, and
garbage collection make partial states classifiable and recoverable.

### Budgets, lifecycle, and diagnostics

`maxPayloadBytes` and `maxEntries` are hard namespace budgets. Both raw and
metadata-only entries count toward the entry limit; byte-weighted LRU eviction is
selected in the same transaction that publishes a new entry. Public mutation is
limited to exact `delete`, ID-prefix `invalidate`, `clear`, and explicit garbage
collection.

Lifecycle is `active | disposing | disposed`. `dispose()` is idempotent, rejects new
operations, waits for operations already admitted by that instance, and closes its
database connection without clearing persisted data.

Cache joins the shared diagnostic envelope:

```ts
type ScratchDiagnostic = GPUDiagnostic | WorkerDiagnostic | CacheDiagnostic
```

Storage unavailability and unknown storage failures throw `ScratchDiagnosticError`
with a cache-domain context. Quota exhaustion and repairable payload corruption are
explicit outcomes with structured diagnostics. `inspect()` contains bounded current
facts, counters, storage estimate/persistence observations, and finite history; it
never contains payloads or an unbounded key log.

## Alternatives Rejected

- **Geo-owned cache runtime:** rejected because storage and lifecycle are not
  geospatial concepts.
- **IndexedDB blobs only:** rejected because large raw graphics payloads belong in
  OPFS while IndexedDB remains the metadata and commit authority.
- **Encoded-source preference:** rejected as a generic policy; callers choose the
  representation and can cache decode-ready raw bytes.
- **A built-in memory tier:** rejected because browser memory limits and working-set
  policy belong to the application.
- **Cache/GPU conversion helpers:** rejected because they create a combinatorial API
  across Buffer, Texture, readback, and every payload representation.

## Consequences

- Scratch can persist arbitrary structured metadata and raw binary blocks without
  acquiring Geo or GPU semantics.
- Callers must define immutable revisions and explicitly convert returned bytes into
  their own domain objects.
- A network/decode miss may need one bounded snapshot when the render owner receives
  a transferred buffer before stale-result acceptance permits cache commit.
- Persistence remains best effort and origin scoped; cache absence or eviction never
  changes source-of-truth semantics.
