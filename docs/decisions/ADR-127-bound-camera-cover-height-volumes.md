# ADR-127: Bound Projected Cells Across the Complete Height Interval

## Status

Accepted. Extends ADR-088's maximum-singular-stretch metric from endpoint samples
to a conservative spatial bound. Preserves ADR-087's independent parent decisions
and ADR-125's execution/resource boundaries.

ADR-130 corrects the additional unclipped half-cell depth guard for the production
CPU selector. This ADR records the historical GPU guard, which remains frozen;
the visible-domain Jacobian/denominator proof below is retained.

## Date

2026-09-09

## Evidence

At `8f6e93c`, native WebGPU retained tile `20/524287/524288` for a camera at
`[19.10925707129402, 19.10925707129402, 10]`, 1280 by 800 reference pixels, pi/3
vertical FOV, and height range `[-120, 500]`. Feedback reported 1.58984375 pixels.
The actual visible z=0 plane required 20.68637864145176 pixels. The upper endpoint
was behind the camera and the lower endpoint was much farther away. Neither
endpoint represented the visible interior. This predates GPU parallelization.

The committed native fixture reproduces that failure against an archived
`8f6e93c`, and tests the repaired implementation at multiple interior heights,
pitches and camera heights. These finite samples demonstrate the regression;
the following enclosure argument explains why endpoint sampling is unnecessary.

## Metric Bound

For clip coordinates `M*p = w*(qx,qy,qz,1)`, horizontal cell width h and reference
pixel scale D, write the existing 2 by 2 Jacobian as:

```text
J(p) = N(q)/w
N(q) = h*D*(M_xy - q_xy*M_w,xy)
sigma_max(J) <= maximumNumerator / minimumPositiveW
```

The matrix numerator is affine in q and its spectral norm is convex. With positive
w throughout a convex world polytope, its projective image is the convex hull of
its projected vertices. A flat patch therefore clips once and takes the largest
vertex numerator and the smallest clipped depth separately. A non-flat prism with
positive box depth encloses all projected box vertices in an XY rectangle, intersects
it with `[-1,1]^2`, and evaluates the numerator at that rectangle's four corners.
If the box crosses the camera plane, the visible frustum rectangle supplies the
enclosure instead. No monotonicity in camera-centred ground distance is assumed.

Depth is the maximum of the box-corner lower bound and independent coordinate-slab
certificates. For each approximate inverse row k, compute an outward interval for
`r = e_j - k*M`. For any admissible p:

```text
p_j = w*k.(qx,qy,qz,1) + r.p
Splus  = abs(kx) + abs(ky) + max(kz,0) + kw
Sminus = abs(kx) + abs(ky) + max(-kz,0) - kw
w >= (minimum_p_j - abs(r).maximum_abs_p) / Splus   (when Splus > 0)
w >= (-maximum_p_j - abs(r).maximum_abs_p) / Sminus (when Sminus > 0)
```

Use the positive parts of these bounds. The homogeneous coordinate p_3=1 also
handles a frustum entirely inside the height interval. XYZ slabs make this much
tighter than a near-plane-only bound when the camera is far above the surface.
The residual identity holds for the actual chosen inverse row; exact inversion is
not assumed. Singular inverses contribute no certificate, while a positive box
depth can still provide a bound.

The GPU retains fixed-point camera subtraction and raw world-plane clipping.
Inverse supports/residuals are rounded outward before upload. Box transform and
projected coordinate intervals include absolute dot/division error allowances;
singular arithmetic normalizes columns before evaluating the Gram discriminant.
The numerator has an absolute L1 error allowance instead of a relative allowance
on a possibly cancelling derivative. The candidate proof uses a 512-ULP-unit
Frobenius envelope plus the existing absolute/FTZ budget. These arithmetic budgets
follow the [WGSL floating-point accuracy contract](https://www.w3.org/TR/2026/CRD-WGSL-20260831/#accuracy-of-concrete-floating-point-expressions).
Native tests retain an explicit 0.02-reference-pixel observation tolerance; they
are not a proof for every browser, hardware implementation or arbitrary numeric input.

## Candidate Completeness and Stopping

The metric still bounds its numerator by `h*||B||F`, where
`B_ij = D_i*(abs(M_ij)+abs(M_wj))`. If the volume bound exceeds the refinement
threshold, its minimum box depth is below the metric/footprint depth cap, since
the chosen denominator is no smaller than that box depth.

That minimum may be outside the clipped volume. Let R_i be the absolute projected
half-extent of the complete box, c its clip-space centre, and d the depth cap.
Potential visibility and `minimumBoxW <= d` imply conservative centre intervals:

```text
-Rw <= cw <= d+Rw
abs(cx) <= d+Rx+2*Rw
abs(cy) <= d+Ry+2*Rw
-Rz <= cz <= d+Rz+2*Rw
```

Inverse/residual interval mapping of this enlarged centre domain, outward tile
rounding and the existing f32 error budgets give the non-flat candidate windows.
The flat clipped-polygon path retains its tighter clipped-point domain. A global
height interval encloses every validated hierarchy range, including ancestor reuse.
The complete minimum-level seed domain remains independent of refinement windows.
Uncertifiable candidate arithmetic still enumerates the complete declared domain;
exceeding its explicit candidate budget is a hard failure.

Finite native controls replace only the candidate windows with complete enumeration
and rerun the same two GPU commands. Their ordered final cuts must match the bounded
construction. Camera-centred order and previous topology remain irrelevant to the
chosen identities.

## Outcome and Execution Contract

Finite feedback reports the conservative projected bound; at the configured maximum
geometry level it may exceed the target and remains visible as such. A final patch
that cannot certify the positive footprint-depth guard, or a representable bound,
sets reserved maximum-span value `0xffffffff`. The final reduction revokes the whole
patch count and lookup before dispatch completion. Cover decoding reports structured
`unbounded-quality`; source demand marks failure and draw emits zero instances.
Empty successful cuts still use maximum span zero. The 44-byte state ABI is unchanged.

Map metadata grows from 560 to 656 bytes: two vec4 support vectors and four residual
vec4 rows, once per parity and in the same view upload. The graph remains two ordered
dispatches, with no intermediate CPU readback, new resource-readiness authority,
Worker change, or additional per-level scheduling. Candidate enumeration may grow
because a conservative volume bound can require more work than endpoint sampling.

Additional height samples, pitch-specific algorithms and hysteresis are rejected:
they cannot replace the enclosure proof. Exact clipped-polyhedron reconstruction
could tighten the bound further, but adds geometric work and requires separate
measurement before replacing this bounded construction.

## Verification and Rollback

Run the native red/green height case, bounded/full candidate comparisons, multiple
heights, A-B-A, DPR, explicit quality failure/recovery, independent coverage/quality
samples, 2:1, source-demand and patch-draw failures. Also run the complete terrain
gates, unit/type/docs/build checks and record measured costs in the branch review.
Revert later dependent commits first, then this volume-bound commit. ADR-126's
metadata repair remains independently available; no backend rollback is required.
