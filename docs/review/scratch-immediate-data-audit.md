# Scratch Immediate Data Native Parity Audit

Status: verified; this document is the final audit commit payload
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
| WGSL feature inventory | `GPU.wgslLanguageFeatures` is a readonly setlike of automatically enabled language-extension names. | Runtime snapshots, deduplicates, sorts, and freezes a string array; missing platform field becomes empty. | Runtime construction and immutability tests; public type evidence; docs. | verified |
| Program language requirements | WGSL `requires` documents extension use and shader creation fails when an extension is unavailable. | Explicit `requiredLanguageFeatures`; no source parsing or rewriting; distinct from device `requiredFeatures`. | Invalid iterable/value, unavailable feature, mutation, and transaction snapshot tests. | verified |
| Immediate address space | `immediate_address_space` enables read-only module-scope `var<immediate>`; one entry point statically accesses at most one immediate variable. | Program source remains caller-authored; Pipeline declares the byte range; Program declares capability. | Browser shader compilation plus Program/Pipeline tests and docs. | verified |
| Store-type restriction | Immediate store type is host-shareable and constructible, excluding arrays and structures containing array members. | Raw bytes retain native freedom; LayoutCodec marks current non-array shapes compatible and arrays incompatible. | Codec compatibility and rejection tests. | verified |
| Device limit | `maxImmediateSize` is the maximum byte size, with CRD default 64. | Pipeline rejects values above the Runtime device limit before native issue. | Boundary and missing/invalid limit tests. | verified |
| Pipeline layout range | `immediateSize` defaults to 0, is a `GPUSize32`, is four-byte aligned, and does not exceed the device limit. | Shared render/compute normalizer; immutable Pipeline fact; exact native descriptor lowering. | Render and compute descriptor, invalid size, lifecycle, and public type tests. | verified |
| Pipeline layout equality | Pipeline layouts are equivalent only when bind-group layouts and immediate sizes are equal. | Pipeline compatibility/identity facts include `immediateSize`. | Equality and command/pipeline mismatch tests. | verified |
| Pipeline shader requirement | A pipeline layout range must be at least the immediate variable's required size. | Scratch validates declared size and capability deterministically; native shader validation remains authoritative for source/type size. | Too-small native validation attribution and browser evidence; docs state the limit. | verified |
| BufferSource copy | Native `setImmediates()` copies AllowSharedBufferSource bytes on the content timeline. | Each actual submission step copies the source into a private Uint8Array before native effects. | ArrayBuffer, TypedArray, DataView, SharedArrayBuffer, mutation, and current-attempt isolation tests. | verified |
| Byte semantics | Native TypedArray offsets use elements while ArrayBuffer/DataView offsets use bytes. | Scratch accepts a complete visible view and always interprets it as bytes; no public offset/size overload. | Typed-view subrange and exact-length tests. | verified |
| Accessible slots | Every 4-byte slot intersecting accessible bytes must be initialized before draw/dispatch. | Every nonzero command issues one `setImmediates(0, completeSnapshot)` call. | Full-range call count/order and independent consecutive-command tests. | verified |
| Render commands | Immediate state persists natively and can otherwise affect later draws. | Every actual Draw owns complete immediate data; no inheritance or dedupe. | Direct/indexed/indirect render tests. | verified |
| Compute commands | Immediate state persists natively and can otherwise affect later dispatches. | Every actual Dispatch owns complete immediate data; no inheritance or dedupe. | Direct/indirect compute tests. | verified |
| Readiness resolution | Native API has no Scratch readiness/fallback policy. | Snapshot only the final executable command after fallback/skip/pass rollback resolution. | skip-command, skip-pass, fallback, and repeated-step tests. | verified |
| Native error ownership | Validation is asynchronous and belongs to the active pass/submission encoder. | Existing submission observation remains the sole owner; command-encode location records exact selected Command. | Synchronous throw, scoped validation, device loss, and no-side-effect tests. | verified |
| Resource independence | Immediate bytes are encoder state, not a GPUBuffer binding or queue transfer. | No Resource, allocation version, content epoch, resource ledger, or upload action. | SubmittedWork and epoch regression tests. | verified |
| Payload retention | The specification requires byte copying for execution, not unbounded diagnostic retention. | Default facts retain metadata only; no payload bytes, values, hashes, source, or handles. | Capture/export/diagnostic redaction tests. | verified |
| Neutral example | Both render and compute pass encoders inherit the binding commands mixin. | `examples/immediateData/` proves compute then render with stable graph identity and mutable sources. | Build, headed browser facts, resize, nonblank pixels, and zero-error evidence. | verified |

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

### Recorded Browser Result

The headed gate passed on its first and only attempt. No retry was used.

- Browser: Google Chrome 150.0.7871.130.
- Adapter: Apple, `metal-3`; `navigator.gpu.wgslLanguageFeatures` contained
  `immediate_address_space`; adapter `maxImmediateSize` was 64.
- Before resize: status `ready`, resize generation 1, 767 submitted and observed
  submissions, compute immediate value `[0.2633,0.5716,0.801,1]`, two independent
  render values, stable graph identity, resolved compute-to-render dependency, and
  visible source mutation.
- After resize to 1280 by 720: status remained `ready`, resize generation advanced
  to 2, submitted and observed counts both reached 3049, and compute/render values
  continued changing without rebuilding Program, Pipeline, BindSet, Command, or
  PassSpec identities.
- Both screenshots contained two distinct rendered triangles. FFmpeg signal
  statistics reported luma ranges 23 through 125 before resize and 23 through 154
  after resize, excluding blank output.
- Playwright reported zero console warnings and errors. Every counted submission
  completed both `nativeOutcome` and `done`, and the page never published an error
  status, covering scoped validation, rejected completion, and device-loss paths.

## Latest Draft Cross-Check

The 2026-07-23 editor drafts were checked after implementation. They retain the
contract used here:

- `GPUSupportedLimits.maxImmediateSize` defaults to 64 and bounds
  `GPUPipelineLayoutDescriptor.immediateSize`;
- pipeline-layout immediate size is four-byte aligned and participates in layout
  equivalence;
- `setImmediates()` copies the supplied BufferSource on the content timeline,
  requires four-byte write granularity, and initializes encoder slots;
- draw/dispatch validation requires all WGSL `AccessibleSlots` to have been set;
- WGSL still limits an immediate variable to host-shareable constructible
  non-array-containing types, at most one statically accessed variable per entry
  point, and a required size no larger than the pipeline layout range.

Scratch's one complete per-occurrence snapshot remains a stricter compositional
contract over the native partial-update state machine. No latest-draft fact requires
scope expansion or a compatibility workaround.

## Independent Review And Correction

Exactly one independent review was performed against
`7d0b60c06c4b64699af293638f8bebf30b2cd98a..38c8f35`. It found four issues:

1. Immediate LayoutUploadView ranges were incorrectly constrained to the visible
   `bytes` subview instead of the established `bytes.buffer` range.
2. Repeated LayoutUploadView accessor reads could leak a raw exception.
3. Program and Pipeline diagnostics omitted required Runtime and numeric constraint
   facts.
4. The too-small shader-required immediate range had no explicit native-attribution
   regression.

The single concentrated correction at `739232c` resolved all four:

- one guarded construction-time materialization now reads the four LayoutUploadView
  fields exactly once and uses the explicit range inside backing storage;
- Runtime subjects and authored/normalized size, alignment, GPUSize32, and device
  limit facts are machine-readable;
- a caller-authored `var<immediate>` compute shader with a 16-byte store type and a
  4-byte pipeline range proves that Scratch does not invent source-size validation
  and attributes a deterministically injected native validation rejection to
  pipeline creation; the headed browser separately proves the valid native path;
- range, accessor, limit-boundary, missing/invalid-limit, and diagnostic regressions
  were added, and the native-call provenance inventory was resynchronized.

The correction checkpoint passed 1004 tests with 2 opt-in browser tests pending,
the complete TypeScript gate, and `git diff --check`.

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

The bounded headed browser gate, exactly one independent review, and the single
allowed correction are complete. This document is the sole payload planned for the
final audit commit.

## Final Sequential Gates

The final fixed-order run passed after all implementation, correction, documentation,
and audit edits were complete:

1. `npm test`: passed with 1004 passing and 2 opt-in browser gates pending.
2. `npm run typecheck`: passed package build, public API typecheck, examples
   typecheck, and canonical WebGPU declaration typecheck.
3. `npm run build`: passed package and production examples builds, including
   `dist/examples/immediateData/index.html`.
4. `git diff --check`: passed.
5. `git status --short`: reported only this audit document before the final audit
   commit.

No implementation change follows this gate record.
