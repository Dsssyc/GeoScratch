# ADR-010: Add Scratch Layout-Aware Readback Operations

## Status

Superseded in part by ADR-036. Layout-aware readback remains accepted;
resource-global layout capture is superseded by `BufferRegion`-owned layout
witnesses.

## Date

2026-07-08

## Context

ADR-007 introduced `LayoutCodec` and `LayoutArtifact` as preparation artifacts for CPU packing, upload bytes, readback interpretation, and generated WGSL accessors.

The remaining loop was GPU-to-CPU host access. `ReadbackOperation` could return raw
bytes or a caller-selected typed array, but it could not directly produce a structured
`LayoutReadbackView` from an explicit source interpretation.

## Historical Decision (Partly Superseded)

The original decision correctly added layout-aware readback, but captured one layout
owned by the whole source buffer. ADR-036 removed resource-global layout ownership.
That capture rule is no longer normative.

## Current Replacement

Extend `ReadbackOperation` with:

- `layout?: LayoutArtifact`
- `toLayoutView(): Promise<LayoutReadbackView>`

`runtime.createReadback({ source })` accepts a source `BufferRegion` and captures that
source region plus its optional layout witness. A raw region remains valid and carries
no layout.

`toLayoutView()` remains part of the readback operation lifecycle:

- it uses the same staging, copy, map, and consume path as `toBytes()`;
- it preserves existing consumed, cancelled, and disposed diagnostics;
- it rejects raw regions with `SCRATCH_READBACK_LAYOUT_MISSING`;
- it returns a `LayoutReadbackView` decoded from the captured `LayoutArtifact`;
- it keeps `toBytes()` and typed-array `toArray(TypedArray)` semantics unchanged.

The shared conversion from `LayoutArtifact + bytes` to `LayoutReadbackView` lives with the layout codec implementation, so `LayoutCodec.createReadbackView(bytes)` and `ReadbackOperation.toLayoutView()` decode through the same layout facts without requiring a live `LayoutCodec` instance.

ADR-036 is normative for `BufferRegion` ownership and compatibility.

## Consequences

- Scratch now has a complete explicit CPU -> GPU -> CPU layout loop for interpreted regions.
- Host readback remains an explicit operation boundary, not a resource method.
- `BufferResource` does not gain `toArray()`, `toBytes()`, `read()`, or `write()` helpers.
- Layout readback diagnostics use the existing `ScratchDiagnostic` envelope and stable layout/readback phases.

## Non-Goals

- Do not add resource-level read, mapping, or array-conversion methods.
- Do not infer a layout for a raw region or search for a matching codec at runtime.
- Do not add automatic scheduling, geo integration, or scene policy in this decision.
- Do not introduce material, style, symbolizer, layer, or scene concepts into Scratch core.
