# ADR-026: Add Scratch ReadbackCommand Ordered Staging

## Status

Accepted

## Date

2026-07-10

## Context

`ReadbackOperation` is the normal Scratch GPU-to-CPU path. It captures a buffer source and lazily creates a runtime-owned staging copy when host materialization begins. That default keeps host synchronization explicit without requiring users to manage `MAP_READ` buffers.

Lazy staging cannot express every ordering requirement. Some workloads need to capture bytes between two commands in one submission, before a later command overwrites the same source. Performing the copy when `toBytes()` or `toArray()` is called would read a different content epoch.

The Scratch API vision reserves `ReadbackCommand` for this uncommon case. It must insert staging at an exact `SubmissionBuilder` position while still returning a `ReadbackOperation` for host materialization and lifecycle management.

## Decision

Add a buffer-only `ReadbackCommand` with an explicit source epoch:

```ts
type ReadbackCommandDescriptor = {
    label?: string
    source: {
        resource: BufferResource
        contentEpoch: number
    }
    sourceOffset?: number
    byteLength?: number
    range?: ReadbackRange
    retain?: ReadbackRetentionPolicy
    whenMissing: 'throw'
}
```

`ScratchRuntime.createReadbackCommand(...)` and `ScratchRuntime.readbackCommand(...)` create the command. `SubmissionBuilder.readback(command)` places it in submission order. `ReadbackCommand.result({ after: submitted })` returns the one `ReadbackOperation` created for that command and `SubmittedWork`; there is no implicit latest-submission lookup.

Submission validation treats the command as a read-only step:

- command ownership and disposal checks are structural errors in every validation mode;
- source readiness and required `contentEpoch` use the existing submission simulation;
- `throw`, `warn`, and `off` retain their existing validation disposition;
- the source must be a `BufferResource` with `GPUBufferUsage.COPY_SRC`;
- the range follows the existing `ReadbackOperation` buffer range rules.

Submission encoding allocates a runtime-owned staging buffer with `MAP_READ | COPY_DST` and records one `copyBufferToBuffer` at the readback step. It captures the source content epoch, allocation version, and the most recent producer before that step. A later write in the same submission does not change the staged bytes or their provenance.

The resulting scheduled `ReadbackOperation` waits for the submitted work and maps the staging buffer that already exists. It does not create another command encoder, submit another copy, or revalidate the live source after staging. The normal `runtime.readback(...)` path remains lazy and keeps its existing pre-staging source freshness checks.

`SubmittedWork.resourceAccesses` records one source read with `stepKind: 'readback'` and `commandKind: 'readback'`. The command does not advance a user resource `contentEpoch`, does not change `allocationVersion`, and does not create a producer epoch. A producer epoch is associated with the operation only when an earlier step in the same submission produced the captured source epoch.

## Alternatives Considered

### Make all readback eager

Rejected. Most host reads do not require a staging copy at a specific command-graph position. Eager staging would change the normal `ReadbackOperation` cost and lifecycle contract.

### Stage when `result(...)` is called

Rejected. That would lose command order and could read contents written after the declared readback step.

### Return bytes or a promise directly from the command

Rejected. Host materialization still needs the established `ReadbackOperation` lifecycle, retention, cancellation, disposal, layout views, and structured diagnostics.

### Infer the latest submitted work

Rejected. Reused commands can participate in more than one submission. Requiring `{ after }` keeps result identity explicit and deterministic.

### Accept a bare BufferResource source

Rejected for the command API. Submission-order validation requires an explicit source `contentEpoch`. The normal lazy `ReadbackOperation` may continue to capture the live epoch from a bare source at operation creation.

### Add texture readback and budget policy in the same slice

Rejected. Texture-to-buffer GPU copies already have an explicit `CopyCommand` direction, while direct texture host materialization requires a separate region/layout contract. Staging budgets and mapped leases require runtime policy beyond this ordered-copy primitive.

## Consequences

- Scratch can capture buffer bytes at an exact command-graph position without a CPU roundtrip between GPU commands.
- Scheduled and lazy readback share one public `ReadbackOperation` lifecycle but have distinct staging behavior.
- Scheduled materialization never submits a hidden second copy.
- Source reads participate in submission diagnostics and ledgers without producing user resource epochs.
- Repeated `result({ after })` calls for the same command and submission return the same operation.
- Direct texture readback, mapped leases, staging budgets, range-level epochs, automatic scheduling, and non-throw readback readiness policies remain future work.
