# WebMercatorQuad Continuous Distance-Band Symmetry Repair

## Status

Superseded on 2026-08-19 by
`2026-08-19-webmercator-projected-cell-pitch-gated-cover-design.md`. This English
document remains the canonical historical account of the parity-bias repair; its
constant-radius quality policy is no longer current.

This design repairs one defect in ADR-083's inverse cover. It does not introduce a
second selector or replace the accepted architecture.

## Observed Defect

The finest cover currently creates a fixed 4 by 4 tile window by rounding only its
minimum row and column down to an even parent-group boundary. When the camera tile
index is odd, the camera tile becomes the last tile in the window. At the example's
default position, the z14 camera column is `13697.966`, while the selected finest
window is `13694..13697`: the camera has nearly four tiles of fine coverage on one
side and almost none on the other.

Direct-to-final and pitched/rotated-to-final browser trajectories produce identical
cover facts and pixel hashes. The defect is therefore deterministic spatial
quantization, not stale feedback, previous topology, residency, or floating-point
drift.

## Inherited Non-Negotiable Boundaries

The repair preserves all accepted ADR-083 boundaries:

- every patch remains an OGC `WebMercatorQuad` matrix/row/column identity;
- the cover remains the only geometry LoD authority;
- generation starts from camera/view facts and never traverses world roots;
- Virtual Raster remains a passive demand, residency, and fallback service;
- output remains deterministic, prefix-free, complete over visible source coverage,
  and edge-adjacent by at most one level;
- mesh stitching, full-identity lookup, indirect draw, double-flight resources,
  high-precision camera encoding, lifecycle, and diagnostics remain unchanged;
- previous-frame topology and atlas availability never choose the settled cut.

## Industrial Evidence

MapLibre GL JS computes desired zoom from continuous camera-to-tile bounding-volume
distance. MapLibre Native exposes a minimum fine-detail radius and splits by the
continuous distance from the view/camera point to each tile AABB. Cesium selects
terrain by projected geometric error and provider-reported tile distance. deck.gl's
ordinary planar tile cover avoids mixed-LoD asymmetry by using one zoom over continuous
viewport bounds.

The reusable principle is continuous spatial error/distance. Their root-forward
traversals, orientation thresholds, cache coupling, and previous-frame availability
logic are not adopted.

## Decision

Replace the parity-shifted fixed window with camera-centered continuous AABB-distance
bands. Keep direct bounded enumeration.

### Fixed-coordinate band

For each participating matrix level `L`, let the camera's canonical wide-fixed axis
coordinate be `C`, with `Q` coordinate bits. One tile spans
`2^(Q - L)` fixed units. The band uses a constant minimum fine radius
`R = 2` in that level's tile units.

For one axis:

```text
tile       = floor(C / tileWidth)
fractional = C mod tileWidth != 0
rawMin     = tile - R
rawMax     = tile + R - (fractional ? 0 : 1)
```

`rawMin..rawMax` is exactly the set of standard tile AABBs whose one-dimensional
distance from the continuous camera point is less than `R`. No f32 conversion is
needed: `tile` and `fractional` are derived directly from the two u32 fixed limbs.

The raw interval is then expanded, never shifted or shrunk, to complete parent groups:

```text
alignedMin = rawMin rounded down to an even child index
alignedMax = rawMax rounded up to an odd child index
```

Consequently each non-minimum-level axis contains at most six tiles, so one level
enumerates at most 36 candidates. Exact parent-center ties expand both directions
instead of choosing an arbitrary side.

### Nested direct bands

Bands are generated independently from the same continuous camera coordinate at each
level. A coarser band is unioned with the parent projection of the finer band as a
defensive completeness check, then clamped to `TileMatrixCoverage`. The minimum matrix
level retains the complete configured safety domain.

The existing finest-level decision (`ceil(zoomHint)` plus the accepted pitch boost)
is unchanged. Pitch and bearing do not bias band direction. Bearing affects only final
frustum visibility; it does not rotate or shift the world-space LoD field.

Candidates covered by a finer band are omitted exactly as before. The existing final
frustum test, 2:1 closure, lookup construction, demand generation, source-ceiling
lowering, and indirect arguments remain unchanged.

## Observable Guarantees

- Mirror-equivalent tile AABBs have equal desired levels for an arbitrary continuous
  camera position, including odd row/column indices.
- Quantization may expand a band by at most one tile on each edge; it can never remove
  the guaranteed radius or move the complete band to one side.
- Returning to the same camera produces the same cover regardless of navigation path.
- At fixed camera position and zoom, bearing 0 and 180 expose the same world-space LoD
  organization after rotating visibility.
- Candidate work remains bounded by at most 36 candidates per non-minimum level plus
  the configured minimum safety domain; there is no root DFS or repeated trial cut.
- The physical patch and demand budgets remain hard failures rather than hidden
  quality degradation.

## Verification

Tests must fail on the old implementation before production edits.

Reference gates:

- odd z14 column: equal-distance east/west samples resolve to equal geometry levels;
- odd z12 row: equal-distance north/south samples resolve to equal geometry levels;
- exact odd parent-center boundary expands both directions without tie bias;
- bands retain complete parent groups, nesting, prefix freedom, visible completeness,
  2:1 adjacency, zoom monotonicity, and near/far ordering;
- per-level candidate bounds remain finite.

Real Chrome/WebGPU gates:

- fresh-direct and pitched/rotated-to-final top-down paths remain pixel-identical;
- bearing 0/180 no longer exposes one-sided finest coverage at the default position;
- top-down, high-pitch, mobile, resize, failure, cancellation, cache, and lifecycle
  proofs remain clean;
- the existing 90-frame shaded/wireframe latency gates remain mandatory;
- patch counts, requests, source ceiling, device-loss, overflow, and diagnostic bounds
  do not regress.

## Non-Goals

- No screen-space-error policy redesign.
- No change to pitch boost, source precision, mesh density, or terrain shaders.
- No LoD hysteresis or previous-frame geometry authority.
- No Virtual Raster, Worker, Cache, or atlas changes.
- No moving clipmap identity and no compatibility path for the defective window.

## References

- https://github.com/maplibre/maplibre-gl-js/blob/main/src/geo/projection/covering_tiles.ts
- https://github.com/maplibre/maplibre-gl-js/blob/main/developer-guides/covering-tiles.md
- https://github.com/maplibre/maplibre-native/blob/main/src/mbgl/util/tile_cover.cpp
- https://github.com/maplibre/maplibre-native/pull/2958
- https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/QuadtreePrimitive.js
- https://github.com/visgl/deck.gl/blob/master/modules/geo-layers/src/tileset-2d/utils.ts
