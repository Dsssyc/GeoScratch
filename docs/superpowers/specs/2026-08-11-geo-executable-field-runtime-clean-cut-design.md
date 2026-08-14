# Geo Executable Field Runtime Clean Cut Design

Status: Accepted; amended by ADR-074
Date: 2026-08-11

## Goal

Make `examples/demLayer` a thin consumer of public `geoscratch/scratch` and
`geoscratch/geo` APIs. Scratch continues to own domain-independent GPU, Worker,
cache, diagnostics, and scheduling primitives. Geo owns map-camera adaptation,
tile-space demand, Virtual Raster execution, GPU render-patch selection, and
WebMercator terrain lowering. The example owns only DEM source interpretation, its
Worker task implementation, presentation controls, and fragment presentation WGSL.

## Current Problem

The current public Geo surface contains the right low-level nouns but not the
complete executable products. `MapFieldLayer` validates a field composition,
while the example still assembles residency, request scheduling, GPU feedback,
MapLibre camera precision, render-patch refinement, indirect drawing, and the
entire Scratch graph. This makes the example the real framework implementation
and leaves the public API unable to reproduce the example without copying it.

## Ownership

### Scratch

- `GPURuntime`, `Surface`, resources, layouts, programs, pipelines, commands,
  passes, submissions, readback, diagnostics, Worker groups, and Persistent Cache.
- A generic bounded phase budget for arbitrary asynchronous CPU work. It has no
  tile, network, decode, Geo, or DEM vocabulary.

### Geo

- Immutable view snapshots and concrete MapLibre-compatible planar view reading.
- Tile topology, spatial profiles, view demand, GPU tile frontier, and feedback.
- A WebMercator tiled Virtual Raster field model that owns geographic-to-tile
  address lowering and generated shader sampling functions.
- An explicit Virtual Raster runtime that composes caller-supplied request
  execution with residency, request scheduling, GPU atlas/page-table state,
  publication acknowledgement, transition leases, and bounded diagnostics.
- A generic planar render-patch frontier with its own library-owned WGSL kernel.
- A WebMercator terrain renderer that lowers a scalar `MapFieldLayer` plus Virtual
  Raster runtime into persistent Scratch resources, generated terrain WGSL, and
  explicit submissions.

### DEM Example

- Parse and validate the demo manifest.
- Translate the manifest into the public WebMercator Virtual Raster field
  descriptor.
- Implement DEM tile URL construction, Worker task payloads, PNG decoding, and
  application-selected cache policy.
- Supply terrain presentation WGSL.
- Create the map, runtime, Geo products, controls, and render loop.
- Keep browser-proof instrumentation outside the rendering implementation.

## Public Products

### `TaskPhaseBudget<Phase>`

A Scratch utility with explicit per-phase limits, priority-aware acquisition,
cancellation, bounded facts, and idempotent permit release. Phase names are
caller-defined strings.

### `MapLibrePlanarViewAdapter`

A dependency-light structural adapter. It reads the MapLibre/Mapbox transform,
constructs a camera-relative WebMercator matrix in JavaScript `f64`, splits the
projected camera origin into high/low `f32` pairs, and emits an immutable
`GeoViewSnapshot` with runtime-supplied frame and residency provenance.

It does not create or own a map and does not access global `maplibregl` state.

### `WebMercatorVirtualRasterField`

An immutable composition of coverage, address space, address codec, spatial
profile, semantic field, tiled representation, plane, geographic coverage, and
minimum-level safety pages. It generates a namespaced WGSL accessor for vertex,
fragment, and compute stages without exposing physical atlas addressing to the
consumer shader.

### `VirtualRasterRuntime`

An explicit runtime product created from a `GPURuntime`, one tiled field model,
one caller-supplied `VirtualRasterRequestExecutor`, and explicit budgets. It owns
residency, request scheduling, GPU state, demand reconciliation, publications,
and transition leases. Request executor disposal remains caller-owned so Worker
and cache lifetimes are not silently fused with GPU lifetime.

The shutdown sequence is explicit: stop demand, settle/dispose the request
executor, then dispose the Virtual Raster runtime.

### `GpuRenderPatchFrontier`

A planar GPU product that expands visible source tiles into distance-aware
screen-space render patches, applies temporal hysteresis and bounded selection,
balances the final cut to a maximum adjacent level delta of one, and publishes
indirect draw arguments plus delayed structured feedback. Its compute WGSL is a
library implementation detail.

### `WebMercatorTerrainRenderer`

An explicit OGC `WebMercatorQuad` Geo rendering product. It owns the terrain
geometry, render-patch frontier, depth target, Scratch binding graph, render
pipelines, commands, generated precision/patch/stitching/height-sampling WGSL,
and feedback orchestration. It borrows a `VirtualRasterRuntime`, `MapFieldLayer`,
`GPURuntime`, and `Surface`; it does not create or dispose those owners.

The application supplies fragment presentation WGSL and selects a named
presentation. The renderer composes it after the generated field-sampling and
complete WebMercator terrain modules. No projection-neutral alias is exposed.

## Data Flow

```text
MapLibre map
  -> MapLibrePlanarViewAdapter
  -> GeoViewSnapshot
  -> GpuTileFrontier
  -> VirtualRaster demand feedback
  -> caller-owned Worker request executor
  -> VirtualRasterRuntime residency/publication
  -> GpuRenderPatchFrontier
  -> WebMercatorTerrainRenderer indirect draw
  -> Scratch submission
```

The CPU never traverses the complete quadtree per frame and never reads terrain
selection back synchronously. Delayed feedback remains epoch-bound and stale or
superseded results remain explicit.

## Diagnostics And Lifetimes

- New public Geo validation uses `GeoDiagnosticError`; Scratch validation uses
  `ScratchDiagnosticError`.
- Every runtime product exposes immutable facts and rejects use after disposal.
- Publication acknowledgement remains single-authority and monotonic.
- Map view snapshots carry frame and residency epochs supplied by the rendering
  owner, not fabricated by a camera adapter.
- No product silently creates a WorkerSystem, Persistent Cache, map, GPURuntime,
  or Surface.

## Clean-Cut Requirements

- Remove the example-owned render-patch implementation and shader.
- Remove the example-owned GPU graph implementation.
- Remove the example-owned MapLibre precision implementation.
- Remove the DEM-named generic phase budget.
- Do not leave forwarding wrappers that preserve old example APIs solely for
  compatibility.
- Do not add DEM, MapLibre, tile, cache, or Worker concepts to Scratch GPU core.
- Do not make `MapFieldLayer` a hidden lifecycle or resource owner.
- Do not change the visual behavior, LoD policy, 2:1 balancing, camera precision,
  cache controls, or Worker/cache independence already proven by the example.

## Acceptance

- `examples/demLayer` imports executable field, camera, Virtual Raster, and
  render-patch behavior only from public package entrypoints.
- The example contains no `GpuTileFrontier`, residency, GPU page-table, indirect
  frontier, bind-layout, pipeline, pass, or command construction.
- The example supplies exactly its data-source implementation and terrain WGSL.
- Public type tests cover every new product.
- Existing CPU parity, browser proof, wireframe, LoD, camera stability, cache,
  Worker, and Scratch provenance tests continue to pass after import migration.
- `npm test`, `npm run typecheck`, and `npm run build` pass.
- A WebGPU browser run proves shaded and wireframe terrain, camera movement,
  pitched-view distance LoD, resize, and disposal.

## Rejected Alternatives

### Put everything in `MapFieldLayer`

Rejected because it would merge map, Worker, cache, source, GPU, and presentation
lifetimes into another hidden global state machine.

### Keep example wrappers over copied implementations

Rejected because the public Geo API would still be unable to express the working
example and duplicated algorithms would drift.

### Move DEM-named files unchanged into Geo

Rejected because source decoding and elevation portrayal are valid specializations,
but camera precision, Virtual Raster execution, and render-patch selection are not
DEM concepts.
