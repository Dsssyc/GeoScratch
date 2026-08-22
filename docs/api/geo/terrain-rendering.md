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

`createWebMercatorTerrainRenderer` is Geo's OGC `WebMercatorQuad` terrain
orchestrator. It composes one `MapFieldLayer`, one prepared Virtual Raster runtime,
one `GpuWebMercatorQuadCover`, generated terrain WGSL, indirect drawing,
capture-sized resize, delayed demand settlement, and disposal. The name is
projection-specific; there is no generic terrain alias that pretends planar and globe
selection are equivalent.

The frame order is:

```text
view upload -> inverse-cover compute -> terrain drawIndirect
```

The cover is the only geometry-LoD authority. It derives a prefix-free, standard-tile
cover from current camera facts without root traversal or atlas residency. Its output
contains full `tileMatrix/tileRow/tileCol` identities, a neighbor lookup, desired page
feedback, and an indirect instance count. The final cover is 2:1 edge-balanced before
terrain rendering.

The built-in terrain policy uses a 512-reference-pixel zoom convention, 128 cells per
standard patch, an eight-reference-pixel maximum area-equivalent projected cell span,
a 0.005 numerical refinement tolerance, and a 60-degree variable-LoD pitch threshold.
`variableLodPitchThresholdRadians` may override that threshold in the renderer
descriptor. Below it, the complete visible footprint uses one geometry level; at or
above it, projected-cell evidence produces finer near and coarser far patches. Cover
capacity is allocated from reference viewport size and the configured uniform-pitch range, so
capacity failure remains explicit rather than causing hidden quality degradation.
Physical presentation size and DPR do not participate. The threshold is an explicit
quality/performance switch: a view immediately below it
may draw substantially more geometry than the variable cut at the boundary. Applications
that prioritize sustained high-pitch interaction should configure a lower threshold.

Raster demand is explicitly downstream. Cover feedback retains desired precision and
source ceiling, then the renderer creates a `ViewTileDemandSet`.
`VirtualRasterRuntime.reconcileViewDemands()` schedules only executable source pages.
Already exact-resident pages do not consume the concurrent request budget. Missing
exact pages continue rendering through page-table ancestor fallback; residency timing
never changes geometry topology.

`elevationBounds` may provide a complete immutable hierarchy matching source coverage.
The renderer scales every record by exaggeration and the cover uses exact or
source-ceiling-ancestor bounds. Omitted metadata uses the global elevation range;
partial metadata fails before GPU resource creation.

`webMercatorTerrainWgslModule` owns the full vertex path. It reconstructs wide-fixed
standard-tile positions, subtracts the camera before f32 conversion, resolves cover
neighbors, snaps mixed-LoD edges, samples height by global field coordinate, and
projects the result. The built-in
`WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT` displays the post-stitch
mesh with stable per-tile colors. Application presentation WGSL supplies fragment
shading only.

`render(capture)` consumes one `GeoViewSourceCapture<ViewInput>`, resizes physical
attachments from `presentationSize`, submits the matching reference-pixel view, and
returns `GeoFrameResult<WebMercatorTerrainFrameValue>`.
Submission/native observation, delayed cover readback, raster request settlement, and
later publication remain separate promises. Superseded cover feedback cannot reconcile
demand or overwrite current facts. Until the latest camera decision is settled, every
newer frame for that same decision retains `needsFollowUp`; a latest-only frame controller
therefore cannot suppress the extra frame required to consume one-frame-lagged feedback.
The renderer owns two map-meta/cover parity sets;
the Underwater Terrain application uses a measured two-frame in-flight bound.

The renderer does not own a map host, controller, source manifest, URL policy, Worker
system, decoder, or persistent cache choice. Those remain explicit application
composition.

Related decisions: `docs/decisions/ADR-074-webmercator-terrain-wgsl-ownership.md`
assigns terrain vertex and stitching ownership;
`docs/decisions/ADR-083-webmercator-inverse-cover-passive-virtual-raster.md`
defines inverse-cover composition; `docs/decisions/ADR-084-reference-pixel-terrain-lod.md`
defines reference-pixel quality and immutable elevation bounds.
