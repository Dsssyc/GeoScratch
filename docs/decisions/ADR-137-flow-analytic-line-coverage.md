# ADR-137: Render Flow Trails With Explicit Pixel Coverage

## Status

Accepted. Supersedes ADR-098's native line/overlap-depth rasterization and
ADR-133's default Balanced choice and nearest upscaling. Source sampling,
particle simulation, history decay and geographic demand remain unchanged.

## Decision

Native is the default quality. Balanced remains an explicit lower pixel budget
and still never changes the Surface, map, source precision or diagnostic views.
The example draws one four-vertex instanced quad per active particle segment.
Canonical endpoints remain wide fixed until camera-relative projection. A
homogeneous six-plane clip precedes division, including camera-plane crossings;
ordinary in-view endpoints take a short path.

Centerline width is 0.5 reference pixels. The draw snapshots target dimensions,
target-pixel width and full-coverage opacity before particle compute, preserving
the existing single-submission upload ordering. Screen-linear interpolants carry
local segment coordinates. Box-filtered interval coverage includes orientation's
pixel footprint and fractional segment length. Opacity is composed in optical
density, so subdivision cannot stamp repeated full-opacity endpoint discs.

Transparent coverage blends into raw history without depth testing/writing.
The former first-hit depth rule would let a nearly transparent quad fringe hide a
later opaque centerline. Both the particle and inspector draws now use the
color-only history pass; the unused overlap-depth allocation is removed. With
equal colors, overlapping contributions compose independently of particle order
within rgba8 rounding. Different colors retain ordinary ordered alpha blending;
this is not a general order-independent transparency renderer.

The history owner keeps exactly two rgba8unorm textures. Final upscaling uses a
clamped linear sampler, while Native uses the original exact textureLoad path.
Retained upscaling gathers the same clipped-visible texture with manual bilinear
sampling; it never updates raw ink or accumulates resampling. The history uniform's
previous final padding word records native/scaled-final/scaled-retained filtering;
its total size stays 352 bytes and decaySteps stays at byte 344. Raw composition
does not apply the final-presentation filter.

The particle draw owns one raster uniform, layout, binding and upload command and
releases partial construction failures. Particle state and the shared view remain
borrowed. History owns its new sampler. No public Scratch/Geo API changes, new
backend payload, hidden readback or source-specific shader specialization is added.

## Verification

The native line proof checks angle, pixel phase and DPR, partial coverage,
subpixel segments, dormant/zero suppression, segmentation within rgba8 rounding,
same-pass overlapping particles in reversed order and camera-plane clipping
against the frozen native line reference. The retained-history proof checks a
half-resolution checkerboard against a CPU bilinear oracle, clamped edges,
ready/retained agreement, exact retained A-B-A, unchanged raw decay and Native bytes.
Existing lifecycle, history-time, trail-quality, visual-time and camera-continuity
proofs remain required. Default-native checks distinguish source resolution from
the history budget.

These are intentional raster changes, not pixel equivalence with old hard lines.
Performance must be measured with matched source inputs and explicit quality;
concurrent local model GPU work must not be mistaken for a code regression.
