---
docId: geo.coordinates-precision
canonical: true
apiSources:
  - packages/geoscratch/src/geo/coordinate-domain.ts
  - packages/geoscratch/src/geo/mercatorCoordinate.ts
  - packages/geoscratch/src/geo/position-codec.ts
  - packages/geoscratch/src/geo/web-mercator-quad.ts
---
# Coordinates And Precision

[简体中文](./coordinates-precision_zh.md) | [Geo overview](./README.md)

Coordinate domains describe dimensional axes, surface semantics, auxiliary axes,
wrapping, and canonical units before storage or rendering is chosen. `localVector`
marks translation-invariant values separately from absolute positions. Web Mercator
provides projection constants, geographic/projected conversion, tile bounds, and a
stable address codec; it is one model, not the definition of Geo.

Position codecs preserve large-world stability without requiring every dynamic vertex
to carry JavaScript double-double values. `WideFixedCodec` stores canonical positions
as wide integer cells and local components. `CellLocalF32Codec` converts work into a
camera-relative cell-local frame whose f32 values remain small in shaders. WGSL helpers
reconstruct relative positions and tile addresses from compact integer/f32 inputs.

The canonical position and origin remain separate authority. A camera move updates the
origin transform rather than rebuilding every static vertex buffer. Dynamic shader
work, including particle integration or stitched terrain vertices, stays local and
periodically rebases cells, preventing unbounded f32 drift. Codecs expose precision and
overflow facts; they do not silently clamp or select a CRS.
