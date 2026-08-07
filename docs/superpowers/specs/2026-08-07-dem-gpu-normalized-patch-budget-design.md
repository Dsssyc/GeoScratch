# DEM GPU-Normalized Render-Patch Budget Design

## Status

Approved for implementation on 2026-08-07.

## Problem

The DEM render-patch frontier currently makes an independent projected-grid-spacing
decision for every bounded branch. Each local decision can be reasonable while the
complete pitched view still contains far more patches than a map renderer should keep
active. Raising the local pixel threshold only moves the failure between viewport
sizes and camera poses. Truncating the emitted descriptor array would leave holes and
make traversal order an accidental rendering policy.

The data frontier also describes one 256-texel raster page with a geometric error of
`tileWidth / 64` texels. That value came from the render mesh sector size, not from the
raster. It can force data residency two matrix levels finer than the texture footprint
requires and creates a source-page floor that the render frontier cannot coarsen below.

## Source Model

MapLibre's covering-tile algorithm combines per-candidate distance and pitch with a
global tile-count normalization. Its default `tileCountMaxMinRatio` is `3.0`, so a
pitched view does not refine every locally eligible branch without regard to the
complete working set. GeoScratch keeps this principle but does not copy MapLibre's CPU
depth-first traversal or planar integral approximation.

GeoScratch already has the more general input: the GPU can project the actual bounded
candidate tree with the current clip matrix and count the resulting complete cuts.
The GPU will therefore measure candidate counts directly and select the global bias in
the same submission that emits indirect draw arguments.

## Decisions

### Data and geometry remain independent

`GpuTileFrontier` continues to own raster demand, residency, fallback, and the source
matrix-level ceiling. Its DEM level metric becomes one source texel in projected
meters (`matrix.cellSize`), independent of `TERRAIN_SECTOR_SIZE`.

`DemRenderPatchFrontier` continues to own terrain geometry through `z14`. It may refine
a resident source page but never invents raster pages or reads decisions back to the
CPU.

### Camera pitch is an explicit map fact

`GpuTileFrontierView` and `GpuTileFrontierMapMeta` gain `cameraPitchRadians`. The field
is explicit rather than reconstructed from a projection matrix, remains projection
agnostic, and occupies the existing final aligned word of the 144-byte map metadata
layout.

### Project only terrain footprint

Projected grid spacing is measured independently on the minimum- and maximum-elevation
XY planes. The larger plane footprint is used. The vertical distance between those
planes does not contribute to projected patch height, preventing a global elevation
range from masquerading as horizontal coverage under pitch.

### GPU count trials select a global bias

The maximum four-level render expansion is evaluated against 17 thresholds at
quarter-level intervals. Bias step `s` uses:

```text
threshold(s) = maximumCellSpanPixels * 2^(s / 4),  s in [0, 16]
```

Every trial follows the same parent-before-child stop rule and canonical terminal-path
deduplication as emission. Each trial therefore counts a complete, prefix-free cut.
The count pass writes only bounded atomic counters.

The vertical-view baseline is derived from the viewport and the nominal 512-pixel
patch span, including one boundary patch in each axis:

```text
baseline = (ceil(viewportWidth / 512) + 1)
         * (ceil(viewportHeight / 512) + 1)
```

The frame budget interpolates from `baseline` at zero pitch to three times `baseline`
near the horizon using `sin(pitch)^2`. The budget is clamped to descriptor capacity.
The selection pass chooses the least coarsening trial whose complete-cut count is no
greater than the frame budget.

The previously selected bias remains active while its current count lies between 75%
and 100% of the budget and it is at most one quarter-level step coarser than the
newly desired bias. This bounded hysteresis avoids threshold oscillation without
letting a stale camera pose retain a materially coarser cut. It requires no CPU
authority, unbounded history, or delayed feedback control.

The final trial unconditionally stops at each visible source-page root. If this
source-page floor exceeds the budget, that complete cut remains drawable and the
feedback reports the constraint. Emission is never truncated.

### GPU frame order

For each parity, one persistent compute pass executes:

1. reset counters while retaining the previous bias;
2. count all 17 complete-cut trials;
3. choose the budget and selected bias;
4. emit the selected complete cut and logical-patch lookup;
5. finalize indirect draw arguments.

No per-frame GPU object, CPU tree traversal, instance upload, or count readback is
introduced. Delayed readback remains diagnostic-only.

## Diagnostics

Render-patch feedback adds:

- vertical-view baseline budget;
- current pitch-adjusted frame budget;
- unnormalized requested patch count;
- coarsest source-floor patch count;
- selected quarter-level bias;
- whether the source floor prevented satisfying the budget.

These facts distinguish local quality pressure, global normalization, and a data-floor
constraint without making delayed readback authoritative.

## Acceptance Gates

- Unit tests prove the budget is baseline-sized at zero pitch and approaches a 3x
  ceiling at high pitch.
- Unit tests prove the selected trial is the finest complete cut within budget and
  hysteresis never retains an over-budget cut.
- Static integration tests prove count, select, emit, and finalize dispatches remain
  GPU-ordered and indirect draw count is not host-authored.
- DEM data-page error is `matrix.cellSize` and contains no mesh-sector divisor.
- `npm test` and `npm run build` pass.
- Real WebGPU verification covers top-down and pitched views at zooms 10 and 14, with
  no descriptor/lookup overflow, no holes, and bounded patch counts reported by the
  diagnostic feedback.

## References

- [MapLibre covering tiles](https://github.com/maplibre/maplibre-gl-js/blob/main/src/geo/projection/covering_tiles.ts)
- [MapLibre covering-tiles guide](https://github.com/maplibre/maplibre-gl-js/blob/main/developer-guides/covering-tiles.md)
- [Cesium terrain quadtree](https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/QuadtreePrimitive.js)
