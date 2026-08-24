# ADR-077: Use a Rotation-Invariant Projected Cell Scale

## Status

Partially superseded by
[ADR-083](ADR-083-webmercator-inverse-cover-passive-virtual-raster.md). The old
render-root frontier is replaced, while the rotation-invariant local Jacobian metric
remains valid evidence for conservative view-derived level decisions. ADR-088 supersedes
the determinant scalar with the Jacobian's maximum singular value.
ADR-084 additionally supersedes the old physical-pixel field names and fixes the metric
to logical reference pixels.

## Date

2026-08-16

## Context

ADR-076 replaced clipped-patch area with a local projective differential, but combined
the projected horizontal cell axes as:

```text
sqrt(length(Jx) * length(Jy))
```

This expression omits the angle between the two projected axes. It is therefore not an
area measure and is not invariant under a rotation of the horizontal basis relative to
the projection's principal directions. In an anisotropic oblique view, changing camera
bearing can increase the value by more than a factor of two even though the local
projected cell and its singular scales are unchanged. The resulting error is spatially
uneven: a farther diagonal patch can cross the subdivision threshold before a nearer
adjacent patch solely because the fixed Web Mercator axes align differently with the
direction of strongest foreshortening.

The LoD metric must respond to perspective, foreshortening, elevation bounds, and
viewport scale. It must not add a different value merely because the same local
projective map is expressed through a rotated horizontal basis.

## Decision

At every visible evaluation position and on both elevation planes, the GPU evaluates
the analytic local derivative of perspective division for the one-cell Web Mercator x
and y displacements. These two pixel-space vectors are the columns of a 2 by 2 local
projective Jacobian `J`.

The area-equivalent projected cell scale is:

```text
sqrt(abs(det(J)))
```

or, for pixel-space columns `Jx` and `Jy`:

```text
sqrt(abs(Jx.x * Jy.y - Jx.y * Jy.x))
```

The determinant includes the angle between the projected axes and is invariant under
orthonormal changes of the horizontal basis as well as the screen basis. Taking its
square root keeps the result in pixels, so the existing `maximumCellSpanPixels`
threshold and global bias remain dimensionally valid.

If any corner of the evaluated cell can reach or cross the camera plane, the metric
returns the viewport maximum and refines conservatively. This preserves the near-plane
protection previously supplied by the finite endpoint calculation.

## Consequences

- Camera bearing no longer changes LoD merely by aligning the projected grid axes with
  different directions of foreshortening.
- A farther oblique patch cannot outrank a nearer equivalent patch because of the old
  basis-dependent axis product.
- Perspective area, foreshortening, elevation bounds, viewport scale, the global patch
  budget, and the balanced-cut contract continue to affect the final cut. ADR-078
  subsequently removes hysteresis.
- This metric decision did not change the public frontier shape. ADR-078 subsequently
  changes the descriptor and feedback facts for priority filling.
- The computation remains GPU-resident and adds no CPU traversal or readback authority.

## Verification

A numerical regression uses a local Jacobian with singular scales 12 and 1. Rotating
its basis by 45 degrees changes the rejected axis-product metric by more than a factor
of two, while the determinant metric remains equal to numerical precision. After the
rotated candidate is uniformly scaled by one half to represent a farther cell, the old
metric still ranks it above the near cell; the determinant metric ranks it below. The
same test binds the active WGSL to the determinant expression and its conservative
cell-plane guard.

The real Chrome/WebGPU wireframe gate at zoom 10, pitch 70, and bearing 90 selects an
unbalanced cut of 28 patches; bounded 2:1 balancing adds nine patches for a final cut of
37 across levels 7 through 11. Descriptor and lookup overflow remain zero. Additional
Retina probes at oblique bearings 35, -45, and 45 produce coherent near-to-far cuts with
no uncaptured WebGPU error or device loss.

## Rejected Alternatives

### Keep the product of projected axis lengths

Rejected because it equals projected area only when the two axes remain perpendicular.
Perspective generally makes them oblique, so the value depends on camera bearing.

### Use only Euclidean camera distance

Rejected because distance alone omits field of view, viewport size, foreshortening,
elevation bounds, and local perspective. It would replace a screen-space error metric
with an empirical ordering rule.

### Add a bearing-specific correction factor

Rejected because the determinant is the coordinate-independent quantity already
defined by the local projective map. A correction factor would encode symptoms rather
than the geometry.
