---
docId: geo.virtual-raster
canonical: true
apiSources:
  - packages/geoscratch/src/geo/virtual-raster-cache-address.ts
  - packages/geoscratch/src/geo/virtual-raster-demand.ts
  - packages/geoscratch/src/geo/virtual-raster-gpu-feedback.ts
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
protocol. The descriptor states `borrowed` or `owned` WorkerSystem authority; Geo
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
publishes coherent snapshots; leases prevent physical slots from being recycled while
a submission may still sample them. GPU feedback rings bound asynchronous readback and
reject stale slots. Feedback lowering carries a missing in-flight page for exactly one
subsequent feedback generation. This bounded continuity absorbs alternating GPU
frontier transactions without turning a single omission into cancellation; absence
from two consecutive batches still cancels obsolete work. Demand-controller facts
report the fixed grace and current deferred count. Deferred work is lowered as
background prefetch, so current refinement and the safety cover always win a bounded
request budget.
The reported deferred count includes only pages admitted to that bounded scheduling
set, not grace candidates dropped by the budget.

The runtime composes those authorities but does not invent camera demand, cache policy,
network format, or rendering geometry. Cache addresses are pure mappings into Scratch
Cache; cache remains optional. Applications can use Virtual Raster for DEM, imagery,
flow fields, classifications, simulation grids, or editable rasters without coupling
their shaders to tile neighbors or atlas coordinates.

## Related decisions

- `docs/decisions/ADR-055-high-precision-virtual-raster-dem.md`
- `docs/decisions/ADR-056-generic-worker-webmercator-virtual-raster-cache.md`
- `docs/decisions/ADR-072-worker-context-pool-and-typed-protocols.md`
- `docs/decisions/ADR-073-virtual-raster-executor-authority.md`
