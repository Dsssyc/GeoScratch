# ADR-074: Make Web Mercator Terrain WGSL Geo-Owned

## Status

Accepted

## Date

2026-08-14

## Context

The first reusable terrain extraction moved scheduling, GPU frontiers, indirect draw,
feedback, resize, and lifecycle into Geo, but left the complete terrain vertex shader
in the DEM example. That shader still owned logical render-patch lookup, mixed-LoD
neighbor resolution, mesh stitching, wide-fixed camera-relative positioning, and
Virtual Raster height sampling. The example therefore remained a second implementation
authority for mechanisms that every Web Mercator terrain consumer requires.

The public name `TerrainFieldRenderer` also overstated the abstraction. Its runtime,
tile matrix, position reconstruction, and frontier policy were specifically OGC
`WebMercatorQuad`. Retaining a projection-neutral name would invite globe and other
tiling models to depend on a false generic contract.

## Decision

Geo owns a complete generated module, `webMercatorTerrainWgslModule`, and the high-level
`createWebMercatorTerrainRenderer` composition. The generated module owns:

- wide-fixed logical position construction and camera-relative projection;
- bounded render-patch lookup, covering-patch and neighbor queries;
- mixed-LoD shared-edge snapping and sampling-level reconciliation;
- logical Virtual Raster height sampling;
- terrain vertex outputs and a built-in tile-wireframe diagnostic fragment.

`gpuRenderPatchReadWgslModule` is the reusable lower-level read contract. It declares
its storage bindings and layout dependencies and can be composed without the terrain
renderer.

Applications may append presentation WGSL containing fragment entry points and helper
functions. They do not reimplement vertex generation, patch lookup, stitching, or
height sampling. The DEM presentation shader is consequently fragment-only.

The old `TerrainFieldRenderer` names and `shader` descriptor property are removed.
There is no compatibility alias. The Web Mercator API uses
`WebMercatorTerrainRenderer`, `createWebMercatorTerrainRenderer`, and
`presentationShader` throughout.

## Consequences

- The DEM example becomes a thin source, map, controls, policy, and presentation
  composition rather than a hidden terrain engine.
- Web Mercator terrain consumers share one precision, stitching, and Virtual Raster
  sampling implementation.
- Raster LoD and render-patch LoD remain independent and explicit through
  `samplingLevel`.
- Globe, dual-quadtree, and non-Web-Mercator renderers must define their own spatial
  contract instead of inheriting an inaccurate alias.
- Public API reference and bilingual current API documentation must describe the
  projection-specific ownership boundary.

## Rejected Alternatives

### Keep the example-owned vertex shader

Rejected because it makes every consumer and agent rediscover private bindings,
precision rules, neighbor lookup, and stitching behavior.

### Keep `TerrainFieldRenderer` as an alias

Rejected because the implementation is not projection-neutral and the project is in a
clean-cut 0.x phase.

### Move terrain behavior into Scratch

Rejected because tile identity, Web Mercator coordinates, render-patch neighbors, and
Virtual Raster semantics are geographic policy. Scratch remains domain-neutral.
