---
docId: geo.views-frames
canonical: true
apiSources:
  - packages/geoscratch/src/geo/frame-controller.ts
  - packages/geoscratch/src/geo/geo-view.ts
  - packages/geoscratch/src/geo/maplibre-planar-view.ts
---
# Views And Frame Control

[简体中文](./views-frames_zh.md) | [Geo overview](./README.md)

`GeoViewAdapter` reads an external camera or map and produces immutable
`GeoViewSnapshot` values containing viewport, matrices, camera position, zoom,
orientation, and a monotonic revision. The MapLibre planar adapter translates
MapLibre-compatible state without making MapLibre the owner of Geo resources.

Snapshots are observations, not global camera state. Screen-based demand may consume
them for visualization, while simulations, prefetch, editing, or offline processes may
produce independent demand. This distinction prevents camera locality from becoming a
universal resource policy.

`GeoFrameController` coordinates snapshot reading, resize, prepare, render, feedback,
and invalidation for one assembled field. It owns frame-loop authority only when the
descriptor gives it that responsibility. It does not own the external map, GPU runtime,
or field resources unless those are explicitly registered for cleanup.
