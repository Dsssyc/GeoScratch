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
policy, and selected global budget bias. Each horizontal terrain footprint is clipped
against all six WebGPU homogeneous clip planes to obtain visible evaluation positions.
At those positions, the GPU projects a symmetric one-cell displacement along both
horizontal axes and uses their geometric-mean pixel span as the refinement metric. The
metric is local and does not shrink merely because viewport clipping leaves a smaller
visible sliver during zoom-in. Local split decisions never read data-frontier topology
or the previous parity's patch topology. The GPU may retain the previous *global* bias
only inside the bounded frame-budget hysteresis band; that uniform budget decision
does not grant individual patches a second refinement threshold.

Lower-level consumers may compose `gpuRenderPatchReadWgslModule` directly. It exposes
bounded visible-instance lookup, covering-patch lookup, neighbor resolution, and edge
coordinate snapping with explicit storage bindings and layout dependencies. Generated
modules never read a CPU-selected tile list or round-trip draw counts through the CPU.

The renderer does not own a map host, camera controller, source manifest, network
transport, decoder, Worker system, or application cache policy. Those remain explicit
composition inputs. The Underwater Terrain example therefore owns source-specific
loading and decoding, map/UI assembly, cache-budget choice, and its fragment
presentation only.
