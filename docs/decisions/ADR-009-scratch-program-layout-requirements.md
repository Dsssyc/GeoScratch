# ADR-009: Validate Scratch Program Buffer Layout Requirements

## Status

Accepted

## Date

2026-07-08

## Context

ADR-007 introduced `LayoutCodec` and `LayoutArtifact` as the explicit CPU/WGSL data boundary. ADR-008 attached optional `LayoutArtifact` metadata to `BufferResource` and validated layout-aware uploads.

One gap remained: a `Program` could include WGSL accessors generated from a `LayoutArtifact`, while its `BindLayout`, `BindSet`, and bound `BufferResource` objects had no mechanical way to prove they matched that artifact. Callers could accidentally bind a buffer prepared for a different struct layout and only discover the problem through shader behavior.

The Scratch API vision keeps `Program` as a shader contract and metadata object. It does not own concrete resources, bind sets, command counts, or submission behavior.

## Decision

Add explicit Program-side buffer layout requirements:

- `ProgramBufferLayoutRequirement`
- `ProgramDescriptor.layoutRequirements?: ProgramBufferLayoutRequirement[]`
- `Program.layoutRequirements`

Each requirement names a buffer binding by `group` and `binding`, optionally by `name`, declares the required buffer binding type, optionally declares required shader stages, and carries the authoritative `LayoutArtifact`.

Program construction normalizes and validates requirements:

- `group` and `binding` must be non-negative integers;
- `name`, when present, must be a non-empty string;
- `type` is limited to `uniform`, `read-storage`, or `storage`;
- `visibility`, when present, must be a non-empty subset of `vertex`, `fragment`, and `compute`;
- `layout` must be a valid `LayoutArtifact`;
- duplicate `(group, binding)` pairs are rejected.

Pipeline construction validates the abstract contract:

- the required bind group must be present in `bindLayouts`;
- the required binding entry must be present;
- the entry name must match when the requirement declares a name;
- the entry type must match;
- the entry visibility must include every required stage.

`DrawCommand` and `DispatchCommand` construction validate concrete resources:

- the required bind set group must be supplied;
- the supplied bind set layout must already be compatible with the pipeline;
- the required binding must resolve to a `BufferResource`;
- the buffer must declare a `layout`;
- the buffer layout `structuralHash` must match the Program requirement layout `structuralHash`.

All failures use `ScratchDiagnosticError` with code `SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH` and phase `program`. Subjects identify the shader binding contract, and diagnostics carry structured `expected`, `actual`, and related Program/Pipeline/BindLayout/BindSet/BufferResource/LayoutArtifact subjects where useful.

## Consequences

- A Program can now declare the layout contract expected by generated WGSL accessors without owning concrete buffers.
- Pipeline creation catches mismatched `BindLayout` metadata before GPU pipeline creation.
- Command creation catches missing or mismatched concrete buffer layouts before encoding or submission.
- Programs without layout requirements remain valid.
- `geoscratch` and `geoscratch/scratch` expose the new public TypeScript type.

## Non-Goals

- Do not parse WGSL or make shader reflection authoritative.
- Do not auto-generate bind layouts from shader source.
- Do not make `Program` own concrete resources, bind sets, draw counts, or dispatch counts.
- Do not move Program-aware validation into `BindSet`, because plain bind sets only know their `BindLayout`.
- Do not introduce Material, material, Style, symbolizer, layer, or scene concepts into Scratch core.
- Do not add dynamic offsets, vertex layout generation from `LayoutArtifact`, render graph scheduling, readback command changes, examples migration, or geo terrain/flow integration in this decision.
