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

Every patch is an OGC identity `(tileMatrix, tileRow, tileCol)`. Camera-derived probing
addresses the fixed global matrix and never creates a moving game-style grid. At every
pitch, `writeView()` prepares conservative standard-parent windows from the actual
projection matrix and precise fixed-point camera. The GPU records an exact sparse
parent identity only where the maximum
singular stretch of one projected geometry cell exceeds
`maximumCellSpanReferencePixels` plus `refinementTolerance`. Pitch and FOV affect the
projection naturally; they never select a uniform/variable algorithm mode.

Candidate membership follows a projected-depth bound, not radial distance or a
pitch/FOV-hint algorithm switch. With cell width `h`, reference pixel scales `s`,
and the actual projection `M`, `B_ij = s_i * (abs(M_ij) + abs(M_wj))` bounds the
clipped Jacobian: `maximumStretch <= h * ||B||F / w`. The inverse projection maps
the resulting depth cap to conservative standard row/column windows. Separate f32
coordinate/clipping/metric error bounds and inverse residual intervals enlarge the
window. Clipping retains camera-relative world vertices and evaluates raw plane
equations formed from matrix rows before projection. Only the clipped vertices
are projected for quality evaluation. This avoids losing near/far depth constants
when mixing or subtracting large clip coordinates on coarse patches; interpolation
retains affine homogeneous `w=1`. The shader clamps clipped NDC and interpolation ratios to their mathematical
domains and avoids division by a subnormal clipping denominator. These constraints
limit roundoff; they do not change the exact projected-cell definition.

Uncertifiable arithmetic uses the complete declared geometry domain. The independent
coarse seed domain is never restricted by a refinement cap. `maximumCandidates` on
the cover descriptor bounds the sum of seed and refinement input candidates; it
defaults to `max(16384, 64 * maximumPatches)`. Invalid budgets fail at construction;
an over-budget view fails synchronously in `writeView()` with
`GEO_WEB_MERCATOR_COVER_CANDIDATE_CAPACITY_EXCEEDED`, before an upload/token is created.
The selector never shrinks the domain to fit. This input budget does not count
materialized children or subsequent adjacency work. `facts().candidateCapacity`
reports it separately from output patch and lookup capacity.

The projected metric uses `GeoViewSnapshot.referenceViewport`, a rotation-invariant
local projective Jacobian, perspective, foreshortening, and immutable vertical bounds.
Its largest singular value constrains the longest screen direction instead of hiding a
long, thin cell behind small projected area. Physical presentation size and DPR never
change cover identities. A cell that can cross the camera plane refines conservatively.

`GpuWebMercatorQuadCoverPolicy` declares ordered geometry levels, hard patch capacity,
`cellsPerPatchEdge`, `maximumCellSpanReferencePixels`, and numerical tolerance. Invalid
facts fail before resource creation. The built-in terrain consumer uses 128 cells and
a calibrated five-reference-pixel threshold. The public cover policy contains no
source ceiling or pitch boundary.

The kernel seeds the declared minimum geometry window, probes bounded parents, preserves
each exact ancestor decision, replaces a selected parent only with its own four standard
children, emits a prefix-free visible cut, and performs local 2:1 closure. Independent
parents are never unioned into a level-wide rectangle. It does not start at world roots,
traverse a root-to-leaf
quadtree, count trial cuts, inspect atlas slots, or retain previous-frame topology as
selection authority. Descriptor, lookup, or patch-capacity overflow is a hard
diagnostic; no path silently coarsens the cut. A successful empty visible cut has
`patchCount: 0` and omits level/span ranges. Overflow or incomplete 2:1 closure
remains failure even when no patches survive; range sentinels are not public values.

`WebMercatorTileVerticalBounds` is a geometry fact rather than terrain identity. A
flat consumer can use `[0, 0]`; terrain can convert source elevation metadata; an
extruded consumer can provide conservative feature heights. A supplied hierarchy must
exactly match the spatial profile. Geometry above its highest level uses that ancestor.
An omitted hierarchy uses `verticalRangeMeters`. Cache, request, and residency state
cannot change these bounds.

`GpuWebMercatorQuadCoverTemplate` exposes borrowed parity resources for downstream
GPU components: map metadata, patches, lookup, and full state. `writeView()` owns one
ephemeral upload containing camera facts and the conservative windows; `frame()` selects parity,
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
Raster remains downstream and passive. Before reading patches, projection rejects
a failed cover or mismatched frame: it emits no demands and sets its existing
`overflowCount` failure marker. Nonzero overflow therefore also includes an invalid
upstream cover, and feedback decoding rejects it instead of reporting a valid empty demand.

`GpuWebMercatorQuadPatchDraw` is the separate draw-count adapter. It borrows cover
state, owns one consumer element count plus parity draw-indirect buffers, and uses one
persistent compute dispatch to write `[elementCount, patchCount, 0, 0, 0]`. The 20-byte
record is valid for indexed draw and its first 16 bytes remain valid for non-indexed draw.
A failed cover produces zero instances, so partial geometry is never drawn while
CPU feedback is pending. The cover owns neither those buffers nor the consumer mesh.

Related decisions: ADR-083 establishes inverse-cover and passive Virtual Raster;
ADR-084 establishes reference-pixel quality; ADR-086 supersedes their pitch-gated
parts and separates cover, source demand, and patch draw ownership; ADR-087 preserves
sparse parent decisions; ADR-088 defines maximum projected stretch; ADR-089 defines the
consumer-neutral indexed/non-indexed indirect ABI. ADR-125 records candidate
completeness, failed-cut revocation and the bounded execution work.
