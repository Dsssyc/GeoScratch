# ADR-067: Geo View, Field, and Tile Spatial Profile Boundaries

## Status

Accepted

## Date

2026-08-08

## Context

The GPU-resident DEM proved a bounded WebGPU tile frontier, Virtual Raster
residency, indirect rendering, and camera-relative precision. Its reusable spatial
logic was nevertheless split across `GpuTileFrontier` and the example:

- the frontier descriptor required a `WebMercatorQuadAddressCodec`;
- CPU and WGSL spatial evaluation assumed one `1 x 1` root world;
- MapLibre camera facts were assembled directly at the frontier call site;
- GPU feedback was lowered directly into request-scheduler demand;
- height-field semantics, tiled storage, and map presentation had no separate
  identities.

That shape cannot honestly express an OGC TileMatrixSet with a `2 x 1` level-zero
matrix, and it conflates screen demand, data meaning, physical representation, and
resource scheduling. It would also make a later globe implementation either fork the
entire frontier or accumulate projection flags inside one shader.

The approved design is recorded in
[`2026-08-08-geo-view-field-tile-profile-design.md`](../superpowers/specs/2026-08-08-geo-view-field-tile-profile-design.md).

## Decision

### Tile topology is independent of spatial evaluation

`TileTopology` owns roots, matrix-level ordering, parent/children, child ordinal,
root-aware canonical paths, prefix tests, and normalized matrix bounds. The current
`regularQuadTileTopology()` accepts any finite regular OGC-style quadtree whose
adjacent matrix dimensions double. A root ordinal is the first canonical path item,
so equal local child paths under different roots cannot alias.

The implementation has a real `2 x 1` root-forest proof. It does not reduce the two
roots to a synthetic single root or a DEM-specific quadtree node type.

### The current frontier spatial contract is explicitly planar

`TileSpatialProfile` combines one topology and one finite `TileMatrixCoverage`. The
current `coordinateFrame` is deliberately restricted to `planar`. A profile supplies:

- matrix-level and matrix-id translation;
- projected and normalized tile bounds;
- covered parent/child and canonical path operations;
- camera fixed-coordinate encoding;
- the two-axis coordinate, root-bit, quantum, and high-limb facts consumed by the
  generic planar frontier WGSL.

`webMercatorPlanarTileSpatialProfile()` preserves the existing high-precision
WebMercator address codec. `planarTileSpatialProfile()` also supports rectangular root
grids such as `2 x 1`. Profile construction rejects non-regular matrices, unsupported
origins, bounding-box/matrix-span disagreement, non-power-of-two root dimensions,
endpoint aliasing, and hierarchies that do not fit the fixed-coordinate ABI. CPU tile
bounds and WGSL fixed coordinates therefore share one validated planar world instead
of independently trusting contradictory metadata.

`GpuTileFrontierDescriptor` now requires `spatialProfile`; the former bare
`addressCodec` descriptor path is removed. The CPU oracle, feedback canonicalization,
and WGSL all use profile/topology facts. There is no compatibility flag.

This is not a globe claim. A future globe frontier requires a separately reviewed
spatial evaluator for curved tile bounds, ellipsoid-relative precision, horizon and
frustum tests, screen-space error, and WGSL lowering. Multi-root topology is a
prerequisite, not a substitute for those semantics.

### Views are immutable, platform-adapted facts

`GeoViewSnapshot` is an immutable, defensively copied selection input containing the
relative clip matrix, camera high/low expansion, viewport, FOV, latitude, pitch, zoom
hint, frame epoch, and residency snapshot epoch. `GeoViewAdapter<Input>` converts a
platform-owned camera model to that snapshot without making MapLibre or Mapbox a Geo
dependency.

The DEM keeps MapLibre duck types and `far`, `near`, center, bearing, and presentation
facts in the example. Its adapter emits `dem-map-view` snapshots. Map runtime discovery
occurs only when a map operation is invoked, so importing the layer contract does not
require a DOM or global MapLibre object.

Delayed GPU feedback remains paired with the exact snapshot that produced it. DEM
reconciliation rejects a frame-epoch or residency-epoch mismatch before changing
generation or request state.

### View demand is not request ownership

`ViewDemandProducer` performs a stateless, bounded, deterministic conversion from a
snapshot plus page intents to `ViewTileDemandSet`. Each demand records view id, producer
id, frame epoch, residency epoch, priority, intent, and reason. A separate
`virtualRasterDemandSetFromViewDemands()` lowering maps view intent to the existing
request-scheduler contract.

The producer does not own a scheduler, Worker, cache, residency, network request, or
GPU resource. DEM safety-cover demands remain explicit application requirements and
are composed with lowered view demands.

### Field meaning, tiled representation, and map composition are separate

`GeoField` describes semantic sample facts: domain, field kind, channels, sample type,
unit, no-data value, and interpolation. `TiledFieldRepresentation` binds one field to a
Virtual Raster plane, spatial profile, coverage, and source revision.

`MapFieldLayer` validates and exposes one planar field composition:

```text
GeoField
    + TiledFieldRepresentation
    + TileSpatialProfile(planar)
    + GeoViewAdapter
    + ViewDemandProducer
```

It intentionally has no lifecycle methods and owns no runtime, cache, Worker,
scheduler, atlas, pipeline, or submission. The DEM example remains the owner of those
objects and uses the layer only as an explicit composition boundary.

## Consequences

- DEM behavior retains its existing GPU command graph, residency authority, precision,
  mesh stitching, cache policy, and Worker pipeline.
- The same frontier algorithms can evaluate a finite `1 x 1` or `2 x 1` planar root
  forest without a WebMercator import.
- Camera provenance and resource demand are inspectable at the boundary where delayed
  GPU feedback enters CPU scheduling.
- A field can gain another physical representation without changing its semantic
  identity, and a presentation can be replaced without acquiring hidden resource
  ownership.
- Globe, simulation, and editing remain explicit future designs. They may reuse field,
  topology, demand, residency, and Scratch primitives, but they are not forced through
  the screen-only Map composition.

## Rejected Alternatives

### Keep WebMercator in the frontier and add a second globe frontier

Rejected because traversal, budgeting, compaction, feedback, and residency semantics
would fork with the projection.

### Add projection and root-count flags to one shader

Rejected because planar AABBs and ellipsoid patches do not share one honest spatial
test. Flags would hide incompatible precision, culling, and error models.

### Make camera the only demand authority

Rejected because simulation, analysis, and editing can require off-screen data. This
ADR accepts only a screen-view demand producer and leaves additional producers
composable.

### Let MapFieldLayer create cache, Worker, scheduler, or GPU resources

Rejected because it would combine unrelated lifetimes, make no-cache operation
implicit, and recreate a global tile state machine.

### Preserve the old address-codec descriptor as compatibility

Rejected because GeoScratch is `0.x.x` and the clean target has one spatial authority.

## References

- [OGC Two Dimensional Tile Matrix Set 2.0](https://docs.ogc.org/is/17-083r4/17-083r4.html)
- [Cesium GeographicTilingScheme](https://cesium.com/learn/cesiumjs/ref-doc/GeographicTilingScheme.html)
- [MapLibre globe view](https://maplibre.org/roadmap/maplibre-gl-js/globe-view/)
- [S2 cell hierarchy](https://s2geometry.io/devguide/s2cell_hierarchy)
