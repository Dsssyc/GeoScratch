# Scratch API Intelligent-Friendly Review

Status: Living temporary review
Date: 2026-07-06

This file tracks open design issues for the `scratch` API's "intelligent-friendly" goal: maximize locally-verifiable correctness while preserving direct GPU control. It is temporary in the sense that items should be revised, resolved, or replaced as the architecture matures. It is not a legacy archive.

Accepted vision still lives under `docs/vision/scratch-api/`. This review file is the working basis for follow-up design passes and should be updated whenever an item is resolved or a sharper issue appears.

## Recently Resolved

### Declarative Per-Command Immediate Data

Resolved in ADR-047 and the bilingual Runtime, Program/Codec, Command, Submission,
Transfer, and Diagnostic vision modules. Runtime capability facts, explicit Program
language requirements, immutable Pipeline ranges, stable Command source identities,
and per-occurrence submission snapshots now express the native
`immediate_address_space` path without inventing a Resource or exposing partial
encoder state.

This preserves the intelligent-friendly property tested by the application examples:
an agent can understand one Draw or Dispatch from its Pipeline and complete local
data source, without reconstructing previous `setImmediates()` calls. Frame-varying
values do not force graph reconstruction because source contents remain mutable
between submissions. Readiness/fallback resolution remains authoritative, and
diagnostics retain bounded metadata without retaining payloads.

The boundary is intentionally narrow: Scratch does not parse WGSL, infer immediate
size, expose callbacks, deduplicate state across commands, or claim complete
WebGPU/WGSL parity. See `scratch-immediate-data-audit.md`.

### Stable Commands And Submission-Step Current Content

Resolved in ADR-041 and the bilingual resource, command, submission, transfer, and diagnostic vision modules. DrawCommand and DispatchCommand now accept one closed read-epoch union: an exact non-negative number or `'current-at-step'`. The sentinel resolves only for the final selected command at its explicit submission position, after prior step effects and before its own writes. It does not add callbacks, aliases, command mutation, automatic ordering, retries, or transfer/query API drift.

Coverage check for this pass:

- Numeric exact stale/read-before-write behavior remains unchanged: covered by `tests/scratch-current-content-reads.test.js` and existing dependency suites.
- Throw/skip-command/skip-pass/fallback readiness, no-lookahead behavior, read-before-own-write ordering, validation modes, and indeterminate hard failure: covered by the focused current-content suite.
- Shader, vertex, index, and indirect reads use the same mode: covered by focused compute and fixed-function tests.
- Authored-vs-resolved immutable ledger facts and stable command/upload identities: covered by focused tests, the 20,000-submission fake-GPU stress proof, and the 120-frame headed Chrome proof.
- Public root and compatibility type surfaces reject aliases and callbacks: covered by `tests/types/public-api.ts`.

### GPU Operation Provenance And Fallible Allocation

Resolved direction:

- Public persistent buffer creation, texture creation, and texture replacement return ordinary Promises. Resource classes have no public constructor or static synchronous allocation bypass.
- Each covered attempt pushes OOM then validation, issues exactly one native allocation, pops validation then OOM before the first await, and classifies scope results without parsing native prose.
- Initial candidates remain pending facts and become live resources only after scoped acknowledgement. Replacement candidates remain private while the old allocation stays current; success commits once and failure leaves every old allocation fact unchanged.
- `runtime.diagnostics` separates an always-current fact graph, a bounded default recorder, immutable bounded incident reports, and explicit finite deep capture. It exports frozen JSON evidence and no mutable GPU handles.
- Default recording omits stacks, full descriptors, command payloads, and retained `SubmittedWork` values. Deep capture may add stacks/descriptors but stops by operation count, duration, evidence bytes, or explicit stop.
- OOM incidents identify the exact trigger operation while reporting other Scratch-owned allocations only as pressure contributors. Logical footprint is not physical VRAM, and non-Scratch browser/driver/system allocations remain unknown.
- Uncaptured errors coexist with application listeners and receive temporal or unknown attribution. Device loss freezes pending/current context without claiming the latest operation caused loss or that rollback restored usable resources.
- Historical phase statement (superseded): internal staging allocation, samplers, query sets, bindings, pipelines, encoders, queue operations, mapping, and submission-level native attribution were deferred by the first allocation-only slice.
- Current replacement: supporting-object and pipeline creation use acknowledged operations. Sampler, QuerySet, BindLayout, BindSet, and async pipeline candidates settle scoped native evidence before becoming public; submission and queue work use the bounded native-observation model. Mapping remains represented through explicit readback-operation lifecycles rather than a blanket claim over every browser-owned native action.

This closes the first native asynchronous error-model slice without turning `SubmittedWork` history into a runtime log or adding instrumentation to the command hot path. See ADR-032 and `scratch-gpu-operation-provenance-audit.md`.

### Texture Allocation Replacement And Resize Invalidation

Resolved direction:

- `TextureResource.resize()` is the lasting Promise-returning resource-lifecycle primitive for size-only physical replacement behind stable logical identity.
- Construction snapshots the complete recreation descriptor, including immutable normalized size and materialized `viewFormats`; replacement follows create-before-swap failure atomicity.
- Concrete texture handles use private slots, reject field/prototype shadowing and subclass construction, and default optional dimensions only from `undefined`, never `null`.
- Changed resize keeps the old allocation current while a scoped candidate settles, then advances `allocationVersion` once, preserves `contentEpoch`, marks the replacement empty, clears allocation-scoped views, and destroys the old texture without a queue-completion wait.
- Current replacement: persistent bindings use explicit `TextureViewSpec` values and acknowledged `BindSet.prepare()`. BindLayout dimensions remain explicit, prepared native views are allocation-scoped, replacement makes the BindSet stale, and submission never infers a new dimension or repairs the set. Color/depth attachments independently lower their logical views per submission and preflight current render extents, sample counts, usage, and overlap before native work.
- Uploads, external-image uploads, every native texture copy direction, draw, dispatch, and pass-owned query sets resolve or validate current-use lifecycle and allocation facts before native effects. Stable logical commands and pass specs remain reusable; stale or disposed dependencies still fail.
- Surface coordination is explicit through `surface.resize(...)` followed by `await texture.resize(surface.size)`. Core owns no observer, size-provider closure, runtime texture scan, or hidden surface relationship.
- The deterministic `Texture Resize` browser proof reuses one logical texture, pass spec, bind set, and draw command, then verifies physical identity replacement, exact epochs, destruction, visible rendering, and exact padded readback bytes.

This closes the resize-invalidation gap without promoting surface policy or native texture-view ownership into logical resources. See ADR-031, ADR-036, ADR-037, and `scratch-texture-resize-audit.md`.

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

Resolved in `docs/vision/scratch-api/05-passes-submissions-scheduler/`: scratch core now uses `Submission` rather than `Frame` as the single submission model. The design separates `SubmissionBuilder` from `SubmittedWork`, uses `submitted.nativeOutcome` for immutable native evidence and `submitted.done` for the joined native-observation/queue-completion boundary, and treats presentation as one submission mode rather than the definition of the core type.

Coverage check for this pass:

- `Frame` is no longer the scratch core submission type: covered by `05-passes-submissions-scheduler`, `00-overview`, and `07-transfers-epochs`.
- `SubmissionBuilder` / `SubmittedWork` split: covered by `05-passes-submissions-scheduler` and the scratch-api module index.
- `SubmittedWork` is not thenable; native evidence uses `submitted.nativeOutcome`, and the joined native-observation/queue-completion boundary uses `submitted.done`: covered by `05-passes-submissions-scheduler` and `07-transfers-epochs`.
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

### Readback Staging And Mapping Provenance

Resolved in ADR-034, the bilingual runtime/submission/transfer/diagnostic vision
modules, and the TypeScript implementation:

- Direct and ordered readbacks use one internal staging-allocation transaction.
  Direct allocation is acknowledged before copy issue; the Promise-only ordered
  factory acknowledges one reusable slot before command visibility.
- Both paths use one scoped `mapAsync()` transaction as the buffer-specific host
  availability barrier. Fixed-order native outcomes, lifecycle races, cleanup,
  one materialization owner, and consume/retain concurrency are explicit.
- Pending operations, logical staging bytes, retained host bytes, and active
  mappings are always-current bounded facts. The current schema-v5
  operation/incident history remains separately bounded, serializable,
  source-free, and handle-free; ADR-038 cleanly replaced schema v4 after
  supporting-object targets and preparation operations became necessary.
- Final fixed-baseline parity preserved 12/12 original JavaScript behaviors and
  16/16 Goal-start TypeScript behaviors; 10/10 intentional ADR-034 replacements
  are explicit rather than disguised as compatibility.
- Strict re-review closed pending-budget provenance, per-link queue-completion
  incidents, active-mapping lifetime accounting, and disposed-command historical
  result reachability. A second pass found no remaining required issue.
- The 20,000/5,000-cycle stress runner, seven-profile benchmark, exact native-call
  audit, headed real-WebGPU readback probe, and 11-page browser matrix pass.

This closes the buffer readback staging and mapping provenance slice without a
synchronous factory, public staging handle, CPU roundtrip, unbounded ledger, or
schema-v2 compatibility path. Texture readback, mapped leases, and broader
native-operation provenance remain explicit future slices rather than hidden
partial implementations.

### Hello GAW Application Lifetime And Source-Blind Failure Localization

Resolved at the example boundary by ADR-043 and the Hello GAW failure-evidence audit.
The migrated workload exposed an application responsibility that the Scratch kernel
must not hide: runtime-owned GPU objects, page-owned decoded image sources, browser
listeners, scheduled frame work, and issued observation Promises do not share one
native owner. Hello GAW now creates one local authority before initialization and
orders stop, observation settlement, external release, and runtime disposal explicitly.

This real rendering workload confirms where the intelligent-friendly design helped:

- `ScratchRuntime` provides one transitive disposal boundary, so the page does not
  need to reconstruct or duplicate the GPU resource graph.
- Promise-returning factories make every acquisition boundary explicit enough to
  register ownership immediately after settlement.
- `SubmittedWork.nativeOutcome` and `done` give the page a concrete terminal barrier;
  the after-submit proof records pending `1 -> 0` before runtime disposal.
- Public `isDisposed` facts let the verifier observe runtime and Surface lifecycle
  independently from application counters.
- The unified diagnostic envelope, incident outcomes, bounded recorder, source-free
  compilation report, and finite capture identify a failed Bloom-combine pipeline,
  Program, module, and shader-compilation outcome without parsing console prose.
- Immutable JSON evidence gives browser automation and an Agent the same inspectable
  facts, while the verifier emits only a compact summary rather than feeding the full
  runtime ledger into ordinary context.

The exercise also sharpens two limits. Scratch cannot infer ownership of
`ImageBitmap`, listeners, or frame scheduling, so application lifecycle authority is
still required. Also, a real invalid WGSL operation may produce several independent
native outcomes; an Agent must inspect structured `incident.outcomes` rather than
treating the top-level multiple-failure code or first outcome as a selected root cause.
This is evidence preservation, not ambiguity introduced by Scratch.

The bounded five-scenario proof closes the specific Hello GAW initialization leak. It
does not justify a generic disposable stack in Scratch core, automatic lifecycle
repair, OOM attribution, device-loss recovery, or an unbounded always-on trace.

### DEM Layer Persistent Graph And Application-Owned LoD

The DEM Layer clean cut is a closer rendering-business test than a synthetic API
probe: MapLibre camera state drives CPU terrain traversal, six changing GPU inputs,
two dependent render passes, and native indirect draws. The implementation keeps 42
Scratch identities stable across camera changes and Surface resize; a frame creates
only a `SubmissionBuilder` and bounded observation bookkeeping. Browser facts recompute
the complete 13-resource/11-upload/layout/BindSet/Program/pipeline/pass/command identity
inventory instead of comparing a construction-time hash to itself.

The following current contracts materially reduced ambiguity for the implementation
and for an Agent reviewing it:

- `LayoutCodec` owns uniform alignment and packing, so camera, tile, and static
  records are updated through named fields rather than repeated byte-offset arithmetic.
- Stable `UploadCommand` objects retain typed-array source identity. Mutating those
  arrays makes CPU-selected instance counts explicit data, while stable indirect
  `DrawCommand` objects keep command shape immutable.
- `contentEpoch: 'current-at-step'`, `SubmittedWork.resourceAccesses`, and producer
  facts prove the exact node-level, node-box, indirect-argument, and LoD-map chains.
  The terrain pass can therefore explain which earlier step produced every consumed
  epoch without a CPU readback or console inference.
- Explicit BindLayouts, Programs, pipelines, PassSpecs, and commands make persistent
  graph identity auditable. Surface and depth allocation replacement is separate from
  graph reconstruction, and stale BindSet preparation is inspected only after resize.
  Real native validation also exposed the old wrapper's implicit depth default, which
  the current terrain pipeline now states as depth-write plus `less` comparison.
- Promise-only pipeline creation, structured diagnostics, bounded deep capture, and
  source-sanitized evidence localize the deterministic invalid-terrain-WGSL failure
  without retaining shader source or parsing browser console prose.
- Runtime transitive ownership and separate `SubmittedWork.nativeOutcome` / `done`
  observations provide a finite GPU cleanup boundary without claiming ownership of
  MapLibre, ImageBitmap, listeners, or frame scheduling.

The exercise also identifies responsibilities that correctly remain above Scratch.
The CPU LoD selector owns terrain bounds, subdivision policy, the 5,000-node cap, and
serializable selection facts. The map host owns camera interpretation and the normal
basemap. The page lifecycle owns decoded-image transfer, coalesced render scheduling,
listener removal, late async settlement, and cleanup order. It tracks the finite page
initialization and each full render/resize task, and registers issued native work before
provenance validation may fail. Visual parity still requires a headed browser and pixel
evidence; Scratch's logical provenance cannot decide whether an application chose the
right terrain policy or camera matrix.

The remaining friction is explicit rather than hidden. The application still needs
substantial proof wiring to publish compact graph, selection, lifecycle, and pixel
facts. WGSL storage bindings required six mechanical read-only access corrections
before native validation accepted the preserved shaders; the migration also had to
delete unreachable palette declarations, an uncalled color map, and commented styling
paths rather than carrying them forward as false parity. Neither fact warrants a
DEM-specific core abstraction, an automatic render graph, a generic lifecycle stack,
or CPU-dynamic command closures. The useful result is that Scratch exposes enough
stable facts for the application to prove its own policy and ownership decisions.

## Resolved Review Items

### Submission Native Outcome And Content Truth

Implementation and bilingual contract are now present for the ADR-035 core:

- `SubmissionBuilder.submit()` remains synchronous and physically ordered;
  default summary scopes are constant-size, off mode is explicitly unobserved,
  per-location detail exists only in finite capture, and readback ownership
  claims complete before observation scopes.
- `SubmittedWork.nativeOutcome` is immutable and always resolving, the preflight
  report remains historical, and `done` joins native observation with queue
  completion plus lifecycle until that completion settles, without waiting for
  readback mapping or host copy. Lifecycle attribution remains temporal.
- Delayed native or queue failure marks only still-current persistent potential
  writes indeterminate, including a successfully replayed prefix when a later
  action throws. Epochs never roll back, later acknowledged epochs are guarded,
  all reads hard-fail before native effects, and Surface presentation output is
  excluded.
- Direct readback observes copy issue independently from mapping; ordered
  readback gates bytes on the associated submission outcome without converting
  queue-completion rejection into mapping failure. Direct readback rejects an
  indeterminate source before staging allocation.

The schema-v5 implementation, unit/type gates, bilingual contract, ordinary
example migration, complete native-call inventory, long-run scope/budget
evidence, real delayed-validation Chrome evidence, fixed-baseline parity, and
the strict re-review are now recorded. The submission slice remains resolved by ADR-035; its
diagnostic envelope is now governed by ADR-038, and current fixed-baseline evidence
is recorded in `scratch-persistent-binding-views-final-audit.md`.

## Update Rules

- Keep this file current when `docs/vision/scratch-api/` changes.
- Mark an item resolved only when the accepted vision docs contain the replacement contract.
- Add new items here when a review finds a design risk that should guide future architecture work.
- Do not treat old entries as archival truth; rewrite them when the design moves.
