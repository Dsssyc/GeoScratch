---
docId: scratch.cache
canonical: true
apiSources:
  - packages/geoscratch/src/scratch/cache/diagnostics.ts
  - packages/geoscratch/src/scratch/cache/persistent-cache.ts
  - packages/geoscratch/src/scratch/cache/types.ts
---
# Persistent Cache

[简体中文](./cache_zh.md) | [Scratch overview](./README.md)

`PersistentCache` is a browser persistence primitive independent of Worker, GPU, and
Geo. IndexedDB stores metadata and is the authoritative commit point. Optional raw
`ArrayBuffer` payloads use immutable `(id, revision)` paths in OPFS. A record becomes
visible only after metadata commit, so interrupted payload writes cannot masquerade as
complete entries.

Use `persistentCacheDescriptor` to validate and freeze namespace, budgets, lifecycle,
history, and persistence-request policy synchronously without touching IndexedDB, OPFS,
or `navigator.storage`. Descriptor failures use the `cache-descriptor` diagnostic phase.
`PersistentCache.open` consumes the same normalized contract and owns only asynchronous
storage acquisition and initialization.

The application chooses disabled versus persistent use and supplies lifecycle policy.
Session cleanup suits disposable visualization data; durable reuse suits editing and
recovery. Quotas bound bytes and entries, while invalidation and garbage collection
are explicit. Scratch does not add a hidden JS-memory cache and does not convert cache
records into GPU resources.

Callers retain semantic ownership of keys, revisions, metadata schemas, and coherence.
Use `persistentCacheKey` to normalize identity. Each `PersistentCache` descriptor bounds
one namespace instance; when an application shards one logical cache across Workers, its
adapter must partition the application-level byte and entry totals. The DEM adapter does
this exactly and disables surplus cache shards when the entry budget is smaller than the
Worker count. Cache diagnostics report storage stage and evidence without coupling
failures to a particular loader or data format.
