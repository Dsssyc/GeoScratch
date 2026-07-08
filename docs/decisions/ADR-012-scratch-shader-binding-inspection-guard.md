# ADR-012: Scratch Shader Binding Inspection Guard

Status: Accepted
Date: 2026-07-08

## Context

Scratch now has explicit `Program`, `BindLayout`, `BindSet`, pipelines, commands, submissions, layout codecs, layout-aware uploads/readbacks, program layout requirements, and dynamic buffer offsets.

The remaining developer-safety gap is that WGSL resource declarations can drift from explicit bind layout entries. The vision docs require explicit bind layouts to stay authoritative, while shader inspection remains a helper that catches common mistakes without entering the submission hot path.

## Decision

Add `inspectShader(input, options?)` to both public entrypoints:

- `geoscratch`
- `geoscratch/scratch`

The helper accepts a WGSL module string, an array of module strings, or a `Program`. It returns a `ShaderInspection` object containing detected `ShaderBinding` records, parser diagnostics, a `ScratchDiagnosticReport`, and `compareBindLayouts(bindLayouts, options?)`.

The first scanner is intentionally conservative. It strips WGSL line and block comments, detects declarations with `@group(n)` and `@binding(m)`, supports either attribute order, and classifies the current supported binding families:

- `var<uniform>`
- `var<storage, read>`
- `var<storage, read_write>`
- `var<storage>`
- sampled textures such as `texture_2d<f32>`
- samplers such as `sampler` and `sampler_comparison`

Storage textures, external textures, and declarations the scanner cannot classify produce `SCRATCH_PROGRAM_SHADER_REFLECTION_INCONCLUSIVE` warning diagnostics. They are not treated as hard mismatch proof.

`compareBindLayouts` compares detected shader bindings against explicit `BindLayout` entries by group and binding. It returns warning diagnostics for:

- `SCRATCH_BIND_SHADER_INDEX_MISMATCH`
- `SCRATCH_BIND_SHADER_TYPE_MISMATCH`

Diagnostics use structured subjects and payloads:

- `BindLayoutEntry` for explicit entry-side findings
- `ShaderBinding` for shader-side findings
- `Program` in related context when the input or options provide one
- machine-readable `expected` and `actual` facts

Per-binding suppression is supported for intentional superset bind layouts.

## Consequences

Explicit `BindLayout` remains the runtime source of truth. Shader inspection does not create, mutate, or repair layouts, bind sets, programs, pipelines, commands, or submissions.

The helper can be used in tests, development tooling, examples, or user diagnostics without adding a runtime dependency on WGSL reflection.

Future work may add fuller WGSL parsing, stage visibility checks, bind layout suggestions, storage texture support, or external texture support. Those are separate public API decisions and should not be inferred from this guard.
