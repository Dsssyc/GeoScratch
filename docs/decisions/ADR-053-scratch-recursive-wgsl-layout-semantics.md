# ADR-053: Add Recursive WGSL Layout Semantics

## Status

Proposed

## Date

2026-07-24

## Context

`LayoutCodec` currently supports `i32`, `u32`, `f32`, their numeric vectors,
`mat4x4f`, and fixed arrays of primitives. It cannot represent the complete
host-shareable type family or the current `buffer_view` language feature.
That leaves the relationship among CPU bytes, WGSL ABI, buffer binding size,
generated accessors, upload/readback views, Program requirements, and device
capabilities incomplete.

The frozen WGSL baseline is the Candidate Recommendation Draft of 16 July
2026, SHA-256
`2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa`.
It defines 12 language extensions, including `buffer_view`,
`uniform_buffer_standard_layout`, and
`unrestricted_pointer_parameters`.

## Decision Boundary

Phase 5 will complete this ADR with one canonical recursive type model covering:

- `i32`, `u32`, `f32`, and exact IEEE binary16 `f16`;
- all valid numeric vectors and every floating matrix shape;
- nested structures and recursive fixed arrays;
- final-member runtime-sized arrays with binding-derived counts;
- storage-only `atomic<i32>` and `atomic<u32>`;
- member `@align` and `@size`;
- fixed and runtime buffer types plus explicit buffer-view built-ins; and
- truthful uniform, storage, vertex, readback, and immediate compatibility.

Artifacts must distinguish fixed layouts from runtime-tailed layouts. ABI and
schema hashes include recursive type, explicit layout, capability contract,
required device features, and required WGSL language features.
`uniform_buffer_standard_layout` is a named hash-visible contract, not an
implicit reinterpretation.

`bool`, abstract numerics, pointers, references, textures, samplers, external
textures, and other opaque handles are not ordinary LayoutCodec fields.
Program remains responsible for caller-authored `enable` and `requires`
directives; Scratch records requirements but never rewrites WGSL source.

## Rejected Directions

- A full WGSL parser, compiler, linker, or source rewriter.
- A second flat primitive API beside the recursive model.
- Caller-authored array stride.
- Silent f16-to-f32 ABI promotion.
- A fabricated fixed byte length for runtime-sized layouts.
- CPU-side atomic synchronization claims.
- Hiding byte offsets or dynamic sizes in buffer-view accessors.

## Acceptance Evidence

The completed ADR requires official-table layout tests, recursive hash tests,
path-specific diagnostics, Program/capability checks, upload/readback round
trips, buffer-view bounds and alignment tests, and browser shader proofs for
nested matrices, f16 where supported, and `buffer_view` where supported.
