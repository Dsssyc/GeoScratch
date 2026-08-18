---
docId: geo.tiles-demand
canonical: true
apiSources:
  - packages/geoscratch/src/geo/tile-matrix.ts
  - packages/geoscratch/src/geo/tile-spatial-profile.ts
  - packages/geoscratch/src/geo/tile-topology.ts
  - packages/geoscratch/src/geo/view-tile-demand.ts
---
# Tile Models And Demand

[简体中文](./tiles-demand_zh.md) | [Geo overview](./README.md)

Tile matrix sets and finite coverage describe source addressability, bounds, origin,
matrix dimensions, and per-level limits. Topology describes parent, child, and neighbor
relationships independently from projection. Spatial profiles encode tile bounds and
camera-relative coordinates for a particular map or globe model.

`ViewDemandProducer` validates, deduplicates, prioritizes, and bounds caller-derived
tile candidates against one immutable view provenance record. It does not inspect the
camera or choose LoD itself. A view-cover, simulation, editor, prefetch corridor, or
analytic extent remains the semantic demand producer.

Demand is intent rather than residency. `ViewTileDemand` carries the executable page,
`desiredSampleLevel`, `sourceLevelCeiling`, priority, intent, reason, generation,
and exact view/frame/residency provenance. Lowering to Virtual Raster deliberately
drops the semantic level fields: residency schedules the page but cannot revise the
producer's LoD decision. A raster source may stop at z10 while standard geometry
continues through z14.
