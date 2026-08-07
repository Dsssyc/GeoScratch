# ADR-066: Normalize DEM Render-Patch LoD on the GPU

## Status

Accepted; extends ADR-065 with a global frame budget.

## Date

2026-08-07

## Context

ADR-065 corrected the local terrain metric to projected grid spacing. A locally
correct threshold was still insufficient: every visible branch could refine
independently, so a pitched view could produce a dense patch field even when most
of those patches contributed little to the complete frame.

MapLibre's covering-tile policy addresses the same class of pressure by combining
camera-dependent candidate priority with global tile-count normalization. Its
default maximum-to-minimum tile-count ratio is three. That is the useful principle,
but its CPU traversal and planar integral approximation are not the right authority
for GeoScratch's GPU-resident frontier and indirect rendering path.

The DEM raster frontier also used a mesh-derived error value. Dividing one tile by
the 64-cell terrain sector coupled data residency to render geometry and could
create an unnecessarily fine source-page floor.

## Decision

### Keep data pages and render patches independent

The raster frontier now describes one source texel with `TileMatrix.cellSize`.
It owns demand, residency, fallback, and the manifest's `z10` data ceiling.
The render-patch frontier independently owns geometry refinement through `z14`.

### Publish camera pitch as an explicit GPU fact

`GpuTileFrontierView` requires `cameraPitchRadians`. `LayoutCodec` places it at
byte offset 140 in the existing 144-byte map metadata allocation. The field is
validated in `[0, pi / 2]` and avoids inferring application camera semantics from
a projection matrix.

### Measure horizontal terrain footprint

Each candidate's projected grid spacing is evaluated on its minimum- and
maximum-elevation horizontal planes. The larger projected footprint wins. The
vertical span of a conservative terrain AABB therefore cannot masquerade as
horizontal patch coverage when the camera is pitched.

### Select a complete cut from measured GPU counts

The fixed four-level candidate tree is evaluated at 17 quarter-level bias steps:

```text
threshold(step) = maximumCellSpanPixels * 2^(step / 4)
```

Every trial uses the same parent-before-child stop rule and canonical terminal
deduplication as emission, so every count describes a complete prefix-free cut.
The final trial always stops at each visible source-page root and defines the
smallest cut this stage can produce.

For a nominal 512-pixel patch span, the vertical-view baseline is:

```text
(ceil(viewportWidth / 512) + 1) * (ceil(viewportHeight / 512) + 1)
```

The pitch-adjusted budget interpolates from that baseline to three times the
baseline with `sin(pitch)^2`. The GPU chooses the least biased complete cut inside
the budget. A previous choice is retained only when its current count is within
75% through 100% of the budget and it is no more than one quarter-step coarser
than the newly desired cut.

The persistent compute order is:

```text
reset -> count 17 trials -> select -> emit -> finalize indirect draw
```

The CPU uploads camera metadata but neither traverses the patch tree nor reads a
count back to control rendering. Delayed readback is diagnostic-only.

### Preserve completeness when the source floor exceeds budget

Render patches currently refine visible resident source pages; they do not merge
multiple source pages into a synthetic ancestor. When the visible source-page
count exceeds the frame budget, the complete source cut is retained and feedback
sets `budgetLimitedBySourceFloor`. Descriptor truncation is forbidden because it
would create terrain holes and make invocation order an accidental policy.

## Consequences

- GeoScratch uses MapLibre's global-normalization principle while replacing its
  CPU estimate with directly measured GPU candidate cuts.
- Local projected quality, global working-set control, and raster residency remain
  separate authorities.
- The frame graph adds persistent count and selection kernels but no per-frame GPU
  objects, host-authored instance list, or control readback.
- Diagnostics expose baseline and frame budgets, requested and selected counts,
  source floor, selected bias, level range, and both overflow counters.
- The source-page floor is explicit. Coarsening below it would require a separate
  render-root authority capable of merging source pages while preserving virtual-
  raster sampling; this ADR does not hide that as an achieved property.

## Verification

Headless Chrome 151 on Apple Metal produced stable complete cuts with no descriptor
or lookup overflow, no uncaptured WebGPU error, and no device loss.

At 1024 by 768 pixels, top-down `z9`, `z10`, `z12`, and `z14` selected 20, 6, 7,
and 4 render patches. The corresponding baseline budget was 9; `z9` correctly
reported a 20-page source floor, while `z12` and `z14` normalized requested counts
of 10 to 7 and 4.

At the same viewport, 45-degree views selected 19 and 18 patches, 70-degree views
selected 19, 17, and 22 patches, and 85-degree views selected 21 and 24 patches.
Their pitch-adjusted budgets were 18, 25, and 27 respectively. A 390 by 844,
70-degree mobile view selected 10 patches within a budget of 17.

The wireframe gate confirms distinct stable tile colors, post-stitch triangle
edges, mixed geometry levels at `z14`, and complete viewport coverage.

## Rejected Alternatives

### Copy MapLibre's CPU covering traversal

Rejected because it would duplicate GPU-resident camera and candidate facts on the
host, introduce a second selection authority, and require per-frame instance upload.

### Raise the local projected-cell threshold

Rejected because a local constant cannot bound the complete frame across viewport,
pitch, bearing, and source-frontier changes.

### Truncate the descriptor buffer at the budget

Rejected because atomic invocation order is not a spatial policy and truncation can
leave holes. The selected result must be a complete cut.

### Drive the next frame from delayed readback

Rejected because it creates host latency and split authority. Count, selection,
emission, and indirect draw remain ordered in one GPU submission.

## References

- [MapLibre covering tiles](https://github.com/maplibre/maplibre-gl-js/blob/66256d0ece1b00c71cefa8c59668ba4f101e0495/src/geo/projection/covering_tiles.ts)
- [MapLibre covering-tiles guide](https://github.com/maplibre/maplibre-gl-js/blob/main/developer-guides/covering-tiles.md)
- [Cesium Native tile selection](https://cesium.com/learn/cesium-native/ref-doc/selection-algorithm-details.html)
