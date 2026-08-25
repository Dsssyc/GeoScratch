# ADR-089: Index WebMercator Terrain Draws

## Status

Accepted. Extends ADR-074, ADR-086, and ADR-088 without changing geometry-LoD,
Virtual Raster, or presentation ownership.

## Date

2026-08-25

## Context

A 128 by 128 terrain patch contains 16,641 logical grid vertices but 98,304 triangle
indices. The unindexed path treated every triangle corner as a distinct vertex invocation,
so height sampling, fixed-coordinate reconstruction, neighbor lookup, and projection ran
up to six times for the same logical point. The maximum-stretch cover in ADR-088 correctly
kept more high-pitch geometry, but the canonical pitch-70 tracking proof then observed only
38 to 43 submitted camera transitions out of 90 and native-observation p95 of 34 to 43 ms.

Scratch already expresses index buffers and `drawIndexedIndirect`. Retaining an unindexed
terrain path would make a WebGPU-native capability unavailable to Geo for no semantic
reason.

## Decision

`GpuWebMercatorQuadPatchDraw` owns a generic positive `elementCount` rather than a
terrain-specific or non-indexed `vertexCount`. Its persistent compute writes one 20-byte
indirect record:

```text
[elementCount, patchCount, 0, 0, 0]
```

The complete record is a valid `drawIndexedIndirect` argument. Its first 16 bytes are
also a valid non-indexed `drawIndirect` argument, so the adapter remains consumer-neutral.

WebMercator terrain binds immutable triangle and line index buffers with `INDEX` usage only.
Indexed drawing supplies each logical grid-position index as `vertex_index`, letting the
native post-transform cache reuse vertex results within each patch instance. Index data is
not duplicated as a shader storage binding.

The renderer owns a second immutable line-list index buffer for the diagnostic wireframe.
For every grid cell it emits the bottom edge, left edge, and the actual parity-selected
diagonal. Adjacent cells supply the opposite edges, so this is exactly three lines or six
indices per cell: the same `6 * N^2` element count as the triangle-list buffer. Both
presentations therefore share one indirect record. The wireframe fragment only colors
native line primitives and does not infer topology with derivatives or request the
implementation-specific fragment `primitive_index` extension.

## Consequences

- Terrain preserves the same triangles, height samples, fixed coordinates, mesh stitching,
  patch identities, and indirect instance count while avoiding triangle-corner vertex
  duplication.
- Triangle and wireframe index buffers remain distinct renderer-owned resources with the
  same element count; neither is exposed as shader storage.
- The maximum-stretch cover can remain within its quality contract without regressing the
  existing shaded or wireframe 90-frame latency gates.
- `WebMercatorTerrainContractFacts` reports `terrainElementCount`, and patch-draw facts
  report `elementCount`.
- The index buffer remains an immutable renderer-owned geometry resource; it does not move
  geometry generation, LoD, or mesh ownership into Scratch.

## Rejected Alternatives

### Lower terrain quality until the unindexed path passes

Rejected because it would reintroduce the long-cell under-resolution fixed by ADR-088.

### Use fragment `primitive_index` to reconstruct barycentrics

Rejected because Chrome requires an explicit non-core WGSL extension for that builtin.
The public renderer must compile on the baseline WebGPU/WGSL contract.

### Infer every mesh edge from interpolated grid coordinates

Rejected after browser evidence showed that derivative-based complete-cell inference drew
repeating diamond and star patterns that were not trustworthy mesh diagnostics. A line-list
index buffer expresses the actual topology directly.

### Keep `vertexCount` as an indexed-count alias

Rejected because the public fact would be false for indexed consumers. During 0.x the
clean-cut `elementCount` name is preferable to a compatibility alias.
