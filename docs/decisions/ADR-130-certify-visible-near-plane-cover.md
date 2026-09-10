# ADR-130: Certify Cover Quality on the Visible Near-Plane Domain

## Status

Accepted. Corrects the CPU quality guard introduced with ADR-129 from the frozen
ADR-127 implementation. ADR-088's local maximum-singular-stretch definition,
conservative candidate windows, independent parents and explicit LoD ceiling remain.
The frozen GPU reference retains its old guard and is a documented counterexample
for this boundary; its source/hash manifest is unchanged.

## Date

2026-09-10

## Evidence

At `0b6b9c5`, Underwater Terrain at centre `[120.980697, 31.684162]`, zoom 18,
pitch 45 degrees, bearing 0 and 1280 x 800 reference pixels fails with
`GEO_WEB_MERCATOR_COVER_SELECTION_INVALID`, `actual.reason: 'unbounded-quality'`.
There are 362 checked candidates and no descriptor, lookup or adjacency overflow.
The same captured view fails in the frozen native GPU selector. Its native submission
succeeds; this is a geometry certification failure, not a queue or Worker failure.
The camera/bounds are retained in `tests/fixtures/terrain-near-plane-view.json`.

For a final z14 height prism, the existing box/slab certificate proves a visible
clip-w lower bound of approximately 15.999934. The old guard subtracts the
unclipped half-cell depth radius, approximately 22.627417, and declares the metric
unbounded. Yet `maximumNumerator / minimumVisibleW` is finite, approximately
5665.477 reference pixels. The LoD ceiling already permits a reported finite bound
above the quality threshold; it does not permit an uncertified or partial cut.

The guard therefore revokes a whole valid cut because an extension outside the
clipped domain crosses the camera plane. The application then treats the diagnostic
as fatal. Swallowing the error or keeping an old cover would conceal this mistake.

## Decision and proof

Keep the existing `J(p) = N(q) / w` projected-cell Jacobian and its numerical
allowances. Certify the denominator on the **visible clipped domain**:

- A flat patch is clipped by all six frustum planes. Its vertices already have
  positive w above the numerical floor. Since w is affine, their minimum bounds
  w throughout the clipped convex polygon.
- A height prism uses the existing maximum of its box-corner lower bound and the
  inverse-coordinate-slab certificates, with transform/residual allowances. These
  bound every admissible visible point, including interior heights.
- The numerator is affine in projected XY and its spectral norm is convex. Its
  existing vertex/rectangle bound divided by the positive visible-domain lower
  bound therefore still bounds the local stretch throughout that domain.

Remove the additional `0.5 * (abs(dx.w) + abs(dy.w))` subtraction. That condition
asks whether a whole *unclipped* cell around a visible point stays in front of the
camera, which is not the local Jacobian domain. WebGPU clips primitives against its
[clip volume](https://www.w3.org/TR/webgpu/#primitive-clipping); clipped-away parts
need not satisfy a separate uncut-footprint guard.

Retain the `1e-5` visible-w floor and unbounded/non-representable failure handling.
The volume guard also rejects NaN by requiring `minW > 1e-5`. No cell-count, LoD
ceiling, quality threshold, elevation bound, pitch mode, history or residency policy
changes. Finite over-threshold values at the explicit geometry ceiling remain
reported, so this repair is not a claim that every maximum-zoom view meets five pixels.

## Candidate completeness

The new metric changes only old infinite results into certified finite bounds.
The existing frozen candidate helper includes the former half-cell guard cap as
well as the metric cap; retaining it can only enumerate extra candidates for the
corrected predicate. The unchanged minimum-level seed still covers the declared
coarse domain. Do not narrow windows or add early stopping in this repair.
Finite exhaustive-candidate controls compare ordered output and final state against
the bounded CPU computation. Parent replacement, closure and compaction are unchanged.

## Verification and reference policy

Regressions cover the captured terrain view and a clipped flat plane at 40/52 bits,
independent screen-ray coverage and point-Jacobian bounds, exhaustive/bounded
candidate equivalence, and positive-w values immediately below/above the numerical
floor. The four captured-case tests fail with the old guard and pass with the repair.

Keep all existing native CPU/GPU successful-cut and matching-failure controls. Add
explicit near-plane counterexamples where frozen GPU fails with `unbounded-quality`
and corrected CPU returns a certified cut; do not weaken the old comparison or change
reference hashes to manufacture equality. The renderer gates now sweep every integer
pitch from 0 to 85 at zoom 18 and include shaded maximum-zoom recovery, alongside the
existing wide-view, DPR, A-B-A, 2:1, overflow, source, resource, cleanup and native gates.

## Rollback

Revert this repair commit to restore the previous CPU guard and its documented
maximum-zoom failure. No backend or GPU-reference rollback is needed.
