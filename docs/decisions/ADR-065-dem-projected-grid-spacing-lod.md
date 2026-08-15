# ADR-065: Select DEM Render Patches by Projected Grid Spacing

## Status

Partially superseded by ADR-076 and ADR-077. Projected terrain-cell spacing remains the
policy. ADR-076 replaces this ADR's clipped-footprint area formulation with a local
projective cell differential, and ADR-077 defines its rotation-invariant Jacobian
determinant scale.

## Date

2026-08-07

## Context

ADR-064 correctly moved geometry selection from one zoom-derived level to bounded
per-branch GPU selection. Its metric was nevertheless incorrect. It divided a
WebMercator tile's horizontal width by the 64-cell mesh and named the result
"geometric error", then required that value to project below two pixels.

Cesium's screen-space error projects a terrain provider's approximation error. A
horizontal mesh-cell width is not that error. The two-pixel rule therefore forced
ordinary pitched views toward `z14` even though the source DEM stops at `z10` and the
mesh already contains 64 cells per render patch. The debug view became a dense colored
checkerboard and obscured rather than explained LoD and stitching.

MapLibre uses a fixed reusable terrain mesh and camera-dependent tile coverage. Its
covering-tile policy accounts for viewport, field of view, pitch, and candidate
distance; it does not require every terrain-grid cell to occupy at most two pixels.

## Decision

### Measure what the render policy actually controls

For every bounded candidate, `DemRenderPatchFrontier` projects all eight corners of
the camera-relative patch AABB with `clipFromRelativeWorld`. The NDC rectangle is
clipped to the viewport. The selection value is:

```
sqrt(projectedWidthPixels * projectedHeightPixels) / terrainSectorSize
```

This is the geometric-mean projected span of one mesh cell. It is named projected
grid spacing throughout the TypeScript, WGSL, graph facts, tests, and diagnostics.
It is not presented as source error or terrain approximation error.

The default maximum is eight pixels. With a 64-cell patch this gives a nominal
512-pixel patch span. Perspective foreshortening reduces distant pitched patches
without a separate CPU distance rule. A near-plane intersection refines
conservatively, while the existing source-plus-four and `z14` ceilings keep work
bounded.

### Preserve independent data and geometry authorities

The data frontier still owns source requests, fallback, and residency through `z10`.
The render-patch frontier may subdivide a resident page through `z14` for extreme
close views. It does not request invented raster detail. Logical patch lookup,
mesh stitching, virtual-raster sampling, GPU-produced counts, and indirect terrain
draw remain unchanged.

### Make the result observable without making it authoritative

Each parity owns one persistent consume-on-read 32-byte state readback. A delayed
feedback record exposes selected patch count, level range, projected cell-span range,
descriptor overflow, lookup overflow, and frame epoch. Readback never drives
selection, residency, cache, or rendering. The command and staging slots are fixed;
runtime duration cannot grow their count.

## Rejected Alternatives

### Raise the old SSE threshold

Rejected because changing two to eight would retain a false model and misleading API
names. The corrected metric is based on actual projected patch dimensions.

### Use only the longest projected axis

Rejected because a highly pitched patch can be long in one screen axis and nearly
edge-on in the other. The geometric mean captures projected area and avoids refining
the horizon solely because of one elongated AABB axis.

### Return to one level per camera zoom

Rejected because near and far patches in one pitched frustum require different
geometry levels.

### Feed GPU feedback back into the next selection

Rejected because the current clip matrix already supplies the decision input. The
readback exists only to audit bounded GPU behavior and must not create a CPU control
loop.

## Consequences

- At the fixed `zoom=10`, pitch-70, bearing-90 browser gate, the selected geometry is
  21 patches across levels 10..11, with projected cell spans 2.30..7.38 pixels.
- The same gate reports zero descriptor or lookup overflow and no WebGPU diagnostic
  failure.
- At `zoom=14`, close geometry can reach `z14`, while the same frame still contains
  coarser `z10` patches.
- The persistent graph gains two readback commands and no per-frame resource or
  command allocation.
- Scratch remains unaware of DEM, tiles, LoD, or projected-grid policy.

## References

- [MapLibre covering tiles](https://github.com/maplibre/maplibre-gl-js/blob/66256d0ece1b00c71cefa8c59668ba4f101e0495/src/geo/projection/covering_tiles.ts)
- [MapLibre terrain mesh](https://github.com/maplibre/maplibre-gl-js/blob/66256d0ece1b00c71cefa8c59668ba4f101e0495/src/render/terrain.ts)
- [Cesium Native tile selection](https://cesium.com/learn/cesium-native/ref-doc/selection-algorithm-details.html)
