# ADR-007: Add Scratch LayoutCodec As A Preparation Artifact

## Status

Accepted

## Date

2026-07-08

## Context

The Scratch API vision defines `LayoutSpec -> LayoutArtifact -> LayoutCodec` as the shader/data boundary for CPU packing, upload byte ranges, readback interpretation, and generated WGSL accessor modules.

The existing Scratch TypeScript source already has runtime, resource, binding, pipeline, command, pass, submission, query, and readback primitives, but it did not yet expose a layout codec primitive. Callers still had to manually mirror WGSL field padding in JavaScript bytes when preparing uniform or storage buffer data.

## Decision

Add `LayoutCodec` and the `layoutCodec()` factory to Scratch core as runtime-independent preparation artifacts.

The codec lowers a struct-like `LayoutSpec` into a deterministic `LayoutArtifact` with field offsets, alignment, padding, byte length, stride, requested usages, usage compatibility, and a structural hash. It provides explicit CPU-side helpers for:

- packing logical values into GPU-aligned bytes,
- writing packed values into a caller-provided buffer,
- returning a contiguous upload byte view,
- creating readback views over returned bytes,
- generating WGSL struct/accessor modules.

The first supported field set is intentionally limited to WGSL host-shareable numeric shapes needed by current Scratch buffer workflows: `f32`, `i32`, `u32`, numeric vectors, `mat4x4f`, and fixed-size arrays of supported primitive field types.

Layout validation failures use the existing `ScratchDiagnostic` envelope with phase `layout-codec`. This keeps errors machine-readable and consistent with the rest of Scratch.

## Consequences

- `geoscratch` and `geoscratch/scratch` both expose the new public API.
- Scratch users can prepare upload bytes and readback values without hand-coding WGSL padding.
- Generated WGSL accessors remain explicit source modules that callers compose into `Program`; no shader mutation happens during submission.
- Future `Program` or buffer-layout compatibility checks can compare explicit `LayoutArtifact` metadata instead of parsing prose or inferring byte layouts from examples.

## Non-Goals

- Do not introduce `Material`, `Style`, symbolizer, layer, or scene-like terms into Scratch core.
- Do not make `Program` own concrete resources or per-object values.
- Do not make `BindSet` own shader source or execution counts.
- Do not generate layout or shader code in the submission hot path.
- Do not make shader reflection authoritative.
- Do not replace examples or add large demo data in this decision.
