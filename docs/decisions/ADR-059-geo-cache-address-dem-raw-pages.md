# ADR-059: Keep Geo Cache Adaptation Pure And Cache DEM Raw Pages

## Status

Accepted

## Date

2026-08-06

## Context

ADR-058 owns persistent storage without raster semantics. Geo still needs a stable
way to map source, tile, representation, decoder, and coherence facts into that
domain-neutral cache. The DEM example must also prove that the split removes repeat
image decode rather than merely moving the previous encoded-PNG store.

The old Geo cache runtime owned storage, LRU policy, memory tiers, and lifecycle.
Keeping it beside `PersistentCache` would leave two cache authorities and preserve
an obsolete public architecture.

## Decision

### Geo is an address adapter

`geoscratch/geo` exports `virtualRasterCacheAddress()`. It validates Geo facts and
returns exactly:

- a Scratch `PersistentCacheKey`;
- structured-cloneable `VirtualRasterCacheMetadata`;
- stable source, plane, tile-matrix-set, and matrix ID prefixes for invalidation.

The key includes source, matrix-set identity, matrix, row, column, plane,
source/payload representation, decoder, sample type, schema version, and one of the
accepted immutable, revisioned, or editable-base coherence revisions. Dirty editing
state is never a cache revision.

Geo does not open IndexedDB or OPFS, choose byte budgets, retain payloads, expose a
memory tier, or own cache disposal. `VirtualRasterCache`,
`createVirtualRasterCache()`, `virtualRasterCacheKey()`, and the old cache policy and
record contracts are deleted without aliases.

### DEM is the first raw consumer

The DEM example owns only two policies: `none` and `persistent`. Default execution
uses `none`; the persistent proof explicitly supplies a namespace and finite byte
and entry budgets. Each stable page key is assigned to one Worker context shard, and
that context opens an independent Scratch cache namespace. Worker, Cache, and GPU
lifecycles remain separate and are composed by the example.

The miss path is:

```text
fetch encoded PNG -> decode uint8 height page once
    -> retain one bounded cache snapshot
    -> transfer the render buffer to main-thread residency
    -> accept only if the demand result is still current
    -> persist the retained raw snapshot
```

The snapshot is necessary because transfer detaches the render buffer before the
request scheduler can accept or reject the candidate. It is bounded by request and
decode concurrency and is released on accept, discard, cancellation, or disposal.
Stale results never enter cache.

The hit path reads a caller-owned raw buffer from OPFS and transfers it directly to
residency. It performs no HTTP fetch, `createImageBitmap`, channel extraction, or
second cache snapshot. Metadata and exact byte length are validated before transfer;
an invalid record is removed and treated as a miss.

### Executable acceptance

The headed Chrome DEM proof uses a two-page GPU atlas to force eviction and fallback.
It verifies that camera return increases persistent raw-cache hits without increasing
network or decode counters. It then disposes the complete page/Worker lifecycle,
reloads the page with the same namespace, and verifies at least one hit with zero
network requests and zero image decodes. It also retains the WebMercatorQuad route,
orientation, mesh-stitching, cross-page sampling, cancellation, stale rejection,
staging acknowledgement, deterministic screenshots, and idempotent teardown gates.

## Consequences

- Geo keeps reusable addressing/coherence semantics without becoming a storage
  framework.
- DEM persistent hits are decode-ready raw height pages rather than encoded source
  hits.
- Source adapters for other rasters may choose different raw representations and
  metadata while reusing the same Scratch cache.
- Application-level memory caching, editing authority, Flow virtual-raster LoD, and
  GPU resource conversion remain independent follow-up concerns.
