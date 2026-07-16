# ADR-040: Scratch Lifecycle Authority Stamps

## Status

Accepted

## Date

2026-07-16

## Context

Scratch exposes lifecycle assertions such as `ScratchRuntime.assertActive()` and
`Program.assertUsable()` for explicit public validation. A genuine branded object can
remain extensible, however, and JavaScript permits an own property to shadow a method
in its prototype. Internal correctness therefore cannot depend on dynamically calling
those public methods. A caller could otherwise suppress runtime ownership or disposal
checks without forging the object's private brand.

Pipeline preparation also reads caller-owned Program facts and pipeline descriptor
values. Their getters and iterators may run arbitrary JavaScript, including disposing
the Program or Runtime. A check performed only before sampling becomes stale, while a
check performed only after asynchronous native creation permits avoidable WebGPU work
before reporting the lifecycle conflict.

## Decision

Runtime and Program lifecycle authority is held in module-private state and consumed
through non-virtual internal functions.

- Each `ScratchRuntime` has one private lifecycle cell containing disposed and
  device-lost facts, retained device-loss information, and a monotonically increasing
  lifecycle epoch. Every state transition increments the epoch exactly once.
- Scratch internals use the private Runtime authority directly. Public `assertActive()`
  and lifecycle getters are observations over the same cell, not the authority path
  used by internal lifecycle checks.
- Each `Program` has one private lifecycle cell containing its owning Runtime,
  disposed fact, and lifecycle epoch. Program disposal increments the epoch exactly
  once. Public assertion methods delegate to non-virtual internal authority functions.
- Pipeline preparation captures one immutable Program authority stamp, including the
  exact Program state, its lifecycle epoch, and the owning Runtime authority stamp.
- Scratch validates that stamp after each phase that executes caller-owned Program
  getters or iterators, after materializing the pipeline descriptor and immediately
  before native pipeline issue, and again before committing a successful asynchronous
  native result as a public Pipeline.
- Invalidation before native issue throws the canonical direct Runtime or Program
  lifecycle diagnostic and performs no shader-module, pipeline-layout, or native
  pipeline creation.
- Invalidation after native issue cannot retract WebGPU work already issued. Scratch
  rejects publication of the Pipeline and records the existing structured late
  pipeline-creation lifecycle diagnostic.
- Mutating caller-owned Program facts does not change the lifecycle epoch. A pipeline
  candidate uses its materialized fact snapshot; later candidates observe later facts.
- Scratch does not automatically retry a stale candidate. Getters and iterators may
  have externally visible effects, so replay is not semantically safe.

The authority checks are constant-time identity, boolean, and integer comparisons.
They do not add listeners, wait queues, reverse ownership graphs, or historical logs.

## Rejected Alternatives

### Public `prepare()` or a mandatory lifecycle state machine

Forcing callers to advance every object through a preparation protocol would expose
an avoidable ordering state machine and recreate the implicit sequencing burden that
Scratch is intended to remove. Preparation remains an internal transaction boundary.

### Locking across caller code or asynchronous native work

JavaScript getters and iterators are arbitrary caller code and must not run while
Scratch holds a lock. Holding a lock across a WebGPU promise would also serialize
independent work, complicate cancellation, and still could not undo a native request
already issued. Snapshot plus epoch validation provides the required consistency
without blocking lifecycle transitions.

### Freezing every public object

Freezing can prevent one shadowing mechanism but does not define asynchronous
authority, transaction boundaries, or native commit rules. Extensibility is not used
as a correctness boundary.

### Automatic retry

Retrying would replay caller getters and iterators whose side effects Scratch cannot
roll back. A stale candidate fails deterministically and the caller may explicitly
start a new operation.

### One global Runtime

Multiple devices and replacement runtimes are valid same-realm workflows. Global
singleton policy would hide ownership rather than enforce exact ownership.

## Consequences

- Own-property shadowing of public lifecycle methods cannot suppress Runtime or
  Program ownership and disposal checks on the covered internal paths.
- Reentrant disposal during Program or pipeline descriptor sampling stops before
  avoidable WebGPU creation effects.
- Pipeline creation has an explicit sample, issue, and commit authority boundary
  without adding a public `prepare()` step.
- Native async creation remains honestly uncancellable after issue; Scratch guarantees
  only that an invalidated candidate is not published as a usable Pipeline.
- This decision covers Scratch-internal Runtime lifecycle checks and Program-to-Pipeline
  creation. Other Scratch-owned types require their own focused authority review before
  their public assertion methods are treated as internal security or consistency
  boundaries.
