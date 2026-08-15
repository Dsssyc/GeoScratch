# Geo Virtual Raster Worker, Cache, And DEM Audit

## Scope

This is the required one-to-one audit for the clean cut from the ADR-055 local DEM
prototype through the ADR-056 streaming architecture and the ADR-058/059 cache
replacement. It compares the exact baseline liabilities with the public contracts,
implementation owners, and executable proof. A feature is not marked complete merely
because a type or ADR exists.

Audit classification: `implementation-complete`; the Goal 2/3 fixed full gate is
recorded separately after execution. The former memory-cache representation finding
is resolved by the ADR-058/059 clean cut rather than hidden behind a compatibility
tier.

Audited implementation commits:

```text
43fc2f2 Define worker and WebMercator virtual raster contracts
e6713a6 Implement generic worker task system
fd8ef8b Implement WebMercatorQuad virtual addressing
922168d Add virtual raster cache and owned page transfers
a62b79e Migrate DEM streaming to WebMercator workers
3e6425a Separate DEM network and decode budgets
5b5233a Remove foreign residency accounting facts
a5c6148 Define Scratch persistent cache and DEM goals
b5dc94b Define Scratch cache public contract tests
8c67417 Add Scratch persistent cache and Geo address adapter
7efe1c2 Integrate persistent raw DEM tile cache
```

## One-To-One Replacement Matrix

| Baseline liability | Required target | Implementation evidence | Executable proof | Result |
| --- | --- | --- | --- | --- |
| No reusable thread abstraction; a DEM-specific pool would repeat map-framework lock-in. | Public, explicitly constructed, non-singleton `WorkerSystem` independent of Geo and the GPU runtime. | `packages/geoscratch/src/scratch/worker/` and the `geoscratch/scratch` package export. | Public API/type tests plus real custom operation returning 42 from a module Worker. | Replaced |
| Worker code could otherwise depend on tile/DEM concepts or hidden closures. | URL-loaded namespaced modules with typed operations; no `eval`, `new Function`, serialized closure, Geo, Scratch, tile, camera, or DEM dependency. | `module.ts`, `protocol.ts`, standalone `worker-bootstrap.ts`; source dependency scan. | Module-load/error tests and production-preview DEM Worker bootstrap proof. | Replaced |
| No explicit trust, state-affinity, or reclamation boundary. | `WorkerGroup` isolation (`shared`, `group`, `task`), finite min/max capacity, sticky context, host termination on reclaim, and idempotent disposal. | `worker-system.ts` binds each host to one group and frozen `(id, version, URL)` module set; no cross-group warm reuse exists. | Stateful value advances 7 to 12 on one host, snapshots, disposes, reopens; capacity reclaim creates a new host and idle group reaches zero workers. | Replaced |
| FIFO work could starve background tasks and had no hard queue budget. | Three priority classes, scores, enqueue order, aging, group fairness, reprioritization, deadlines, and finite queue/active limits. | `WorkerTaskPriority`, group scheduler, bounded history. | Browser reprioritization changes completion order; saturation/fairness/aging unit tests pass. | Replaced |
| Network fetch and CPU decode shared one opaque concurrency ceiling. | Independently configured priority-aware network and decode budgets with active, queued, limit, and observed-maximum facts. | Scratch `TaskPhaseBudget` gates the separate Geo Worker `fetch` and `decode` operations without adding tile concepts to WorkerSystem. | `tests/scratch-task-phase-budget.test.js` reaches two simultaneous network permits and one decode permit, cancels/reprioritizes queued work, and returns all counts to zero; the headed Underwater Terrain streaming proof enforces limits 2 and 1. | Replaced |
| “Cancel” was one ambiguous operation. | Separate queued removal, cooperative abort, stale rejection, and exclusive-host hard termination. | Worker diagnostics plus task and demand reconciliation APIs. | Browser observes cooperative cancellation and crash/hard termination; DEM churn observes four cancellations and four stale results. | Replaced |
| Remote failure or host loss could become an unstructured console error. | Structured bounded diagnostics, normalized remote name/message/code/stack, blast-radius-aware termination, and replacement-host recovery. | `worker/diagnostics.ts` and host failure convergence. | Browser preserves `BROWSER_FIXTURE_REMOTE`, isolates an intentional crash, and completes work on a new worker. | Replaced |
| Worker result transfer could duplicate buffers or leave unclear ownership. | Unique transfer list, sender detachment, receiver adoption, one owner, and explicit discard. | `transferWorkerResult()` and `virtual-raster-transfer.ts`. | Browser moves six bytes and observes sender length 0; ownership tests reject duplicate/second adoption. | Replaced |
| Default Worker bootstrap only worked beside package source. | Standalone deployable bootstrap plus separately bundled user module URL. | Dependency-free emitted bootstrap, typed module contract, and framework-independent `geoscratch-worker` artifact build. | Build test forbids static sibling imports; both Vite dev and production preview complete the DEM proof. | Corrected |
| `GeoScratchLocalRasterQuad` used a southwest local grid and local zoom aliases. | OGC `WebMercatorQuad` with EPSG:3857, top-left origin, standard matrix IDs, global row/column identity, and source CRS kept separately. | `tile-matrix.ts`, `web-mercator-quad.ts`, DEM manifest validator and Python backend. | CPU/WGSL boundary tests plus manifest/Python/browser endpoint proofs. | Deleted and replaced |
| Dense page indexing grew with the full logical/world grid. | Per-matrix `TileMatrixLimits` and compact coverage offsets only for source-intersecting tiles. | `TileMatrixCoverage` and `virtualRasterTileAddressSpace()`. | Unit tests reverse compact indices, reject out-of-limit tiles, and prove global identity without dense world allocation. | Replaced |
| Persistent per-sample tile/texel decomposition would amplify dynamic-state bandwidth. | High-precision canonical position is persistent; tile, texel, sub-texel, compact entry, and physical slot are reconstructed transiently in every shader stage. | `WideFixedCodec`, `WebMercatorQuadAddressCodec`, generated virtual-raster WGSL. | Carry/borrow, antimeridian, tile/texel edge tests and 262,144-particle compute proof with zero persistent address bytes. | Replaced |
| DEM mesh stitching and sample coordinates could diverge. | Stitch first, derive one canonical coordinate, then sample at the selected logical LoD. | Geo-owned `webMercatorTerrainWgslModule` composes canonical patch reads, mixed-LoD edge snapping, wide-fixed positioning, and Virtual Raster sampling; the DEM presentation shader is fragment-only. | Generated-WGSL contract tests, shared edge quanta and mixed-LoD tests, deterministic page-boundary captures, and headed tile-wireframe proof. | Preserved, strengthened, and moved to Geo |
| Main thread fetched and decoded DEM image pages. | Worker context performs cache lookup, HTTP fetch, image decode, candidate accept/discard, and bounded facts. | `dem-tile-worker.ts`, `dem-tile-executor.ts`. | Source scan leaves `createImageBitmap` only in Worker; standard tile traffic and worker counters are observed in Chrome. | Replaced |
| Residency cloned decoded typed arrays. | Whole backing ArrayBuffer transfer and one-time owned payload adoption; residency moves ownership without clone/slice. | `virtual-raster-transfer.ts`, `virtual-raster-residency.ts`. | Detachment, source scan, identity/adoption tests, and zero sender decoded bytes after transfer. | Replaced |
| Immutable snapshots retained decoded payloads. | Snapshot holds mapping/fallback/epoch only; `VirtualRasterPublication` exclusively owns finite upload payloads until acknowledgement or abandon. | Residency publication and `VirtualRasterGpuState.stage/acknowledge`. | Snapshot tests find no payload; staging bytes return to zero after GPU observation and at teardown. | Replaced |
| CPU bytes, cache, staging, and GPU residency were one accounting bucket. | Orthogonal executor pending/decode facts, persistent cache bytes, publication staging bytes, resident GPU bytes, page count, and bounded histories, each reported only by its authority. | Executor/cache/residency/GPU facts; Residency no longer publishes foreign fields as constant false zeroes. | Unit tests reject foreign Residency facts; browser terminal facts prove active operations and transient ownership return to zero while accepted persistent payloads remain until eviction, invalidation, or clear. | Replaced |
| Completed-result retention was implicit. | Absence of a cache means `none`; independently opened Scratch `PersistentCache` stores bounded raw payloads without a built-in application memory tier. | `scratch/cache/` owns IndexedDB metadata, OPFS raw payloads, LRU budgets, recovery, diagnostics, and lifecycle. Geo owns only `virtualRasterCacheAddress()`. | Dedicated Chrome proof covers raw/meta records, reload, immutable revision, byte/entry LRU, invalidation, GC, repair, clear, storage facts, and disposal. | Replaced |
| Cache retention implied content correctness and was unsafe for editing. | Independent immutable/revisioned/editable-base coherence keys; dirty working state remains outside cache. | Geo address adapter maps coherence plus source/representation/decoder/schema facts to a Scratch `(id, revision)` key and stable invalidation prefixes. | Revision change misses; prefix invalidation and key isolation unit/browser tests pass. | Replaced |
| Camera code fanned out requests directly and acted like a fragile `prepare()` state machine. | Idempotent demand generations reconcile retained/new/obsolete pages and expose one settlement promise; delayed GPU feedback has one bounded prefetch grace generation. | `VirtualRasterRequestScheduler` and `createVirtualRasterDemandController()`. | Unit tests cover dedupe, reprioritize, cancellation, stale discard, alternating feedback, current-demand budget priority, and repeated disposal; DEM churn converges to newest camera. | Replaced |
| Root fallback could be evicted or starved by detail. | Pinned root page plus critical required priority; detail/prefetch remain lower priority. | DEM demand planner and deterministic residency LRU. | Two-page atlas repeatedly evicts detail while root fallback remains available. | Replaced |
| `/tiles/{z}/{x}/{y}.png` and full-image fallback left two data models. | Only `/tiles/WebMercatorQuad/{matrix}/{row}/{col}.png`; source PNG is offline COG input. | Python service, manifest, client URL builder, server README. | Old/full routes fail, network observer records only standard tiles, and source scan finds no browser PNG fallback. | Deleted |
| Tile orientation depended on an implicit southwest flip. | Source, COG, standard tile, and shader are north-up; top-left rows are converted exactly once by standard addressing. | Build/service manifest facts and DEM validator. | Python corner/center/random equivalence, orientation test, and headed terrain capture. | Corrected |
| Parent fallback produced nearest/blocky transitions at mixed residency LoDs. | Fallback converges to one common level, recomputes bilinear weights there, and blends only where a same-level neighbor resolves coarser. | Generated `DemHeight_sample_level` and residency-aware guard band. | Cross-page unit tests and page-boundary pixel contrast gate pass. | Corrected |
| DEM teardown did not own request/cache/Worker lifetime. | The DEM source transfers its executor through an explicit owned binding; Geo stops and settles scheduling before disposing that executor, while page `LifetimeScope` drains GPU work and releases the runtime/map authorities. | `dem-source.ts`, `VirtualRasterRuntime`, Scratch `WorkerContextPool`, and `main.ts`. | Runtime ownership tests plus pause/drain, equivalent double dispose, all task/context/cache/staging/native counters zero, and all owned processes/ports closed. | Replaced |
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

- raw payload and metadata-only records survive a new cache instance;
- caller payload mutation after `put()` cannot change the stored snapshot, and every
  hit returns a caller-owned buffer;
- the same immutable key is first-writer-wins while a new revision misses;
- independent byte and entry budgets enforce deterministic LRU;
- exact delete, ID-prefix invalidation, clear, stale pending cleanup, and orphan OPFS
  garbage collection converge;
- payload loss or size mismatch becomes a structured repair miss;
- oversize and quota outcomes are explicit, storage failures use cache-domain
  `ScratchDiagnosticError`, and persistence/estimate facts remain browser observations;
- repeated dispose is equivalent and later operations fail as `CACHE_DISPOSED`.

### DEM

- development and production-preview routes pass in headed WebGPU Chrome;
- two atlas pages force fallback and eight observed detail evictions across camera moves;
- rapid churn produces bounded cancellations and stale results without a cancellation
  loop or stale publication; accepted alternating feedback coalesces in-flight pages;
- network and decode use independent limits of two and one; observed maxima stay within
  each limit and both active/queued counts return to zero;
- camera return produces three cumulative raw-cache hits while network and decode
  counts remain unchanged;
- after complete Worker/page disposal, a new lifecycle restores two raw pages with
  zero network requests, zero image decodes, and no new COG reads;
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
- Scratch Cache has no Worker, GPU, Geo, tile, CRS, virtual-raster, or DEM dependency;
- Geo cache adaptation has no storage, LRU, budget, database, filesystem, or lifecycle
  authority;
- DEM imports library behavior only from public package entrypoints;
- `dem-source.ts` validates and freezes one manifest, then derives one model and stable
  tile-URL closure from that authority; model construction and per-page requests do not
  reparse or clone the manifest;
- generic `VirtualRasterRuntime.inspect()` remains limited to runtime authorities while
  DEM source and Worker facts are read separately and combined only by browser proof code;
- all added browser/library implementation source is TypeScript and generated `dist` is not
  tracked.

## Resolved Finding And Remaining Boundaries

The former F-1 is resolved by deleting the built-in memory tier and encoded persistent
store. DEM now persists decode-ready raw height pages in the domain-neutral Scratch
cache. A network miss makes one bounded raw snapshot because transfer detaches the
render owner before stale-result acceptance; a hit transfers a fresh OPFS read directly
and performs no image decode. This does not invent an ownership-moving decoded L1 or
claim zero-copy persistence.

The following remain explicit non-goals rather than hidden partial implementations:

- visible `flowLayer` migration;
- application JS memory cache or Service Worker CacheStorage;
- collaborative edit protocol or editor UI;
- a complete CRS engine or OGC API Tiles server;
- WebGPU native sparse textures, which are not currently available;
- changing the inherited DEM far-plane/depth policy.
