# ADR-117: Compare Source-Center Flow SDF Reconstruction Kernels

## Status

Accepted as an opt-in Flow Field comparison. Adds C/D without replacing A's hard
boundary default or B's owner-footprint SDF from ADR-116. Scratch/Geo APIs, backend
payloads, source manifests, and the frozen Flow Layer example are unchanged.

## Date

2026-09-08

## Context

B measures distance to the exact union of original supported texel squares. Its
inward opacity transition is continuous, but its zero contour intentionally
remains raster-shaped. The user requested a smaller experiment than contour
extraction, curve fitting, curvature evolution, or case-specific topology repair:
treat derived SDF values as center samples and compare interpolation kernels.
All information must come from existing time-varying U/V pages.

## Decision

Expose `sdf-center-linear` as **C · Center SDF (linear)** and
`sdf-center-smooth` as **D · Center SDF (smooth)**. Retain `hard`/`sdf` and the default
`hard`. Reuse the validated `sdfFeatherTexels` range [0.05, 0.35], default 0.25;
enable Feather for B/C/D only in Particles. Inspection and activity contour remain
unfiltered by the presentation boundary choices.

For each time endpoint independently, classify a resident U/V center as supported
when speed is nonzero and at least the existing activity-kill threshold. At a
supported center calculate positive Euclidean distance to the nearest unsupported
unit-square footprint; at an unsupported center calculate the negative distance
to the nearest supported footprint. Truncate magnitude to 1.5 source texels.

The 3x3 neighborhood around a center is sufficient: a square whose integer offset
has any component of magnitude at least 2 starts at least 1.5 texels away. Each
nearby square contributes `length(max(abs(offset) - 0.5, 0))`. The union of the
neighborhoods needed for four adjacent center values is exactly a 4x4 footprint.
Evaluate these samples in shader registers, not a persistent SDF texture.

Mix each center's two signed distances by the current temporal progress, then
reconstruct from the same four mixed values. C uses bilinear weights. D uses
`h(f) = f*f*(3-2*f)` in each axis in place of f. Both retain the center samples
and have nonnegative weights summing to one, so neither overshoots the four-value
range. The kernel selector is a pipeline constant, not another resource or channel.

The zero contour of this reconstructed scalar field is the display boundary.
Coverage is `smoothstep(-feather, feather, distance)`, multiplied into visible
history alpha only. Do not subsequently apply an original-owner square mask:
that would reintroduce the shape mismatch. The raw/visible history ownership and
finite decay are retained. Neither kernel generates missing ink.

C/D particle sampling uses ordinary registered source-center U/V interpolation
and time interpolation without extending an exact-zero owner across its whole
square. The resulting actual velocity still controls advection and immediate
zero/below-threshold death. C and D share this particle policy; only their display
reconstruction differs. A/B retain their original owner gate. No boundary sliding,
curve following, velocity extrapolation beyond source extent, or topology patches
are introduced. This is an example-local interpretation selected for comparison,
not a silent change to the manifest's default nearest-texel-zero contract.

## Readiness, Cost, And Ownership

Reuse the existing wide-fixed half-texel registration and positive requested-level
residency proof. Bounds are checked before clamping source loads. Every source
sample required by the reconstruction must be resident at the requested common
level in both endpoints. An unavailable, failed, coarse, out-of-source, or legacy
case uses A's existing display fallback, never fabricated dry values.

Read the four central samples in both endpoints first. When all eight support bits
are 1, coverage is 1; when all are 0, coverage is 0. Every same-sign center distance
has magnitude at least .5, outside the maximum .35 display band, so outer neighbors
cannot change these cases. Other spatial or temporal transitions read the remaining
halo: eight U/V texel loads on the interior fast path and at most 32 on the complete
path, in addition to residency metadata work. Missing required halo falls back;
the comparison does not request more pages to conceal this limitation.

The existing display step selects one of two additional stable pipelines. No new
texture, compute/render pass, decoded payload, CPU raster, readback, network tile,
cache identity, or backend data channel is introduced. This trades fragment work
for a bounded local comparison rather than introducing a second derived-resource
streaming lifecycle. Native browser performance must be measured, not inferred
from the four-value reconstruction alone.

## Continuity And Limits

For unchanged same-level resident source facts, each endpoint distance is independent
of the other time sample. Shared temporal endpoints therefore agree across pair
handoffs. Temporal mixing and either fixed spatial weighting commute. This only
establishes scalar-field continuity, not physically correct intermediate geometry:
whole regions changing endpoint support can fade simultaneously, and topology may
change during the visual morph. Missing/LoD transitions still have a separate
fallback boundary.

D's weights make first derivatives vanish at the center-cell edges, unlike ordinary
bilinear reconstruction, but this does not preserve a true signed-distance metric.
For example a straight crossing at fractional coordinate .25 moves to approximately
.32635. Fine channels, diagonal contacts and small islands can widen, shrink,
merge or disappear. No circle, true shoreline, or topology guarantee is claimed.
The signed samples still originate in coarse U/V-inferred support, not a supplied
physical wet/dry field. Feather controls a source-space display band and does not
recover source detail or replace screen-space antialiasing at minification.

## Verification And Rollback

Verify the center-distance helper against an independent brute-force square-union
oracle, including rotation/reflection, signs, the 1.5 truncation bound, and both
reconstruction kernels. Check shared source centers, cell edges and time-pair joins;
record rather than hide the kernels' expected straight-edge/thin-structure changes.
Native VT tests must cover requested-level readiness, source boundaries, unknown
halo fallback, interior fast paths, both time endpoints and real tiled data.
Keep A/B, zero-speed death, retained-history lifecycle, camera/time controls, and
cleanup proofs passing; compare C/D at the same data/time/camera in a browser.

Baseline `0e6b3af` is retained by local branch
`socu/flow-before-center-sdf-0e6b3af`. Land this comparison as a separate verified
commit and use `git revert` on that commit to undo only this slice. The selector
also keeps A/B available for immediate visual comparison without a data rebuild.
