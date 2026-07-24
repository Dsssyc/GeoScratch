# ADR-053: Add Recursive WGSL Layout Semantics

## Status

Accepted

## Date

2026-07-24

## Context

The former `LayoutCodec` supported only `i32`, `u32`, `f32`, their numeric
vectors, `mat4x4f`, and fixed arrays of primitives. It could not represent the
complete host-shareable type family or the current `buffer_view` language
feature. That left the relationship among CPU bytes, WGSL ABI, buffer binding
size, generated accessors, upload/readback views, Program requirements, and
device capabilities incomplete.

The frozen WGSL baseline is the Candidate Recommendation Draft of 16 July
2026, SHA-256
`2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa`.
It defines 12 language extensions, including `buffer_view`,
`uniform_buffer_standard_layout`, and
`unrestricted_pointer_parameters`.

## Decision

Scratch uses one canonical recursive type model covering:

- `i32`, `u32`, `f32`, and exact IEEE binary16 `f16`;
- all valid numeric vectors and every floating matrix shape;
- nested structures and recursive fixed arrays;
- final-member runtime-sized arrays with binding-derived counts;
- storage-only `atomic<i32>` and `atomic<u32>`;
- member `@align` and `@size`;
- fixed and runtime buffer types plus explicit buffer-view built-ins; and
- truthful uniform, storage, vertex, readback, and immediate compatibility.

Input descriptors encode the WGSL grammar that matters to host layout:
fixed arrays can contain only fixed-footprint elements, an opaque `buffer` is
root-only, and a runtime-sized array can appear only at the root or as the
final member of its containing structure. TypeScript rejects invalid static
combinations while the runtime validates JavaScript and dynamically sourced
descriptors with the same rules.

Artifacts discriminate `FixedLayoutArtifact` from `RuntimeLayoutArtifact`.
Only a fixed artifact publishes `byteLength` and `stride`. A runtime artifact
publishes its fixed prefix, minimum binding size, runtime tail or byte
granularity, and requires an explicit runtime extent whenever a concrete host
byte length is needed. No operation infers a fixed size from a current
allocation.

ABI and schema hashes include recursive type, explicit layout, capability
contract, required device features, and required WGSL language features.
`uniform_buffer_standard_layout` is a named hash-visible contract, not an
implicit reinterpretation. Each usage publishes a structured compatibility
fact with compatibility, reasons, required device features, required language
features, and mutable-storage requirements. `f16` derives the `shader-f16`
device requirement.

`LayoutBufferViewContract` expresses `bufferView`, `bufferArrayView`, and
`bufferLength` without hiding byte offsets, lengths, alignments, or pointer
provenance. Address-space/access combinations follow WGSL: uniform is read,
workgroup is read-write, and storage is read or read-write. A
function-parameter pointer path names its parameter-buffer chain and derives
`unrestricted_pointer_parameters`; every buffer-view contract derives
`buffer_view`. Fixed buffers may narrow to a same-sized or smaller fixed
parameter buffer, or to a runtime buffer; runtime-to-fixed and widening paths
fail closed. Program layout requirements consume these contracts, derive
their device/language requirements, and contribute their minimum or statically
required binding ranges to pipeline and command validation.

`bool`, abstract numerics, pointers, references, textures, samplers, external
textures, and other opaque handles are not ordinary LayoutCodec fields.
Program remains responsible for caller-authored `enable` and `requires`
directives, override expressions, and dynamic values. Scratch records
requirements but never parses or rewrites WGSL source.

## Rejected Directions

- A full WGSL parser, compiler, linker, or source rewriter.
- A second flat primitive API beside the recursive model.
- Caller-authored array stride.
- Silent f16-to-f32 ABI promotion.
- A fabricated fixed byte length for runtime-sized layouts.
- CPU-side atomic synchronization claims.
- Hiding byte offsets or dynamic sizes in buffer-view accessors.

## Acceptance Evidence

The accepted implementation is covered by:

- official-table scalar, vector, matrix, array, structure, alignment, and size
  tests;
- exact binary16 conversion and recursive fixed/runtime upload-readback round
  trips;
- recursive ABI/schema identity and mutation-isolation tests;
- runtime-tail size/count, atomic access, and buffer-view path, bounds,
  alignment, access, and feature tests;
- Program requirement derivation and missing/present capability tests;
- compile-time invalid-grammar tests at both public entrypoints; and
- a bounded 20,000-cycle fixed/runtime codec stress gate.

Consolidated browser shader execution for nested matrices, `f16` where
supported, and `buffer_view` where supported remains a Phase 6 release gate.
This ADR accepts the API and semantic decision; it does not claim that later
browser gate before it runs.
