---
docId: geo.view-cover
canonical: true
apiSources:
  - packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-layout.ts
  - packages/geoscratch/src/geo/gpu-web-mercator-quad-cover.ts
  - packages/geoscratch/src/geo/gpu-web-mercator-quad-demand.ts
  - packages/geoscratch/src/geo/gpu-web-mercator-quad-patch-draw.ts
---
# WebMercatorQuad View Cover

[简体中文](./view-cover_zh.md) | [Geo overview](./README.md)

`GpuWebMercatorQuadCover` is Geo's geometry-LoD authority for planar
`WebMercatorQuad` patch rendering. It consumes one immutable `GeoViewSnapshot` and
emits a bounded standard-tile cut, full-identity neighbor lookup, GPU patch count, and
geometry feedback. It does not own a tiled source, raster demand, atlas residency,
mesh vertex count, or draw arguments.

Every patch is an OGC identity `(tileMatrix, tileRow, tileCol)`. Camera-derived level
windows address the fixed global matrix and never create a moving game-style grid. At
every pitch, one adaptive kernel probes bounded standard parents around the precise
fixed-point camera position and creates nested child windows only where the
area-equivalent projected span of one geometry cell exceeds
`maximumCellSpanReferencePixels` plus `refinementTolerance`. Pitch and FOV affect the
projection naturally; they never select a uniform/variable algorithm mode.

The projected metric uses `GeoViewSnapshot.referenceViewport`, a rotation-invariant
local projective Jacobian, perspective, foreshortening, and immutable vertical bounds.
Physical presentation size and DPR never change cover identities. A cell that can
cross the camera plane refines conservatively.

`GpuWebMercatorQuadCoverPolicy` declares ordered geometry levels, hard patch capacity,
`cellsPerPatchEdge`, `maximumCellSpanReferencePixels`, and numerical tolerance. Invalid
facts fail before resource creation. The built-in terrain consumer uses 128 cells and
a calibrated four-reference-pixel threshold. The public cover policy contains no
source ceiling or pitch boundary.

The kernel seeds the declared minimum geometry window, probes bounded parent windows,
nests standard children through their ancestors, emits a prefix-free visible cut, and
performs local 2:1 closure. It does not start at world roots, traverse a root-to-leaf
quadtree, count trial cuts, inspect atlas slots, or retain previous-frame topology as
selection authority. Descriptor, lookup, or patch-capacity overflow is a hard
diagnostic; no path silently coarsens the cut.

`WebMercatorTileVerticalBounds` is a geometry fact rather than terrain identity. A
flat consumer can use `[0, 0]`; terrain can convert source elevation metadata; an
extruded consumer can provide conservative feature heights. A supplied hierarchy must
exactly match the spatial profile. Geometry above its highest level uses that ancestor.
An omitted hierarchy uses `verticalRangeMeters`. Cache, request, and residency state
cannot change these bounds.

`GpuWebMercatorQuadCoverTemplate` exposes borrowed parity resources for downstream
GPU components: map metadata, patches, lookup, and full state. `writeView()` owns one
ephemeral upload, `frame()` selects parity,
`encode()` submits one adaptive compute, and `capture()` reads only geometry state.
Feedback reports candidate/patch counts, level range, adjacency, projected-cell span,
and overflow facts. It contains no demand records or selection mode.

`gpuWebMercatorQuadCoverReadWgslModule()` exposes full-identity lookup,
covering-neighbor resolution, and edge-coordinate snapping for patch consumers.
Entries store complete level, row, and column facts rather than a compact z14 key.

`GpuWebMercatorQuadDemandProjection` is the separate source-lowering stage. It borrows
a cover frame, owns one source coverage and its own parity resources, deduplicates
executable source tiles, and preserves `desiredSampleLevel`, `sourceLevelCeiling`,
request identity, wrapped camera-distance priority, frame epoch, and residency epoch as
separate facts. Its bounded feedback can be converted to `ViewTileDemandSet`; Virtual
Raster remains downstream and passive.

`GpuWebMercatorQuadPatchDraw` is the separate draw-count adapter. It borrows cover
state, owns one consumer vertex count plus parity draw-indirect buffers, and uses one
persistent compute dispatch to write `[vertexCount, patchCount, 0, 0]`. The cover owns
neither those buffers nor the consumer mesh.

Related decisions: ADR-083 establishes inverse-cover and passive Virtual Raster;
ADR-084 establishes reference-pixel quality; ADR-086 supersedes their pitch-gated
parts and separates cover, source demand, and patch draw ownership.
