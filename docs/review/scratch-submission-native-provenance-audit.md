# Scratch Submission Native Provenance Audit

Date: 2026-07-14
Decision: ADR-035
Status: Complete; fixed-baseline parity and strict review are recorded separately

## Audit Boundary

This inventory covers every current Scratch TypeScript call site that issues a
submission/direct-readback encoder, pass, command, finalization, queue, detailed
debug-label, or acknowledged persistent bind-group native call. The executable scanner
is `tests/scratch-submission-native-source-audit.test.js`.

The observation owner is a call-path fact, not a property of a native method:

- `SubmissionBuilder.submit()` wraps resolved command encoding and physical
  queue replay through `beginSubmissionNativeObservation()`.
- direct readback wraps its ephemeral copy encoder and submit through
  `beginReadbackNativeObservation()`.
- command encoding calls are inside `issueCommandEncoding()` when reached from
  a submission. A manual `encode(nativeEncoder)` remains explicitly deferred
  and has no Scratch submission provenance.
- queue writes share `writeUploadCommandQueueAction()`. The submission path is
  observed; direct `execute(queue)` remains explicitly deferred and retains only
  its existing synchronous validation/exception contract.
- BindSet preparation owns persistent binding-view and bind-group creation. Both
  are independently acknowledged before submission; command encoding only
  consumes the committed native objects and never creates or repairs them.
- persistent render attachments use submission-scoped `attachment-view`
  observation. Their native views are recreated for each submission and are not
  retained by `PassSpec`.
- surface attachments validate complete private configuration snapshots and create
  submission-scoped leases before any encoder is created. Current-texture acquisition
  and view creation then run inside the owning `attachment-view` issue; descriptor
  lowering consumes only the resulting native view. A direct public
  `Surface.getCurrentTexture()` call remains explicitly deferred and has no Scratch
  submission provenance.
- raw runtime.device / runtime.queue calls remain outside Scratch provenance;
  this Goal does not monkey patch platform objects or infer ownership by time.

The three explicitly deferred direct paths are preserved Goal-start behavior, not
unresolved source locations. They are reported as remaining native families for
a later clean-cut API decision rather than mislabeled as ADR-035 coverage.

## Native Call Inventory

| ID | Source call site | Native call | Declared owner or deferred path | Classification |
| --- | --- | --- | --- | --- |
| N1 | `packages/geoscratch/src/scratch/binding.ts:983` | persistent binding `GPUTexture.createView()` | `bind-set-preparation` candidate transaction; committed atomically with its bind group. | Independently acknowledged before submission |
| N2 | `packages/geoscratch/src/scratch/binding.ts:1020` | `GPUDevice.createBindGroup()` | `bind-set-preparation` transaction; committed before submission. | Independently acknowledged before submission |
| N3 | `packages/geoscratch/src/scratch/command.ts:762` | render `setPipeline()` | `issuePassCommandEncoding()` on submission path; manual encode remains raw. | Observed command; manual encode deferred |
| N4 | `packages/geoscratch/src/scratch/command.ts:767` | `setVertexBuffer()` | Same pass-command owner. | Observed command; manual encode deferred |
| N5 | `packages/geoscratch/src/scratch/command.ts:775` | `setIndexBuffer()` | Same pass-command owner. | Observed command; manual encode deferred |
| N6 | `packages/geoscratch/src/scratch/command.ts:783` | `drawIndexed()` | Same pass-command owner. | Observed command; manual encode deferred |
| N7 | `packages/geoscratch/src/scratch/command.ts:791` | `draw()` | Same pass-command owner. | Observed command; manual encode deferred |
| N8 | `packages/geoscratch/src/scratch/command.ts:798` | `drawIndirect()` | Same pass-command owner. | Observed command; manual encode deferred |
| N9 | `packages/geoscratch/src/scratch/command.ts:800` | `drawIndexedIndirect()` | Same pass-command owner. | Observed command; manual encode deferred |
| N10 | `packages/geoscratch/src/scratch/command.ts:957` | `beginOcclusionQuery()` | Same pass-command owner. | Observed command; manual encode deferred |
| N11 | `packages/geoscratch/src/scratch/command.ts:1081` | `endOcclusionQuery()` | Same pass-command owner. | Observed command; manual encode deferred |
| N12 | `packages/geoscratch/src/scratch/command.ts:1250` | compute `setPipeline()` | Same pass-command owner. | Observed command; manual encode deferred |
| N13 | `packages/geoscratch/src/scratch/command.ts:1255` | `dispatchWorkgroupsIndirect()` | Same pass-command owner. | Observed command; manual encode deferred |
| N14 | `packages/geoscratch/src/scratch/command.ts:1260` | `dispatchWorkgroups()` | Same pass-command owner. | Observed command; manual encode deferred |
| N15 | `packages/geoscratch/src/scratch/command.ts:1806` | `copyBufferToBuffer()` | `issueStandaloneCommandEncoding()` on submission path. | Observed command; manual encode deferred |
| N16 | `packages/geoscratch/src/scratch/command.ts:1827` | `copyTextureToTexture()` | Same standalone-command owner. | Observed command; manual encode deferred |
| N17 | `packages/geoscratch/src/scratch/command.ts:1856` | `copyBufferToTexture()` | Same standalone-command owner. | Observed command; manual encode deferred |
| N18 | `packages/geoscratch/src/scratch/command.ts:1884` | `copyTextureToBuffer()` | Same standalone-command owner. | Observed command; manual encode deferred |
| N19 | `packages/geoscratch/src/scratch/command.ts:2201` | ordered-readback `copyBufferToBuffer()` | Ordered readback step is one standalone command location. | Observed command; manual encode deferred |
| N20 | `packages/geoscratch/src/scratch/command.ts:2760` | `resolveQuerySet()` | Resolve step is one standalone command location. | Observed command; manual encode deferred |
| N21 | `packages/geoscratch/src/scratch/command.ts:3132` | `GPUQueue.writeBuffer()` | Submission replay uses one `queue-action`; direct upload execution shares this call site without an owner. | Observed submission; direct execute deferred |
| N22 | `packages/geoscratch/src/scratch/command.ts:3139` | `GPUQueue.writeTexture()` | Same shared queue-action boundary. | Observed submission; direct execute deferred |
| N23 | `packages/geoscratch/src/scratch/command.ts:3591` | dynamic-offset `setBindGroup()` | Enclosed by the owning draw/dispatch command location. | Observed command; manual encode deferred |
| N24 | `packages/geoscratch/src/scratch/command.ts:3599` | static `setBindGroup()` | Enclosed by the owning draw/dispatch command location. | Observed command; manual encode deferred |
| N25 | `packages/geoscratch/src/scratch/command.ts:6380` | `copyExternalImageToTexture()` | Submission replay uses one `queue-action`; direct execution shares this call site without an owner. | Observed submission; direct execute deferred |
| N26 | `packages/geoscratch/src/scratch/readback.ts:482` | `createCommandEncoder()` | Direct-readback native observation, `encoder-create`. | Observed direct readback |
| N27 | `packages/geoscratch/src/scratch/readback.ts:484` | `copyBufferToBuffer()` | Direct-readback native observation, `command-encode`. | Observed direct readback |
| N28 | `packages/geoscratch/src/scratch/readback.ts:493` | `finish()` | Direct-readback native observation, `encoder-finish`. | Observed direct readback |
| N29 | `packages/geoscratch/src/scratch/readback.ts:497` | `queue.submit()` | Direct-readback native observation, `queue-submit`. | Observed direct readback |
| N30 | `packages/geoscratch/src/scratch/submission.ts:637` | `createCommandEncoder()` | Submission encoder-segment location, `encoder-create`. | Observed submission |
| N31 | `packages/geoscratch/src/scratch/submission.ts:660` | `finish()` | Submission encoder-segment location, `encoder-finish`. | Observed submission |
| N32 | `packages/geoscratch/src/scratch/submission.ts:790` | `beginComputePass()` | Compute pass location, `pass-begin`. | Observed submission |
| N33 | `packages/geoscratch/src/scratch/submission.ts:816` | compute pass `end()` | Compute pass location, `pass-end`. | Observed submission |
| N34 | `packages/geoscratch/src/scratch/submission.ts:842` | `beginRenderPass()` | Render pass location, `pass-begin`. | Observed submission |
| N35 | `packages/geoscratch/src/scratch/submission.ts:893` | render pass `end()` | Render pass location, `pass-end`. | Observed submission |
| N36 | `packages/geoscratch/src/scratch/submission.ts:921` | `queue.submit()` | Queue-action location with `command-buffer`, `queue-submit`. | Observed submission |
| N37 | `packages/geoscratch/src/scratch/submission.ts:1287` | `pushDebugGroup()` | Only inside finite detailed command observation. | Detailed observation only |
| N38 | `packages/geoscratch/src/scratch/submission.ts:1292` | `popDebugGroup()` | Balanced in `finally` inside the same detailed command observation. | Detailed observation only |
| N39 | `packages/geoscratch/src/scratch/surface.ts:256` | public `GPUCanvasContext.getCurrentTexture()` | Direct public Surface borrowing validates private ownership/configuration first but has no submission observation owner. | Direct call deferred |
| N40 | `packages/geoscratch/src/scratch/surface.ts:353` | submission Surface `GPUTexture.createView()` | A prepared Surface lease is consumed only inside the owning submission `attachment-view` issue. | Observed submission attachment |
| N41 | `packages/geoscratch/src/scratch/surface.ts:353` | submission Surface `GPUCanvasContext.getCurrentTexture()` | Same prepared Surface attachment issue and configuration-version lease as N40. | Observed submission attachment |
| N42 | `packages/geoscratch/src/scratch/surface.ts:865` | `GPUCanvasContext.getConfiguration()` | Configuration commit observation and managed-use preflight compare the complete native configuration with private committed facts; submission creates every Surface lease before any encoder. | Deterministic Surface transaction/preflight |
| N43 | `packages/geoscratch/src/scratch/texture.ts:496` | persistent attachment `GPUTexture.createView()` | Called only inside the owning submission `attachment-view` issue with pass, slot, view, resource, and allocation facts. | Observed submission attachment |

Inventory totals:

- 43 source call sites, all classified.
- 9 calls physically owned by `submission.ts`.
- 20 command-encoder/pass calls reached through submission command wrappers.
- 3 shared queue-action calls observed in submission replay, with direct
  `execute(queue)` explicitly deferred.
- 4 direct-readback calls owned by the readback observation.
- 2 persistent binding calls independently acknowledged by BindSet preparation.
- 2 Surface current-texture acquisition/view calls are owned by submission
  `attachment-view` observation; one separate direct current-texture call remains deferred.
- 1 synchronous Surface configuration-inspection call serves configuration commit and
  managed-use preflight; every submission Surface lease is prepared before encoder effects.
- 1 submission-scoped persistent attachment view call observed per attachment slot.
- 0 unresolved or unknown source call sites.

## Attribution Limits

| Evidence | Strongest allowed claim | Forbidden upgrade |
| --- | --- | --- |
| Finite detailed scope around one discriminated location | `exact-location` | It does not prove one native call inside that location when several calls share the scope. |
| Default summary scope | `enclosing-submission-family` | Issued locations do not identify a unique command. |
| Queue completion rejection | `enclosing-submission-family` | It does not identify which replayed command or action failed. |
| Device loss or runtime disposal during observed work | `temporal-correlation` | Detailed mode cannot make a runtime-wide lifecycle event exact. |
| Device `uncapturederror` near an operation | `temporal-correlation` or `unknown` | Time proximity is not ownership. |
| Raw `runtime.device` / `runtime.queue` activity | `unknown` | It is never attached to a Scratch submission by inference. |

WebGPU retains at most one error per filter in one scope, so even detailed
capture does not claim exhaustive native outcomes. Native prose never upgrades
attribution or selects a stable diagnostic. OOM does not identify one command
or resource; it proves only that the enclosing observed family captured an OOM
error.

## Runtime And Browser Result

The executable source inventory, 20,000-summary/20,000-off stress run, eleven
benchmark profiles, and headed Chrome verifier all passed on 2026-07-13. The
performance record contains the exact machine, scope, timing, evidence-byte,
budget, ignored-Promise, finite-capture, and terminal-zero observations.

Chrome 150.0.7871.115 on Apple Metal 3 supplied two distinct proofs:

- A valid summary submission returned synchronously and non-thenably, resolved
  to frozen `observed-succeeded`, preserved ordered/direct bytes
  `[2, 4, 6, 8]`, and left no incident, uncaptured error, owner, subscriber, or
  resource behind.
- A valid Scratch render setup with a 4-byte uniform binding and shader-required
  16-byte uniform structure produced delayed validation. Detailed capture
  observed it at `encoder-finish` with an `encoder-segment` location, followed
  by validation at `queue-submit` for the command-buffer action. `done` rejected
  with the structured submission diagnostic, and both current epoch-1
  potential-write targets became `indeterminate`.

The Chrome result is deliberately not described as a unique draw-command cause.
This browser/device validated the undersized binding when the encoder was
finalized, so the strongest supported statement is the exact observed
`encoder-finish` operation inside its segment. There is no fabricated
`pass-command` outcome, and native prose did not select the primary diagnostic.
The error remained inside Scratch scopes: the probe recorded zero uncaptured,
console, page, or request failures.

The existing 11-page headed regression matrix and exact readback probe also
passed. All 11 canvases were nonblank under the existing pixel checks, and all
pages retained zero unexpected browser failures.

## Completion Link

Task 10 evidence is closed. The Goal-start `a69c79a` parity matrix now remains
as historical input to `scratch-persistent-binding-views-final-audit.md`, whose
current fixed-baseline runner supersedes the old standalone submission parity
runner. The verdict is not inferred from this source/runtime inventory.
