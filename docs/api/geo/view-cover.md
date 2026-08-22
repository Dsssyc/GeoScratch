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
Camera/view-derived level windows select from the fixed global matrix and never create
a moving game-style grid. The kernel evaluates the area-equivalent projected span of
one geometry cell with a rotation-invariant local projective Jacobian. The metric
uses `referenceViewport` pixels and includes perspective, foreshortening, and exact
immutable tile elevation bounds. DPR and physical presentation size never change the
cover; a cell that can cross the camera plane still refines conservatively.

`variableLodPitchThresholdRadians` divides two deterministic modes. A pitch strictly
below the threshold anchors the complete footprint at the 512-reference-pixel
WebMercator zoom and emits one uniform geometry level, refining the whole footprint
only when projected quality requires it. A pitch equal to or above the threshold
directly probes bounded standard parents around the precise camera coordinate at every
possible level and creates nested child windows only where projected cell span exceeds
the threshold. Both modes conservatively reject invisible candidates and finish with
the same prefix-free emission and local 2:1 closure. Candidate work scales with the
bounded visible footprint and hard patch capacity; there is no constant candidate
claim independent of viewport size. The kernel does not start at world roots, traverse
a root-to-leaf quadtree, count trial cuts, or retain previous-frame topology as
selection authority.

`GpuWebMercatorQuadCoverPolicy` declares ordered geometry/source levels, one hard
patch capacity, `referenceTileSizePixels`, `cellsPerPatchEdge`,
`maximumCellSpanReferencePixels`, `refinementTolerance`, and
`variableLodPitchThresholdRadians` in `[0, PI / 2]`. Invalid quality or threshold facts
fail before resource creation. Complete demand capacity is derived from the patch bound
because one patch emits at most one demand. `sourceMaximumMatrixLevel` is a source fact,
not a geometry ceiling. Geometry patches may continue to z14 while raster demand lowers
to a standard z10 ancestor. Feedback retains `desiredSampleLevel`,
`sourceLevelCeiling`, and the executable request tile as separate facts.
Demand priority orders desired precision first, then wrapped standard-tile distance
to the camera anchor, so a tight residency budget does not fall back to row/column key order.

Selection feedback reports `selectionMode`, final minimum/maximum geometry levels,
and Q8-decoded `minimumCellSpanReferencePixels` /
`maximumCellSpanReferencePixels`. These facts are observation-only;
they never feed the next frame. Descriptor, lookup, demand, or capacity overflow is a
hard diagnostic and never silently coarsens the requested cut.

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

An optional complete `WebMercatorTileElevationBounds` hierarchy supplies one immutable
minimum/maximum pair for every source tile. Geometry above the source ceiling uses the
source-ceiling ancestor. Partial hierarchies are invalid; an omitted hierarchy uses the
global descriptor range. Cover facts expose hierarchy/global mode and record count.
Residency, request completion, cache hits, and atlas contents cannot alter these bounds.

Related decisions:
`docs/decisions/ADR-083-webmercator-inverse-cover-passive-virtual-raster.md`
establishes inverse cover and passive Virtual Raster authority;
`docs/decisions/ADR-084-reference-pixel-terrain-lod.md` defines the reference-pixel
quality model and immutable elevation hierarchy.
