---
docId: geo.virtual-raster
canonical: true
apiSources:
  - packages/geoscratch/src/geo/virtual-raster-cache-address.ts
  - packages/geoscratch/src/geo/virtual-raster-demand.ts
  - packages/geoscratch/src/geo/virtual-raster-gpu.ts
  - packages/geoscratch/src/geo/virtual-raster-residency.ts
  - packages/geoscratch/src/geo/virtual-raster-runtime.ts
  - packages/geoscratch/src/geo/virtual-raster-transfer.ts
  - packages/geoscratch/src/geo/virtual-raster-worker-executor.ts
  - packages/geoscratch/src/geo/virtual-raster.ts
---
# Virtual Raster

[简体中文](./virtual-raster_zh.md) | [Geo overview](./README.md)

Virtual Raster presents a logical field larger than finite GPU storage. Address spaces,
planes, request executors, sampling profiles, accessors, and snapshots separate logical
identity from physical atlas placement. Compact source coverage avoids a dense page table for
the whole world. Library WGSL resolves exact pages, parent fallback, cross-page
filtering, and outer-boundary policy from shader positions in vertex, fragment, or
compute stages.

Demand scheduling, CPU page transfer, residency, publication, GPU tables, and feedback
are distinct authorities. The request scheduler reconciles generation-tagged demand
and cancellation. `VirtualRasterRequestExecutor` is the sole executable asynchronous
page-source boundary consumed by scheduling and runtime composition; there is no
disconnected `loadPage()` source object beside it. Decoded ownership is expressed only
as `OwnedVirtualRasterPagePayload` and its transfer operations, not by an alias with a
second identity. `createVirtualRasterWorkerExecutor` adapts one fixed seven-operation
context protocol (`lookup`, `fetch`, `decode`, `transfer`, `accept`, `discard`, and
`facts`) over `WorkerContextPool` and independently bounded network/decode phases.
`VirtualRasterWorkerModuleProtocol` gives source implementations the same typed
protocol. Its descriptor accepts either that typed contract, preserving candidate/init/
Worker-facts inference, or one deployment `WorkerModuleReference`. The descriptor states
`borrowed` or `owned` WorkerSystem authority; Geo
does not infer ownership, accept operation-name aliases, or fabricate initial and
disposed Worker facts. Facts are queried from live contexts, and pool terminal state
records whether remote Worker finalizers completed or lifecycle authority forced
bounded termination. Executor facts label Worker business snapshots as `live` or
`last-observed-before-disposal`; after disposal, context-pool facts rather than a
fabricated business snapshot are the lifecycle authority.

`createVirtualRasterRuntime` also requires an explicit `VirtualRasterExecutorBinding`.
A `borrowed` executor remains entirely caller-owned. An `owned` executor must provide
asynchronous `dispose()`; ownership transfers when runtime creation begins, creation
failure releases it, and runtime disposal stops and settles scheduler work before
releasing it exactly once. Independent shutdown failures are retained together rather
than allowing one failure to skip another authority. Runtime facts report the declared
executor ownership without fabricating executor business state.
Transfer helpers make `ArrayBuffer` ownership explicit. Residency stages pages and
publishes coherent snapshots; optional leases remain available to consumers that must
hold physical assignments across asynchronous work. The runtime itself consumes
explicit `ViewTileDemandSet` values through `reconcileViewDemands()`. It does not
inspect camera, zoom, projected error, adjacency, or geometry topology.

Demand producers retain `desiredSampleLevel` and `sourceLevelCeiling`; lowering to
`VirtualRasterDemandSet` passes only the executable page, priority, usage, generation,
and reason. Known source ceilings therefore suppress impossible requests without
rewriting desired precision. Runtime construction reserves request and physical-page
capacity for every pinned safety-cover page; `ViewDemandProducer.maxDemands` is the
remaining `min(maxPhysicalPages, maxRequests) - safetyCoverPageCount` capacity and may
therefore be zero. Reconciliation sends both exact-resident and missing selected pages
from that runtime-owned producer to the scheduler; foreign or over-capacity sets fail
instead of being silently reordered or truncated. The scheduler marks resident pages
used and requests only missing pages, so a tight atlas cannot repeatedly evict two
current detail pages through one free slot. The complete geometry cover remains independent
from this residency budget.

`VirtualRasterResidencyFacts.staleResponseCount` includes both rejected obsolete
staging/failure attempts and previously valid staged pages retired when a newer demand
no longer selects them. Retiring a staged page releases its owned bytes before GPU
publication; the counter alone does not mean stale data was adopted. Same-page demand
retention rebases its staged generation instead of discarding it. These retirements
are cancellation cost and should be distinguished from invalid source adoption in audits.

`VirtualRasterGpuState.encode()` records exact update ownership and appends a staged
publication before dependent commands in one open submission. After that submission
has entered the same WebGPU queue, later frames may reference its staged snapshot while
native acknowledgement is still pending because queue order preserves the dependency.
An unencoded staged snapshot, a different runtime, or a different update remains
invalid. Acknowledgement is still the commit authority: it advances the public snapshot
epoch only after every update command is present and native execution succeeds.

The runtime composes those authorities but does not invent camera demand, cache policy,
network format, or rendering geometry. Cache addresses are pure mappings into Scratch
Cache; cache remains optional. `virtualRasterCacheMetadataMatches()` compares untrusted
stored metadata with every canonical address identity field while allowing source-specific
payload facts beside that base metadata. A source Worker still validates its own payload
shape and treats an identity mismatch as a cache miss rather than adopting stale bytes.
Applications can use Virtual Raster for DEM, imagery,
flow fields, classifications, simulation grids, or editable rasters without coupling
their shaders to tile neighbors or atlas coordinates.

## Related decisions

- `docs/decisions/ADR-055-high-precision-virtual-raster-dem.md`
- `docs/decisions/ADR-056-generic-worker-webmercator-virtual-raster-cache.md`
- `docs/decisions/ADR-072-worker-context-pool-and-typed-protocols.md`
- `docs/decisions/ADR-073-virtual-raster-executor-authority.md`
- `docs/decisions/ADR-085-maplibre-readiness-and-raster-source-boundaries.md`
