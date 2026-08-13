---
docId: geo.terrain-rendering
canonical: true
apiSources:
  - packages/geoscratch/src/geo/terrain-field-renderer.ts
  - packages/geoscratch/src/geo/web-mercator-virtual-raster-wgsl.ts
---
# Terrain Rendering

[简体中文](./terrain-rendering_zh.md) | [Geo overview](./README.md)

`createTerrainFieldRenderer` is the reusable Geo orchestration extracted from the DEM
example. It composes a Geo view, field/runtime, GPU render-patch frontier, atlas
sampling module, mesh-stitching topology, pipelines, indirect draws, resize, feedback,
and lifecycle into one explicit renderer contract. The application supplies source,
presentation, shader/color policy, and ownership choices.

Web Mercator Virtual Raster WGSL samples height by logical world position, including
parent fallback and cross-tile filtering. Terrain vertex generation stays camera-
relative and can refine mesh density independently of raster z. Mesh stitching, not
Virtual Raster, removes T-junction cracks; Virtual Raster removes CPU padding and
neighbor-aware shader plumbing at tile boundaries.

The renderer is not a universal scene, map, or DEM loader. It does not own an external
map or silently start unrelated Workers. Other renderers may consume the same field and
frontier primitives for imagery, flow, compute, or editing. The DEM example should
contain only source-specific loading/decoding, presentation shaders, controls, and
assembly that cannot be expressed by these public contracts.
