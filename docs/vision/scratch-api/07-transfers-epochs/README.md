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

## Readback Operation Lifecycle

The runtime should track `ReadbackOperation` objects, not whether a JavaScript `Promise` was awaited. Promise consumption is not a reliable contract in JavaScript: a promise can be passed elsewhere, wrapped, observed through `.then()`, or retained without being awaited. A runtime-owned operation is observable and diagnosable.

Target operation state:

```ts
type ReadbackState =
    | 'requested'
    | 'scheduled'
    | 'submitted'
    | 'mapping'
    | 'ready'
    | 'consumed'
    | 'cancelled'
    | 'failed'
    | 'disposed'
```

State semantics:

- `requested` -> source, range or region, layout view, and content epoch are captured.
- `scheduled` -> a copy, resolve, or map path has been assigned.
- `submitted` -> GPU work is in flight. It may not be possible to retract, but the result can still be marked unwanted.
- `mapping` -> staging copy exists and `mapAsync` or equivalent host availability is pending.
- `ready` -> a CPU-readable result exists but has not been consumed or explicitly retained.
- `consumed` -> `toArray()` or `toBytes()` returned an owned copy and runtime staging can be released.
- `cancelled` -> the caller declared that the result is no longer needed. Already submitted GPU work may still finish, but the runtime should discard the result and release staging.
- `failed` -> device loss, source disposal before copy, map failure, validation error, or budget failure prevented a usable result.
- `disposed` -> the user-facing operation is closed. The runtime may keep an internal cleanup record until in-flight GPU work and staging release finish. Later read attempts fail with a diagnostic error.

Default host-copy reads are **consume-on-read**:

```ts
const result = await readback.toArray()  // returns an owned copy
// operation transitions to consumed; staging can be freed
```

If repeated reads are required, the caller should opt into retention explicitly:

```ts
const readback = scratch.readback({
    source: particles.segment('positions'),
    after: submitted,
    retain: 'until-dispose',
})
```

Zero-copy or mapped views must be leased, because a mapped range is invalid after unmap:

```ts
const lease = await readback.map()
try {
    const view = lease.view
    // inspect the mapped data
} finally {
    lease.dispose()
}
```

Only the lease exposes the mapped view. The operation tracks active leases, and development validation should warn if a lease is not released before the operation or runtime is disposed.

`cancel()` and `dispose()` are explicit:

```ts
readback.cancel('no longer visible')
readback.dispose()
```

`cancel()` means the result is no longer needed. `dispose()` releases local operation ownership; if the operation is still in flight, it behaves like cancel plus user-facing detachment while the runtime keeps enough internal state to release staging later. After disposal, `toArray()`, `toBytes()`, and `map()` reject with a structured diagnostic.

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

## Retention, Budgets, And Diagnostics

Readback retention is a runtime policy, not hidden garbage collection. The default policy should be conservative:

- keep an operation until it is consumed, cancelled, disposed, or failed
- warn in development when a pending operation becomes stale
- warn in development when a ready operation remains unconsumed
- fail fast or emit a high-severity diagnostic when staging budgets are exceeded
- never silently evict a readback result unless the operation was explicitly declared evictable

Example configuration shape:

```ts
const runtime = await ScratchRuntime.create({
    readback: {
        staleAfterFrames: 3,
        staleAfterMs: 250,
        maxPendingOperations: 16,
        maxStagingBytes: 64 * 1024 * 1024,
        onBudgetExceeded: 'throw',
    },
})
```

Potential diagnostic codes:

```ts
type ReadbackDiagnosticCode =
    | 'SCRATCH_READBACK_STALE_PENDING'
    | 'SCRATCH_READBACK_READY_UNCONSUMED'
    | 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED'
    | 'SCRATCH_READBACK_CANCELLED'
    | 'SCRATCH_READBACK_SOURCE_DISPOSED_BEFORE_COPY'
    | 'SCRATCH_READBACK_RUNTIME_DISPOSED'
    | 'SCRATCH_READBACK_LEASE_NOT_RELEASED'
```

Every readback diagnostic should carry enough context for an agent or human to repair the issue without parsing prose:

```ts
type ReadbackDiagnostic = {
    code: ReadbackDiagnosticCode
    severity: 'info' | 'warn' | 'error'
    operationId: string
    label?: string
    state: ReadbackState
    sourceResourceId: string
    allocationVersion: number
    contentEpoch: number
    rangeOrRegion?: unknown
    producerSubmissionId?: string
    ageInFrames?: number
    ageInMs?: number
    stagingBytes?: number
    hint?: string
}
```

General validation diagnostics are a broader design topic, but readback-specific diagnostics should follow this machine-readable pattern from the start.

## Non-Goals

- Do not expose core `resource.toArray()` or `resource.toBytes()` sugar.
- Do not expose core `resource.write()` sugar.
- Do not hide upload, readback, or copy submission.
- Do not make `ReadbackCommand` the default path.
- Do not add automatic render-graph sorting to the core scheduler.
- Do not turn common patterns such as ping-pong, history buffers, or readback rings into first-class kernel features.
