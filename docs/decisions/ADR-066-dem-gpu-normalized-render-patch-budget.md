# ADR-066: Normalize DEM Render-Patch LoD on the GPU

## Status

Accepted; extends ADR-065 with a global frame budget. Amended after the rapid-camera
transition regression and the local refinement pulse described below. ADR-068 adds a
correctness-owned balance pass after this ADR's budget-selected cut.

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
create an unnecessarily large source working set.

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

The footprint polygon is clipped against WebGPU's homogeneous near plane
(`clip.z >= 0`) before perspective division. Edges crossing that plane contribute
their intersection points. A corner behind the eye is not converted into an
arbitrary maximum footprint: that discontinuity previously made the measured span
jump from about 8 pixels to the `65535` diagnostic ceiling over a narrow zoom range.

### Select a complete cut from measured GPU counts

The fixed four-level candidate tree is evaluated at 17 quarter-level bias steps:

```text
threshold(step) = maximumCellSpanPixels * 2^(step / 4)
```

Every trial uses the same parent-before-child stop rule and canonical terminal
deduplication as emission, so every count describes a complete prefix-free cut.
The final trial always stops at each visible source-page root.

Trial counts are not required to be monotonic. Frustum-AABB testing is conservative:
a parent can intersect the frustum while all of its refined children are rejected.
A finer complete visible cut can therefore contain fewer patches than a coarser cut.

For a nominal 512-pixel patch span, the vertical-view baseline is:

```text
(ceil(viewportWidth / 512) + 1) * (ceil(viewportHeight / 512) + 1)
```

The pitch-adjusted budget interpolates from that baseline to three times the
baseline with `sin(pitch)^2`. The GPU scans fine to coarse and chooses the first
complete cut inside the budget. If none fits, it chooses the trial with the minimum
measured count rather than assuming the final source-root trial is smallest. A
previous choice is retained only when its current count is within 75% through 100%
of the budget and it is no more than one quarter-step coarser than the newly desired
cut.

### Keep each local refinement decision temporally stable

Global budget hysteresis cannot stabilize a single distant patch whose projected
footprint briefly crosses the local threshold. The two existing parity lookup
buffers therefore also form a GPU-resident history: each frame reads the opposite
parity's final balanced cut while writing its own.

For a nominal threshold `T`, a patch that was terminal in the previous cut remains
terminal until its footprint exceeds:

```text
T * 2^(1 / 4)
```

A previously refined patch remains refined until its parent footprint falls to
`T`. This one-quarter-level band separates the refine and coarsen boundaries without
delaying a newly visible patch or requiring descendant scans. Trial counting and
final emission use the same history-aware threshold, so the budget still describes
the cut that is actually emitted. Both lookup buffers are explicitly cleared during
frontier initialization to make the first frame valid under Scratch's resource
readiness model.

The persistent compute order is:

```text
reset -> count 17 trials -> select -> emit -> balance -> validate -> finalize indirect draw
```

The CPU uploads camera metadata but neither traverses the patch tree nor reads a
count back to control rendering. Delayed readback is diagnostic-only.

### Preserve completeness when no measured trial fits

Render patches currently refine visible resident source pages; they do not merge
multiple source pages into a synthetic ancestor. When every measured complete cut
exceeds the frame budget, the minimum-count trial is retained and feedback sets
`budgetLimitedByMinimumTrial`. Descriptor truncation is forbidden because it would
create terrain holes and make invocation order an accidental policy.

Feedback reports `minimumTrialPatchCount` and `sourceRootPatchCount` separately.
This prevents conservative hierarchical culling from being misrepresented as a
source-page floor.

## Consequences

- GeoScratch uses MapLibre's global-normalization principle while replacing its
  CPU estimate with directly measured GPU candidate cuts.
- Local projected quality, global working-set control, and raster residency remain
  separate authorities.
- The visual-density budget applies to the emitted complete cut. ADR-068 reports
  level-difference-one balance splits as explicit correctness overhead rather than
  truncating them into holes.
- The frame graph adds persistent count and selection kernels but no per-frame GPU
  objects, host-authored instance list, or control readback.
- Local temporal stability reuses the existing parity lookup allocations; it adds
  no CPU traversal, GPU readback, persistent buffer, or per-frame command.
- Diagnostics expose baseline and frame budgets, requested, unbalanced, and final counts,
  minimum-trial and source-root counts, selected bias, level range, and both
  overflow counters, plus balance splits and maximum adjacent level delta.
- Coarsening below every available complete cut would require a separate render-root
  authority capable of merging source pages while preserving virtual-raster sampling;
  this ADR does not hide that as an achieved property.

## Verification

Headless Chrome 151 on Apple Metal produced stable complete cuts with no descriptor
or lookup overflow, no uncaptured WebGPU error, and no device loss.

At 1024 by 768 pixels, top-down `z9`, `z10`, `z12`, and `z14` selected 20, 6, 7,
and 4 render patches. The corresponding baseline budget was 9; `z9` reported a
minimum available count of 20, while `z12` and `z14` normalized requested counts
of 10 to 7 and 4.

At the same viewport, 45-degree views selected 19 and 18 patches, 70-degree views
selected 19, 17, and 22 patches, and 85-degree views selected 21 and 24 patches.
Their pitch-adjusted budgets were 18, 25, and 27 respectively. A 390 by 844,
70-degree mobile view selected 10 patches within a budget of 17.

The wireframe gate confirms distinct stable tile colors, post-stitch triangle
edges, mixed geometry levels at `z14`, and complete viewport coverage.

The pitched-motion gate fixes the source frontier and samples `z10.02`, `z10.04`,
and `z10.06`. Before this amendment the render cut pulsed from 18 `z10` patches to
19 `z10/z11` patches and immediately back to 18 `z10` patches. The same gate also
samples `z13.66`, `z13.70`, and `z13.84`; no projected span may reach the former
`65535` near-plane sentinel. Both checks run in Chrome WebGPU with zero pending
demands, overflow counters, console errors, diagnostic incidents, or device loss.

The amended rapid-camera gate executes 84 continuous center, zoom, pitch, and
bearing changes, including a pitched-to-top-down return. It remains `ready` with
no console or page error. The captured regression sequence
`[9, 9, 9, 9, 9, 6, 2, ..., 2, 3]` is also retained as a unit test proving that a
non-monotonic complete-cut series is valid and that its actual minimum is selected.

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
