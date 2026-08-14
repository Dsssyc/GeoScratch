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
to carry JavaScript double-double values. `WideFixedCodec` stores each signed canonical
axis as two u32 limbs. Its generated WGSL includes exact shifted-u32 construction,
signed wide-axis conversion, signed difference, fractional normalization, and expansion
subtraction helpers. In particular, `<namespace>_signed_difference_f32` performs integer
subtraction before f32 conversion, while `<namespace>_fraction_f32` derives a normalized
logical coordinate without first materializing a large global f32 position.

`CellLocalF32Codec` converts dynamic work into a camera-relative cell-local frame whose
f32 values remain small in shaders. WGSL helpers reconstruct relative positions and
transient LoD addresses from compact integer/f32 inputs; per-vertex buffers do not carry
a repeated seven-field physical tile address.

The canonical position and origin remain separate authority. A camera move updates the
origin transform rather than rebuilding every static vertex buffer. Dynamic shader
work, including particle integration or stitched terrain vertices, stays local and
periodically rebases cells, preventing unbounded f32 drift. Static terrain derives its
canonical wide-fixed position from logical patch identity and local grid coordinates,
so camera changes do not rebuild vertex buffers. Codecs expose precision and overflow
facts; they do not silently clamp, wrap signed overflow, or select a CRS.
