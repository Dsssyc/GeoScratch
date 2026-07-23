# Scratch Submission Native Provenance Audit

Date: 2026-07-24
Decisions: ADR-035, ADR-046, ADR-049
Status: Current through Scratch attempt-local texture authority

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
  are independently acknowledged before submission. Attempt-local binding views,
  external imports, and bind groups are instead realized inside the selected
  command's submission observation and are never installed into persistent state.
- persistent render attachments use submission-scoped `attachment-view`
  observation. Their native views are recreated for each submission and are not
  retained by `PassSpec`.
- surface attachments validate complete private configuration snapshots before any
  encoder is created. One `AttemptTextureAuthority` shares each current native texture
  across selected attachment, binding, and copy uses. Acquisition and view creation
  run inside the owning `attachment-view` or `command-encode` issue. The managed
  `Surface.getCurrentTexture()` bypass no longer exists.
- raw runtime.device / runtime.queue calls remain outside Scratch provenance;
  this Goal does not monkey patch platform objects or infer ownership by time.

The two explicitly deferred convenience paths are preserved Goal-start behavior, not
unresolved source locations. They are reported as remaining native families for
a later clean-cut API decision rather than mislabeled as ADR-035 coverage.

## Native Call Inventory

| ID | Source call site | Native call | Declared owner or deferred path | Classification |
| --- | --- | --- | --- | --- |
| N1 | `packages/geoscratch/src/scratch/binding.ts:1149` | attempt-local binding `GPUTexture.createView()` | Realized only while encoding the selected draw or dispatch command. | Observed command |
| N2 | `packages/geoscratch/src/scratch/binding.ts:1172` | attempt-local `GPUDevice.createBindGroup()` | Same selected command owner; retained only by its attempt authority. | Observed command |
| N3 | `packages/geoscratch/src/scratch/binding.ts:1310` | persistent binding `GPUTexture.createView()` | `bind-set-preparation` candidate transaction; committed atomically with its bind group. | Independently acknowledged before submission |
| N4 | `packages/geoscratch/src/scratch/binding.ts:1347` | persistent `GPUDevice.createBindGroup()` | `bind-set-preparation` transaction; committed before submission. | Independently acknowledged before submission |
| N5 | `packages/geoscratch/src/scratch/command.ts:887` | render `setPipeline()` | `issuePassCommandEncoding()` on submission path; manual encode remains raw. | Observed command; manual encode deferred |
| N6 | `packages/geoscratch/src/scratch/command.ts:889` | `setViewport()` | Same pass-command owner. | Observed command; manual encode deferred |
| N7 | `packages/geoscratch/src/scratch/command.ts:897` | `setScissorRect()` | Same pass-command owner. | Observed command; manual encode deferred |
| N8 | `packages/geoscratch/src/scratch/command.ts:903` | `setBlendConstant()` | Same pass-command owner. | Observed command; manual encode deferred |
| N9 | `packages/geoscratch/src/scratch/command.ts:904` | `setStencilReference()` | Same pass-command owner. | Observed command; manual encode deferred |
| N10 | `packages/geoscratch/src/scratch/command.ts:906` | `setVertexBuffer()` | Same pass-command owner. | Observed command; manual encode deferred |
| N11 | `packages/geoscratch/src/scratch/command.ts:914` | `setIndexBuffer()` | Same pass-command owner. | Observed command; manual encode deferred |
| N12 | `packages/geoscratch/src/scratch/command.ts:930` | `drawIndexed()` | Same pass-command owner. | Observed command; manual encode deferred |
| N13 | `packages/geoscratch/src/scratch/command.ts:938` | `draw()` | Same pass-command owner. | Observed command; manual encode deferred |
| N14 | `packages/geoscratch/src/scratch/command.ts:945` | `drawIndirect()` | Same pass-command owner. | Observed command; manual encode deferred |
| N15 | `packages/geoscratch/src/scratch/command.ts:947` | `drawIndexedIndirect()` | Same pass-command owner. | Observed command; manual encode deferred |
| N16 | `packages/geoscratch/src/scratch/command.ts:1104` | `beginOcclusionQuery()` | Same pass-command owner. | Observed command; manual encode deferred |
| N17 | `packages/geoscratch/src/scratch/command.ts:1228` | `endOcclusionQuery()` | Same pass-command owner. | Observed command; manual encode deferred |
| N18 | `packages/geoscratch/src/scratch/command.ts:1410` | compute `setPipeline()` | Same pass-command owner. | Observed command; manual encode deferred |
| N19 | `packages/geoscratch/src/scratch/command.ts:1421` | `dispatchWorkgroupsIndirect()` | Same pass-command owner. | Observed command; manual encode deferred |
| N20 | `packages/geoscratch/src/scratch/command.ts:1426` | `dispatchWorkgroups()` | Same pass-command owner. | Observed command; manual encode deferred |
| N21 | `packages/geoscratch/src/scratch/command.ts:1938` | `setImmediates()` | Complete per-command snapshot selected by the submission. | Observed command |
| N22 | `packages/geoscratch/src/scratch/command.ts:2658` | `clearBuffer()` | `issueStandaloneCommandEncoding()` on submission path. | Observed command; manual encode deferred |
| N23 | `packages/geoscratch/src/scratch/command.ts:2925` | `copyBufferToBuffer()` | Same standalone-command owner. | Observed command; manual encode deferred |
| N24 | `packages/geoscratch/src/scratch/command.ts:2946` | `copyTextureToTexture()` | Same standalone-command owner. | Observed command; manual encode deferred |
| N25 | `packages/geoscratch/src/scratch/command.ts:2978` | `copyBufferToTexture()` | Same standalone-command owner. | Observed command; manual encode deferred |
| N26 | `packages/geoscratch/src/scratch/command.ts:3009` | `copyTextureToBuffer()` | Same standalone-command owner. | Observed command; manual encode deferred |
| N27 | `packages/geoscratch/src/scratch/command.ts:3331` | ordered-readback `copyBufferToBuffer()` | Ordered readback step is one standalone command location. | Observed command |
| N28 | `packages/geoscratch/src/scratch/command.ts:3891` | `resolveQuerySet()` | Resolve step is one standalone command location. | Observed command |
| N29 | `packages/geoscratch/src/scratch/command.ts:4312` | `GPUQueue.writeBuffer()` | Submission replay uses one `queue-action`; direct execution shares the call site. | Observed submission; direct execute deferred |
| N30 | `packages/geoscratch/src/scratch/command.ts:4319` | `GPUQueue.writeTexture()` | Same shared queue-action boundary. | Observed submission; direct execute deferred |
| N31 | `packages/geoscratch/src/scratch/command.ts:4775` | dynamic-offset `setBindGroup()` | Enclosed by the owning draw/dispatch command location. | Observed command; manual encode deferred |
| N32 | `packages/geoscratch/src/scratch/command.ts:4783` | static `setBindGroup()` | Enclosed by the owning draw/dispatch command location. | Observed command; manual encode deferred |
| N33 | `packages/geoscratch/src/scratch/command.ts:7916` | `copyExternalImageToTexture()` | Submission replay uses one `queue-action`; direct execution shares the call site. | Observed submission; direct execute deferred |
| N34 | `packages/geoscratch/src/scratch/readback.ts:483` | `createCommandEncoder()` | Direct-readback native observation, `encoder-create`. | Observed direct readback |
| N35 | `packages/geoscratch/src/scratch/readback.ts:485` | `copyBufferToBuffer()` | Direct-readback native observation, `command-encode`. | Observed direct readback |
| N36 | `packages/geoscratch/src/scratch/readback.ts:494` | `finish()` | Direct-readback native observation, `encoder-finish`. | Observed direct readback |
| N37 | `packages/geoscratch/src/scratch/readback.ts:498` | `queue.submit()` | Direct-readback native observation, `queue-submit`. | Observed direct readback |
| N38 | `packages/geoscratch/src/scratch/submission.ts:714` | `createCommandEncoder()` | Submission encoder-segment location, `encoder-create`. | Observed submission |
| N39 | `packages/geoscratch/src/scratch/submission.ts:737` | `finish()` | Submission encoder-segment location, `encoder-finish`. | Observed submission |
| N40 | `packages/geoscratch/src/scratch/submission.ts:894` | `beginComputePass()` | Compute pass location, `pass-begin`. | Observed submission |
| N41 | `packages/geoscratch/src/scratch/submission.ts:930` | compute pass `end()` | Compute pass location, `pass-end`. | Observed submission |
| N42 | `packages/geoscratch/src/scratch/submission.ts:966` | `beginRenderPass()` | Render pass location, `pass-begin`. | Observed submission |
| N43 | `packages/geoscratch/src/scratch/submission.ts:1030` | render pass `end()` | Render pass location, `pass-end`. | Observed submission |
| N44 | `packages/geoscratch/src/scratch/submission.ts:1060` | `queue.submit()` | Queue-action location with `command-buffer`, `queue-submit`. | Observed submission |
| N45 | `packages/geoscratch/src/scratch/submission.ts:1564` | `pushDebugGroup()` | Only inside finite detailed command observation. | Detailed observation only |
| N46 | `packages/geoscratch/src/scratch/submission.ts:1569` | `popDebugGroup()` | Balanced in `finally` inside the same detailed observation. | Detailed observation only |
| N47 | `packages/geoscratch/src/scratch/surface.ts:884` | `GPUCanvasContext.getConfiguration()` | Configuration commit and managed-use preflight compare native and private facts. | Deterministic Surface transaction/preflight |
| N48 | `packages/geoscratch/src/scratch/temporal-texture.ts:495` | `GPUDevice.importExternalTexture()` | Called only by an attempt authority reached from a selected command. | Observed command |
| N49 | `packages/geoscratch/src/scratch/temporal-texture.ts:619` | `GPUCanvasContext.getCurrentTexture()` | One authority acquisition shared across selected attachment and command uses. | Observed attachment or command |
| N50 | `packages/geoscratch/src/scratch/temporal-texture.ts:657` | shared attempt-local `GPUTexture.createView()` | One helper lowers selected Surface bindings, explicit lease attachments, and direct Surface attachment sugar. | Observed attachment or command |
| N51 | `packages/geoscratch/src/scratch/texture.ts:496` | persistent attachment `GPUTexture.createView()` | Called only inside the owning submission `attachment-view` issue. | Observed submission attachment |

Inventory totals:

- 51 source call sites, all classified.
- 9 calls physically owned by `submission.ts`.
- 26 command-encoder/pass calls reached through submission command wrappers.
- 3 shared queue-action calls observed in submission replay, with direct
  `execute(queue)` explicitly deferred.
- 4 direct-readback calls owned by the readback observation.
- 2 persistent binding calls independently acknowledged by BindSet preparation.
- 2 attempt-local binding calls owned by selected command observations.
- 3 temporal-texture calls owned by selected command or attachment observations:
  one external import, one shared current-texture acquisition, and one shared
  attempt-local view helper.
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
