# ADR-008: Integrate Scratch LayoutArtifact With Buffers And Uploads

## Status

Superseded by ADR-036.

## Date

2026-07-08

## Context

ADR-007 introduced `LayoutCodec` as a runtime-independent preparation artifact for
GPU-aligned upload bytes, readback views, and WGSL accessors. This ADR originally
attached one optional interpretation directly to each buffer. ADR-036 later replaced
that one-to-one model with explicit many-to-many resource views.

## Historical Decision (Superseded)

The superseded implementation made a `BufferResource` carry one layout, one element
count, and one layout byte range. Upload validation compared a single combined hash
owned by the buffer. Those public fields, their descriptor inputs, and that combined
hash were removed by ADR-036. This historical section is not a usable API contract.

## Current Replacement

`BufferResource` is a raw container. Interpretation belongs to immutable
`BufferRegion` values:

- `buffer.region()` selects a byte range and may carry one `LayoutArtifact` witness.
- One buffer may expose multiple typed or raw, overlapping or disjoint regions.
- One layout may be used by regions from multiple buffers.
- Layout identity is split into physical `abiHash` and semantic `schemaHash`.
- Layout-aware uploads target a `BufferRegion`; byte range, ABI, and schema checks are
  performed against that region rather than global buffer metadata.
- Raw uploads remain explicit and certify no semantic schema.

ADR-036 is the normative resource/layout decision.

## Consequences

- Buffer allocation is independent from interpretation and remains reusable across
  multiple data models.
- Upload and readback range ownership is explicit through `BufferRegion`.
- Program and command validation compare region witnesses without mutating resources.
- No compatibility alias restores resource-global layout fields.

## Non-Goals

- Do not make `LayoutCodec` an upload command factory.
- Do not add `BufferResource.write()`, `BufferResource.toArray()`, or `BufferResource.toBytes()`.
- Do not add render graph, scheduler, examples migration, geo layer changes, or material/style/layer concepts to scratch core.
