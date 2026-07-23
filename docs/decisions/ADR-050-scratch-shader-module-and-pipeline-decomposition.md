# ADR-050: Decompose Scratch Shader Modules And Pipelines

## Status

Proposed

## Date

2026-07-24

## Context

The current `Program.modules` model joins caller source parts into one native
shader module during pipeline creation. That prevents native module reuse,
cannot represent distinct vertex and fragment modules faithfully, ties
compilation evidence to a pipeline transaction, and obscures native
`layout: "auto"` and derived bind-group layouts.

The frozen WebGPU baseline exposes reusable `GPUShaderModule` objects,
per-stage module references and constants, optional compilation hints,
asynchronous pipeline factories, auto pipeline layout, and native
`getBindGroupLayout()`.

## Decision Boundary

Phase 2 will complete this ADR and clean-cut the old model. The accepted design
must establish:

- Promise-only `ScratchRuntime.createShaderModule()` acknowledgement;
- source-part composition, source hashes, and source-location mapping owned by
  `ShaderModule`;
- `Program` as a resource-free stage and requirement contract referencing
  one or more acknowledged ShaderModules;
- independent vertex, fragment, and compute stage descriptors;
- native ShaderModule reuse across multiple pipelines;
- explicit BindLayouts as the default pipeline layout mode;
- explicit opt-in native auto layout with opaque native-derived BindLayouts;
- compilation hints as optional performance facts without correctness claims;
- optional render fragment stage and an exact no-color-output descriptor; and
- removal of `Program.modules` and every old single-module pipeline
  assumption, without aliases.

Auto-derived layouts must preserve Runtime ownership and native identity while
reporting structurally that Scratch has less local validation evidence than
for an explicit BindLayout. Shader inspection remains advisory and must never
be described as the authority that authored a native layout.

## Rejected Directions

- Rejoining distinct source modules behind the public API.
- Recreating a ShaderModule for every pipeline.
- Restoring synchronous public pipeline factories.
- Inserting a dummy fragment shader for depth-only rendering.
- Treating shader reflection as a complete WGSL parser or layout authority.
- Keeping old Program or pipeline descriptors as compatibility overloads.

## Acceptance Evidence

The completed ADR requires tests for separate modules, reuse, compilation
hints, auto-derived layouts, explicit-layout defaults, fragmentless
depth/stencil behavior, structured native failures, type-level clean-cut
rejections, and a headed public-package browser proof.
