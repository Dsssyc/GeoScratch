# ADR-072: Own Retained Worker Contexts Through Typed Pools

## Status

Accepted

## Date

2026-08-14

## Context

ADR-056 established a generic `WorkerSystem`; ADR-070 made Worker modules deployable
without Vite-specific URL glue. The Underwater Terrain example still repeated a lower-level
assembly sequence: construct a system, construct one fixed group, open one retained
context per shard, manufacture initial facts on the main thread, interpret remote
errors structurally, and coordinate two layers of disposal. Geo's Virtual Raster
adapter repeated the group and context lifecycle and accepted configurable operation
names that TypeScript could not relate to the Worker implementation.

That duplication made the example responsible for generic concurrency lifecycle and
allowed caller and implementation signatures to drift. Moving DEM fetch, decode, or
cache policy into Scratch would be the wrong correction because those remain business
operations. The reusable missing primitive is the ownership and protocol boundary.

## Decision

Scratch provides two orthogonal additions:

1. `WorkerModuleProtocol` declares module and retained-context operation input/output
   types. `defineWorkerModuleContract<Protocol>()` checks the Worker implementation,
   while typed context-pool calls use the same operation map. Transfer results remain
   valid implementations of a declared output.
2. `WorkerContextPool` owns one fixed group and retained context set. Its descriptor
   explicitly selects a borrowed or owned `WorkerSystem`. It validates all context
   descriptors before allocation, rolls back partial initialization, exposes bounded
   facts, and disposes idempotently. An idle pool gives remote context finalizers a
   bounded grace period; a pool with queued or active work, or a finalizer that exceeds
   that period, terminates the group so non-cooperative code cannot block lifecycle
   convergence. Facts distinguish each termination mode.

`recommendedWorkerCount` centralizes a bounded hardware-concurrency heuristic.
`workerRemoteErrorFacts` and `workerRemoteErrorCode` expose remote application facts
only from branded Scratch Worker diagnostics rather than accepting lookalike objects.

Geo's `VirtualRasterWorkerModuleProtocol` fixes the seven semantic context operations
required by the Virtual Raster request path. `createVirtualRasterWorkerExecutor`
composes `WorkerContextPool` with `TaskPhaseBudget`, requires explicit system
ownership, queries initial facts from every live context, and reports the pool's
terminal state. It no longer supports operation-name aliases or callbacks that
fabricate initial and disposed facts. Its business snapshots are explicitly labelled
`live` or `last-observed-before-disposal`; terminal context, group, and system facts
remain the lifecycle authority.

The Underwater Terrain example keeps its Worker module, cache policy, URL construction, candidate
metadata, sharding values, and missing-tile classification. Its thin executor assembly
chooses the owned-system policy and supplies those source-specific values to Geo.

## Consequences

- Applications with fixed retained Worker contexts do not repeat group creation,
  rollback, context lookup, or system-ownership disposal.
- A module's business protocol is checked at both implementation and typed call sites.
- Worker, Geo, and DEM dependency direction remains `DEM -> Geo -> Scratch`; Scratch
  acquires no tile, cache, raster, GPU, or DEM semantics.
- `WorkerContextPool` does not replace dynamic `WorkerGroup` scheduling. Callers that
  need elastic groups, task isolation, or direct context ownership still use the
  lower-level Worker API.
- Forced convergence can skip a remote context finalizer when work is still active.
  Modules that require durable commit must complete or cancel that work before pool
  disposal; cache state is recovery-oriented and cannot make termination contingent
  on an uncooperative task.
- A timed-out finalizer produces a structured `WORKER_CONTEXT_DISPOSE_TIMEOUT`
  diagnostic after the pool reaches its disposed state. Callers can report cleanup
  incompleteness without leaving Worker ownership alive.

## Rejected Alternatives

- **Move the complete DEM Worker executor into Scratch:** rejected because tile URLs,
  cache coherence, candidate settlement, and missing-tile meaning are domain policy.
- **Keep lifecycle assembly in every example:** rejected because ownership and rollback
  are generic mechanics with identical failure modes.
- **Infer system ownership from whether a system object was supplied:** rejected because
  disposal authority would become implicit.
- **Keep configurable operation names:** rejected because aliases erase the shared
  TypeScript protocol and create multiple spellings for one Geo semantic contract.
- **Always wait for context finalizers:** rejected because a non-cooperative active task
  could prevent application disposal forever.
