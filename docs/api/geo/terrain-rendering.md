---
docId: geo.terrain-rendering
canonical: true
apiSources:
  - packages/geoscratch/src/geo/web-mercator-terrain-renderer.ts
  - packages/geoscratch/src/geo/web-mercator-terrain-wgsl.ts
  - packages/geoscratch/src/geo/web-mercator-virtual-raster-wgsl.ts
---
# Terrain Rendering

[简体中文](./terrain-rendering_zh.md) | [Geo overview](./README.md)

`createWebMercatorTerrainRenderer` is Geo's complete OGC `WebMercatorQuad` terrain
orchestrator. It composes a `MapFieldLayer`, Web Mercator Virtual Raster runtime, GPU
data frontier, GPU render-patch frontier, generated terrain WGSL, indirect draw,
feedback, resize, and disposal into one explicit renderer. The name is intentionally
projection-specific. There is no generic `TerrainFieldRenderer` alias: a globe or
another tiling topology requires a renderer with different spatial and selection
semantics.

`webMercatorTerrainWgslModule` owns the entire terrain vertex path. It reconstructs
wide-fixed logical positions from render patches, takes camera-relative differences
before f32 conversion, resolves neighboring render patches, snaps mixed-LoD shared
edges, samples height through the logical Virtual Raster accessor, and projects the
result. It also provides the built-in fragment entry point named by
`WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT`. The renderer's
`presentationShader` is an extension source for application fragment entry points; it
consumes `WebMercatorTerrainVertexOutput` and must not duplicate position, stitching,
tile lookup, or height-sampling logic.

Raster LoD and geometry LoD are separate authorities. The data frontier owns demand,
residency, publication, and fallback up to the source matrix limit. The render-patch
frontier traverses an immutable, prefix-free geographic safety cover and may refine the
terrain grid beyond the source limit. A render patch carries only geometry identity.
Terrain requests the finest logical Virtual Raster level, and the page table resolves
each coordinate to the available physical page. Virtual Raster removes CPU padding and
physical-atlas coupling; mesh stitching removes T-junction cracks.

Render-patch refinement is canonical for the current camera, viewport, render roots,
and policy. Each horizontal terrain footprint is clipped against all six WebGPU
homogeneous clip planes to obtain visible evaluation positions. At those positions,
the GPU projects a symmetric one-cell displacement along both horizontal axes and uses
the area-equivalent pixel span of their local Jacobian as the refinement metric. The
metric is local and does not shrink merely because viewport clipping leaves a smaller
visible sliver during zoom-in.

The GPU counts 17 complete uniform-bias cuts and chooses a stateless in-budget base.
It then repeatedly identifies the greatest above-threshold Q8-quantized local span.
Every terminal patch with that exact error belongs to one indivisible cohort: the GPU
splits the complete cohort only when all of its visible children fit the residual frame
budget. It never selects an equal-error subset by logical tile identity, traversal
order, or screen direction. Unused slots are valid when the next complete quality
cohort does not fit. The primary lookup is rebuilt from that error-cohort-filled cut
before bounded 2:1 balancing. Local selection never reads data-frontier topology,
previous-parity topology, or a previous bias. Delayed render-patch feedback exposes
base, fill, budget-limited, unbalanced, and balance facts, but never controls a later
render cut.

`renderFrame()` returns as soon as the current work is submitted. Native observation,
delayed GPU feedback, feedback-driven residency, and convergence are separate promises;
none retains frame-submission authority. Feedback for an older camera is reported as
superseded and cannot reconcile residency or overwrite current facts. A decision is
settled only after its frontier is converged and it requests no additional pages. When
the camera or residency decision key changes, the renderer immediately withdraws the
previous frontier and render-patch facts and reports `transitioning` until feedback for
the current decision settles. Returning to an earlier camera does not reuse its old
settled status because intervening decisions have mutated the GPU-resident frontier.

Lower-level consumers may compose `gpuRenderPatchReadWgslModule` directly. It exposes
bounded visible-instance lookup, covering-patch lookup, neighbor resolution, and edge
coordinate snapping with explicit storage bindings and layout dependencies. Generated
modules never read a CPU-selected tile list or round-trip draw counts through the CPU.

The renderer does not own a map host, camera controller, source manifest, network
transport, decoder, Worker system, or application cache policy. Those remain explicit
composition inputs. The Underwater Terrain example therefore owns source-specific
loading and decoding, map/UI assembly, cache-budget choice, and its fragment
presentation only.
