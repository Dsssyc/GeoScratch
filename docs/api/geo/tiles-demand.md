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

`ViewDemandProducer` turns a view snapshot into prioritized tile demand using
frustum/viewport evidence, projected error, distance, and source limits. It is one
demand producer, not the Virtual Raster owner. Other producers may request simulation
regions, prefetch corridors, edit neighborhoods, or analytic extents, then merge into a
generation-tagged demand set.

Demand is intent rather than residency. It carries usage, priority, revision, and
generation so stale asynchronous loads can be rejected. Source detail level and render
mesh detail are distinct: a raster source may stop at z10 while a terrain frontier
continues refining geometry for smoother projection.
