# ADR-088: Bound Maximum Projected Cell Stretch

## Status

Accepted. Supersedes the determinant metric in ADR-077 while preserving its requirement
that geometry quality be invariant under rotations of the geographic and screen bases.
It complements the sparse exact-parent construction in ADR-087.

## Date

2026-08-25

## Context

The adaptive cover measured one projected geometry cell with the area-equivalent scale
`sqrt(abs(det(J)))`, where the columns of the local 2 by 2 projective Jacobian `J` are
the projected Web Mercator cell axes. The determinant is rotation-invariant, but it
collapses when one screen direction is strongly foreshortened. A long, thin cell can
therefore pass the area threshold even while its long edge spans too many reference
pixels for terrain geometry.

After exact sparse parent refinement removed level-window coupling, the canonical
MapLibre camera pitch sweep still exposed this defect. At zoom 10 and a 1280 by 800
reference viewport, the settled cover dropped from 24 to 16 patches at 13 degrees and
from 50 to 36 at 83 degrees. Wireframe captures showed whole far and foreground rows
coarsening because projected cell height shrank, not because their maximum screen extent
or source precision became smaller.

Pinned MapLibre source separates equal-screen-width, equal-screen-area, and
equal-screen-height loading behavior rather than treating area as the only valid error
measure. Its per-tile traversal also keeps spatial decisions independent. GeoScratch
already computes the complete local projective Jacobian and immutable vertical bounds,
so it can use that direct evidence without copying MapLibre's CPU distance model or
root-forward traversal.

## Decision

The cover quality scalar is the largest singular value of the local projected-cell
Jacobian:

```text
maximumStretch(J) = sqrt(lambda_max(transpose(J) * J))
```

For Jacobian columns `x` and `y`, the implementation evaluates:

```text
xx = dot(x, x)
xy = dot(x, y)
yy = dot(y, y)
lambda_max = 0.5 * (xx + yy + sqrt((xx - yy)^2 + 4 * xy^2))
```

This scalar is invariant under orthonormal changes of both geographic and screen bases,
but unlike the determinant it bounds the worst projected direction. Near-plane crossing
continues to return the reference-viewport maximum and refine conservatively.

`GpuWebMercatorQuadCoverPolicy.maximumCellSpanReferencePixels` retains its public name:
it now means maximum allowed projected stretch in any screen direction. The built-in
128-cell WebMercator terrain consumer uses a calibrated threshold of five reference
pixels with 0.005 numerical tolerance. Other cover consumers choose their own explicit
threshold.

The selector remains stateless and current-view deterministic. No previous cut,
residency state, pitch mode, or temporal hysteresis participates.

## Consequences

- Long, foreshortened terrain cells cannot be accepted solely because their projected
  area is small.
- Top-down isotropic behavior is unchanged because both singular values equal the old
  area-equivalent scale there.
- The canonical settled 0 through 85 degree pitch sweep is non-coarsening: patch count
  grows from 8 to 88, remains below the 96-patch acceptance gate, preserves 2:1
  adjacency, and reports no descriptor or lookup overflow.
- High-pitch geometry is denser than the determinant cut, but remains far below the
  declared patch capacity; ADR-089's indexed terrain path keeps both shaded and wireframe
  latency gates satisfied.
- Feedback `minimumCellSpanReferencePixels` and
  `maximumCellSpanReferencePixels` now report maximum-stretch samples.

## Rejected Alternatives

### Keep determinant scale and add temporal hysteresis

Rejected because it hides an under-resolved long cell and makes transient topology depend
on history before correcting the geometric error definition.

### Use the maximum length of the two stored axes

Rejected because that value changes when the same Jacobian is expressed in a rotated
geographic basis. The largest singular value is the coordinate-independent maximum.

### Copy MapLibre's CPU distance formula

Rejected because GeoScratch already owns the exact projection matrix, reference viewport,
fixed-point camera, and vertical bounds on the GPU. Copying the formula would add a second
camera model and restore CPU/root-traversal coupling.
