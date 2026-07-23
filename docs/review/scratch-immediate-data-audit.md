# Scratch Immediate Data Native Parity Audit

Status: implementation complete through Phase 4; final audit and browser gate pending
Date: 2026-07-23
Baseline: `7d0b60c06c4b64699af293638f8bebf30b2cd98a`
Decision: ADR-047
WebGPU source: Candidate Recommendation Draft, 14 July 2026
WGSL source: Candidate Recommendation Draft, 16 July 2026

## Fixed Scope

This audit is the bounded acceptance matrix for Runtime WGSL language-feature facts,
Program language-feature requirements, render and compute pipeline immediate ranges,
per-command immediate data, per-submission snapshots, native `setImmediates()`
lowering, LayoutCodec immediate compatibility, diagnostics, and one neutral consumer
example.

Later editor-draft additions are follow-up facts. RenderBundle, GPUExternalTexture,
public debug markers, partial immediate updates, tracked callback values, and broader
LayoutCodec type support cannot add work to this matrix.

## Fixed Specification Sources

The fixed local source copies are:

- WebGPU CRD 2026-07-14, SHA-256
  `23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30`;
- WGSL CRD 2026-07-16, SHA-256
  `2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa`.

The installed canonical declaration provider is `@webgpu/types` 0.1.71. It already
declares `GPU.wgslLanguageFeatures`,
`GPUSupportedLimits.maxImmediateSize`,
`GPUPipelineLayoutDescriptor.immediateSize`, and
`GPUBindingCommandsMixin.setImmediates()`. Scratch must not add duplicate global
declarations.

## Normative Matrix

| Capability | Normative WebGPU/WGSL fact | Fixed Scratch contract | Required evidence | Status |
| --- | --- | --- | --- | --- |
| WGSL feature inventory | `GPU.wgslLanguageFeatures` is a readonly setlike of automatically enabled language-extension names. | Runtime snapshots, deduplicates, sorts, and freezes a string array; missing platform field becomes empty. | Runtime construction and immutability tests; public type evidence; docs. | pending |
| Program language requirements | WGSL `requires` documents extension use and shader creation fails when an extension is unavailable. | Explicit `requiredLanguageFeatures`; no source parsing or rewriting; distinct from device `requiredFeatures`. | Invalid iterable/value, unavailable feature, mutation, and transaction snapshot tests. | pending |
| Immediate address space | `immediate_address_space` enables read-only module-scope `var<immediate>`; one entry point statically accesses at most one immediate variable. | Program source remains caller-authored; Pipeline declares the byte range; Program declares capability. | Browser shader compilation plus Program/Pipeline tests and docs. | pending |
| Store-type restriction | Immediate store type is host-shareable and constructible, excluding arrays and structures containing array members. | Raw bytes retain native freedom; LayoutCodec marks current non-array shapes compatible and arrays incompatible. | Codec compatibility and rejection tests. | pending |
| Device limit | `maxImmediateSize` is the maximum byte size, with CRD default 64. | Pipeline rejects values above the Runtime device limit before native issue. | Boundary and missing/invalid limit tests. | pending |
| Pipeline layout range | `immediateSize` defaults to 0, is a `GPUSize32`, is four-byte aligned, and does not exceed the device limit. | Shared render/compute normalizer; immutable Pipeline fact; exact native descriptor lowering. | Render and compute descriptor, invalid size, lifecycle, and public type tests. | pending |
| Pipeline layout equality | Pipeline layouts are equivalent only when bind-group layouts and immediate sizes are equal. | Pipeline compatibility/identity facts include `immediateSize`. | Equality and command/pipeline mismatch tests. | pending |
| Pipeline shader requirement | A pipeline layout range must be at least the immediate variable's required size. | Scratch validates declared size and capability deterministically; native shader validation remains authoritative for source/type size. | Too-small native validation attribution and browser evidence; docs state the limit. | pending |
| BufferSource copy | Native `setImmediates()` copies AllowSharedBufferSource bytes on the content timeline. | Each actual submission step copies the source into a private Uint8Array before native effects. | ArrayBuffer, TypedArray, DataView, SharedArrayBuffer, mutation, and current-attempt isolation tests. | pending |
| Byte semantics | Native TypedArray offsets use elements while ArrayBuffer/DataView offsets use bytes. | Scratch accepts a complete visible view and always interprets it as bytes; no public offset/size overload. | Typed-view subrange and exact-length tests. | pending |
| Accessible slots | Every 4-byte slot intersecting accessible bytes must be initialized before draw/dispatch. | Every nonzero command issues one `setImmediates(0, completeSnapshot)` call. | Full-range call count/order and independent consecutive-command tests. | pending |
| Render commands | Immediate state persists natively and can otherwise affect later draws. | Every actual Draw owns complete immediate data; no inheritance or dedupe. | Direct/indexed/indirect render tests. | pending |
| Compute commands | Immediate state persists natively and can otherwise affect later dispatches. | Every actual Dispatch owns complete immediate data; no inheritance or dedupe. | Direct/indirect compute tests. | pending |
| Readiness resolution | Native API has no Scratch readiness/fallback policy. | Snapshot only the final executable command after fallback/skip/pass rollback resolution. | skip-command, skip-pass, fallback, and repeated-step tests. | pending |
| Native error ownership | Validation is asynchronous and belongs to the active pass/submission encoder. | Existing submission observation remains the sole owner; command-encode location records exact selected Command. | Synchronous throw, scoped validation, device loss, and no-side-effect tests. | pending |
| Resource independence | Immediate bytes are encoder state, not a GPUBuffer binding or queue transfer. | No Resource, allocation version, content epoch, resource ledger, or upload action. | SubmittedWork and epoch regression tests. | pending |
| Payload retention | The specification requires byte copying for execution, not unbounded diagnostic retention. | Default facts retain metadata only; no payload bytes, values, hashes, source, or handles. | Capture/export/diagnostic redaction tests. | pending |
| Neutral example | Both render and compute pass encoders inherit the binding commands mixin. | `examples/immediateData/` proves compute then render with stable graph identity and mutable sources. | Build, headed browser facts, resize, nonblank pixels, and zero-error evidence. | pending |

## Diagnostic Matrix

| Invalid fact | Primary code | Required structured facts |
| --- | --- | --- |
| Program language feature unavailable or malformed | `SCRATCH_PROGRAM_LANGUAGE_FEATURE_UNAVAILABLE` | Program/runtime ids, requested and available names |
| Pipeline immediate size invalid | `SCRATCH_PIPELINE_IMMEDIATE_SIZE_INVALID` | Pipeline kind, authored/normalized size, alignment, GPUSize32 and device limit |
| Command immediate source missing, forbidden, wrong-sized, detached, resized, forged, or layout-incompatible | `SCRATCH_COMMAND_IMMEDIATE_DATA_INVALID` | Command/pipeline ids, source kind, visible and expected byte lengths, optional layout hashes |
| Layout immediate incompatibility | Existing LayoutCodec structured code | Layout hash, incompatible field path/type, immediate usage |
| Native synchronous or scoped failure | Existing submission native-observation code | Selected command id and command-encode location, without payload |

Structural Program, Pipeline, and Command errors remain hard in every submission
validation mode. They are not optional dependency findings.

## Snapshot And Lowering Invariants

1. Readiness, fallback, skip-command, and skip-pass resolution completes first.
2. Only final executable Draw/Dispatch steps materialize immediate sources.
3. Every source is copied exactly once per actual step before any native effect.
4. All other preflight completes before encoder creation or queue replay.
5. Zero-size Pipelines issue no native immediate call.
6. Every nonzero actual command issues exactly one full-range call at offset zero.
7. Native call order follows ADR-047 for render and compute.
8. No cross-command state reuse or deduplication is observable.
9. No immediate payload enters diagnostics, captures, exports, SubmittedWork resource
   facts, or content epochs.

## Browser Acceptance Facts

The bounded browser verifier must record:

- browser version and adapter identity;
- `navigator.gpu.wgslLanguageFeatures` containing `immediate_address_space`;
- adapter `maxImmediateSize`;
- successful compute and render immediate values;
- at least two DrawCommand values that remain independent;
- stable Program, Pipeline, BindSet, Command, and PassSpec identity;
- source mutation becoming visible in the next submission;
- resize generation and nonblank output before and after resize;
- observed submission count;
- page errors, unhandled rejections, console/WebGPU validation errors, uncaptured
  errors, and device loss.

The browser gate may run at most twice, with a second attempt allowed only for a
documented browser, desktop, or harness interruption.

## Explicit Follow-Ups

- RenderBundle and `executeBundles()`.
- GPUExternalTexture and external-frame lifetime.
- Public debug markers.
- Partial immediate range updates or cross-command deduplication.
- WGSL source parsing or automatic `requires` injection.
- Program required limits.
- `buffer_view` and broader LayoutCodec types.
- Mapped buffer leases and direct texture readback.
- Complete WebGPU or WGSL parity.

## Completion Record

Phase 1 fixed ADR-047 and this matrix at commit `2a17ce8`. Phase 2 added Runtime,
Program, and render/compute Pipeline contracts at `f0eef3a`. Phase 3 added
per-occurrence snapshots, readiness/fallback behavior, complete native lowering, and
command-level native attribution at `6a55905`.

Phase 4 now includes LayoutCodec immediate compatibility, public TypeScript routing,
the neutral `examples/immediateData/` consumer, and synchronized bilingual vision
material. The example uses caller-authored `requires immediate_address_space;` and
`var<immediate>`, stable compute/render Pipelines, BindSets, Commands, and PassSpecs,
one compute-to-render Resource dependency, and mutable CPU sources.

The matrix remains pending until the fixed sequential final gates, bounded headed
browser evidence, exactly one independent review, at most one concentrated
correction, and one final audit commit are complete.
