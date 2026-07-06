# Scratch API Intelligent-Friendly Review

Status: Living temporary review
Date: 2026-07-06

This file tracks open design issues for the `scratch` API's "intelligent-friendly" goal: maximize locally-verifiable correctness while preserving direct GPU control. It is temporary in the sense that items should be revised, resolved, or replaced as the architecture matures. It is not a legacy archive.

Accepted vision still lives under `docs/vision/scratch-api/`. This review file is the working basis for follow-up design passes and should be updated whenever an item is resolved or a sharper issue appears.

## Recently Resolved

### Readback Version Semantics

Resolved in `docs/vision/scratch-api/07-transfers-epochs/`: resource identity, physical allocation changes, and content changes are now separate concepts. `allocationVersion` covers physical GPU object replacement and binding invalidation. `contentEpoch` covers bytes/texels produced by upload, copy, render, compute, clear, resolve, or mip generation. Readback now creates an explicit `ReadbackOperation`; `toArray()` / `toBytes()` live on that operation, not on `Resource`.

The accepted vision also removes core `resource.write()` sugar. CPU-to-GPU writes are explicit upload commands or higher-level helpers that lower to explicit uploads.

Coverage check for this pass:

- Resource is identity/state, not a transfer handle: covered by `02-resources` and `07-transfers-epochs`.
- `allocationVersion` vs `contentEpoch`: covered by `02-resources`, `03-bindings`, `04-pipelines-commands`, and `07-transfers-epochs`.
- Upload, readback, copy, render writes, compute writes, clear, resolve, and mip generation as content producers: covered by `07-transfers-epochs`.
- Rendering resources, including attachment writes, depth/stencil, surface current textures, resize invalidation, and temporal history textures: covered by `07-transfers-epochs`.
- No core `resource.toArray()` / `resource.toBytes()` / `resource.write()` sugar: covered by `02-resources` and `07-transfers-epochs`.
- Future-agent routing: covered by `AGENTS.md` and the `scratch-api` module index.

### Pending Readback Lifecycle

Resolved in `docs/vision/scratch-api/07-transfers-epochs/`: stale readback detection is defined over runtime-owned `ReadbackOperation` objects, not over whether a JavaScript `Promise` was awaited. The vision now defines the target operation state machine, consume-on-read default behavior, explicit retention, mapped-view leases, `cancel()` / `dispose()` semantics, staging budgets, and readback-specific diagnostic codes.

Coverage check for this pass:

- Promise await detection is explicitly rejected as the core contract: covered by `07-transfers-epochs`.
- Runtime-owned operation states from `requested` through `disposed`: covered by `07-transfers-epochs`.
- Default consume-on-read and explicit `retain: 'until-dispose'`: covered by `07-transfers-epochs`.
- Zero-copy mapped views use an explicit lease with disposal: covered by `07-transfers-epochs`.
- `cancel()` and `dispose()` semantics: covered by `07-transfers-epochs`.
- Readback retention budgets and no hidden eviction by default: covered by `07-transfers-epochs`.
- Machine-readable readback diagnostics with operation/source/epoch/age/byte context: covered by `07-transfers-epochs`.

### Submission Naming And Mental Model

Resolved in `docs/vision/scratch-api/05-passes-submissions-scheduler/`: scratch core now uses `Submission` rather than `Frame` as the single submission model. The design separates `SubmissionBuilder` from `SubmittedWork`, uses `submitted.done` for GPU completion, and treats presentation as one submission mode rather than the definition of the core type.

Coverage check for this pass:

- `Frame` is no longer the scratch core submission type: covered by `05-passes-submissions-scheduler`, `00-overview`, and `07-transfers-epochs`.
- `SubmissionBuilder` / `SubmittedWork` split: covered by `05-passes-submissions-scheduler` and the scratch-api module index.
- `SubmittedWork` is not thenable; GPU completion uses `submitted.done`: covered by `05-passes-submissions-scheduler` and `07-transfers-epochs`.
- Presentation is a submission mode, not the core concept: covered by `01-runtime-surface`, `05-passes-submissions-scheduler`, `07-transfers-epochs`, and `scratch-graphics-kernel.md`.
- `FrameContext` / `FrameValidationMode` are renamed to `SubmissionContext` / `SubmissionValidationMode`: covered by `04-pipelines-commands` and `05-passes-submissions-scheduler`.

### QuerySet Scope

Resolved in `docs/vision/scratch-api/07-transfers-epochs/`: scratch core keeps the WebGPU-compatible `QuerySet` name but defines it as indexed query slots, not an unordered collection. Core query types are limited to `timestamp` and `occlusion`. Timestamp queries are feature-gated by `timestamp-query`, occlusion queries are render-pass-scoped, query results are resolved into buffers and then read through `ReadbackOperation`, and pipeline statistics remain outside the core model.

Coverage check for this pass:

- `QuerySetResource` is indexed slots, not an unordered set: covered by `02-resources` and `07-transfers-epochs`.
- Core query types are `timestamp | occlusion`: covered by `02-resources` and `07-transfers-epochs`.
- Timestamp feature gating and pass-level `timestampWrites`: covered by `05-passes-submissions-scheduler` and `07-transfers-epochs`.
- Render-pass-only occlusion query set and begin/end brackets: covered by `04-pipelines-commands`, `05-passes-submissions-scheduler`, and `07-transfers-epochs`.
- Explicit `resolveQuerySet` into a buffer before readback: covered by `04-pipelines-commands` and `07-transfers-epochs`.
- Query-specific diagnostics and pipeline statistics non-goal: covered by `07-transfers-epochs`.

### Program, Layout Codec, And Material Boundary

Resolved in `docs/vision/scratch-api/08-programs-codecs/`: shader authoring is split into `LayoutSpec`, `LayoutArtifact`, `LayoutCodec`, `Program`, `Pipeline`, `BindSet`, `Command`, and `Submission`. Layout codec output connects CPU packing, upload byte views, readback views, and generated WGSL accessors. `Material` is explicitly excluded from scratch core because it couples program, data, render semantics, and scene assignment.

Coverage check for this pass:

- CPU array to GPU-aligned buffer path: covered by `02-resources` and `08-programs-codecs`.
- Layout artifact and codec split: covered by `02-resources` and `08-programs-codecs`.
- Generated WGSL accessor modules plus user WGSL compose into `Program`: covered by `08-programs-codecs`.
- `Program` / `Pipeline` / `BindSet` / `Command` responsibilities stay separate: covered by `04-pipelines-commands` and `08-programs-codecs`.
- No `Material` / `Style` / material-like scratch core term: covered by `00-overview`, `03-bindings`, `04-pipelines-commands`, `08-programs-codecs`, and `scratch-graphics-kernel.md`.
- Build-time or runtime-initialization code generation is allowed, but submission hot paths consume explicit artifacts: covered by `08-programs-codecs`.

### Validation Diagnostic Schema

Resolved in `docs/vision/scratch-api/09-diagnostics-validation/`: scratch diagnostics are now a machine-readable API contract, not prose-only logs or ad-hoc exception strings. The vision defines one `ScratchDiagnostic` envelope across runtime, resource, layout-codec, program, binding, pipeline, command, submission, query, and readback phases. It also defines diagnostic report shape, validation mode disposition, code naming and stability rules, structured subject/related/expected/actual payloads, and explicit repair suggestions that tooling may use without scratch silently applying fixes.

Coverage check for this pass:

- Unified `ScratchDiagnostic` envelope and `ScratchDiagnosticReport`: covered by `09-diagnostics-validation`.
- Validation phases across runtime/resource/layout/program/bind/pipeline/command/submission/query/readback: covered by `09-diagnostics-validation`.
- Query/readback codes lifted into the shared envelope instead of separate shapes: covered by `07-transfers-epochs` and `09-diagnostics-validation`.
- Submission validation reports and structured diagnostic errors: covered by `05-passes-submissions-scheduler` and `09-diagnostics-validation`.
- Program/layout codec diagnostics using structured subjects: covered by `08-programs-codecs` and `09-diagnostics-validation`.
- Repair suggestions are advisory and must not create hidden auto-repair behavior: covered by `06-design-review` and `09-diagnostics-validation`.

## Current Review Items

None. The current intelligent-friendly scratch API review queue is complete. Add new items here when a later pass finds a sharper design risk.

## Update Rules

- Keep this file current when `docs/vision/scratch-api/` changes.
- Mark an item resolved only when the accepted vision docs contain the replacement contract.
- Add new items here when a review finds a design risk that should guide future architecture work.
- Do not treat old entries as archival truth; rewrite them when the design moves.
