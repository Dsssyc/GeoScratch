---
docId: geo.fields
canonical: true
apiSources:
  - packages/geoscratch/src/geo/geo-field.ts
  - packages/geoscratch/src/geo/map-field-layer.ts
  - packages/geoscratch/src/geo/web-mercator-virtual-raster-field.ts
---
# Fields And Layer Composition

[简体中文](./fields_zh.md) | [Geo overview](./README.md)

`GeoField` models a value defined over a coordinate domain, with value shape,
interpolation, missing-data semantics, and one or more representations. A tiled
representation says how storage is partitioned; it does not force rendering code to
address neighboring tiles manually.

`webMercatorVirtualRasterField` composes a field with Web Mercator addressing and
Virtual Raster sampling. Shader consumers supply a geographic or projected position
and use generated library functions to resolve the appropriate logical page, parent
fallback, boundary behavior, and physical atlas sample. The field abstraction hides
storage partitioning from terrain, flow, compute, and editing shaders while preserving
explicit status for missing or fallback samples.

`mapFieldLayer` binds a field-oriented renderer to a view/frame lifecycle. It is a
small composition contract, not a scene hierarchy and not a promise that every field
uses one planar quadtree. Globe or non-quadtree representations may implement the same
field semantics with different topology and demand producers.
