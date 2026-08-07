# DEM Screen-Space Render-Patch LoD Implementation Plan

**Goal:** Replace zoom-uniform DEM geometry refinement with bounded GPU screen-space
error selection so one pitched frame uses finer near patches and coarser far patches,
while raster requests remain capped at the source `z10` ceiling.

## Constraints

- Keep `GpuTileFrontier` authoritative for raster residency, demand, fallback, and
  retirement.
- Keep geometry selection example-owned; do not add DEM or quadtree semantics to
  Scratch.
- Keep all per-frame selection, counts, adjacency, and draws GPU-side.
- Preserve the `z14` render ceiling, four-level maximum source-page expansion,
  high-precision fixed coordinates, virtual-raster sampling, and persistent graph.
- Remove the fixed source-domain LoD texture rather than scaling it up.

## Completed Steps

- [x] Add RED tests proving one camera view selects different levels at near and far
  distances and that the old shader still reads `zoomHint`.
- [x] Implement bounded terminal-path traversal with frustum culling and two-pixel SSE
  stopping in `render-patch-frontier.wgsl`.
- [x] Emit a parity-local logical patch hash together with render descriptors and one
  terrain indirect argument.
- [x] Replace LoD-texture neighbor sampling with max-level edge probes and logical hash
  lookup from `z14` toward `z0`.
- [x] Generalize fine-edge snapping to bounded multi-level differences and preserve
  explicit neighboring sampling levels.
- [x] Remove the LoD-map texture, shader, program, pipeline, pass, commands, and stale
  graph/provenance facts.
- [x] Run focused tests, TypeScript checks, production build, complete unit tests, and
  real Chrome WebGPU pitched-camera rendering.
- [x] Record the supersession in ADR-064 and update living DEM/Scratch audits.
