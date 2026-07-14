# Passes, Submissions, And Scheduler

Status: Vision draft
Date: 2026-07-12

## Decision

Use persistent `PassSpec` objects for stable pass shape. Use `Submission` as the core GPU-kernel submission model that binds pass specs to the current command lists.

The old `Frame` name is removed from the scratch core model. A frame is an application or presentation cadence; a submission is work sent toward the GPU queue. A submission may present to a surface, or it may be compute-only/offscreen.

The first scheduler model is explicit submission order plus dependency validation. Automatic sorting or render-graph scheduling can be built later as an upper orchestration mode.

## PassSpec

`PassSpec` describes stable encoder boundaries, attachment shape, and pass-level instrumentation such as timestamp writes or occlusion query-set ownership.

Render pass spec example:

```ts
const scenePass = runtime.createRenderPass({
    label: 'scene',
    color: [
        {
            target: sceneColor.view(),
            load: 'clear',
            store: 'store',
            clear: [0, 0, 0, 1],
        },
    ],
    depth: {
        target: depthTexture.view({ aspect: 'depth-only' }),
        depthLoad: 'clear',
        depthStore: 'store',
        depthClear: 1,
    },
    occlusionQuerySet: visibilityQueries,
    timestampWrites: {
        querySet: renderTiming,
        begin: 0,
        end: 1,
    },
})
```

Compute pass spec example:

```ts
const simulationPass = runtime.createComputePass({
    label: 'simulation',
    timestampWrites: {
        querySet: simulationTiming,
        begin: 0,
        end: 1,
    },
})
```

`timestampWrites` lower to WebGPU pass descriptor timestamp writes and require a `timestamp` query set. `occlusionQuerySet` is render-pass-only and requires an `occlusion` query set. Query result transfer is not implicit in pass specs; resolve and readback remain explicit commands or operations.

An attachment is validated against its actual logical view, not only its parent
texture. A persistent `TextureViewSpec` must include `RENDER_ATTACHMENT` view
usage and satisfy the complete renderable-view shape. Its normalized view format
is the sole attachment format; optional pass metadata must match it exactly. A
color slot requires a color-renderable format, while depth/stencil renderable
formats belong only in the depth/stencil attachment. An explicit Surface view
descriptor may use the configured format or one configured compatible view format.
It remains a `2d` single-mip/single-layer all-aspect RGBA view; usage is `0` or a
configured Surface usage subset containing `RENDER_ATTACHMENT`. A view with
`TRANSIENT_ATTACHMENT` usage requires
`load: 'clear'` and `store: 'discard'` for color and for every writable
depth/stencil aspect. Scratch chooses those operations as transient defaults and
rejects incompatible explicit values. A provided `depthClear` must be finite and
inside `[0, 1]`. When writable depth defaults or explicitly resolves to
`depthLoad: 'clear'` and no value is provided, Scratch normalizes `depthClear` to
`1`; it never emits a clear operation without the required native clear value.
Texture-backed attachments may use native-renderable `2d`, `2d-array`, or `3d`
views with one mip and one selected array layer. A `2d-array` view selects its
layer with `baseArrayLayer`. A `3d` color view spans the current logical mip depth
and requires the pass to select one in-range `depthSlice`; non-`3d`
attachments reject `depthSlice`. Color clears are normalized only from an exact
four-component finite sequence or a complete finite `{ r, g, b, a }`
dictionary. Stencil clears are limited to the `GPUStencilValue`/`GPUSize32`
range. A render pass may be depth-only, but it may not omit both color and
depth/stencil attachments. Submission preflight requires color attachment regions
to be pairwise disjoint. Views of one texture overlap when they select the same
mip and array layer, or the same 3D `depthSlice`; distinct layers and slices remain
valid. Surface creation separately enforces one live owner per canvas context.
Pass creation and submission both require the exact owner and compare the complete
current `GPUCanvasContext.getConfiguration()` plus canvas size with private Surface
facts. After the submission plan is validated, every executable Surface attachment is
prepared before any command encoder is created. This immutable lease records Surface
identity, format, and configuration version; the later observed `attachment-view`
operation borrows the current texture and creates its view without another
configuration read. A forged alias or external configuration drift therefore fails
before presentation or encoder effects. Submission still compares Surface context
identity defensively when checking region overlap.

Pass specs do not store commands. This prevents stale command lists from surviving across submissions.

## Submission

`SubmissionBuilder` records one explicit pass-command sequence. It is not a display frame and does not imply presentation:

```ts
const submitted = runtime.createSubmission({ validation: 'throw' })
    .compute(simulationPass, [
        simulateParticles,
    ])
    .render(scenePass, [
        drawTerrain,
        drawParticles,
    ])
    .render(outputPass, [
        compositeToSurface,
    ])
    .submit()

const nativeOutcome = await submitted.nativeOutcome
await submitted.done
```

Conceptual split:

- `SubmissionBuilder` records and validates the current pass-command sequence.
- `SubmittedWork` is returned by `.submit()`. It owns the submitted-work id,
  always-resolving `nativeOutcome`, strengthened `done` promise, execution
  outcomes, resource accesses, producer epochs, potential writes, diagnostics,
  and links used by readback operations.

`SubmittedWork` should not be thenable. Waiting uses `await submitted.done`, not `await submitted`. This keeps the submitted-work object inspectable and consistent with `ReadbackOperation`, where the object is not itself a promise.

Submission responsibilities:

- collect pass-command pairs in user order
- validate runtime ownership
- validate pass and command compatibility
- validate resource read/write order
- prepare explicit transfer operations
- resolve command readiness policies into one pre-encoder execution plan
- skip empty passes
- record only the commands selected by that plan
- observe Scratch-owned native issue boundaries under runtime policy
- submit command buffers
- return `SubmittedWork`

### Ordered Readback Preparation And Links

`SubmissionBuilder.submit()` remains synchronous whether or not a builder
contains readback. Ordered readback preparation therefore happens before the
hot submission call:

```ts
const readbackCommand = await runtime.createReadbackCommand(descriptor)
const submitted = runtime.submission().readback(readbackCommand).submit()
const bytes = await readbackCommand.result({ after: submitted }).toBytes()
```

The Promise-only factory validates the immutable command descriptor and
acknowledges one reusable staging allocation. Submission preflight then claims
that slot before encoder creation. A second concurrent use of the same command
fails structurally before encoder or queue effects; successful materialization
returns the slot for sequential reuse. No staging allocation occurs while
encoding or replaying a submission.

Every ordered step contributes one frozen serializable link:

```ts
type SubmittedReadbackLink = Readonly<{
    commandId: string
    operationId: string
    stepIndex: number
    sourceResourceId: string
    allocationVersion: number
    contentEpoch: number
    stagingAllocationOperationId: string
}>
```

`SubmittedWork.readbacks` contains links, not mutable operations, command
payloads, mapped bytes, or native buffers. A queue completion rejection becomes
`SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED` without rewriting the linked
readback operation's independent mapping outcome. Each immutable link also
produces a `readback-failure` incident at `queue-completion` with
`enclosing-operation-family` attribution: the completion barrier identifies
the replayed submission family, not one proven causal command.

### Native Outcome And Completion

`SubmissionBuilder.submit()` remains synchronous and non-thenable. Complete
Scratch preflight happens before observation reservation or native effects;
encoding and queue actions then occur in the declared physical order before
the method returns. Every Scratch error scope is popped in reverse order before
return or throw, while its settlement Promise is retained and immediately
observed without moving queue calls into a microtask.

Ordered-readback ownership claims are part of that preflight. A busy/disposed
claim fails before observation scopes; if observation reservation itself fails,
all acquired claims are released before encoder or queue work.

Runtime diagnostics policy is `submissionScopes: 'summary' | 'off'`. The
default `summary` mode reserves one finite owner and opens one constant-size
validation/internal/OOM bundle for the complete effectful attempt. It reports
`enclosing-operation-family` attribution and issued locations, not a fabricated
unique command. `off` opens no scope and publishes honest unobserved
provenance. Effect-free work uses no owner or native scope.

`SubmittedWork.nativeOutcome` always resolves to one deeply frozen,
JSON-serializable version-5 result. Its status is exactly:

```ts
type ScratchSubmissionNativeOutcomeStatus =
    | 'no-native-work'
    | 'observed-succeeded'
    | 'observed-failed'
    | 'unobserved'
    | 'observation-failed'
```

The outcome retains bounded locations and every retained independent failure
fact in fixed stage/issue order. It does not reject away simultaneous evidence.
`SubmittedWork.report` remains the immutable synchronous preflight report and
is never rewritten after return.

`SubmittedWork.done` joins native observation,
`queue.onSubmittedWorkDone()`, and runtime/device lifecycle until queue
completion settles. It rejects with one structured submission diagnostic when
an applicable boundary proves failure or observation itself cannot settle. A
late lifecycle event is `lifecycle-recheck` with `temporal-correlation`
attribution, never `exact-operation`, and is deduplicated when native settlement
already retained it. `done` does not wait for readback `mapAsync()`, mapped-range
access, host copy, retention, mapped leases, cancellation, or cleanup. Queue
completion is still enclosing-family evidence and cannot identify one command
or turn an independently successful mapping into failure.

Per-location detail exists only in finite diagnostics capture:

```ts
const capture = runtime.diagnostics.capture({
    maxOperations: 128,
    maxDurationMs: 5_000,
    maxEvidenceBytes: 256 * 1024,
    nativeSubmissionDetail: 'step',
})

// Reproduce a bounded number of submissions, then stop explicitly if needed.
const report = capture.stop()
```

Detailed mode scopes encoder creation/finalization, pass begin/end,
standalone/pass commands, and queue actions separately. It can report
`exact-operation` attribution to the scoped location, but not necessarily to
one native call inside that location. Active detailed captures share one
snapshotted instrumentation plan and never multiply native issue calls.

Every submission also publishes immutable `potentialWrites`. If native
observation fails, observation settlement fails, or queue completion rejects,
only writes whose allocation and produced epoch are still current become
`indeterminate`. Epochs and historical ledgers never roll back. A later
acknowledged producer protects or recovers the newer epoch; Surface presentation
targets are excluded from persistent indeterminate state.

If replay stops on a later synchronous native exception and no `SubmittedWork`
is returned, the same native-settlement guard covers only the successfully
replayed action prefix. Failed and unreplayed actions publish no write effect.

### Resize Between Construction And Submission

`TextureResource.resize()` does not add a submission step. It is a Promise-returning resource allocation transaction, not queue work. While its candidate scopes settle, the old allocation remains current and submission encoding performs no hidden wait. An application that requires the replacement for a submission explicitly awaits resize first. A `SubmissionBuilder` stores logical pass, command, resource, and `TextureViewSpec` references; preflight and encoding validate whichever allocation is current at submission time. Texture-backed color and depth/stencil attachments retain their `2d`, `2d-array`, or `3d` logical view shape. Stale mip/layer descriptors, an out-of-range `3d` `depthSlice`, overlapping color attachment regions, or mismatched current render extents/sample counts fail before command encoder creation or ledger mutation. Native attachment views are submission-scoped, observed through `SubmittedWork`, and never cached or prepared by `PassSpec`. Attachments remain independent of the compatibility-mode texture-binding dimension.

Resize itself records no resource access, producer epoch, command buffer, queue action, or completion registration. The replacement starts empty even though its `contentEpoch` number is preserved. A later write may make it ready for a later read in the same submission, and both ledgers then report the new `allocationVersion` and the next `contentEpoch`.

After submission, `SubmittedWork.resourceAccesses` and `producerEpochs` remain an immutable historical record of the allocation and content facts used by that submission. A later texture resize cannot rewrite those arrays or alter the existing `done` promise.

## Physical Queue Timeline

`SubmissionBuilder.steps` defines one total order across encoder-backed work and queue-side uploads. Recording commands into an encoder is not the same as enqueuing them: `GPUQueue.writeBuffer(...)` and `GPUQueue.writeTexture(...)` enter the queue when called, while copy, readback staging, resolve, compute, and render work enter the queue only when a finished command buffer is submitted.

Submission lowering therefore uses three phases:

1. Resolve readiness, fallback, dependency validation, ownership, lifecycle, and pass compatibility before creating an encoder or touching `GPUQueue`.
2. Prepare a complete internal discriminated queue-action timeline. Simulate logical resource accesses and epoch effects against temporary content-state snapshots in declared step order while encoding command-buffer segments, but do not call queue write or submit methods yet. Restore live content state before replay.
3. Replay the prepared timeline in exact order and commit each action's logical effects only after its queue call succeeds, then register `queue.onSubmittedWorkDone()` after the final action.

The internal action families are command buffer, buffer upload, texture upload, and external-image upload. They are explicit variants, not arbitrary callbacks and not a public scheduler API.

A command-buffer segment is a maximal contiguous sequence of executed encoder-backed steps. A queue-side upload ends the preceding segment and separates it from the next one:

```text
copy + compute -> buffer upload -> texture upload -> render + readback
```

lowers to:

```text
submit(copy + compute)
writeBuffer
writeTexture
submit(render + readback)
```

Consecutive uploads do not create empty command buffers. Skipped commands, skipped passes, and effect-free empty passes do not create segments. Encoder-only work with no upload boundary remains one encoder, one command buffer, and one `queue.submit(...)`.

`SubmittedWork.commandBuffers` contains every real segment in physical queue order. Upload-only work has an empty command-buffer array but still registers completion after the final queue write. Effect-free work creates no encoder or queue action and uses an already-resolved `done` promise. See ADR-029.

Every resolved upload revalidates its live data range and required queue method before encoder creation. Once replay begins, the builder is non-retryable: an unexpected synchronous queue failure cannot duplicate earlier actions, and only successfully enqueued actions commit their prepared logical effects. Those committed prefix effects remain guarded by the attempt's native settlement even when `submit()` throws.

### External Image Queue Actions

`ExternalImageUploadCommand` enters the same total order with `uploadKind: 'external-image'` and an internal prepared action:

```ts
{ kind: 'external-image-upload', command, effects }
```

Like buffer and texture uploads, it ends a preceding encoder segment and separates later encoder-backed work. Consecutive external uploads do not create empty command buffers, and external-upload-only work keeps `SubmittedWork.commandBuffers` empty while registering `done` after the final queue call.

All external uploads are preflighted before the first encoder or queue side effect. Preparation simulates only non-empty target writes and restores live state before replay. Replay calls `GPUQueue.copyExternalImageToTexture()` at the action's exact position and commits the prepared target effect only after the native queue call succeeds. A zero-width or zero-height action stays in the physical timeline but carries no target effect, resource access, producer epoch, or simulated readiness.

If the native call throws synchronously, replay stops. Earlier successful actions remain committed and attached to the attempt's native-settlement indeterminacy guard; the failed and later actions do not commit effects, and the builder remains non-retryable. Because `submit()` throws and returns no `SubmittedWork`, staging buffers for unreplayed readbacks are destroyed immediately; staging already referenced by a submitted command buffer is destroyed after `queue.onSubmittedWorkDone()` settles. The native exception is wrapped by the external-image command diagnostic contract rather than converted into a generic queue callback failure. See ADR-030.

## Resolved Readiness Execution

`submit()` completes readiness resolution before creating a WebGPU command encoder. The resolved plan contains the validation report, resolved render/compute steps, final simulated resource/query state, and execution-outcome drafts. Encoding consumes only those resolved steps; it does not revisit the original builder command lists or decide a policy again.

Draw/Dispatch resolution occurs at the exact command position:

- a missing `throw` command fails before encoder or resource side effects in every validation mode;
- a missing `skip-command` request is omitted and produces no read, write, ready-state, or producer fact;
- a missing `skip-pass` request removes the complete pass;
- a missing `use-fallback` request resolves a same-kind fallback chain, and only the final selected command participates in dependency validation and encoding.

Each pass resolves against cloned readiness state, query-slot state, and pass-local dependency findings. A skipped pass discards all clones, including earlier command writes, render attachment load/clear/store, color/depth epochs, timestamp writes, occlusion query writes, and optional findings. A render pass whose draws are individually skipped still executes when attachment operations remain. An effect-free compute pass with no selected commands is `skipped-empty` and does not begin a native pass.

`SubmittedWork.executionOutcomes` is the immutable control-flow ledger. For each render/compute step, a pass summary is followed by Draw/Dispatch command outcomes in original request order. Pass `requestedCommandIds` retain the original pass command sequence; `encodedCommandIds` retain the actual sequence, including a selected fallback. Each command attempt records its policy and complete missing-resource state/epoch facts. All outcomes, attempts, missing facts, subjects, nested arrays, and the top-level array are frozen.

Normal skip/fallback results are not diagnostics. `resourceAccesses` and `producerEpochs` are captured only while encoding resolved commands and executed pass effects, so they cannot contain skipped-primary or skipped-pass ghosts.

## Presentation Is A Submission Mode

A submission may present, but presentation is not the definition of the core submission unit:

- no surface target -> compute-only or offscreen submission
- surface output -> presentation submission that borrows a surface current texture view

CPU/GPU data motion is explicit. Uploads, copies, render writes, compute writes, and readback staging all participate in the same submission order and epoch validation. Results return to the CPU through a `ReadbackOperation`, for example `await readback.toArray()`, not through `buffer.toArray()`. See `07-transfers-epochs` for the full model.

Application code may still have a `renderFrame()` or animation-frame loop. That application frame can create one or more scratch submissions, but it is not the scratch core type.

## Dependency Validation

The core scheduler does not automatically sort commands. It validates explicit order.

Examples of checks:

- resource from wrong runtime
- disposed or lost resource used by a command
- command reads a content epoch before the submission prepares or writes it
- same pass reads and writes the same resource without an explicitly allowed pattern
- surface current texture view used outside its owning presentation submission
- render command inserted into compute pass
- dispatch command inserted into render pass
- dispatch workgroup count exceeds `maxComputeWorkgroupsPerDimension`
- bound storage buffer range exceeds device storage-binding limits

Native indexed and indirect commands use the same declared-read validation path as shader resources. Vertex, index, and indirect buffers must have explicit required content epochs. A prior upload or GPU command in the same submission may produce that epoch; the later fixed-function read is recorded in `SubmittedWork.resourceAccesses` without advancing the resource epoch. Indirect argument contents remain GPU data and are not copied to the CPU for scheduler validation.

Submission simulation and encoding share the command's potential-write decision. A direct draw or dispatch whose static count is known to execute no invocations does not mark declared outputs ready and does not create write or producer ledger entries. Indirect counts remain opaque, so their declared writes are conservatively treated as potential producers without host inspection.

Validation modes:

```ts
type SubmissionValidationMode = 'off' | 'warn' | 'throw'
```

Development should prefer `throw`. Production or profiling runs may choose `warn` or `off`.

Validation findings should use the shared `ScratchDiagnostic` envelope from `09-diagnostics-validation`. Submission validation should attach a deterministic diagnostic report to `SubmittedWork` when work is submitted, and should throw a structured diagnostic error in `throw` mode rather than a prose-only `Error`.

## Readiness Policy Interaction

Dependency validation and resource readiness policy are separate.

- Validation checks whether the selected submission order, required epochs, and ownership are coherent.
- `whenMissing` controls what to do if a required resource has no readable content at that position.

`SubmissionValidationMode` controls optional dependency-finding disposition, not readiness control flow. `off` still resolves skip/fallback and preserves execution outcomes. Draw and Dispatch implement all four policies; Copy, Readback, and Resolve remain `throw`-only.

## Future Upper Orchestration

Automatic sorting should not be part of the first core scheduler. A future upper layer may provide:

```ts
scratch.schedule(commands, {
    strategy: 'topological',
}).into(submission)
```

That layer can build on command read/write declarations without changing the core `Submission` model.

## Non-Goals

- Do not make pass specs mutable containers for current-submission commands.
- Do not make automatic render graph sorting the default core behavior.
- Do not hide submission order from users who need WebGPU-level control.
- Do not encode geospatial layer order in the scratch scheduler.
- Do not expose submission validation as prose-only errors.
- Do not use `Frame` as the scratch core submission type; frame cadence belongs to geo, app, or presentation layers.
- Keep mapped leases, texture readback, external-texture frame lifetime, tracked dynamic values, render graph ownership, and raw-device tracking outside this submission-native-outcome slice.
