# Transfers And Epochs

Status: Vision draft
Date: 2026-06-30

## Decision

`Frame` remains the presentation-optional submission unit. CPU/GPU data motion is not a method on `Resource`; it is expressed as explicit transfer operations and commands.

A `Resource` is a logical identity plus state. It is not a host transfer handle. Upload, readback, copy, render writes, and compute writes all participate in the same epoch model, so the runtime can validate which contents are read and which physical GPU object is bound.

This replaces the earlier resource-as-readback-handle model. It resolves the async readback, submission, and timing/query gaps without making `buffer.toArray()` or `buffer.write()` part of the core resource contract.

## Frame Is The Submission Unit

`Frame` records passes and commands and submits them. Presentation is one mode, not the definition:

- with a surface output -> a presentation frame using a frame-scoped surface texture view
- with no surface -> a compute or offscreen submission

`submit()` is awaitable for GPU completion, backed by `queue.onSubmittedWorkDone`. Completion is separate from data transfer: awaiting `submit()` tells you submitted GPU work finished; it does not automatically move data to or from the CPU.

```ts
const submitted = scratch.frame()       // no surface -> compute submission
    .compute(simulationPass, [simulate])
    .submit()

await submitted                         // GPU completion, not host readback
```

`Frame` is therefore the single submission concept. There is no separate `Submission` or `Batch` type in the core model.

## Epoch Model

Every resource should expose or internally track:

- runtime owner
- logical id
- descriptor shape
- current physical GPU object
- `allocationVersion`
- `contentEpoch`
- readiness state
- last writer or producer submission
- pending transfer operations
- disposal state

`allocationVersion` changes when the physical binding target changes:

- buffer or texture replacement
- resize
- device-loss rehydration
- descriptor changes that change the GPU object or view compatibility

`allocationVersion` is what `BindSet`, view caches, render attachments, and command caches compare before reuse. A content write must not force a bind group rebuild unless it also changes the physical binding target.

`contentEpoch` changes when bytes or texels change:

- `UploadCommand`
- `CopyCommand` destination writes
- `DrawCommand` render attachment writes
- `DispatchCommand` storage buffer or storage texture writes
- render pass clear, resolve, and store operations
- explicit clear, resolve, or mipmap generation commands if they become part of the API

`contentEpoch` may be tracked per resource first, and later by buffer range or texture region where useful. The important contract is that readback and dependency validation talk about content epochs, while binding invalidation talks about allocation versions.

## Upload

CPU-to-GPU writes are explicit transfer commands:

```ts
const uploadPositions = scratch.command.upload({
    label: 'upload positions',
    target: positions,
    data: positionsArray,
    range: { offset: 0 },
})

scratch.frame()
    .upload(uploadPositions)
    .submit()
```

There is no core `positions.write(...)` method. A convenience helper may be added above the core later, but it must lower to an explicit upload operation with inspectable target, range, readiness, and epoch effects.

An upload advances the target's `contentEpoch` for the written range and records the producing submission. If upload allocation requires replacing the physical GPU object, it also advances `allocationVersion`.

## Readback

GPU-to-CPU reads create an explicit `ReadbackOperation`:

```ts
const submitted = scratch.frame()
    .compute(simulationPass, [simulate])
    .submit()

const readback = scratch.readback({
    source: particles.segment('positions'),
    after: submitted,
})

const values = await readback.toArray()
```

`toArray()` and `toBytes()` belong to the readback operation, not to `BufferResource` or `TextureResource`. The operation captures the source resource, range or region, layout view, producer submission, and source `contentEpoch`.

Properties:

- **Explicit wait point.** Host access is an `await` on a transfer result, never a transparent stall hidden behind a resource getter.
- **Epoch capture.** A readback reads the content epoch captured by the readback request or by the declared `after` submission. It must not silently drift to the resource's latest contents.
- **Auto staging.** The runtime owns `MAP_READ` staging resources. User buffers do not need map usage for common readback, but the source needs the appropriate copy usage or an explicit resolve path.
- **Layout-derived views.** Buffer layout from `02-resources` decides whether the result is a `TypedArray`, bytes, or a layout-derived structured view. AoS fields are strided and should not be promised as one contiguous typed array unless explicitly deinterleaved.

For uncommon cases where the copy or resolve point must be placed inside the command graph, use `ReadbackCommand`:

```ts
const readParticles = scratch.command.readback({
    label: 'read particle positions',
    source: particles.segment('positions'),
})

const submitted = scratch.frame()
    .compute(simulationPass, [simulate])
    .readback(readParticles)
    .submit()

const values = await readParticles.result({ after: submitted }).toArray()
```

`ReadbackCommand` is an ordered-staging escape hatch. It is not the default readback path, and it still produces an explicit `ReadbackOperation`.

## Copy

GPU-to-GPU copies are explicit commands:

```ts
const copyHistory = scratch.command.copy({
    label: 'copy color to history',
    source: sceneColor,
    target: historyColor,
    region: sceneRegion,
})
```

A copy reads the source `contentEpoch` and advances the target `contentEpoch`. If the copy target requires a new physical resource, allocation replacement is represented separately through `allocationVersion`.

## Rendering Resources

The same model covers graphics resources:

- A render pass attachment is a declared write. Its store, clear, and resolve behavior advances the attachment resource's `contentEpoch`.
- A later pass that samples that texture declares a read of the produced `contentEpoch`.
- Depth and stencil attachments use the same rule. Load/store policy and read-as-texture use must be explicit enough for dependency validation.
- The surface current texture is a borrowed frame-scoped target, not a persistent `TextureResource`. It cannot be retained beyond the frame that acquired it.
- Resizing a render target advances `allocationVersion` and invalidates cached views, bind sets, pass attachments, and commands that depend on the previous physical object.
- Temporal resources such as TAA history, trails, or iterative simulation textures are ordinary resources whose previous-frame contents are represented by content epochs, not by a special core feature.

## Timing And Queries

GPU timing uses the same transfer model:

- `QuerySetResource` is a resource kind for timestamp or occlusion queries, feature-gated where required.
- `timestampWrites` attach to pass specs.
- Query results are resolved through an explicit copy/resolve into a buffer and then read through a `ReadbackOperation`.

Pipeline statistics are not part of the current WebGPU core contract and should stay outside the core design unless a future target explicitly supports them.

## Lifetime And Diagnostics

- Runtime-owned staging resources are released when the `ReadbackOperation` resolves, is cancelled, or is disposed.
- A requested but unresolved readback is a runtime-owned pending operation, not an unobservable Promise leak. Development validation can warn on stale pending readbacks.
- Diagnostics should include resource id, allocation version, content epoch, range or region, producer submission, and the operation that created the pending transfer.

## Non-Goals

- Do not expose core `resource.toArray()` or `resource.toBytes()` sugar.
- Do not expose core `resource.write()` sugar.
- Do not hide upload, readback, or copy submission.
- Do not make `ReadbackCommand` the default path.
- Do not add automatic render-graph sorting to the core scheduler.
- Do not turn common patterns such as ping-pong, history buffers, or readback rings into first-class kernel features.
