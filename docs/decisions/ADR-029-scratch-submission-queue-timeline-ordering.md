# ADR-029: Preserve Scratch Submission Queue Timeline Order

## Status

Accepted

## Date

2026-07-11

## Context

`SubmissionBuilder.steps` already defined one explicit logical order across uploads, copies, ordered readback staging, query resolves, compute passes, and render passes. `SubmittedWork.resourceAccesses` and `producerEpochs` recorded that declared order.

The physical WebGPU queue order did not always match it. Scratch created one `GPUCommandEncoder`, walked every resolved step, called `GPUQueue.writeBuffer` or `GPUQueue.writeTexture` immediately for upload steps, encoded all other work into that one encoder, and called `GPUQueue.submit` only after the walk.

For a declared sequence such as:

```text
GPU work A
upload B
GPU work C
```

the physical queue therefore received:

```text
upload B
one command buffer containing GPU work A and GPU work C
```

Encoder record order cannot repair this mismatch because a queue write is enqueued when the queue method is called, while encoder-backed work is enqueued only when its finished command buffer is submitted. The bug was especially visible for ordered readback: a staging copy declared before a later upload could physically execute after that upload and capture the wrong bytes.

## Decision

### One total order

`SubmissionBuilder.steps` defines one total submission order. Every physical queue action produced by a resolved step must be enqueued in that same order.

Submission lowering uses an internal discriminated queue timeline equivalent to:

```ts
type PreparedQueueAction =
    | { kind: 'command-buffer', commandBuffer: GPUCommandBuffer }
    | { kind: 'buffer-upload', command: UploadCommand }
    | { kind: 'texture-upload', command: TextureUploadCommand }
```

This representation is internal. It is inspectable and can gain another explicit variant later, but it is not a public task-executor or callback API.

### Three processing phases

`SubmissionBuilder.submit()` has three ordered phases:

1. Resolve readiness, fallback behavior, dependency validation, ownership, lifecycle, and pass compatibility before creating an encoder or touching `GPUQueue`.
2. Prepare the complete physical queue timeline. Encode command-buffer segments and record logical resource access and epoch effects in declared step order without calling queue write or submit methods.
3. Replay the prepared actions in exact order. A command-buffer action calls `queue.submit([commandBuffer])`; an upload action performs its corresponding queue write.

`queue.onSubmittedWorkDone()` is registered only after the final prepared action has been enqueued.

### Maximal encoder segments

A command-buffer segment is a maximal contiguous sequence of executed encoder-backed steps:

- `CopyCommand`
- `ReadbackCommand` staging
- `ResolveQuerySetCommand`
- compute passes
- render passes

A buffer or texture upload terminates a preceding segment and separates it from a following segment. Consecutive uploads do not create empty segments. Skipped passes, skipped commands, and effect-free empty passes also do not create segments. Work with no upload boundary keeps the efficient existing shape of one encoder, one command buffer, and one queue submission.

### Epoch and upload behavior

Upload normalization and validation remain command construction and submission-validation responsibilities. Timeline preparation commits the upload's logical write once; timeline replay performs the physical queue write without advancing the target epoch a second time. Direct `UploadCommand.execute(queue)` and `TextureUploadCommand.execute(queue)` still perform one physical write and one logical epoch advance.

Segmentation does not change resource access order, allocation versions, readiness decisions, execution outcomes, or query-slot behavior.

### SubmittedWork and readback

`SubmittedWork.commandBuffers` contains every real command buffer in physical queue order. It may contain multiple buffers when uploads split encoder work, and it is empty for upload-only or effect-free work.

`SubmittedWork.done` covers every queue write and command-buffer submission belonging to the aggregate work. Upload-only work calls `queue.onSubmittedWorkDone()` after its final upload. Effect-free work uses an already-resolved promise and does not wait on unrelated queue work.

Ordered readback operations continue to reference the aggregate `SubmittedWork`, even when their staging copies belong to different command-buffer segments. Each operation keeps its own staging buffer, captured content epoch, allocation version, and producer provenance.

## Alternatives Considered

### Keep one final queue submission

Rejected. One final `queue.submit(...)` necessarily enqueues every earlier `queue.writeBuffer(...)` and `queue.writeTexture(...)` before all encoded work, regardless of builder step order.

### Stage every upload into command buffers

Rejected for this slice. It would replace the established queue-write upload path with staging allocations and GPU copies, add transfer and memory overhead, and broaden buffer/texture upload policy beyond the ordering correction. Queue-side uploads remain explicit actions in the same timeline.

### Store arbitrary queue callbacks

Rejected. Callbacks would hide action identity, resource effects, validation boundaries, and future extension points. A discriminated action model remains locally inspectable and mechanically reviewable.

### Submit every encoder-backed step separately

Rejected. It would preserve order but fragment command buffers without a queue-side boundary. Maximal contiguous segments preserve both order and the existing efficient shape.

### Add external-image upload at the same time

Rejected. `copyExternalImageToTexture` is another queue-side action and should extend the established timeline model in a later decision. Adding it before fixing total queue order would duplicate the same defect.

## Consequences

- Physical WebGPU queue order now matches declared submission order for buffer uploads, texture uploads, copies, ordered readback staging, query resolves, compute passes, and render passes.
- Interleaved uploads create only the command-buffer boundaries required to preserve that order.
- Upload-only submissions create no fake command buffer; effect-free submissions create no physical queue action.
- Resource-access, producer-epoch, readiness, fallback, and readback ledgers describe the work that was actually enqueued.
- Future queue-side operations must add explicit prepared-action variants and preserve the same resolve, prepare, and replay phases.
- No new public API or diagnostic code is introduced by this decision.
