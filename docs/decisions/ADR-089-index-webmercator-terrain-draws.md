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

WebMercator terrain binds its immutable grid index buffer with both `INDEX` and `STORAGE`
usage. Indexed drawing supplies each logical grid-position index as `vertex_index`, letting
the native post-transform cache reuse vertex results within each patch instance.

The diagnostic wireframe does not require duplicated barycentric vertices. The recursive
power-of-two plane resolves to a regular grid whose diagonals alternate by integer-cell
parity. The fragment entry point reconstructs integer grid edges and the checkerboard
diagonal from the interpolated, post-stitch `gridPosition`. It uses only core WGSL and does
not request the implementation-specific fragment `primitive_index` extension.

## Consequences

- Terrain preserves the same triangles, height samples, fixed coordinates, mesh stitching,
  patch identities, and indirect instance count while avoiding triangle-corner vertex
  duplication.
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

### Keep `vertexCount` as an indexed-count alias

Rejected because the public fact would be false for indexed consumers. During 0.x the
clean-cut `elementCount` name is preferable to a compatibility alias.

