# Scratch API Intelligent-Friendly Review

Status: Living temporary review
Date: 2026-07-06

This file tracks open design issues for the `scratch` API's "intelligent-friendly" goal: maximize locally-verifiable correctness while preserving direct GPU control. It is temporary in the sense that items should be revised, resolved, or replaced as the architecture matures. It is not a legacy archive.

Accepted vision still lives under `docs/vision/scratch-api/`. This review file is the working basis for follow-up design passes and should be updated whenever an item is resolved or a sharper issue appears.

## Recently Resolved

### GPU Operation Provenance And Fallible Allocation

Resolved direction:

- Public persistent buffer creation, texture creation, and texture replacement return ordinary Promises. Resource classes have no public constructor or static synchronous allocation bypass.
- Each covered attempt pushes OOM then validation, issues exactly one native allocation, pops validation then OOM before the first await, and classifies scope results without parsing native prose.
- Initial candidates remain pending facts and become live resources only after scoped acknowledgement. Replacement candidates remain private while the old allocation stays current; success commits once and failure leaves every old allocation fact unchanged.
- `runtime.diagnostics` separates an always-current fact graph, a bounded default recorder, immutable bounded incident reports, and explicit finite deep capture. It exports frozen JSON evidence and no mutable GPU handles.
- Default recording omits stacks, full descriptors, command payloads, and retained `SubmittedWork` values. Deep capture may add stacks/descriptors but stops by operation count, duration, evidence bytes, or explicit stop.
- OOM incidents identify the exact trigger operation while reporting other Scratch-owned allocations only as pressure contributors. Logical footprint is not physical VRAM, and non-Scratch browser/driver/system allocations remain unknown.
- Uncaptured errors coexist with application listeners and receive temporal or unknown attribution. Device loss freezes pending/current context without claiming the latest operation caused loss or that rollback restored usable resources.
- Internal staging allocation, samplers, query sets, bindings, pipelines, encoders, queue operations, mapping, and submission-level native attribution remain explicit deferred families.

This closes the first native asynchronous error-model slice without turning `SubmittedWork` history into a runtime log or adding instrumentation to the command hot path. See ADR-032 and `scratch-gpu-operation-provenance-audit.md`.

### Texture Allocation Replacement And Resize Invalidation

Resolved direction:

- `TextureResource.resize()` is the lasting Promise-returning resource-lifecycle primitive for size-only physical replacement behind stable logical identity.
- Construction snapshots the complete recreation descriptor, including immutable normalized size and materialized `viewFormats`; replacement follows create-before-swap failure atomicity.
- Concrete texture handles use private slots, reject field/prototype shadowing and subclass construction, and default optional dimensions only from `undefined`, never `null`.
- Changed resize keeps the old allocation current while a scoped candidate settles, then advances `allocationVersion` once, preserves `contentEpoch`, marks the replacement empty, clears allocation-scoped views, and destroys the old texture without a queue-completion wait.
- Bind sets derive views from their layout dimension; color/depth attachments select one 2D mip/layer and preflight it plus cross-attachment render extents/sample counts before encoder creation. Uploads, external-image uploads, every native texture copy direction, draw, and dispatch resolve or validate the current allocation at use time. Stable logical commands remain reusable; stale ranges and readiness still fail.
- Compatibility-mode bind preflight re-derives omitted `textureBindingViewDimension` per allocation (`2d` for one layer, `2d-array` for multiple); binding consumers that no longer match fail synchronously, while explicit compatible binding contracts and core-feature single-layer bindings remain reusable. Raw views and render attachments remain governed by texture-view and pass rules rather than this binding-only constraint.
- Surface coordination is explicit through `surface.resize(...)` followed by `await texture.resize(surface.size)`. Core owns no observer, size-provider closure, runtime texture scan, or hidden surface relationship.
- The deterministic `Texture Resize` browser proof reuses one logical texture, pass spec, bind set, and draw command, then verifies physical identity replacement, exact epochs, destruction, visible rendering, and exact padded readback bytes.

This closes the resize-invalidation gap without promoting surface policy or a second persistent logical view abstraction into Scratch core. See ADR-031 and `scratch-texture-resize-audit.md`.

### Physical Queue Timeline Ordering

Resolved in ADR-029 and the submission/transfer vision docs: `SubmissionBuilder.steps` now defines one physical queue order across queue-side buffer/texture uploads and encoder-backed copy, ordered readback staging, query resolve, compute, and render work. The discovered implementation gap was that immediate queue writes were enqueued before one final command-buffer submission even when an upload appeared later in the builder sequence.

Submission now resolves and validates first, prepares an internal discriminated queue-action timeline second, and replays it third. Queue uploads split only maximal contiguous encoder segments. The model rejects arbitrary queue callbacks, preserves one command buffer when there is no upload boundary, creates no fake command buffer for upload-only work, and uses already-resolved completion for effect-free work.

Coverage check for this pass:

- Buffer and texture upload leading, trailing, interleaved, consecutive, and alternating order: covered by `tests/scratch-submission-queue-order.test.js`.
- Segment coalescing and omission for skipped/effect-free passes: covered by `tests/scratch-submission-queue-order.test.js` and the existing readiness suite.
- Validation-before-queue-side-effect behavior in `throw`, `warn`, and `off` modes: covered by the focused queue-order suite and existing structured diagnostic tests.
- Upload live-data/queue preflight, package-internal lowering, and non-retryable partial replay with per-action effect commitment: covered by focused runtime and public type tests.
- Resource access, producer epoch, allocation version, and exactly-once upload epoch semantics: covered by the focused queue-order and submitted-work ledger suites.
- Ordered readback bytes, staging identity, epoch separation, and producer provenance across upload boundaries: covered by the focused queue-order and readback suites.
- Aggregate `SubmittedWork.commandBuffers` and `done` behavior for segmented, upload-only, and effect-free work: covered by the focused queue-order suite.
- Real WebGPU proof (`upload 0 -> +1 -> upload 10 -> +1 -> readback === 11`): covered by `examples/submissionOrder/` and browser verification.
- Architectural contract and future queue-side extension boundary: covered by ADR-029, `05-passes-submissions-scheduler`, and `07-transfers-epochs`.
- Final cross-representation and failure audit: covered by `docs/review/scratch-submission-queue-order-audit.md`.

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

### Readiness Absence As Observable Control Flow

Resolved in `docs/vision/scratch-api/02-resources/`, `04-pipelines-commands/`, and `05-passes-submissions-scheduler/`: expected missing Draw/Dispatch inputs now execute the declared `skip-command`, `skip-pass`, or `use-fallback` control flow instead of bypassing a diagnostic while encoding the original command. Submission resolves one immutable execution decision before encoder creation, and `SubmittedWork.executionOutcomes` records requested commands, attempted fallback chains, missing resource facts, and actual encoded commands.

Expected streaming absence is not a warning/error. Diagnostics remain reserved for invalid fallback contracts, hard readiness policy failures, pass incompatibility, ownership/lifecycle faults, and dependency epoch findings for the final selected command.

Coverage check for this pass:

- Draw/Dispatch discriminated readiness descriptor and immutable same-kind fallback: covered by `04-pipelines-commands` and ADR-028.
- One pre-encoder resolved plan and no second encoding-time decision path: covered by `05-passes-submissions-scheduler` and ADR-028.
- Transactional pass rollback across commands, attachments, timestamps, occlusion slots, and optional findings: covered by `05-passes-submissions-scheduler` and ADR-028.
- Immutable command/pass execution outcomes with requested/encoded IDs and missing facts: covered by `05-passes-submissions-scheduler` and `09-diagnostics-validation`.
- Execution/resource/producer ledger consistency: covered by the eight-row audit in `docs/review/scratch-readiness-policy-execution-audit.md`.
- Copy, Readback, and Resolve remain `throw`-only rather than inheriting undefined skip semantics: covered by `04-pipelines-commands` and ADR-028.

### Async Pipeline Acknowledgement And Compilation Provenance

Resolved in ADR-033 and the bilingual `01-runtime-surface`,
`04-pipelines-commands`, `08-programs-codecs`, and
`09-diagnostics-validation` modules: render and compute pipeline factories now
return ordinary Promises and use only native async pipeline creation. Scratch
publishes no pending wrapper and does not move compilation into command or
submission work.

Compilation information, the async pipeline result, supporting-object error
scopes, and lifecycle rechecks remain independent outcomes. A real Chrome
invalid-WGSL probe produced supporting-object validation, shader compilation,
and async pipeline validation evidence together. Scratch records all three and
does not select a primary cause from settlement order. Native message prose is
bounded and source-sanitized evidence only; `sourceExcerptRedacted` records
when Program-derived text was removed, while stable diagnostic codes come from
structural fields and transaction stages.

Coverage check for this pass:

- Promise-only render/compute factories and closed constructors: covered by ADR-033, public TypeScript tests, and render/compute transaction suites.
- Exact async native lowering, balanced validation/internal/OOM scopes, and pop-before-await ordering: covered by `pipeline-creation.ts` and controllable fake-GPU tests.
- Bounded UTF-16 compilation mapping without WGSL retention: covered by compilation/redaction tests, source-free incident/capture stress, and real Chrome invalid-WGSL evidence.
- Pending/current/disposed facts, private runtime ownership, and lifecycle subscriber cleanup: covered by the 64-cycle stress test and 5000-cycle benchmark.
- Submission hot-path exclusion: covered by the source audit and `scratch-async-pipeline-creation-docs.test.js`.
- Legacy top-level renderer calls remain classified rather than silently rewritten: covered by the AST consumer audit and async-pipeline audit.
- Real render/compute success, structured failure, zero uncaptured errors, and 11 nonblank regression examples: covered by the headed Chrome verifier.

## Current Review Items

### Readback Staging And Mapping Provenance

ADR-034 accepts the target contract. Implementation must still prove that
ordered staging is acknowledged before submission, direct staging is
acknowledged before copy issue, mapping uses a buffer-specific barrier, terminal
lifecycle races release every owner exactly once, schema-v3 evidence remains
bounded, and no native staging handle becomes public.

The TypeScript implementation and fake-GPU suites now cover both acknowledged
allocation boundaries, one shared scoped `mapAsync()` transaction, fixed-order
simultaneous outcomes, one materialization owner, consume/retain concurrency,
ordered sequential reuse, device-loss/cancel/dispose races, structured
mapped-range/host-copy/cleanup failures, immutable submitted links, and finite
current facts. Public and compatibility typechecks pass without a native
staging field or synchronous ordered factory. Keep this item open until the
20,000/5,000-cycle stress evidence, benchmark, native-call audit, headed-browser
matrix, and final source-parity review are complete.

## Update Rules

- Keep this file current when `docs/vision/scratch-api/` changes.
- Mark an item resolved only when the accepted vision docs contain the replacement contract.
- Add new items here when a review finds a design risk that should guide future architecture work.
- Do not treat old entries as archival truth; rewrite them when the design moves.
