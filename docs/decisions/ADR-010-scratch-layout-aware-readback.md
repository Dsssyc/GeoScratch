# ADR-010: Add Scratch Layout-Aware Readback Operations

## Status

Accepted

## Date

2026-07-08

## Context

ADR-007 introduced `LayoutCodec` and `LayoutArtifact` as preparation artifacts for CPU packing, upload bytes, readback interpretation, and generated WGSL accessors.

ADR-008 attached optional `LayoutArtifact` metadata to `BufferResource` and validated layout-aware uploads. ADR-009 let `Program`, `Pipeline`, and executable commands validate buffer layout requirements against bound resources.

The remaining loop was GPU-to-CPU host access. `ReadbackOperation` could return raw bytes or a caller-selected typed array, but it could not directly produce a structured `LayoutReadbackView` from the layout already declared by the source buffer.

## Decision

Extend `ReadbackOperation` with:

- `layout?: LayoutArtifact`
- `toLayoutView(): Promise<LayoutReadbackView>`

`runtime.createReadback({ source })` captures `source.layout` when the source buffer declares one. Raw buffers remain valid and expose no layout.

`toLayoutView()` remains part of the readback operation lifecycle:

- it uses the same staging, copy, map, and consume path as `toBytes()`;
- it preserves existing consumed, cancelled, and disposed diagnostics;
- it rejects raw buffers with `SCRATCH_READBACK_LAYOUT_MISSING`;
- it returns a `LayoutReadbackView` decoded from the captured `LayoutArtifact`;
- it keeps `toBytes()` and typed-array `toArray(TypedArray)` semantics unchanged.

The shared conversion from `LayoutArtifact + bytes` to `LayoutReadbackView` lives with the layout codec implementation, so `LayoutCodec.createReadbackView(bytes)` and `ReadbackOperation.toLayoutView()` decode through the same layout facts without requiring a live `LayoutCodec` instance.

## Consequences

- Scratch now has a complete explicit CPU -> GPU -> CPU layout loop for layout-backed buffers.
- Host readback remains an explicit operation boundary, not a resource method.
- `BufferResource` does not gain `toArray()`, `toBytes()`, `read()`, or `write()` helpers.
- Layout readback diagnostics use the existing `ScratchDiagnostic` envelope and stable layout/readback phases.

## Non-Goals

- Do not add `ReadbackCommand`.
- Do not add readback retention modes, mapped leases, or staging budgets.
- Do not add scheduler dependency validation or automatic scheduling.
- Do not migrate examples or geo integrations in this decision.
- Do not introduce material, style, symbolizer, layer, or scene concepts into Scratch core.
