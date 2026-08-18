---
docId: geo
canonical: true
apiSources:
  - packages/geoscratch/src/geo/diagnostics.ts
---
# Geo

[简体中文](./README_zh.md) | [API root](../README.md) | [Generated reference](../reference/geo.md)

Geo is the geographic adaptation layer in `geoscratch/geo`. It composes Scratch
primitives into coordinate domains, precision encodings, view snapshots, field
models, tile demand, Virtual Raster residency, GPU-driven view cover, and terrain
rendering. Geo owns geographic semantics and may depend on Scratch; it does not hide
the Scratch runtime or create global GPU state.

Geo diagnostics use the same machine-readable discipline as Scratch while retaining a
separate domain, code, phase, and subject vocabulary. `GeoDiagnosticError` carries
structured evidence across exception boundaries.

## Subsystems

- [Coordinates and precision](./coordinates-precision.md)
- [Views and frame control](./views-frames.md)
- [Fields and layer composition](./fields.md)
- [Tile models and demand](./tiles-demand.md)
- [Virtual Raster](./virtual-raster.md)
- [WebMercatorQuad view cover](./view-cover.md)
- [Terrain rendering](./terrain-rendering.md)

The current executable topology is planar and Web Mercator capable, but core field and
coordinate contracts do not claim that one quadtree represents every globe or CRS.
Future globe profiles may provide different topology and spatial encodings without
changing Scratch.
