# ADR-087: Preserve Sparse Parent Decisions in the WebMercatorQuad Cover

## Status

Accepted. Refines the adaptive inverse-cover construction in ADR-083 and ADR-086.
Their ownership, precision, standard-identity, passive-residency, and projected-quality
decisions remain in force.

## Date

2026-08-24

## Context

The first unified adaptive cover evaluated standard parent tiles independently, but then
reduced all selected children at one level to one axis-aligned rectangle. A parent at one
edge could therefore expand refinement across unrelated rows and columns. When that edge
parent crossed the projected-cell threshold during a continuous camera pitch, the rectangle
contracted and replaced an entire strip of children with their parents. Local 2:1 closure
amplified the topology change. The result was a repeatable refine-then-coarsen flash even
though the camera motion and quality metric were continuous.

The rectangle was an implementation shortcut, not part of `WebMercatorQuad`, the inverse-
cover model, or Virtual Raster. MapLibre's covering traversal preserves each tile's decision
independently, but copying its world-root traversal would discard GeoScratch's bounded,
camera-derived GPU construction.

## Decision

`GpuWebMercatorQuadCover` preserves one sparse refinement decision for every selected parent
identity `(matrixLevel, tileRow, tileCol)`.

- The kernel probes bounded parent candidates around the fixed-point camera position.
- A candidate above the minimum level is eligible only when its own parent was selected for
  refinement. This preserves a standard ancestor chain without traversing the world root.
- A selected parent is replaced only by its own four standard children. Decisions from
  different parents are never unioned into a rectangular level window.
- Invisible materialized children are compacted before and after local 2:1 closure.
- The final cut remains deterministic, prefix-free, bounded by explicit capacity, and
  edge-adjacent by at most one level.
- The temporary sparse decision table may reuse cover-owned GPU lookup storage during the
  single compute invocation. It is cleared before the public final-cover lookup is built.
- Descriptor or temporary/final lookup overflow is a hard diagnostic. The selector never
  silently coarsens to fit capacity.

The CPU reference follows the same sparse-parent construction and remains the semantic
oracle for Node tests. Virtual Raster receives the resulting demand and retains no geometry-
LoD authority.

## Consequences

- One threshold crossing changes only that parent's subtree plus necessary local 2:1 closure;
  it cannot collapse an unrelated rectangular band.
- Continuous pitch may still legitimately change individual tile levels as projected error
  changes, but no global topology change is introduced by spatial aggregation.
- Candidate probing remains bounded and camera-derived; the implementation does not restore
  complete root-forward quadtree traversal.
- Selection hysteresis or visual morphing is not part of this fix. It may be evaluated only
  if isolated per-parent threshold transitions remain objectionable after sparse selection is
  verified.

## Rejected Alternatives

### Retain rectangles and add pitch hysteresis

Rejected because hysteresis would hide a structural coupling while preserving unrelated
parent decisions as one authority.

### Restore a complete CPU or GPU root traversal

Rejected because it abandons bounded inverse probing and scales work with the world tree
rather than the visible standard-tile frontier.

### Let atlas residency retain finer geometry

Rejected because availability is delayed source state, not desired geometry quality. It
would give Virtual Raster camera and LoD authority.

