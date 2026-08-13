---
docId: scratch.geometry
canonical: true
apiSources:
  - packages/geoscratch/src/scratch/geometry/plane.ts
  - packages/geoscratch/src/scratch/geometry/sphere.ts
---
# Geometry

[简体中文](./geometry_zh.md) | [Scratch overview](./README.md)

The geometry helpers create CPU-side typed arrays for regular planes and spheres.
They are deterministic data factories: they do not allocate GPU resources, select a
pipeline, own a runtime, or attach geographic meaning. Applications may upload the
returned positions, normals, texture coordinates, and indices through explicit Scratch
buffer operations.

These helpers are conveniences rather than a scene or mesh object model. Domain-
specific topology, adaptive terrain patches, and tile stitching remain in Geo or the
application that owns those policies.
