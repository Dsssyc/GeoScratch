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
planes, sources, sampling profiles, accessors, and snapshots separate logical identity
from physical atlas placement. Compact source coverage avoids a dense page table for
the whole world. Library WGSL resolves exact pages, parent fallback, cross-page
filtering, and outer-boundary policy from shader positions in vertex, fragment, or
compute stages.

Demand scheduling, CPU page transfer, residency, publication, GPU tables, and feedback
are distinct authorities. The request scheduler reconciles generation-tagged demand
and cancellation. Worker executors are adapters over Scratch Worker operations.
Transfer helpers make `ArrayBuffer` ownership explicit. Residency stages pages and
publishes coherent snapshots; leases prevent physical slots from being recycled while
a submission may still sample them. GPU feedback rings bound asynchronous readback and
reject stale slots.

The runtime composes those authorities but does not invent camera demand, cache policy,
network format, or rendering geometry. Cache addresses are pure mappings into Scratch
Cache; cache remains optional. Applications can use Virtual Raster for DEM, imagery,
flow fields, classifications, simulation grids, or editable rasters without coupling
their shaders to tile neighbors or atlas coordinates.
