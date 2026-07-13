# Transfers And Epochs

Status: Vision draft
Date: 2026-07-12

## Decision

`Submission` is the core submission unit. CPU/GPU data motion is not a method on `Resource`; it is expressed as explicit transfer operations and commands.

A `Resource` is a logical identity plus state. It is not a host transfer handle. Upload, readback, copy, render writes, and compute writes all participate in the same epoch model, so the runtime can validate which contents are read and which physical GPU object is bound.

This replaces the earlier resource-as-readback-handle model. It resolves the async readback, submission, and timing/query gaps without making `buffer.toArray()` or `buffer.write()` part of the core resource contract.

## Submission Is The Submission Unit

`SubmissionBuilder` records passes and commands and submits them. Presentation is one mode, not the definition:

- with a surface output -> a presentation submission using a presentation-submission-scoped surface texture view
- with no surface -> a compute or offscreen submission

`.submit()` synchronously returns `SubmittedWork`, an inspectable non-thenable
handle. Its always-resolving `nativeOutcome` reports native observation, while
its `done` Promise joins that observation with `queue.onSubmittedWorkDone()`
when physical queue actions exist. Effect-free work reports `no-native-work`
and does not wait on unrelated queue work. Completion remains separate from
data transfer: `done` does not map staging, access a mapped range, copy host
bytes, or materialize a readback result.

```ts
const submitted = scratch.submission()  // no surface -> compute submission
    .compute(simulationPass, [simulate])
    .submit()

const nativeOutcome = await submitted.nativeOutcome
await submitted.done                    // observed submission, not host readback
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

Resource identity, lifecycle, readiness, `allocationVersion`, and `contentEpoch` are read-only public facts backed by ECMAScript-private slots. Package consumers cannot rewrite provenance through fields, an upcast to `Resource`, an object-level transition method, or either public package entrypoint. Internal command and submission modules commit transitions through non-entrypoint module functions.

`contentEpoch` changes when bytes or texels change:

- `UploadCommand`
- `CopyCommand` destination writes
- `DrawCommand` render attachment writes
- `DispatchCommand` storage buffer or storage texture writes
- render pass clear, resolve, and store operations
- explicit clear, resolve, or mipmap generation commands if they become part of the API

`contentEpoch` may be tracked per resource first, and later by buffer range or texture region where useful. The important contract is that readback and dependency validation talk about content epochs, while binding invalidation talks about allocation versions.

### Indeterminate Content After Delayed Failure

Submission effects advance epochs optimistically when native actions are
issued. If native observation later fails, observation cannot settle, or queue
completion rejects, Scratch does not roll those published epochs backward.
Instead, each still-current persistent potential write becomes
`indeterminate`: the allocation or query slot exists, but its bytes, texels, or
query values are not proven to match the recorded epoch.

Allocation version and content epoch guards prevent a delayed failure from
poisoning a replacement or a later producer. Every attempt to read current
indeterminate content hard-fails before native work, including copy, direct or
ordered readback, bind-backed draw/dispatch, attachment `load`, and query
resolve. Missing-resource policies and validation modes cannot suppress it. A
later explicit producer advances a new epoch and restores `ready`; historical
submission ledgers and outcomes remain unchanged.

### Texture Allocation Replacement

`TextureResource.resize()` explicitly replaces the physical allocation behind one stable logical texture. It is a Promise-returning scoped allocation transaction, not transfer or submission work: resize creates no encoder, calls no queue method, registers no `onSubmittedWorkDone()`, and does not wait for prior queue completion before destroying the old texture. The old allocation stays installed while the candidate's validation and out-of-memory scopes settle; only acknowledged success advances allocation facts.

A normalized same-size resize returns a resolved Promise and changes nothing. A successful size-changing resize has exactly these effects:

```text
allocationVersion = previous allocationVersion + 1
contentEpoch = previous contentEpoch
state = empty
```

The next successful texture upload, external-image upload, copy target write, render attachment write, or storage write advances from that preserved epoch and makes the replacement ready. Transfer commands resolve the current physical allocation when executed and revalidate current mip, origin, extent, and layer ranges before any encoder or queue effect.

`SubmittedWork` remains historical: later resize cannot alter an earlier submission's allocation-version or producer facts. `ReadbackOperation` captures its source allocation version. The implemented readback source is a buffer, so replacing that captured buffer before materialization rejects with `SCRATCH_READBACK_SOURCE_ALLOCATION_STALE`. Texture data reaches host memory through an explicit texture-to-buffer `CopyCommand`; replacing the texture afterward does not rewrite the already captured destination-buffer provenance. A future direct texture-readback path must use the same allocation-stale rule.

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

### Queue-Side Upload Ordering

Buffer and texture uploads are ordered submission actions, not preparation outside the submission. A queue write must physically appear at its declared `SubmissionBuilder` position relative to copy, ordered readback staging, resolve, compute, and render work.

Queue writes cannot be recorded into the same `GPUCommandEncoder`. Submission lowering therefore prepares an explicit internal queue timeline and splits encoder-backed work only at upload boundaries:

```text
GPU work A -> upload B -> GPU work C
```

becomes:

```text
queue.submit(commandBufferA)
queue.writeBuffer/writeTexture(B)
queue.submit(commandBufferC)
```

The complete timeline is prepared before any queue action is replayed. Preparation revalidates live upload data and queue capabilities, simulates logical effects against temporary content-state snapshots, captures the resulting ledger facts, and restores live state. Replay performs the queue write first and commits the corresponding upload `contentEpoch` exactly once only after that call succeeds. Direct upload command execution remains one validation, one queue write, and one epoch advance.

Replay is non-retryable once it begins. If an unexpected synchronous queue call fails after earlier actions were enqueued, only those successful earlier actions keep their logical effects; the failed and later actions do not. This prevents both fabricated epochs and duplicate retries.

Upload-only submissions execute their writes in order, expose no fake command buffer, and register `done` after the final write. Consecutive uploads do not create empty queue submissions. See ADR-029.

### External Image Upload

`ExternalImageUploadCommand` is the explicit external-source upload variant:

```ts
commandKind: 'upload'
uploadKind: 'external-image'
```

It lowers directly to `GPUQueue.copyExternalImageToTexture()`. The command retains the application-owned source object by identity, and the browser captures its current pixels when the native queue call occurs. Scratch performs no CPU pixel extraction, creates no intermediate byte snapshot, and provides no `writeTexture()` fallback. The external source is not a Scratch resource and receives no invented allocation version, content epoch, readiness state, access entry, or producer fact.

After a non-empty native call returns successfully, Scratch advances the target texture's `contentEpoch` exactly once, marks the target ready, and records one target write and producer epoch. The target's `allocationVersion` does not change because the physical texture is unchanged. Direct execution and submission replay use the same effect rule.

A zero-width or zero-height command remains an ordered queue action and still calls `GPUQueue.copyExternalImageToTexture()` so native source usability and argument validation remain observable. It does not advance `contentEpoch`, make the target ready, create a resource access or producer fact, or fabricate a command buffer. If the native call throws, the failed action commits none of these effects; earlier successful actions stay committed and later actions are not replayed. See ADR-030.

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
- **Acknowledged auto staging.** The runtime owns `MAP_READ` staging resources and acknowledges native validation/OOM outcomes before use. User buffers do not need map usage for common readback, but the source needs the appropriate copy usage or an explicit resolve path.
- **Buffer-specific mapping barrier.** Host materialization waits on the staging buffer's `mapAsync()` rather than inserting an extra whole-queue completion wait.
- **Layout-derived views.** Buffer layout from `02-resources` decides whether the result is a `TypedArray`, bytes, or a layout-derived structured view. AoS fields are strided and should not be promised as one contiguous typed array unless explicitly deinterleaved.

## Staging Allocation And Mapping Transaction

The direct and ordered paths share one staging allocator and one mapping
transaction, but acknowledge allocation at different explicit boundaries:

- direct `ReadbackOperation` allocates one ephemeral slot during the first
  materialization, then rechecks source allocation/content epochs before copy
  encoding;
- ordered `ReadbackCommand` owns one acknowledged reusable slot before the
  Promise-only factory resolves, so synchronous submission never allocates it;
- a direct operation reserves `maxPendingOperations` capacity when created and
  `maxStagingBytes` capacity before materialization allocates staging;
- an ordered factory reserves `maxStagingBytes` capacity before allocating its
  reusable slot, while each synchronous submission reserves
  `maxPendingOperations` capacity when it claims that slot, before encoder or
  queue effects;
- every successful reservation is released exactly once across success,
  failure, cancellation, disposal, runtime loss, and device loss.

Mapping issues exactly one `mapAsync(GPUMapMode.READ, 0, byteLength)` under
validation, internal, and out-of-memory error scopes. Every pushed scope is
popped before the first await. The map Promise, all scope Promises, device loss,
and operation lifecycle settle as independent outcomes in fixed transaction
order; native message text and Promise settlement order do not select a stable
code.

The mapping transaction distinguishes `mapping`, `mapped-range`, `host-copy`,
`cleanup`, and `lifecycle-recheck`. `unmap` and staging `destroy` failures use
separate outcome codes under one `SCRATCH_READBACK_CLEANUP_FAILED` incident. If
host bytes were already copied, cleanup failure does not discard those owned
bytes or falsely claim native destruction succeeded.

### Native Copy Observation And Byte Trust

Direct and ordered readback preserve two independent native boundaries.

A direct readback first acknowledges its ephemeral staging allocation. Its
materialization then applies the runtime `submissionScopes` policy to encoder
creation, copy encoding, encoder finish, and queue submit under a readback
target. Copy observation and buffer mapping settle independently, and bytes are
exposed only after both applicable outcomes succeed. With
`submissionScopes: 'off'`, copy provenance is explicitly `unobserved`; a
successful map is not described as validation acknowledgement. Current
`indeterminate` source content fails with
`SCRATCH_READBACK_SOURCE_CONTENT_INDETERMINATE` before staging allocation or
encoder work, including when the operation captured the same epoch before a
delayed submission failure settled.

An ordered readback does not create a second copy or observation. Before mapped
bytes are exposed, it awaits the associated `SubmittedWork.nativeOutcome`. An
`observed-failed` or `observation-failed` staging-copy family makes those bytes
untrusted and rejects materialization. An explicit `unobserved` outcome permits
the mapped bytes while preserving that provenance. Queue-completion rejection
alone remains independent: it can reject `SubmittedWork.done` and record an
enclosing-family incident without fabricating a mapping failure or discarding
separately owned bytes.

Direct copy observation and submission observation share
`maxPendingNativeObservations`. Budget exhaustion occurs before encoder work;
finite `nativeSubmissionDetail: 'step'` capture records the four direct stages
without inventing a submission ID for the readback target.

Each readback has one materialization owner. Concurrent
`retain: 'until-dispose'` readers share one allocation/copy/map and receive
independent clones. A competing `retain: 'consume-on-read'` reader fails with
`SCRATCH_READBACK_IN_PROGRESS` and cannot issue a second native transaction.

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
const readback = runtime.createReadback({
    source: particlePositions,
    retain: 'consume-on-read',
})
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

Mapped-view leasing is a follow-up boundary and is not implemented by this
contract. A future zero-copy or mapped view must be leased because a mapped
range becomes invalid after unmap:

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
const readParticles = await runtime.readbackCommand({
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

The buffer-only `ReadbackCommand` ordered-staging path is implemented. Its Promise-only factory acknowledges the reusable staging slot before returning. It validates the explicit source epoch, records a read-only submission ledger entry, and copies into runtime-owned staging at the declared step. `result({ after })` returns the operation associated with that exact submitted work; materialization maps the existing staging buffer and does not submit a second copy. This remains an escape hatch, not the default readback path. Direct texture readback and mapped leases remain future work; finite staging budgets are implemented runtime policy.

Command disposal blocks new submission and reuse, but does not erase historical
result lookup while the runtime remains active. An operation already linked to
`SubmittedWork` stays retrievable through `result({ after })`, then releases or
destroys the busy slot through its normal cleanup path.

Queue timeline segmentation preserves that declared staging point across queue-side uploads. A readback before an upload submits its staging-copy segment before the queue write; an upload before a readback performs the queue write before submitting the staging-copy segment. Multiple ordered readbacks separated by an upload keep distinct staging buffers, captured epochs, and producer provenance while sharing one aggregate `SubmittedWork` completion handle.

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
- `TextureResource.resize()` advances `allocationVersion`, clears allocation-scoped cached views, and marks the replacement empty. Bind sets and pass attachments lazily resolve new views; stable logical commands remain reusable and fail only when their declared range, readiness, or required epoch no longer validates against the current allocation.
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

Readback retention is explicit ownership, not hidden garbage collection. The
implemented runtime policy is finite and conservative:

- keep an operation until it is consumed, cancelled, disposed, or failed
- fail before native allocation when pending-operation or staging-byte capacity is exceeded
- count retained host bytes separately from GPU staging bytes
- never silently evict a readback result
- keep operation and incident history bounded independently of current facts

Example configuration shape:

```ts
const runtime = await ScratchRuntime.create({
    readback: {
        maxPendingOperations: 16,
        maxStagingBytes: 64 * 1024 * 1024,
    },
})
```

Stale-operation warnings, automatic eviction, and mapped-view lease budgets are
follow-up policy. They are not aliases or optional flags on the implemented
budget contract.

Stable readback provenance codes using the shared envelope from
`09-diagnostics-validation` include:

```ts
type ReadbackDiagnosticCode =
    | 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED'
    | 'SCRATCH_READBACK_STAGING_VALIDATION_FAILED'
    | 'SCRATCH_READBACK_STAGING_OUT_OF_MEMORY'
    | 'SCRATCH_READBACK_STAGING_SCOPE_FAILED'
    | 'SCRATCH_READBACK_COPY_ISSUE_FAILED'
    | 'SCRATCH_READBACK_MAPPING_VALIDATION_FAILED'
    | 'SCRATCH_READBACK_MAPPING_INTERNAL_FAILED'
    | 'SCRATCH_READBACK_MAPPING_OUT_OF_MEMORY'
    | 'SCRATCH_READBACK_MAPPING_SCOPE_FAILED'
    | 'SCRATCH_READBACK_MAPPING_REJECTED'
    | 'SCRATCH_READBACK_MAPPED_RANGE_FAILED'
    | 'SCRATCH_READBACK_HOST_COPY_FAILED'
    | 'SCRATCH_READBACK_CLEANUP_FAILED'
    | 'SCRATCH_READBACK_UNMAP_FAILED'
    | 'SCRATCH_READBACK_STAGING_DESTROY_FAILED'
    | 'SCRATCH_READBACK_IN_PROGRESS'
    | 'SCRATCH_READBACK_CANCELLED'
    | 'SCRATCH_READBACK_OPERATION_DISPOSED'
    | 'SCRATCH_READBACK_SOURCE_CONTENT_INDETERMINATE'
    | 'SCRATCH_READBACK_SOURCE_ALLOCATION_STALE'
    | 'SCRATCH_READBACK_SOURCE_EPOCH_STALE'
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
