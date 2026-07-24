# Scratch Submission Native Provenance Audit

Date: 2026-07-24
Decisions: ADR-035, ADR-046, ADR-049, ADR-050, ADR-051
Status: Current through Scratch RenderBundle and public debug commands

## Audit Boundary

This inventory covers every current Scratch TypeScript call site selected by
`tests/scratch-submission-native-source-audit.test.js`: submission and direct
readback encoders, pass and command issue, RenderBundle creation/execution,
debug commands, finalization, queue operations, temporal textures, attachment
views, and acknowledged BindSet preparation.

The observation owner is a call-path fact, not a property inferred from a
native method:

- `SubmissionBuilder.submit()` wraps resolved native issue and queue replay
  through `beginSubmissionNativeObservation()`.
- direct readback owns its ephemeral encoder, copy, finish, and submit through
  `beginReadbackNativeObservation()`.
- persistent RenderBundle creation is independently acknowledged before submission;
  attempt-local bundle creation belongs to the selected submission command.
- command lowering is observed when reached through submission or bundle
  creation. A manual `encode(nativeEncoder)` remains explicitly deferred.
- queue uploads share one lowering function. Submission replay is observed;
  direct `execute(queue)` remains explicitly deferred.
- BindSet preparation owns persistent binding-view and bind-group creation.
  Attempt-local views and bind groups instead belong to the selected
  submission command.
- one `AttemptTextureAuthority` owns selected external imports and current
  Surface texture acquisition for a submission.
- raw runtime.device / runtime.queue calls remain outside Scratch provenance;
  Scratch does not monkey patch platform objects or infer ownership by time.

## Native Call Inventory

| ID | Source call site | Native call | Declared owner or deferred path | Classification |
| --- | --- | --- | --- | --- |
| N1 | `packages/geoscratch/src/scratch/binding.ts:1149` | `GPUTexture.createView()` | Selected attempt-local binding command. | Observed command |
| N2 | `packages/geoscratch/src/scratch/binding.ts:1172` | `GPUDevice.createBindGroup()` | Selected attempt-local binding command. | Observed command |
| N3 | `packages/geoscratch/src/scratch/binding.ts:1310` | `GPUTexture.createView()` | Persistent BindSet preparation transaction. | Independently acknowledged |
| N4 | `packages/geoscratch/src/scratch/binding.ts:1347` | `GPUDevice.createBindGroup()` | Persistent BindSet preparation transaction. | Independently acknowledged |
| N5 | `packages/geoscratch/src/scratch/command.ts:887` | render `setPipeline()` | Draw pass-command lowering. | Observed submission; manual encode deferred |
| N6 | `packages/geoscratch/src/scratch/command.ts:889` | `setViewport()` | Draw pass-command lowering. | Observed submission; manual encode deferred |
| N7 | `packages/geoscratch/src/scratch/command.ts:897` | `setScissorRect()` | Draw pass-command lowering. | Observed submission; manual encode deferred |
| N8 | `packages/geoscratch/src/scratch/command.ts:903` | `setBlendConstant()` | Draw pass-command lowering. | Observed submission; manual encode deferred |
| N9 | `packages/geoscratch/src/scratch/command.ts:904` | `setStencilReference()` | Draw pass-command lowering. | Observed submission; manual encode deferred |
| N10 | `packages/geoscratch/src/scratch/command.ts:932` | bundle `setPipeline()` | Persistent bundle transaction or attempt-local submission. | Acknowledged or observed |
| N11 | `packages/geoscratch/src/scratch/command.ts:944` | `setVertexBuffer()` | Shared Draw/BundleDraw lowering. | Acknowledged or observed; manual encode deferred |
| N12 | `packages/geoscratch/src/scratch/command.ts:952` | `setIndexBuffer()` | Shared Draw/BundleDraw lowering. | Acknowledged or observed; manual encode deferred |
| N13 | `packages/geoscratch/src/scratch/command.ts:968` | `drawIndexed()` | Shared Draw/BundleDraw lowering. | Acknowledged or observed; manual encode deferred |
| N14 | `packages/geoscratch/src/scratch/command.ts:976` | `draw()` | Shared Draw/BundleDraw lowering. | Acknowledged or observed; manual encode deferred |
| N15 | `packages/geoscratch/src/scratch/command.ts:983` | `drawIndirect()` | Shared Draw/BundleDraw lowering. | Acknowledged or observed; manual encode deferred |
| N16 | `packages/geoscratch/src/scratch/command.ts:985` | `drawIndexedIndirect()` | Shared Draw/BundleDraw lowering. | Acknowledged or observed; manual encode deferred |
| N17 | `packages/geoscratch/src/scratch/command.ts:1131` | `beginOcclusionQuery()` | Render pass-command location. | Observed submission; manual encode deferred |
| N18 | `packages/geoscratch/src/scratch/command.ts:1255` | `endOcclusionQuery()` | Render pass-command location. | Observed submission; manual encode deferred |
| N19 | `packages/geoscratch/src/scratch/command.ts:1437` | compute `setPipeline()` | Dispatch pass-command lowering. | Observed submission; manual encode deferred |
| N20 | `packages/geoscratch/src/scratch/command.ts:1448` | `dispatchWorkgroupsIndirect()` | Dispatch pass-command lowering. | Observed submission; manual encode deferred |
| N21 | `packages/geoscratch/src/scratch/command.ts:1453` | `dispatchWorkgroups()` | Dispatch pass-command lowering. | Observed submission; manual encode deferred |
| N22 | `packages/geoscratch/src/scratch/command.ts:1965` | `setImmediates()` | Selected Draw, Dispatch, or BundleDraw snapshot. | Acknowledged or observed |
| N23 | `packages/geoscratch/src/scratch/command.ts:2685` | `clearBuffer()` | Standalone submission command. | Observed submission; manual encode deferred |
| N24 | `packages/geoscratch/src/scratch/command.ts:2952` | `copyBufferToBuffer()` | Standalone copy command. | Observed submission; manual encode deferred |
| N25 | `packages/geoscratch/src/scratch/command.ts:2973` | `copyTextureToTexture()` | Standalone copy command. | Observed submission; manual encode deferred |
| N26 | `packages/geoscratch/src/scratch/command.ts:3005` | `copyBufferToTexture()` | Standalone copy command. | Observed submission; manual encode deferred |
| N27 | `packages/geoscratch/src/scratch/command.ts:3036` | `copyTextureToBuffer()` | Standalone copy command. | Observed submission; manual encode deferred |
| N28 | `packages/geoscratch/src/scratch/command.ts:3358` | ordered-readback `copyBufferToBuffer()` | Ordered readback command location. | Observed submission |
| N29 | `packages/geoscratch/src/scratch/command.ts:3918` | `resolveQuerySet()` | Resolve command location. | Observed submission |
| N30 | `packages/geoscratch/src/scratch/command.ts:4339` | `GPUQueue.writeBuffer()` | Shared upload lowering. | Observed submission; direct execute deferred |
| N31 | `packages/geoscratch/src/scratch/command.ts:4346` | `GPUQueue.writeTexture()` | Shared upload lowering. | Observed submission; direct execute deferred |
| N32 | `packages/geoscratch/src/scratch/command.ts:4802` | dynamic-offset `setBindGroup()` | Selected Draw/Dispatch/BundleDraw command. | Acknowledged or observed; manual encode deferred |
| N33 | `packages/geoscratch/src/scratch/command.ts:4810` | static `setBindGroup()` | Selected Draw/Dispatch/BundleDraw command. | Acknowledged or observed; manual encode deferred |
| N34 | `packages/geoscratch/src/scratch/command.ts:7943` | `copyExternalImageToTexture()` | Shared external-image upload lowering. | Observed submission; direct execute deferred |
| N35 | `packages/geoscratch/src/scratch/debug-command.ts:120` | `pushDebugGroup()` | Enclosing command, pass, or bundle owner. | Acknowledged or observed; manual encode deferred |
| N36 | `packages/geoscratch/src/scratch/debug-command.ts:127` | `popDebugGroup()` | Same balanced native encoder scope. | Acknowledged or observed; manual encode deferred |
| N37 | `packages/geoscratch/src/scratch/debug-command.ts:133` | `insertDebugMarker()` | Enclosing command, pass, or bundle owner. | Acknowledged or observed; manual encode deferred |
| N38 | `packages/geoscratch/src/scratch/readback.ts:483` | `createCommandEncoder()` | Direct readback `encoder-create`. | Observed direct readback |
| N39 | `packages/geoscratch/src/scratch/readback.ts:485` | `copyBufferToBuffer()` | Direct readback `command-encode`. | Observed direct readback |
| N40 | `packages/geoscratch/src/scratch/readback.ts:494` | `finish()` | Direct readback `encoder-finish`. | Observed direct readback |
| N41 | `packages/geoscratch/src/scratch/readback.ts:498` | `queue.submit()` | Direct readback `queue-submit`. | Observed direct readback |
| N42 | `packages/geoscratch/src/scratch/render-bundle.ts:623` | `executeBundles()` | ExecuteRenderBundles pass-command location. | Observed submission |
| N43 | `packages/geoscratch/src/scratch/render-bundle.ts:965` | `createRenderBundleEncoder()` | Persistent creation or selected attempt-local realization. | Acknowledged or observed |
| N44 | `packages/geoscratch/src/scratch/render-bundle.ts:987` | bundle `finish()` | Same bundle realization owner. | Acknowledged or observed |
| N45 | `packages/geoscratch/src/scratch/submission.ts:787` | `createCommandEncoder()` | Encoder-segment `encoder-create`. | Observed submission |
| N46 | `packages/geoscratch/src/scratch/submission.ts:823` | `finish()` | Encoder-segment `encoder-finish`. | Observed submission |
| N47 | `packages/geoscratch/src/scratch/submission.ts:993` | `beginComputePass()` | Compute pass `pass-begin`. | Observed submission |
| N48 | `packages/geoscratch/src/scratch/submission.ts:1042` | compute pass `end()` | Compute pass `pass-end`. | Observed submission |
| N49 | `packages/geoscratch/src/scratch/submission.ts:1078` | `beginRenderPass()` | Render pass `pass-begin`. | Observed submission |
| N50 | `packages/geoscratch/src/scratch/submission.ts:1226` | render pass `end()` | Render pass `pass-end`. | Observed submission |
| N51 | `packages/geoscratch/src/scratch/submission.ts:1256` | `queue.submit()` | Command-buffer queue action. | Observed submission |
| N52 | `packages/geoscratch/src/scratch/submission.ts:1789` | detailed `pushDebugGroup()` | Finite per-location diagnostic scope. | Detailed observation only |
| N53 | `packages/geoscratch/src/scratch/submission.ts:1794` | detailed `popDebugGroup()` | Balanced in `finally` for the same location. | Detailed observation only |
| N54 | `packages/geoscratch/src/scratch/surface.ts:884` | `getConfiguration()` | Surface configuration commit and managed preflight. | Deterministic transaction/preflight |
| N55 | `packages/geoscratch/src/scratch/temporal-texture.ts:495` | `importExternalTexture()` | Selected attempt authority command. | Observed command |
| N56 | `packages/geoscratch/src/scratch/temporal-texture.ts:619` | `getCurrentTexture()` | Shared selected Surface attempt. | Observed attachment or command |
| N57 | `packages/geoscratch/src/scratch/temporal-texture.ts:657` | attempt-local `createView()` | Shared selected Surface attempt. | Observed attachment or command |
| N58 | `packages/geoscratch/src/scratch/texture.ts:496` | persistent attachment `createView()` | Submission attachment-view location. | Observed submission |

Inventory totals:

- 58 source call sites, all classified.
- File distribution: binding 4, command 30, debug command 3, direct readback
  4, RenderBundle 3, submission 9, Surface 1, temporal texture 3, texture 1.
- Persistent BindSet and RenderBundle creation have independent acknowledged
  operation owners; attempt-local forms remain inside submission ownership.
- The only deferred managed-object convenience paths are explicit manual
  command encoding and direct queue upload execution.
- 0 unresolved or unknown source call sites.

## Attribution Limits

| Evidence | Strongest allowed claim | Forbidden upgrade |
| --- | --- | --- |
| Finite detailed scope around one discriminated location | `exact-location` | It does not prove one native call when several calls share the location. |
| Default summary scope | `enclosing-submission-family` | Issued locations do not identify a unique command. |
| Persistent supporting-object transaction | `exact-operation` | It does not identify one native call inside that operation. |
| Queue completion rejection | `enclosing-submission-family` | It does not identify which replayed action failed. |
| Device loss or Runtime disposal | `temporal-correlation` | Detailed mode cannot make a Runtime-wide event exact. |
| Nearby uncaptured error | `temporal-correlation` or `unknown` | Time proximity is not ownership. |
| Raw Runtime device or queue activity | `unknown` | It is never attached to Scratch work by inference. |

WebGPU retains at most one error per filter in one scope, so detailed capture
does not claim exhaustive native outcomes. Native prose never upgrades
attribution or selects a stable diagnostic. OOM does not identify one command
or resource; it proves only that the enclosing observed family captured an OOM
error.

## Historical Runtime And Browser Result

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

The Goal-start `a69c79a` parity matrix remains historical input to the current
fixed-baseline audit. This evidence is not reinterpreted as proof of the
RenderBundle and public debug-command paths added later.

## Current Verification Boundary

The Phase 3 Node and type evidence covers native bundle creation/execution,
empty execution state clearing, persistent and attempt-local ownership,
immediate and dependency snapshots, resource epochs, all four debug encoder
families, balanced scopes, structured native failures, and bounded reuse.

The prior headed Chrome result remains historical evidence for the older
submission observation model. RenderBundle and public debug-command browser
proof is intentionally not claimed here; it belongs to the single consolidated
Phase 6 browser verifier.

## Completion Link

This inventory is a living input to
`scratch-webgpu-wgsl-managed-parity-audit.md`. Final completion still requires
all seven capability families, the scoped WGSL type family, the consolidated
browser and stress gates, and the one allowed independent review.
