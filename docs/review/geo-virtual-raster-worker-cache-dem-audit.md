# Geo Virtual Raster Worker, Cache, And DEM Audit

## Scope

This is the required one-to-one audit for the clean cut from the ADR-055 local DEM
prototype to the ADR-056 target. It compares the exact baseline liabilities with the
public contracts, implementation owners, and executable proof. A feature is not
marked complete merely because a type or ADR exists.

Audit classification: `completed-with-findings`. All functional, lifecycle, build,
Python, and browser gates pass, but Finding F-1 records one unmet memory-cache
representation requirement.

Audited implementation commits:

```text
43fc2f2 Define worker and WebMercator virtual raster contracts
e6713a6 Implement generic worker task system
fd8ef8b Implement WebMercatorQuad virtual addressing
922168d Add virtual raster cache and owned page transfers
a62b79e Migrate DEM streaming to WebMercator workers
3e6425a Separate DEM network and decode budgets
5b5233a Remove foreign residency accounting facts
```

## One-To-One Replacement Matrix

| Baseline liability | Required target | Implementation evidence | Executable proof | Result |
| --- | --- | --- | --- | --- |
| No reusable thread abstraction; a DEM-specific pool would repeat map-framework lock-in. | Public, explicitly constructed, non-singleton `WorkerSystem` independent of Geo and the GPU runtime. | `packages/geoscratch/src/scratch/worker/` and the `geoscratch/scratch` package export. | Public API/type tests plus real custom operation returning 42 from a module Worker. | Replaced |
| Worker code could otherwise depend on tile/DEM concepts or hidden closures. | URL-loaded namespaced modules with typed operations; no `eval`, `new Function`, serialized closure, Geo, Scratch, tile, camera, or DEM dependency. | `module.ts`, `protocol.ts`, standalone `worker-bootstrap.ts`; source dependency scan. | Module-load/error tests and production-preview DEM Worker bootstrap proof. | Replaced |
| No explicit trust, state-affinity, or reclamation boundary. | `WorkerGroup` isolation (`shared`, `group`, `task`), finite min/max capacity, sticky context, host termination on reclaim, and idempotent disposal. | `worker-system.ts` binds each host to one group and frozen `(id, version, URL)` module set; no cross-group warm reuse exists. | Stateful value advances 7 to 12 on one host, snapshots, disposes, reopens; capacity reclaim creates a new host and idle group reaches zero workers. | Replaced |
| FIFO work could starve background tasks and had no hard queue budget. | Three priority classes, scores, enqueue order, aging, group fairness, reprioritization, deadlines, and finite queue/active limits. | `WorkerTaskPriority`, group scheduler, bounded history. | Browser reprioritization changes completion order; saturation/fairness/aging unit tests pass. | Replaced |
| Network fetch and CPU decode shared one opaque concurrency ceiling. | Independently configured priority-aware network and decode budgets with active, queued, limit, and observed-maximum facts. | `dem-phase-budget.ts` gates the separate Worker `fetch` and `decode` operations without adding tile concepts to WorkerSystem. | Unit proof reaches two simultaneous network permits and one decode permit, cancels/reprioritizes queued work, and returns all counts to zero; headed DEM proof enforces limits 2 and 1. | Replaced |
| “Cancel” was one ambiguous operation. | Separate queued removal, cooperative abort, stale rejection, and exclusive-host hard termination. | Worker diagnostics plus task and demand reconciliation APIs. | Browser observes cooperative cancellation and crash/hard termination; DEM churn observes four cancellations and four stale results. | Replaced |
| Remote failure or host loss could become an unstructured console error. | Structured bounded diagnostics, normalized remote name/message/code/stack, blast-radius-aware termination, and replacement-host recovery. | `worker/diagnostics.ts` and host failure convergence. | Browser preserves `BROWSER_FIXTURE_REMOTE`, isolates an intentional crash, and completes work on a new worker. | Replaced |
| Worker result transfer could duplicate buffers or leave unclear ownership. | Unique transfer list, sender detachment, receiver adoption, one owner, and explicit discard. | `transferWorkerResult()` and `virtual-raster-transfer.ts`. | Browser moves six bytes and observes sender length 0; ownership tests reject duplicate/second adoption. | Replaced |
| Default Worker bootstrap only worked beside package source. | Standalone deployable bootstrap plus separately bundled user module URL. | Dependency-free emitted bootstrap and DEM Vite chunk plugin. | Build test forbids static sibling imports; both Vite dev and production preview complete the DEM proof. | Corrected |
| `GeoScratchLocalRasterQuad` used a southwest local grid and local zoom aliases. | OGC `WebMercatorQuad` with EPSG:3857, top-left origin, standard matrix IDs, global row/column identity, and source CRS kept separately. | `tile-matrix.ts`, `web-mercator-quad.ts`, DEM manifest validator and Python backend. | CPU/WGSL boundary tests plus manifest/Python/browser endpoint proofs. | Deleted and replaced |
| Dense page indexing grew with the full logical/world grid. | Per-matrix `TileMatrixLimits` and compact coverage offsets only for source-intersecting tiles. | `TileMatrixCoverage` and `virtualRasterTileAddressSpace()`. | Unit tests reverse compact indices, reject out-of-limit tiles, and prove global identity without dense world allocation. | Replaced |
| Persistent per-sample tile/texel decomposition would amplify dynamic-state bandwidth. | High-precision canonical position is persistent; tile, texel, sub-texel, compact entry, and physical slot are reconstructed transiently in every shader stage. | `WideFixedCodec`, `WebMercatorQuadAddressCodec`, generated virtual-raster WGSL. | Carry/borrow, antimeridian, tile/texel edge tests and 262,144-particle compute proof with zero persistent address bytes. | Replaced |
| DEM mesh stitching and sample coordinates could diverge. | Stitch first, derive one canonical coordinate, then sample at the selected logical LoD. | DEM canonical node packer and `terrain-mesh.wgsl`. | Shared edge quanta and mixed-LoD tests plus deterministic page-boundary captures. | Preserved and strengthened |
| Main thread fetched and decoded DEM image pages. | Worker context performs cache lookup, HTTP fetch, image decode, candidate accept/discard, and bounded facts. | `dem-tile-worker.ts`, `dem-worker-source.ts`. | Source scan leaves `createImageBitmap` only in Worker; standard tile traffic and worker counters are observed in Chrome. | Replaced |
| Residency cloned decoded typed arrays. | Whole backing ArrayBuffer transfer and one-time owned payload adoption; residency moves ownership without clone/slice. | `virtual-raster-transfer.ts`, `virtual-raster-residency.ts`. | Detachment, source scan, identity/adoption tests, and zero sender decoded bytes after transfer. | Replaced |
| Immutable snapshots retained decoded payloads. | Snapshot holds mapping/fallback/epoch only; `VirtualRasterPublication` exclusively owns finite upload payloads until acknowledgement or abandon. | Residency publication and `VirtualRasterGpuState.stage/acknowledge`. | Snapshot tests find no payload; staging bytes return to zero after GPU observation and at teardown. | Replaced |
| CPU bytes, cache, staging, and GPU residency were one accounting bucket. | Orthogonal executor pending/decode facts, cache bytes, publication staging bytes, resident GPU bytes, page count, and bounded histories, each reported only by its authority. | Executor/cache/residency/GPU facts; Residency no longer publishes foreign fields as constant false zeroes. | Unit tests reject foreign Residency facts; browser terminal facts prove every actual owner separately returns to zero. | Replaced |
| Completed-result retention was implicit. | Explicit `none`, byte-bounded decoded `memory`, and bounded encoded IndexedDB `persistent` tiers. | `VirtualRasterCache` and persistent store provide all policies, but DEM currently uses encoded records for both retained tiers. | Browser proves none/memory/persistent retention behavior, but does not prove decoded reuse on a DEM memory hit. | Partial (F-1) |
| Cache retention implied content correctness and was unsafe for editing. | Independent immutable/revisioned/editable coherence keys; dirty working state remains outside cache. | `VirtualRasterCacheCoherence` and full cache key schema. | Revision change forces a network load; invalidation and key isolation unit/browser tests pass. | Replaced |
| Camera code fanned out requests directly and acted like a fragile `prepare()` state machine. | Idempotent demand generations reconcile retained/new/obsolete pages and expose one settlement promise. | `VirtualRasterRequestScheduler`. | Unit tests cover dedupe, reprioritize, cancellation, stale discard, request budget, and repeated disposal; DEM churn converges to newest camera. | Replaced |
| Root fallback could be evicted or starved by detail. | Pinned root page plus critical required priority; detail/prefetch remain lower priority. | DEM demand planner and deterministic residency LRU. | Two-page atlas repeatedly evicts detail while root fallback remains available. | Replaced |
| `/tiles/{z}/{x}/{y}.png` and full-image fallback left two data models. | Only `/tiles/WebMercatorQuad/{matrix}/{row}/{col}.png`; source PNG is offline COG input. | Python service, manifest, client URL builder, server README. | Old/full routes fail, network observer records only standard tiles, and source scan finds no browser PNG fallback. | Deleted |
| Tile orientation depended on an implicit southwest flip. | Source, COG, standard tile, and shader are north-up; top-left rows are converted exactly once by standard addressing. | Build/service manifest facts and DEM validator. | Python corner/center/random equivalence, orientation test, and headed terrain capture. | Corrected |
| Parent fallback produced nearest/blocky transitions at mixed residency LoDs. | Fallback converges to one common level, recomputes bilinear weights there, and blends only where a same-level neighbor resolves coarser. | Generated `DemHeight_sample_level` and residency-aware guard band. | Cross-page unit tests and page-boundary pixel contrast gate pass. | Corrected |
| DEM teardown did not own request/cache/Worker lifetime. | One lifecycle authority stops demand, settles work, drains submitted GPU work, then releases Worker/cache/residency/GPU/runtime/map in order. | `dem-lifecycle.ts`, `main.ts`, executor disposal. | Pause/drain, equivalent double dispose, all task/context/cache/staging/native counters zero, and all owned processes/ports closed. | Replaced |
| A DEM/WebMercator implementation could accidentally narrow the reusable virtual-raster contract. | Existing 1D/2D/3D address model and shader-stage accessor remain generic; visible Flow is unchanged. | Geo virtual-raster API and dynamic Flow fixture. | 262,144 particles run six compute steps over three LoDs with zero persistent address payload, one terminal readback, stable identities, and no errors. | Preserved |

## Observed Browser Facts

### Generic Worker

- custom operation value 42;
- queued reprioritization changes dispatch order;
- cooperative cancellation reports `WORKER_TASK_CANCELLED`;
- remote name/code/stack survive normalization;
- transferred sender buffer changes from six bytes to zero;
- stateful context value advances 7 to 12 on stable affinity;
- intentional host crash reports `WORKER_TERMINATED` and replacement work returns 9;
- terminal system has zero groups, workers, contexts, queued tasks, and active tasks.

### Cache

- `none`: two source loads, zero retained entries;
- `memory`: second access is a hit, 8-byte budget retained, one deterministic eviction;
- `persistent`: IndexedDB entry survives reload, revised content misses, clear releases two
  entries/eight bytes, persistence denial is reported honestly;
- quota returns `quota-exceeded`; storage failure uses
  `GEO_VIRTUAL_RASTER_CACHE_STORAGE_FAILED`;
- proof deletes its namespace and closes Chrome/Vite.

### DEM

- development and production-preview routes pass in headed WebGPU Chrome;
- two atlas pages force fallback and eight observed detail evictions across camera moves;
- rapid churn produces four cancellations and four stale results without stale publication;
- network and decode use independent limits of two and one; observed maxima stay within
  each limit and both active/queued counts return to zero;
- memory return produces three cumulative hits while network count remains unchanged;
- staging bytes, pending candidates, sender decoded bytes, active tasks, native observations,
  warnings, errors, failed required requests, and transparent pixels all settle to zero;
- terminal Worker/cache/residency/GPU ownership and all managed processes/ports are released.

### Dynamic Flow Compatibility

- 262,144 positions, 16 bytes each, six compute steps, requested/resolved LoDs 0 through 2;
- 1,572,864 samples, including 862,799 parent fallbacks and 4,723 page transitions;
- zero persistent logical-address bytes, zero address-materialization passes, zero CPU mirror
  per step, and one bounded terminal readback;
- 12 stable graph identities and zero pending native work, incidents, console errors, or
  process residue.

## Source And Ownership Audit

The production source scan confirms:

- no local raster schema/origin/route, payload clone helper, typed-array payload copy,
  browser full-image fallback, main-thread image decode, hidden Worker singleton,
  `eval`, `new Function`, or dual DEM feature flag;
- Worker source has no Geo/Scratch/DEM/tile dependency;
- Geo uses the generic Worker priority/execution vocabulary without adding tile operations
  to Worker;
- Scratch has no new tile, cache, Worker, CRS, virtual-raster, or DEM concept;
- DEM imports library behavior only from public package entrypoints;
- all added browser/library implementation source is TypeScript and generated `dist` is not
  tracked.

## Remaining Boundaries

### Finding F-1: DEM Memory Cache Retains Encoded Bytes

The current DEM `memory` tier stores validated PNG bytes in its Worker-local bounded
cache. A camera return therefore avoids another HTTP request, but the hit still passes
through `createImageBitmap` and channel extraction. This does not meet the goal's
literal requirement that the memory tier retain an immutable decoded payload.

The cause is an unresolved ownership transition: transferring a decoded `ArrayBuffer`
to the main thread detaches it from the Worker, while keeping it in both places would
require the prohibited second payload clone. Correct resolution is a representation-
aware cache split: source-neutral encoded L2 plus an ownership-moving decoded L1 whose
entry leases its one payload to Residency and receives it back only after the relevant
Scratch upload has a settled `SubmittedWork`. The cache key must retain decoder/sample
identity, an in-flight lease must deduplicate requests, eviction must wait for or cancel
the lease explicitly, and no path may alias or clone the decoded backing buffer.

This finding does not affect DEM correctness, orientation, seams, cancellation,
bounded memory, GPU residency, or current example usability. It affects repeated-decode
CPU cost after a page leaves the GPU atlas. The exact unmet gate is the decoded-payload
clause under the goal's `memory` cache semantics, so the audit outcome is
`completed-with-findings`, not `verified-clean`.

The following are explicit non-goals rather than hidden partial implementations:

- visible `flowLayer` migration;
- OPFS or CacheStorage backends;
- collaborative edit protocol or editor UI;
- a complete CRS engine or OGC API Tiles server;
- WebGPU native sparse textures, which are not currently available;
- changing the inherited DEM far-plane/depth policy.
