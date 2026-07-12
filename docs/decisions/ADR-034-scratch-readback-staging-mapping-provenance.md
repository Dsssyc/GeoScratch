# ADR-034: Acknowledge Readback Staging And Record Mapping Provenance

## Status

Accepted

## Date

2026-07-12

## Context

Scratch exposes two buffer readback paths. A direct `ReadbackOperation` lazily
allocates a staging buffer when host materialization starts. A
`ReadbackCommand` allocates a staging buffer while a submission is encoded so
the copy occurs at an exact ordered step. Both paths eventually map the staging
buffer and return an owned host copy.

The current implementation treats the native staging handles as immediately
usable. `GPUDevice.createBuffer()` returns synchronously, but validation and
out-of-memory outcomes can settle asynchronously through error scopes. The
ordered path can therefore encode an invalid candidate before Scratch knows
whether allocation succeeded. A failed candidate can invalidate the containing
command buffer and make the physical effects of unrelated work unclear.

The current mapping path also collapses allocation, command encoding, queue
submission, `mapAsync()`, `getMappedRange()`, host copying, and cleanup failures
into `SCRATCH_READBACK_MAP_FAILED`. It waits for broad queue completion before
mapping even though WebGPU already makes `mapAsync()` wait for the staging
buffer's GPU use. Cancellation during a pending map can be overwritten by the
expected map rejection caused by `unmap()`.

ADR-032 introduced an always-current fact graph, bounded operation/incident
history, and finite deep capture. ADR-033 expanded that model to explicit
resource/pipeline targets. Readback is neither a persistent user resource nor a
pipeline. Reusing resource fields or retaining live operations in the recorder
would make the evidence false or unbounded.

## Decision

### Submission remains synchronous

`SubmissionBuilder.submit()` remains synchronous. It performs validation,
encoding, and physical queue replay in the calling turn, then returns one
non-thenable `SubmittedWork`. It never conditionally awaits readback work and it
does not defer queue calls into a later microtask.

`SubmittedWork.done` remains the completion barrier for queue work that was
actually replayed. A native queue-completion rejection is wrapped in a
structured submission diagnostic. It does not wait for readback mapping, host
copying, retained results, cancellation, or disposal.

### Promise-only ordered command construction

Both ordered readback command factories return ordinary Promises:

```ts
const command = await runtime.createReadbackCommand(descriptor)
const alias = await runtime.readbackCommand(descriptor)
```

Each factory validates and snapshots the descriptor, allocates the command ID,
reserves readback budget, and issues one staging-buffer allocation transaction.
The transaction pushes out-of-memory then validation scopes, creates exactly
one `MAP_READ | COPY_DST` buffer, pops validation then out-of-memory, retains
both pop Promises before the first await, and observes lifecycle/device loss in
parallel. A command is constructed and registered only after all outcomes
settle successfully.

There is no synchronous overload, compatibility alias, pending command wrapper,
lazy first-submit allocation, retry, or fallback to an unscoped buffer.
`ReadbackCommand` remains public for typing and `instanceof`, but package-private
construction tokens close direct and subclass construction.

The command owns one acknowledged runtime staging slot sized to its immutable
range. One command may appear at most once in a builder. It may be reused across
different submissions only sequentially: submission preflight claims an idle
slot, and another submission using the command fails before encoder creation or
queue effects while that slot is claimed, submitted, mapping, or releasing.
Successful host-copy materialization returns the slot to idle. Command disposal
destroys an idle slot immediately and marks a busy slot for destruction after
its current cleanup owner releases it.

This supersedes ADR-026 only for allocation timing and unrestricted
cross-submission reuse. ADR-026's explicit source epoch, exact ordered copy,
read-only ledger, producer provenance, result lookup, and normal direct-readback
boundary remain accepted.

### Direct staging is acknowledged before use

Creating a direct `ReadbackOperation` remains synchronous because it performs no
native allocation. The first materialization becomes the sole owner of an
ephemeral staging transaction. Scratch reserves budget, issues and acknowledges
the scoped allocation, rechecks runtime/source lifecycle and the captured
allocation/content epoch, and only then creates an encoder or touches the queue.

If allocation or a post-settlement lifecycle check fails, no copy is encoded or
submitted. The candidate is destroyed and every reservation/subscription is
released exactly once. Once the copy has been submitted, Scratch does not claim
rollback of GPU work.

A direct operation with `after: SubmittedWork` does not await `after.done`
before issuing its copy. The prior submission's queue actions have already been
replayed before its synchronous `submit()` returned, so the later queue submit
preserves order. `after` continues to identify the producer submission and the
captured source epoch.

### Mapping is a separate transaction

Both direct and ordered host-copy paths use one shared mapping transaction. It
calls `mapAsync(GPUMapMode.READ, 0, byteLength)` as the buffer-specific host
availability barrier. It does not insert an earlier broad
`queue.onSubmittedWorkDone()` wait.

Where error scopes are available, Scratch pushes out-of-memory, internal, and
validation scopes around the single map issue call and pops all scopes in
reverse order before the first await. The map Promise, each scope Promise,
device loss, and lifecycle changes are independent outcomes. Settlement order
does not select a cause. A rejected `OperationError` is not classified as OOM
unless a matching `GPUOutOfMemoryError` was actually observed.

Failure stages are structural:

```ts
type ScratchReadbackFailureStage =
    | 'staging-allocation'
    | 'copy-issue'
    | 'queue-completion'
    | 'mapping'
    | 'mapped-range'
    | 'host-copy'
    | 'cleanup'
    | 'budget'
    | 'lifecycle-recheck'
```

`getMappedRange()`, the owned host copy, `unmap()`, and staging release are
separate stages. Native message prose is bounded evidence only and never
determines a stable diagnostic code.

### One materialization owner

An operation has at most one in-flight materialization. For
`retain: 'until-dispose'`, concurrent host-copy readers share that one
materialization and each receives an independently owned clone. After the first
host copy, GPU staging is released and repeated reads clone retained bytes.

For `retain: 'consume-on-read'`, the first caller owns materialization. Competing
calls fail deterministically with a structured in-progress diagnostic and never
issue another allocation, copy, or map. Reads after success continue to fail as
already consumed.

`cancel()` and `dispose()` preserve their terminal state while a map is pending.
Scratch may call `unmap()` to cancel native mapping. The resulting expected map
rejection is observed and suppressed as cancellation evidence; it does not
replace the operation state with `failed` and never becomes an unhandled
rejection. Cleanup failure is recorded honestly without invalidating an already
owned host copy or claiming native cleanup succeeded.

### Private native staging ownership

Internal staging buffers are not public readback fields. `ReadbackOperation`,
`ReadbackCommand`, `SubmittedWork`, runtime facts, operation records, incidents,
capture reports, and exported evidence never expose a `GPUBuffer`, mapped
`ArrayBuffer`, mutable operation, or mutable runtime collection.

Operation and command IDs, descriptors, lifecycle, provenance, slot state, and
retention state use ECMAScript-private/package-private storage exposed through
read-only getters. Runtime factories are the only construction path.

### Immutable submitted readback links

Every ordered readback allocates its operation ID during submission preparation.
The returned `SubmittedWork` contains a deeply immutable serializable link:

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

Links do not contain live operations or native handles. They remain unchanged
after source mutation, command reuse, mapping, cancellation, or disposal.
`ReadbackCommand.result({ after })` still returns the exact operation registered
for one command/work pair; no latest-submission lookup is added.

### Schema version 3

Operation records, incident reports, runtime snapshots, captures, and exported
evidence advance together to version 3. Version 2 output and compatibility
conversion are not retained during `0.x.x`.

Targets are explicit:

```ts
type ScratchGpuOperationTarget =
    | ScratchGpuResourceOperationTarget
    | ScratchGpuPipelineOperationTarget
    | { kind: 'command'; commandId: string; commandKind: 'readback' }
    | {
        kind: 'readback'
        readbackId: string
        path: 'direct' | 'ordered'
        sourceResourceId: string
        allocationVersion: number
        contentEpoch: number
        byteLength: number
        commandId?: string
        submissionId?: string
        stepIndex?: number
    }
```

Readback operations use `readback-staging-allocation`, `readback-mapping`, and
`readback-staging-release`. Failures create `readback-failure` incidents with a
structural stage and honest attribution confidence. Command/readback targets do
not receive fabricated persistent-resource footprint or pipeline compilation
facts.

The runtime fact graph contains current command slots and active/retained
readback operations. It separately reports current/peak GPU staging bytes,
current/peak retained host bytes, and active mappings. These collections scale
with current explicit ownership, not runtime age.

Successful history remains bounded by operation count and serialized evidence
bytes. Capacity zero disables successful history but not current facts, failure
handling, budget enforcement, or cleanup. Default records contain no stack,
full descriptor, source bytes, mapped bytes, command payload, or
`SubmittedWork`. Deep capture remains explicit, finite, and self-terminating.

### Readback budget

Runtime readback policy includes finite `maxPendingOperations` and
`maxStagingBytes` limits. Pending-operation and staging-byte capacity is
reserved before native allocation. Exceeding either limit fails before a native
call with `SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED`. Every outcome releases its
reservation exactly once.

GPU staging bytes are Scratch logical allocation facts, not physical residency,
free VRAM, driver padding, or total process/system memory. Retained host bytes
are counted separately and never included in GPU pressure evidence. No result is
silently evicted.

## Alternatives Considered

### Make `SubmissionBuilder.submit()` asynchronous

Rejected. It would add a Promise boundary to every frame submission and make
queue issue timing depend on whether a builder contains readback. Resource-like
preparation belongs before the hot submission path.

### Allocate ordered staging during synchronous submission and settle later

Rejected. An invalid candidate could already have invalidated its command-buffer
segment. Rejecting `SubmittedWork.done` later would report failure but could not
make the physical effects unambiguous.

### Allocate one staging buffer per ordered submission

Rejected. Exact acknowledgement would require asynchronous submission
preparation. A command-owned slot keeps preparation explicit while retaining
sequential command reuse.

### Wait for `SubmittedWork.done` before mapping

Rejected. `mapAsync()` already waits for GPU use of that buffer and can settle
before unrelated queue work. A broad completion wait hides a larger stall and
does not improve mapping attribution.

### Treat every map rejection as OOM

Rejected. WebGPU mapping can reject for validation, cancellation, device loss,
or implementation failure. OOM is reported only when structured native evidence
supports it.

### Add mapped leases or texture readback now

Rejected for this Goal. Mapped leases require view invalidation and lease
ownership; texture readback requires explicit region, aspect, texel layout, and
format decoding. Neither is represented by pretending that host-copy buffer
readback is equivalent.

## Consequences

- Ordered command creation becomes explicitly asynchronous and all consumers
  must `await` it.
- Submission stays synchronous and never receives an unacknowledged staging
  allocation.
- Ordered command reuse is sequential rather than concurrently unbounded.
- Direct readback avoids a broad queue-completion stall and preserves queue
  order through normal submission issue order.
- Mapping and cleanup failures become machine-distinguishable and correlated to
  command, operation, submission step, source epoch, and bounded incidents.
- Runtime memory evidence stays current and bounded by explicit ownership;
  historical evidence stays finite.
- Existing direct/ordered epoch, layout, retention, ledger, producer, and result
  semantics remain intact unless this decision explicitly supersedes them.
- Texture readback, mapped leases, stale-operation warnings/eviction, general
  encoder/finalization/queue provenance, and raw-device tracking remain explicit
  future operation families.
