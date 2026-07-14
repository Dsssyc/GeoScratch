# ADR-009: Validate Scratch Program Buffer Layout Requirements

## Status

Superseded in part by ADR-036. Program layout requirements remain accepted;
resource-global `BufferResource` layout and `structuralHash` compatibility are
superseded by `BufferRegion` witnesses plus `abiHash` and `schemaHash`.

## Date

2026-07-08

## Context

ADR-007 introduced `LayoutCodec` and `LayoutArtifact` as the explicit CPU/WGSL data
boundary. A `Program` can include generated WGSL accessors, so executable commands
need a mechanical way to prove that the selected binding interpretation matches the
accessor contract.

The Scratch API vision keeps `Program` as a shader contract and metadata object. It does not own concrete resources, bind sets, command counts, or submission behavior.

## Historical Decision (Partly Superseded)

The original decision correctly introduced explicit Program-side layout requirements,
but concrete validation was tied to one layout and one combined hash stored by the
whole buffer. ADR-036 removed that resource-global interpretation. This historical
rule no longer defines command validation.

## Current Replacement

The following Program-side contract remains accepted:

- `ProgramBufferLayoutRequirement`
- `ProgramDescriptor.layoutRequirements?: ProgramBufferLayoutRequirement[]`
- `Program.layoutRequirements`

Each requirement names a buffer binding by `group` and `binding`, optionally by
`name`, declares the required buffer binding type and shader stages, and carries the
authoritative `LayoutArtifact`.

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

`DrawCommand` and `DispatchCommand` construction validate the concrete binding view:

- the required bind set group must be supplied;
- the supplied bind set layout must already be compatible with the pipeline;
- the required binding must resolve to a `BufferRegion`;
- the region must carry a `LayoutArtifact` witness;
- the region witness must be physically ABI-compatible through `abiHash`;
- its semantic schema must match exactly through `schemaHash`;
- the parent buffer's ownership, lifecycle, usage, range, and effective dynamic offset
  must remain valid.

Layout-contract failures use `ScratchDiagnosticError` with code
`SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH` and phase `program`. Subjects identify the
shader binding contract, and related facts identify the Program, Pipeline, BindLayout,
BindSet, BufferRegion parent, and LayoutArtifact where useful.

ADR-036 is normative for concrete resource views and dual-hash compatibility.

## Consequences

- A Program can now declare the layout contract expected by generated WGSL accessors without owning concrete buffers.
- Pipeline creation catches mismatched `BindLayout` metadata before GPU pipeline creation.
- Command creation catches missing or mismatched concrete `BufferRegion` witnesses before encoding or submission.
- Programs without layout requirements remain valid.
- `geoscratch` and `geoscratch/scratch` expose the new public TypeScript type.

## Non-Goals

- Do not parse WGSL or make shader reflection authoritative.
- Do not auto-generate bind layouts from shader source.
- Do not make `Program` own concrete resources, bind sets, draw counts, or dispatch counts.
- Do not move Program-aware validation into `BindSet`, because plain bind sets only know their `BindLayout`.
- Do not introduce Material, material, Style, symbolizer, layer, or scene concepts into Scratch core.
- Do not generate vertex layouts from `LayoutArtifact` or add render graph, scheduler, geo, terrain, flow, or scene policy in this decision.
