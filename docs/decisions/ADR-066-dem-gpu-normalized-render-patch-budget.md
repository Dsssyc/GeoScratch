# ADR-066: Normalize DEM Render-Patch LoD on the GPU

## Status

Partially superseded by ADR-078. This ADR still defines the normalized frame budget and
the 17 measured complete-cut trials, but the selected trial is now a safe base cut.
ADR-078 removes global history and fills residual budget by current local priority
before ADR-068 balancing. ADR-076 supersedes this ADR's source-page render roots and
clipped-footprint metric.

## Date

2026-08-07

Last amended 2026-08-16.

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

The footprint polygon is clipped against all six WebGPU homogeneous clip planes
before perspective division. Edges crossing a plane contribute their intersection
points. A corner behind the eye is not converted into an arbitrary maximum footprint,
and an off-screen polygon is not approximated by clamping an uncut projected bounding
box. The former discontinuity made the measured span jump from about 8 pixels to the
`65535` diagnostic ceiling; the latter created a narrow off-screen footprint peak.

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

The pitch-adjusted budget interpolates from that baseline to three times the baseline
with `sin(pitch)^2`. The GPU scans fine to coarse and chooses the first complete cut
inside the budget. If none fits, it chooses the trial with the minimum measured count
rather than assuming the final source-root trial is smallest. ADR-078 makes this
selection stateless and uses it as a base for local priority filling; the earlier 75%
global hysteresis rule is superseded.

### Keep local refinement canonical

An earlier amendment read the opposite parity's final lookup and gave a patch that
was terminal in the previous cut a one-quarter-level coarsening threshold. That
suppressed one observed distant-patch pulse, but it also made the previous topology a
second selection authority. A fixed top-down camera could then retain either a coarse
parent or its fine children indefinitely, depending only on whether the camera entered
from a coarser or finer zoom. It also allowed arbitrary spatial asymmetry among patches
with equivalent current projected error.

That local historical threshold is withdrawn. Trial counting and final emission now
derive every local split from the current camera, viewport, source frontier, and the
single selected global bias. The opposite parity lookup remains a current-cut rendering
and balancing resource, but it is not an input to local refinement. Complete six-plane
homogeneous clipping removes the off-screen projected-footprint peak that the historical
threshold had concealed.

ADR-078 also withdraws global frame-budget hysteresis. A settled camera, source
frontier, render roots, and policy now produce one canonical base bias and one
error-cohort-filled local cut without previous-frame authority.

The persistent compute order is:

```text
reset -> count 17 trials -> select base -> emit base -> error-cohort fill
      -> balance -> validate -> finalize indirect draw
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
- Current-cut lookup allocations remain available to rendering and 2:1 balancing,
  but opposite-parity topology is not a local refinement input.
- Diagnostics expose baseline and frame budgets, requested, base, error-cohort-filled,
  unbalanced, and final counts, minimum-trial and source-root counts, selected bias,
  budget-limited refinements, level range, both overflow counters, balance splits, and
  maximum adjacent level delta.
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
and `z10.06`. Near-plane-only clipping produced 18, 19, and 18 patches; complete
homogeneous clipping produces 18 `z10` patches at all three samples without reading
previous patch topology. The same gate also samples `z13.66`, `z13.70`, and `z13.84`;
no projected span may reach the former `65535` near-plane sentinel. Both checks run in
Chrome WebGPU with zero pending demands, overflow counters, console errors, diagnostic
incidents, or device loss.

The canonical top-down gate reaches the same `z10.25`, zero-pitch camera once from
`z9.65` and once from `z10.85`. The previous local-history implementation stabilized
at two different cuts: 6 `z10` patches from the coarse path and 9 `z10/z11` patches
from the fine path, despite equal source frontier and global bias. The amended
implementation produces 9 `z10/z11` patches on both paths, with identical feedback
and canvas SHA-256.

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

### Use the previous patch topology as a local hysteresis authority

Rejected after implementation because it permits multiple permanent cuts for the same
settled inputs. Temporal smoothing must not make an old local topology authoritative
over current geometric facts.

## References

- [MapLibre covering tiles](https://github.com/maplibre/maplibre-gl-js/blob/66256d0ece1b00c71cefa8c59668ba4f101e0495/src/geo/projection/covering_tiles.ts)
- [MapLibre covering-tiles guide](https://github.com/maplibre/maplibre-gl-js/blob/main/developer-guides/covering-tiles.md)
- [Cesium Native tile selection](https://cesium.com/learn/cesium-native/ref-doc/selection-algorithm-details.html)
