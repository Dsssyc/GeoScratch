# Transfers And Epochs

Status: Vision draft
Date: 2026-07-06

## Decision

`Submission` is the core submission unit. CPU/GPU data motion is not a method on `Resource`; it is expressed as explicit transfer operations and commands.

A `Resource` is a logical identity plus state. It is not a host transfer handle. Upload, readback, copy, render writes, and compute writes all participate in the same epoch model, so the runtime can validate which contents are read and which physical GPU object is bound.

This replaces the earlier resource-as-readback-handle model. It resolves the async readback, submission, and timing/query gaps without making `buffer.toArray()` or `buffer.write()` part of the core resource contract.

## Submission Is The Submission Unit

`SubmissionBuilder` records passes and commands and submits them. Presentation is one mode, not the definition:

- with a surface output -> a presentation submission using a presentation-submission-scoped surface texture view
- with no surface -> a compute or offscreen submission

`.submit()` returns `SubmittedWork`, an inspectable handle with a `done` promise backed by `queue.onSubmittedWorkDone`. Completion is separate from data transfer: awaiting `submitted.done` tells you submitted GPU work finished; it does not automatically move data to or from the CPU.

```ts
const submitted = scratch.submission()  // no surface -> compute submission
    .compute(simulationPass, [simulate])
    .submit()

await submitted.done                    // GPU completion, not host readback
```

`Submission` is therefore the single core submission concept. There is no separate `Frame` or `Batch` type in the scratch core model.

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

scratch.submission()
    .upload(uploadPositions)
    .submit()
```

There is no core `positions.write(...)` method. A convenience helper may be added above the core later, but it must lower to an explicit upload operation with inspectable target, range, readiness, and epoch effects.

An upload advances the target's `contentEpoch` for the written range and records the producing submission. If upload allocation requires replacing the physical GPU object, it also advances `allocationVersion`.

## Readback

GPU-to-CPU reads create an explicit `ReadbackOperation`:

```ts
const submitted = scratch.submission()
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
- `ready` -> retained host bytes exist and can be read repeatedly until cancellation or disposal. The default consume-on-read path does not use `ready`.
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

For the host-copy retention path, the first successful read materializes and stores operation-owned host bytes, releases GPU staging, and returns an owned copy. Later `toBytes()`, `toArray()`, and layout-view reads clone from those retained bytes instead of re-staging GPU work. The retained result represents the materialized epoch even if the source resource later advances.

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

For uncommon cases where the staging copy point must be placed inside the command graph, use `ReadbackCommand`:

```ts
const readParticles = runtime.readbackCommand({
    label: 'read particle positions',
    source: {
        resource: particlePositions,
        contentEpoch: particlePositions.contentEpoch + 1,
    },
    whenMissing: 'throw',
})

const submitted = runtime.submission()
    .compute(simulationPass, [simulate])
    .readback(readParticles)
    .submit()

const values = await readParticles.result({ after: submitted }).toArray()
```

The buffer-only `ReadbackCommand` ordered-staging path is implemented. It validates the explicit source epoch, records a read-only submission ledger entry, and copies into runtime-owned staging at the declared step. `result({ after })` returns the operation associated with that exact submitted work; materialization maps the existing staging buffer and does not submit a second copy. This remains an escape hatch, not the default readback path. Direct texture readback, mapped leases, and staging-budget policy remain future work.

## Copy

GPU-to-GPU copies are explicit commands. `CopyCommand` should expose the same native copy directions that WebGPU command encoders expose:

- buffer to buffer
- texture to texture
- buffer to texture
- texture to buffer

CPU uploads and CPU readbacks are separate transfer concepts. `TextureUploadCommand` expresses CPU bytes written through the queue; `ReadbackOperation` expresses host materialization through staging and mapping. Neither replaces a GPU-side `CopyCommand`.

```ts
const copyHistory = scratch.command.copy({
    label: 'copy color to history',
    source: {
        resource: sceneColor,
        contentEpoch: sceneColor.contentEpoch,
    },
    sourceOrigin: sceneRegion.origin,
    target: historyColor,
    targetOrigin: [ 0, 0 ],
    size: sceneRegion.size,
    whenMissing: 'throw',
})
```

Buffer-texture copies use a WebGPU texel buffer layout instead of CPU data:

```ts
const uploadPreparedPixels = scratch.command.copy({
    label: 'copy prepared pixels into texture',
    source: {
        resource: preparedPixelBuffer,
        contentEpoch: preparedPixelBuffer.contentEpoch,
    },
    sourceLayout: {
        offset: 0,
        bytesPerRow: 256,
        rowsPerImage: 64,
    },
    target: albedoTexture,
    targetOrigin: [0, 0],
    targetMipLevel: 0,
    targetAspect: 'all',
    size: { width: 64, height: 64 },
    whenMissing: 'throw',
})
```

Texture-buffer copies are still GPU-side copies. CPU access only begins if a later `ReadbackOperation` maps or materializes the destination buffer:

```ts
const copyTileStats = scratch.command.copy({
    label: 'copy texture tile into staging buffer',
    source: {
        resource: tileTexture,
        contentEpoch: tileTexture.contentEpoch,
    },
    sourceOrigin: [0, 0],
    sourceMipLevel: 0,
    sourceAspect: 'all',
    target: tileStagingBuffer,
    targetLayout: {
        offset: 0,
        bytesPerRow: 256,
        rowsPerImage: 32,
    },
    size: { width: 32, height: 32 },
    whenMissing: 'throw',
})
```

A copy reads the source `contentEpoch` and advances the target `contentEpoch`. If the copy target requires a new physical resource, allocation replacement is represented separately through `allocationVersion`.

## Rendering Resources

The same model covers graphics resources:

- A render pass attachment is a declared write. Its store, clear, and resolve behavior advances the attachment resource's `contentEpoch`.
- A later pass that samples that texture declares a read of the produced `contentEpoch`.
- Depth and stencil attachments use the same rule. Load/store policy and read-as-texture use must be explicit enough for dependency validation.
- The surface current texture is a borrowed presentation-submission-scoped target, not a persistent `TextureResource`. It cannot be retained beyond the presentation submission that acquired it.
- Resizing a render target advances `allocationVersion` and invalidates cached views, bind sets, pass attachments, and commands that depend on the previous physical object.
- Temporal resources such as TAA history, trails, or iterative simulation textures are ordinary resources whose previous-frame contents are represented by content epochs, not by a special core feature.

## Timing And Queries

GPU timing and visibility queries use the same transfer model. The name `QuerySetResource` follows WebGPU `GPUQuerySet`; it is an indexed slot resource, not an unordered collection.

Core query-set contract:

```ts
type QuerySetType = 'timestamp' | 'occlusion'
type QueryUnsupportedPolicy = 'throw' | 'warn-disable' | 'disable'

const timingQueries = scratch.querySet({
    label: 'simulation timing',
    type: 'timestamp',
    count: 2,
    whenUnsupported: 'throw',
})
```

- `count` is the number of indexed query slots.
- Query slots are addressed by explicit indices or index ranges.
- `timestamp` requires the `timestamp-query` feature and can be used by render or compute pass `timestampWrites`.
- `occlusion` belongs to render passes through `occlusionQuerySet` and begin/end occlusion query brackets.
- A query write advances the query slot's content epoch. Resolving query results advances the destination buffer's `contentEpoch`.
- `whenUnsupported` controls feature-gate failure. Development should prefer `throw`; profiling overlays may choose `warn-disable` or `disable` when instrumentation is optional.

Timestamp writes are pass-level instrumentation:

```ts
const simulationPass = scratch.pass.compute({
    label: 'simulate',
    timestampWrites: {
        querySet: timingQueries,
        begin: 0,
        end: 1,
    },
})
```

Occlusion queries are render-pass-scoped:

```ts
const visibilityQueries = scratch.querySet({
    label: 'tile visibility',
    type: 'occlusion',
    count: tileCapacity,
})

const scenePass = scratch.pass.render({
    label: 'scene',
    color: [
        {
            target: sceneColor,
            load: 'load',
            store: 'store',
        },
    ],
    depth: {
        target: depth,
        depthLoad: 'load',
        depthStore: 'store',
    },
    occlusionQuerySet: visibilityQueries,
})

const drawTileWithVisibility = [
    scratch.command.beginOcclusionQuery({ querySet: visibilityQueries, index: tileIndex }),
    drawTile,
    scratch.command.endOcclusionQuery(),
]
```

Query results are not CPU-visible until explicitly resolved and read back:

```ts
const resolveTiming = scratch.command.resolveQuerySet({
    source: {
        querySet: timingQueries,
        slots: [
            { index: 0, contentEpoch: 1 },
            { index: 1, contentEpoch: 1 },
        ],
    },
    destination: timingBuffer,
    destinationOffset: 0,
    whenMissing: 'throw',
})

const submitted = scratch.submission()
    .compute(simulationPass, [simulateParticles])
    .resolve(resolveTiming)
    .submit()

const timingReadback = scratch.readback({
    source: {
        resource: timingBuffer,
        range: { offset: 0, byteLength: 16 },
        view: 'u64',
    },
    after: submitted,
    provenance: {
        querySet: timingQueries,
        slots: [
            { index: 0, contentEpoch: 1 },
            { index: 1, contentEpoch: 1 },
        ],
    },
})

const timingValues = await timingReadback.toBigUint64Array()
```

Pipeline statistics are not part of the current WebGPU core contract and must stay outside the scratch core design unless a future WebGPU target or explicit extension supports them.

Potential query diagnostic codes using the shared envelope from `09-diagnostics-validation`:

```ts
type QueryDiagnosticCode =
    | 'SCRATCH_QUERY_UNSUPPORTED_TYPE'
    | 'SCRATCH_QUERY_FEATURE_UNAVAILABLE'
    | 'SCRATCH_QUERY_INDEX_OUT_OF_RANGE'
    | 'SCRATCH_QUERY_WRONG_PASS_KIND'
    | 'SCRATCH_QUERY_WRONG_SET_TYPE'
    | 'SCRATCH_QUERY_OCCLUSION_NESTED'
    | 'SCRATCH_QUERY_OCCLUSION_NOT_ACTIVE'
    | 'SCRATCH_QUERY_RESOLVE_UNWRITTEN_RANGE'
    | 'SCRATCH_QUERY_RESOLVE_DESTINATION_INVALID'
```

Query diagnostics should include query-set id, type, requested range, pass or command id, feature name where relevant, destination buffer id for resolve failures, and the producer submission id when a query slot was written. These details belong in `subject`, `related`, `expected`, `actual`, or compact evidence fields, not only in prose.

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
        staleAfterSubmissions: 3,
        staleAfterMs: 250,
        maxPendingOperations: 16,
        maxStagingBytes: 64 * 1024 * 1024,
        onBudgetExceeded: 'throw',
    },
})
```

Potential readback diagnostic codes using the shared envelope from `09-diagnostics-validation`:

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
type ReadbackDiagnostic = ScratchDiagnostic & {
    code: ReadbackDiagnosticCode
    phase: 'readback'
    subject: { kind: 'ReadbackOperation', id: string, label?: string }
    related?: [
        { kind: 'Resource', id: string, label?: string, resourceKind?: string },
        ...DiagnosticSubject[],
    ]
    actual?: {
        state: ReadbackState
        allocationVersion?: number
        contentEpoch?: number
        rangeOrRegion?: unknown
        producerSubmissionId?: string
        ageInSubmissions?: number
        ageInMs?: number
        stagingBytes?: number
    }
}
```

Readback-specific diagnostics should follow the shared machine-readable pattern from the start. Readback-specific state lives inside the common `ScratchDiagnostic` envelope, usually in `subject`, `related`, `actual`, and `evidence`.

## Non-Goals

- Do not expose core `resource.toArray()` or `resource.toBytes()` sugar.
- Do not expose core `resource.write()` sugar.
- Do not hide upload, readback, or copy submission.
- Do not make `ReadbackCommand` the default path.
- Do not expose pipeline statistics as a core query type while WebGPU does not provide that core query primitive.
- Do not add automatic render-graph sorting to the core scheduler.
- Do not turn common patterns such as ping-pong, history buffers, or readback rings into first-class kernel features.
