---
docId: geo.gpu-frontiers
canonical: true
apiSources:
  - packages/geoscratch/src/geo/gpu-render-patch-frontier.ts
  - packages/geoscratch/src/geo/gpu-tile-frontier-layout.ts
  - packages/geoscratch/src/geo/gpu-tile-frontier.ts
---
# GPU Frontiers

[简体中文](./gpu-frontiers_zh.md) | [Geo overview](./README.md)

GPU frontiers keep bounded spatial selection and draw preparation on the GPU.
`GpuTileFrontier` evaluates resident tile metadata against view and policy buffers,
emits compact demand/visibility feedback, and prepares indirect arguments. CPU code
updates map/view metadata and consumes delayed feedback; it does not traverse an
unbounded world quadtree every frame.

The render-patch frontier is separate from raster residency. It traverses immutable,
prefix-free render roots rather than current source pages, so asynchronous loading and
fallback cannot redefine geometry topology. It refines terrain mesh patches by the
local projected span of one grid cell even when source raster detail has reached its
maximum. Six-plane homogeneous clipping supplies visible evaluation positions; a
projective cell differential avoids both off-screen over-refinement and viewport-edge
coarsening during zoom-in. Its two pixel-space vectors form a local Jacobian; the square
root of the absolute determinant is the area-equivalent cell span. Unlike multiplying
the two vector lengths, this metric includes their angle and cannot change merely
because camera bearing changes the alignment between the fixed grid axes and the
direction of foreshortening. A normalized budget, bounded balancing passes, hysteresis,
and revision tokens keep selection stable. The balanced cut enforces edge-adjacent level
difference at most one before mesh-stitching flags are produced. Trial counting
saturates immediately above render capacity, so an unusable fine cut cannot turn a
large root span into unbounded traversal work.

Only resident or seedable metadata can participate in a GPU pass, so delayed demand
may affect later frames. This is deliberate eventual refinement, not a claim that every
desired tile is already loaded. Feedback decoders validate counters and budget facts;
stale or inconsistent results are rejected rather than corrupting the active frontier.
Render-patch feedback reports render-root and selected-cut facts, while raster feedback
reports data demand and residency; neither readback becomes a CPU selection authority.
