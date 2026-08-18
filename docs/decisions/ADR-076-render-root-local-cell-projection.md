# ADR-076: Decouple Render Roots and Measure Local Projected Cells

## Status

Superseded by [ADR-083](ADR-083-webmercator-inverse-cover-passive-virtual-raster.md)
for immutable render roots and root-forward traversal. ADR-077's rotation-invariant
local projection evidence and ADR-068's final-cover balance invariant remain inputs to
the inverse standard cover.

## Date

2026-08-15

## Context

The Web Mercator terrain renderer already separated raster residency from geometry
LoD in intent, but two implementation details still coupled them.

First, each frame used the current data-frontier pages as the roots of the geometry
traversal. The renderer could refine those roots only through a fixed number of
descendant levels. A residency change could therefore change the available geometry
cut even when the camera and render policy were otherwise unchanged.

Second, the projected-grid metric divided the area of the clip-volume-clipped patch
polygon by the terrain grid resolution. At a viewport edge, zooming in can reduce the
visible sliver of a patch faster than it increases projection scale. The measured cell
span then decreases, so a finer camera can select a coarser patch. The Underwater
Terrain Retina proof reproduced both regressions during a settled top-down zoom:

```text
z12.00 levels 12..13 -> z12.25 levels 11..13
z13.75 levels 14..14 -> z14.00 levels 13..14
```

This is not a valid LoD response. Zooming in with an otherwise fixed camera must not
reintroduce a coarser render level.

## Decision

### Give geometry its own immutable roots

`GpuRenderPatchFrontier` receives a non-empty, prefix-free set of immutable render
roots. The roots form the bounded geographic safety cover and are uploaded once.
They are not reconstructed from current data-frontier visibility or residency.

Each count trial and final emission performs a bounded GPU depth-first traversal from
those roots through the declared render maximum matrix level. The existing global
17-trial budget selection, balancing, validation, and indirect finalization remain in
one ordered submission. A count trial saturates at one result beyond
`maximumRenderPatches`; this proves that the trial cannot be selected without walking
the rest of an unusable fine cut.

The data frontier remains authoritative for demand, loading, publication, physical
atlas residency, and fallback. It does not select terrain mesh topology.

### Resolve raster availability inside the logical accessor

A render patch contains only its geometry identity:

```text
(matrixLevel, tileRow, tileCol)
```

It does not contain a source-page identity or `samplingLevel`. Terrain vertices ask
the Web Mercator Virtual Raster accessor for logical level zero, which is the finest
level in its reversed address-space ordering. The page table resolves each requested
coordinate to the available physical page and reports the resolved level. Missing or
coarser data can therefore fall back independently of geometry subdivision without a
CPU padding pass or a source-shaped render cut.

### Measure a local projected cell, not clipped polygon area

The patch footprint is still clipped against all six WebGPU homogeneous clip planes.
The clipped polygon supplies visible evaluation positions and rejects patches with no
visible footprint.

At every visible polygon vertex, on both the minimum- and maximum-elevation planes,
the GPU evaluates a symmetric one-cell displacement along the patch's two horizontal
axes. Perspective division converts those differential displacements to pixel spans.
The metric is the geometric mean of the two axis spans, and the maximum over all
evaluated positions and elevation planes controls subdivision.

ADR-077 later corrects how those two vectors are combined. Their length product omits
the angle between them and is basis-dependent; the current implementation uses the
square root of the absolute local Jacobian determinant.

This is a local projective Jacobian of one terrain cell. It remains sensitive to
perspective and foreshortening, but it does not shrink merely because only a sliver of
the parent patch is inside the viewport.

### Keep the settled cut canonical

For fixed render roots, camera metadata, viewport, and render policy, local split
decisions are stateless and canonical. Previous-parity topology and bias are not
error-metric inputs. ADR-078 allocates the current frame's residual budget by local
projected-cell priority without historical authority.

## Consequences

- Geometry refinement no longer changes authority when raster pages load, evict, or
  fall back.
- A zoom-in cannot coarsen a visible patch solely because its clipped screen fragment
  becomes smaller.
- Raster sampling remains valid above the source's maximum matrix level because the
  logical page table resolves each coordinate to available data.
- Render-root storage is immutable and shared by both frame parities. Per-frame
  uploads contain view and policy facts, not a CPU-selected tile list.
- Fine trial traversal is capacity-bounded even when a root spans many render levels;
  over-capacity counts are intentionally saturated rather than treated as exact.
- The render-patch descriptor and feedback surface expose render-root facts instead
  of source-root or fixed-extra-level facts.
- Full-patch projected area is not used: it over-refines large mostly off-screen
  patches. Clipped polygon area is not used: it permits edge coarsening. The local
  cell differential preserves visibility locality without either failure.

## Verification

The Retina browser proof uses a 1512 by 860 CSS-pixel viewport at device pixel ratio
two and holds center, pitch, and bearing fixed while sampling zoom 12 through 14 in
quarter steps. The corrected settled sequence is:

```text
z12.00 12..12
z12.25 13..13
z12.50 13..13
z12.75 13..13
z13.00 13..13
z13.25 13..13
z13.50 13..14
z13.75 14..14
z14.00 14..14
```

Neither the minimum nor maximum render level decreases. The pitched `z10` proof
selects 28 balanced patches across levels 7..11, and the motion samples at `z10.02`,
`z10.04`, and `z10.06` retain the same count and level range. Shaded and wireframe
proofs remain nonblank with no terrain holes, overflow, uncaptured WebGPU error, or
device loss.

## Rejected Alternatives

### Continue from current resident source pages

Rejected because residency is asynchronous data state, not geometry policy. It makes
the same camera capable of producing different mesh cuts as pages arrive or leave.

### Measure the clipped polygon's projected area

Rejected because viewport clipping can make the measured fragment shrink during a
zoom-in and invert the refinement decision.

### Measure the complete uncut patch area

Rejected because a large patch that is almost entirely outside the viewport can force
unnecessary refinement and inflate pitched-view density.

### Store an explicit sampling level in every render patch

Rejected because availability is coordinate-dependent and already belongs to the
Virtual Raster page table. One patch-level value would duplicate residency policy and
cannot represent mixed fallback along a patch boundary.

### Use previous-frame topology to suppress the transition

Rejected because history would make multiple permanent cuts valid for the same
settled inputs and would conceal rather than correct the non-monotonic metric.
