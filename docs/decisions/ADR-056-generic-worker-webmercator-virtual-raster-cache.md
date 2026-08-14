# ADR-056: Use Generic Workers, WebMercatorQuad, And Explicit Virtual Raster Caches

## Status

Partially superseded. ADR-057 supersedes the Worker public subpath. ADR-058 and
ADR-059 supersede the Geo-owned cache runtime, cache tiers, encoded persistent
records, and OPFS non-goal. ADR-070 supersedes direct application-authored Worker
module URLs and the URL-only coherence identity. The Worker scheduling,
WebMercatorQuad, virtual-raster demand, transfer, residency, and publication
decisions remain accepted.

## Date

2026-08-05

## Context

ADR-055 established canonical high-precision positions, Geo-owned virtual rasters,
logical cross-page filtering, bounded residency, immutable publication snapshots,
and a COG-backed DEM proof. The first implementation intentionally used a small
local raster pyramid. That implementation is not the target architecture:

- its `GeoScratchLocalRasterQuad` is a southwest-origin local grid rather than the
  OGC `WebMercatorQuad` tile matrix set;
- its page table is dense over the complete logical raster at every level;
- HTTP fetch and image decode execute on the main thread;
- `VirtualRasterResidency` clones every decoded page;
- immutable snapshots retain decoded page payloads;
- demand is submitted as an immediate list without a bounded priority scheduler;
- completed bytes, in-flight requests, staging, GPU residency, and editable state
  do not have separate ownership or cache contracts.

The Geo API also needs a reusable thread abstraction. A DEM-specific worker would
repeat the limitation of map frameworks whose worker pools can only run internal
tile operations. The worker boundary must therefore be independently useful for
custom stateless work and stateful application contexts.

## Frozen Source Baseline

The decision and implementation use these sources as retrieved on 2026-08-05:

- OGC 17-083r4, *Two Dimensional Tile Matrix Set and Tile Set Metadata 2.0*,
  including the official `WebMercatorQuad` JSON example and
  `TileMatrixLimits` schema:
  https://docs.ogc.org/is/17-083r4/17-083r4.html
  https://schemas.opengis.net/tms/2.0/json/examples/tilematrixset/WebMercatorQuad.json
  https://schemas.opengis.net/tms/2.0/json/tileMatrixLimits.json
- WebGPU editor's draft and the 21 May 2026 W3C Candidate Recommendation Draft:
  https://gpuweb.github.io/gpuweb/
  https://www.w3.org/TR/webgpu/
- WGSL Candidate Recommendation Draft dated 16 July 2026:
  https://www.w3.org/TR/WGSL/
- WHATWG HTML Workers and structured data living standards:
  https://html.spec.whatwg.org/multipage/workers.html
  https://html.spec.whatwg.org/multipage/structured-data.html
- Indexed Database API 3.0 and WHATWG Storage living standards, the latter last
  updated 15 March 2026:
  https://w3c.github.io/IndexedDB/
  https://storage.spec.whatwg.org/
- HTTP semantics and caching, RFC 9110 and RFC 9111:
  https://www.rfc-editor.org/rfc/rfc9110.html
  https://www.rfc-editor.org/rfc/rfc9111.html
- Prioritized Task Scheduling, Comlink, threads.js, workerpool, and Cesium
  `RequestScheduler` as comparative scheduling and RPC evidence only:
  https://wicg.github.io/scheduling-apis/
  https://googlechromelabs.github.io/comlink/
  https://threads.js.org/usage-pool
  https://www.npmjs.com/package/workerpool
  https://cesium.com/learn/cesiumjs/ref-doc/RequestScheduler.html

The normative consequences used here are bounded:

1. A dedicated Worker can load a module script, communicate through structured
   data, transfer ownership of transferable objects, and be terminated. Transferring
   an `ArrayBuffer` detaches it from the sender; sending a cancel message does not
   preempt synchronous JavaScript already running in the worker.
2. IndexedDB transactions are short-lived, ordered within one transaction, and
   atomically commit or roll back. Browser storage quota and persistence are
   implementation-controlled facts that can fail or be denied.
3. `WebMercatorQuad` uses EPSG:3857, a top-left origin at
   `[-20037508.3427892, 20037508.3427892]`, 256 by 256 tiles, and square matrices
   whose width and height are `2^z`. Rows increase southward and columns eastward.
4. WebGPU has no native sparse texture or application-aware page-table sampling.
   Decoded CPU bytes still require an explicit Scratch upload even when worker to
   main-thread ownership moves without copying.

## Decision

### Ownership

The package has three non-overlapping owners:

- `geoscratch/worker` owns worker creation, module loading, task scheduling,
  priority, cancellation, context affinity, transfer protocol, remote error
  normalization, finite diagnostics, crash convergence, and reclamation. It has no
  dependency on Scratch, Geo, DEM, tile identity, camera, or GPU objects.
- `geoscratch/geo` owns tile matrix sets, canonical-position address translation,
  virtual-raster demand, source and cache policy, request scheduling adapters,
  residency, fallback, publication snapshots, GPU lowering, and Geo diagnostics.
- Scratch remains the explicit GPU execution kernel. It does not acquire worker,
  tile, cache, camera, CRS, or DEM concepts.

The Underwater Terrain example owns source bounds and revisions, COG construction and service,
terrain selection, cache-policy choice, lifecycle composition, and presentation.

### Generic Worker System

`WorkerSystem` is explicitly constructed and owns a finite physical worker budget.
It is never a hidden singleton. It creates independent `WorkerGroup` instances and
publishes bounded current facts and history. Repeated disposal is idempotent.

A group is an actual scheduling, trust, isolation, and reclamation boundary:

```ts
type WorkerGroupIsolation = 'shared' | 'group' | 'task'

type WorkerGroupOptions = {
    id: string
    modules: WorkerModuleDescriptor[]
    isolation: WorkerGroupIsolation
    size: { min: number, max: number }
    maxQueuedTasks: number
    maxActiveTasks: number
    idleTimeoutMs: number
}
```

`shared` hosts may run trusted stateless cooperative work. `group` is the default
for stateful contexts and never shares module state across groups. `task` gives one
task an exclusive host so hard cancellation has a known blast radius. In the current
implementation every host remains owned by one group and its frozen module set for
its full lifetime. Idle reclamation, cross-group capacity reclamation, group disposal,
and module/global-state removal terminate the host; there is no cross-group warm
reuse or invented module unloading. Any future cross-group warm reuse requires an
explicit trusted content fingerprint and a successful reset contract before it can
be accepted by a new group.

Worker modules are loaded from analyzable URLs and expose namespaced operations:

```ts
type WorkerModuleDescriptor = {
    id: string
    version: string
    url: URL
}
```

Arbitrary closures, `eval`, `new Function`, default data-URL execution, and binding
module exports onto an unnamespaced worker global are rejected. Module identity is
the stable id, publisher-controlled version, and canonical URL. The version is the
current coherence identity; no cryptographic content fingerprint is claimed.

Every `WorkerTaskHandle<T>` has a stable identity and exposes `result`, `cancel`,
`reprioritize`, and `inspect`. Priority consists of at least three ordered classes,
a stable score within a class, enqueue sequence, aging, group fairness, optional
deadline/generation, and affinity. Queue and active-task limits are hard budgets.

Cancellation has four distinct outcomes:

1. queued cancellation removes work before dispatch;
2. active cooperative cancellation signals a worker-local `AbortController` and
   requires long CPU work to yield or declare itself non-cooperative;
3. stale-result rejection prevents an obsolete generation from entering cache,
   staging, residency, or GPU publication;
4. hard termination is allowed only for an exclusive host or an explicitly accepted
   group blast radius.

Stateful `WorkerContextHandle<T>` values are sticky to one host. Context migration is
never implicit; it requires module-provided `snapshot` and `restore` operations.
Context disposal clears its state. Host loss produces `WORKER_CONTEXT_LOST`.

Worker diagnostics are structured and bounded. Stable initial codes include
`WORKER_MODULE_LOAD_FAILED`, `WORKER_OPERATION_NOT_FOUND`,
`WORKER_TASK_CANCELLED`, `WORKER_TASK_FAILED`, `WORKER_TASK_STALE`,
`WORKER_QUEUE_SATURATED`, `WORKER_TERMINATED`, `WORKER_CONTEXT_LOST`,
`WORKER_TRANSFER_INVALID`, and `WORKER_GROUP_DISPOSED`. Retained evidence contains
identities, finite timing facts, normalized remote errors, and counters, never full
raster payloads or an unbounded task log.

### WebMercatorQuad And Compact Coverage

Geo publishes typed `TileMatrixSet`, `TileMatrix`, `TileMatrixLimits`,
`TileCoordinate`, and `WebMercatorQuad` contracts. The world matrix and source
coverage are separate facts. Longitude wraps at the antimeridian; latitude clamps to
the Web Mercator maximum of approximately 85.0511287798 degrees.

DEM pages retain standard global `(matrixId, tileRow, tileCol)` identity. Each matrix
has finite `TileMatrixLimits`. A compact index is computed from a matrix-local offset
plus `(row - minRow) * columnCount + (column - minCol)`. No page table is allocated
for the rest of the world. Parent identity uses the preceding matrix and floor
division of global row and column.

The authoritative sample path is:

```text
canonical high-precision WebMercator position
    + requested matrix
    -> transient global tile and texel footprint
    -> compact coverage index
    -> immutable slot mapping
    -> physical atlas sample
```

Canonical position remains independent of camera, tile split/merge, cache,
residency, eviction, and atlas relocation. A persistent seven-part physical address
is forbidden. CPU and WGSL address calculations share the same matrix constants and
are tested at antimeridian, latitude, tile, texel, carry/borrow, and coverage edges.
DEM mesh stitching still happens before canonical coordinate construction and height
sampling.

### Transfer Ownership And Publication Lifetime

Fetch, persistent-cache read, and image decode execute in a worker. The completed
typed-array backing buffer is posted with a transfer list. On success the worker's
buffer is detached and the main thread is the unique owner. Residency validates and
adopts the owned payload; it does not clone, slice, or structured-clone it.

Decoded bytes move through an explicit finite lifetime:

```text
worker-owned decoded result
    -> main-thread owned staging batch
    -> immutable mapping publication
    -> Scratch texture upload
    -> SubmittedWork acknowledgement
    -> release or cache according to policy
```

`VirtualRasterSnapshot` contains only page identity, slot, generation, content epoch,
fallback, and compact table facts. An upload batch, not the snapshot, owns staging
bytes. Acknowledgement releases those bytes for `none`; a decoded `memory` L1 may
reclaim the same payload through an explicit ownership lease after the relevant
`SubmittedWork` settles. `persistent` retains bounded source-neutral encoded bytes and
does not retain unlimited decoded memory merely because an encoded L2 entry exists.
At every transition the decoded payload has exactly one owner, and GPU residency does
not depend on a JS payload after upload.

The current DEM executor retains encoded bytes for both completed cache tiers and
therefore repeats image decode after GPU eviction. This is an implementation deviation,
not a change to the decision; the final audit records the missing ownership-moving
decoded L1 as Finding F-1.

### Cache Tier And Coherence

Cache retention and content coherence are independent public policies:

```ts
type VirtualRasterCachePolicy =
    | { tier: 'none' }
    | { tier: 'memory', maxBytes: number }
    | {
        tier: 'persistent'
        memoryMaxBytes: number
        persistentMaxBytes: number
        backend: 'indexeddb'
        namespace: string
      }

type VirtualRasterCacheCoherence =
    | { mode: 'immutable', contentVersion: string }
    | { mode: 'revisioned', revision: string, validator?: string }
    | { mode: 'editable', baseRevision: string }
```

In-flight de-duplication belongs to the request scheduler and short-lived upload
staging belongs to publication, so both remain active independently of cache tier.
`none` retains no completed CPU result. `memory` is a deterministic byte-weighted
decoded L1 with explicit ownership leases. `persistent` uses IndexedDB as a bounded
encoded L2 with an optional bounded decoded L1, schema and namespace identity,
explicit clear/invalidation, transaction results, quota facts, and honest
persistence-permission facts.

A cache key includes source, tile matrix set, matrix, row, column, plane/band,
content revision, encoded representation, decoder version, sample type, and schema
version. Persistent entries prefer source-neutral encoded bytes; decode output is
transferred to the main thread. HTTP validators and content revisions are explicit.

Dirty working state is never a cache entry. An editable source can cache only a
committed base revision. Clearing cache does not discard unsaved edits; stale bases
cannot overwrite newer content epochs; future writes retain an `If-Match` or
equivalent base-revision conflict boundary.

### Demand Reconciliation

Terrain selection publishes idempotent `VirtualRasterDemandSet` generations rather
than calling request methods as an external state machine. The scheduler diffs each
generation, removes obsolete queued work, cooperatively aborts obsolete active work,
rejects late results as stale, reprioritizes retained work, and keeps root fallback
ahead of detail and prefetch. The DEM executor places network and decode operations
behind separate priority-aware concurrency budgets with independent configuration,
active/queued counts, and observed maxima; both still lower into the generic Worker
task scheduler. Queue, active work, completion history, and diagnostics are bounded.

### DEM Clean Cut

The example backend emits a standard WebMercatorQuad manifest with EPSG:4326 source
bounds, projected bounds, tile matrix set URI/CRS, global matrix identifiers,
`TileMatrixLimits`, native-resolution relationship, orientation, content version,
and validators. It exposes only:

```text
/tiles/WebMercatorQuad/{tileMatrix}/{tileRow}/{tileCol}.png
```

The old `/tiles/{z}/{x}/{y}.png` route has no alias. Tiles are read on demand from
the deterministic COG through a standard TMS implementation. The source and COG are
north-up, OGC rows are top-down, and the client performs no second vertical flip.

The browser's normal Underwater Terrain path is terrain demand, generic WorkerGroup scheduling,
selected cache lookup, worker fetch/decode, transferred owned bytes, finite staging,
Scratch upload, immutable compact page table, and vertex-stage logical sampling.
There is no full-image fallback, main-thread tile decode, legacy/new feature flag,
CPU padding, or tile-owned rendering path.

## Public Surface

The TypeScript source-first package adds `geoscratch/worker` through
`packages/geoscratch/src/worker.ts` and `packages/geoscratch/src/worker/`. Geo adds
the tile-matrix, cache, owned-payload, demand, and publication contracts through
`geoscratch/geo`. ESM TypeScript source retains `.js` relative specifiers so emitted
JavaScript resolves without import rewriting. No same-source JavaScript or hand-written
declarations are added.

## Deletion Matrix

| Existing path or behavior | Replacement | Removal gate |
| --- | --- | --- |
| `GeoScratchLocalRasterQuad` and southwest local zooms | OGC `WebMercatorQuad` global identity plus limits | manifest, Python, unit, and browser parity |
| `/tiles/{z}/{x}/{y}.png` | `/tiles/WebMercatorQuad/{matrix}/{row}/{col}.png` | old-route 404 proof |
| main-thread `fetch` plus `createImageBitmap` decode | generic worker module operation | real Worker browser proof |
| `clonePayload()` and typed-array copies | transferred unique ownership | detachment and source scan |
| snapshot-held payload | finite upload publication batch | acknowledgement release proof |
| mixed `cpuBytes` accounting | network/decode phase budgets, staging, memory-cache, persistent metadata facts | bounded accounting tests |
| direct `prepare()` page request fan-out | demand generation reconciliation | churn/cancel/stale proof |
| implicit completed-result retention | explicit none/memory/persistent policy | cache browser proof |

## Consequences

- The worker package is useful outside Geo and can host stateful application logic.
- Global tile identity does not imply global page-table allocation.
- Worker-to-main transfer avoids an extra CPU copy, but GPU upload remains explicit.
- Cache policy is safe for immutable, revisioned, and future editable sources.
- The architecture gains more explicit lifecycle objects and diagnostics; those are
  required to keep long-running memory, queue, and state behavior inspectable.

## Non-Goals

This decision does not migrate the visible Flow layer, implement editing UI or a
remote edit protocol, add OPFS or CacheStorage, require SharedArrayBuffer, share
contexts across browser processes, transfer WebGPU objects between workers, claim
native sparse textures, implement a full CRS engine or OGC API Tiles service, change
the DEM far-plane policy, or add scene/material concepts to Scratch.
