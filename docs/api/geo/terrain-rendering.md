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
orchestrator. It composes one `MapFieldLayer`, prepared Virtual Raster runtime,
`GpuWebMercatorQuadCover`, `GpuWebMercatorQuadDemandProjection`,
`GpuWebMercatorQuadPatchDraw`, generated terrain WGSL, capture-sized attachments,
delayed feedback, and explicit disposal. There is no generic terrain alias that
pretends planar and globe selection are equivalent.

The frame order is:

```text
view upload
    -> adaptive inverse-cover compute
    -> source-demand projection compute
    -> patch-draw indirect preparation compute
    -> terrain drawIndirect
```

These stages have separate ownership. The cover chooses only standard geometry patches
and adjacency. Demand projection maps those patches to the Virtual Raster source
ceiling. Patch draw combines consumer vertex count with GPU patch count. Virtual Raster
then schedules explicit `ViewTileDemandSet` pages and resolves exact or ancestor data;
residency never changes geometry topology.

The built-in terrain consumer uses a 128-cell standard patch, a four-reference-pixel
maximum area-equivalent projected cell span, and 0.005 numerical tolerance. Every pitch
uses the same adaptive selector. There is no 60-degree boundary, mode feedback, renderer
override, or example environment variable. Physical presentation size and DPR do not
participate in the quality metric.

`elevationRangeMeters` and optional `WebMercatorTerrainElevationBounds` remain terrain
source facts. The renderer applies exaggeration and converts them to generalized
`WebMercatorTileVerticalBounds` before creating the cover. A hierarchy must completely
match source coverage; omitted metadata uses the global range. Cache hits, atlas pages,
and request completion cannot supply or mutate bounds.

Demand feedback preserves desired geometry precision separately from source ceiling
and executable request tile. `VirtualRasterRuntime.reconcileViewDemands()` schedules
only those explicit requests. Exact-resident pages do not consume request budget.
Missing exact pages render through page-table ancestor fallback while the same geometry
cut remains active.

`webMercatorTerrainWgslModule` owns the complete vertex path. It reconstructs wide-
fixed standard-tile positions, subtracts the camera before f32 conversion, resolves
cover neighbors, snaps mixed-LoD edges, samples height by global field coordinate, and
projects the result. The built-in wireframe entry point displays the post-stitch mesh
with stable tile colors. Application presentation WGSL supplies fragment shading only.

`render(capture)` consumes one `GeoViewSourceCapture<ViewInput>`, resizes physical
attachments from `presentationSize`, and returns
`GeoFrameResult<WebMercatorTerrainFrameValue>`. Submission/native observation, cover
feedback, demand feedback, raster settlement, and later publication remain distinct
promises and facts. Superseded feedback cannot reconcile demand or overwrite current
state. Until the newest camera decision settles both bounded readbacks, same-decision
frames retain `needsFollowUp` so latest-only admission cannot strand convergence.

The renderer owns two parity sets in each composed GPU component. Underwater Terrain
uses a measured two-frame in-flight bound. The renderer does not own a map host,
controller, source manifest, URL policy, Worker system, decoder, or persistent-cache
choice.

Future feature-to-surface conformance is not implemented by this renderer. A separate
Geo preprocess product may consume its surface geometry or matching field sampler, but
feature identity and source tiling must not become terrain-tile render-to-texture state.

Related decisions: ADR-074 assigns terrain WGSL ownership; ADR-083 defines inverse
cover and passive Virtual Raster; ADR-084 defines reference pixels; ADR-086 unifies the
selector and separates geometry, source demand, and draw-count ownership.
