---
docId: geo.view-cover
canonical: true
apiSources:
  - packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-layout.ts
  - packages/geoscratch/src/geo/gpu-web-mercator-quad-cover.ts
---
# WebMercatorQuad View Cover

[简体中文](./view-cover_zh.md) | [Geo overview](./README.md)

`GpuWebMercatorQuadCover` is Geo's single geometry-LoD authority for planar
`WebMercatorQuad` rendering. It consumes immutable `GeoViewSnapshot` facts and emits a
bounded standard-tile cover, full-identity neighbor lookup, desired raster-page
feedback, and indirect draw arguments. CPU frame work uploads view facts and submits
the persistent graph; it does not materialize a selected tile list.

Every emitted patch is an OGC tile identity `(tileMatrix, tileRow, tileCol)`.
Camera-centered level bands select from the fixed global matrix and never create a
moving game-style grid. The kernel starts at the camera-derived finest standard tile,
constructs parent-aligned nested windows, conservatively rejects invisible candidates,
and performs local 2:1 closure only over that bounded candidate cover. It does not
start at world roots, traverse a root-to-leaf quadtree, count trial cuts, or retain
previous-frame topology as selection authority.

`GpuWebMercatorQuadCoverPolicy` declares ordered geometry/source levels and one hard
patch capacity. Complete demand capacity is derived from that same bound because one
patch emits at most one demand. `sourceMaximumMatrixLevel` is a source fact, not a
geometry ceiling. Geometry patches may continue to z14 while their raster demand lowers to a
standard z10 ancestor. Feedback retains `desiredSampleLevel`,
`sourceLevelCeiling`, and the executable request tile as separate facts.
Demand priority orders desired precision first, then wrapped standard-tile distance
to the camera anchor, so a tight residency budget does not fall back to row/column key order.

`gpuWebMercatorQuadCoverReadWgslModule()` exposes bounded full-identity lookup,
covering-neighbor resolution, and edge-coordinate snapping. Lookup entries store the
complete level, row, and column rather than a collision-prone compact z14 key, so the
contract remains valid through the WebMercatorQuad level range.

The cover owns two parity resource sets for bounded double-flight. `writeView()` creates
one ephemeral view upload, `frame()` selects parity from submission-sequence authority,
`encode()` appends the upload and one cover compute dispatch, and `capture()` appends
bounded state/demand readbacks. Feedback rejects overflow, stale frame epochs, and
final edge-adjacent level deltas greater than one. Root/trial counters are not retained
as constant compatibility vocabulary; structural gates prove those paths are absent.

Virtual Raster is downstream. The cover chooses geometry and desired sample precision;
Virtual Raster only schedules explicit page demand, manages residency, and resolves
exact or ancestor data.
