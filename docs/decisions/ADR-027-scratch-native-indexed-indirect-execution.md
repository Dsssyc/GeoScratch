# ADR-027: Complete Native Indexed And Indirect Execution

## Status

Accepted

## Date

2026-07-10

## Context

Scratch already lowered static non-indexed draws to `draw(...)` and static dispatches to `dispatchWorkgroups(...)`. The target command model also named indexed draws and GPU-produced indirect counts, but the public implementation could not call `setIndexBuffer`, `drawIndexed`, `drawIndirect`, `drawIndexedIndirect`, or `dispatchWorkgroupsIndirect`.

That gap prevented Scratch from expressing a core WebGPU execution path. A compute command could produce argument bytes on the GPU, but consuming those bytes required leaving the Scratch command model or introducing an invalid CPU materialization step. The existing explicit resource-read contract, content epochs, submission readiness simulation, and submitted-work ledger already provided the dependency facts needed by native indirect commands.

## Decision

Add public static indexed and indirect count contracts:

```ts
type DrawCount =
    | StaticDrawCount
    | StaticIndexedDrawCount
    | IndirectCommandCount

type DispatchCount =
    | StaticDispatchCount
    | IndirectCommandCount
```

`DrawCommandDescriptor` is a TypeScript union:

- static vertex counts forbid `indexBuffer`;
- static index counts require `indexBuffer`;
- an indirect count without `indexBuffer` lowers to `drawIndirect`;
- an indirect count with `indexBuffer` lowers to `drawIndexedIndirect`.

`DrawIndexBufferBinding` carries the `BufferResource`, `GPUIndexFormat`, offset, and optional size. Scratch validates runtime ownership, disposal, `GPUBufferUsage.INDEX`, format, element alignment, and range before encoding `setIndexBuffer`.

Indirect draw and dispatch counts carry a `BufferResource` and optional byte offset. Scratch validates runtime ownership, disposal, `GPUBufferUsage.INDIRECT`, four-byte offset alignment, and the native argument block size: 16 bytes for `drawIndirect`, 20 bytes for `drawIndexedIndirect`, and 12 bytes for `dispatchWorkgroupsIndirect`. Scratch never maps or interprets the argument bytes.

Every vertex, index, and indirect buffer must also appear in `resources.read` with an explicit required `contentEpoch`. The typed command fields identify the fixed-function role; `resources.read` remains the authoritative epoch contract. Missing declarations fail with `SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE`. Submission validation and `SubmittedWork.resourceAccesses` reuse the existing declared-read path, so same-submission GPU producers work without a parallel dependency system.

Direct draw and dispatch arguments are validated as WebGPU integer domains. Zero counts remain legal no-op values. Static dispatch dimensions must not exceed `maxComputeWorkgroupsPerDimension`; indirect values remain GPU data and are not copied to the CPU for prevalidation.

## Alternatives Considered

### Read indirect arguments on the CPU and call direct methods

Rejected. It introduces synchronization and a GPU-to-CPU roundtrip where WebGPU already exposes native indirect commands. It also hides the real GPU dependency from submission validation.

### Add only indirect dispatch first

Rejected. `drawIndirect`, `drawIndexedIndirect`, and `dispatchWorkgroupsIndirect` are one native GPU-driven execution family. Leaving only one direction implemented would preserve an arbitrary capability gap and force another public contract revision.

### Add indirect draw without static indexed draw

Rejected. `drawIndexedIndirect` requires an index-buffer contract. Once that contract exists, omitting `drawIndexed` would leave another core render encoder method unexpressed for no architectural benefit.

### Infer fixed-function resource epochs

Rejected. Capturing the current epoch would make commands silently drift and would break same-submission future-epoch declarations. Shader inspection and bind-set contents are helpers, not the authoritative dependency contract.

### Add CPU-dynamic resolver closures in the same change

Rejected. Resolver closures require a stable `SubmissionContext` and tracked dynamic-value model. They are CPU orchestration, not part of native WebGPU execution parity, and remain future work.

## Consequences

- Scratch expresses all direct/indirect draw and dispatch encoder methods in the current target family.
- Compute-produced argument buffers flow directly into later GPU commands without host materialization.
- Index and indirect reads participate in readiness, epoch validation, and submitted-work ledgers without advancing content epochs.
- Invalid descriptor pairings fail in TypeScript and are also guarded at runtime for JavaScript callers.
- `SCRATCH_COMMAND_INDEX_BUFFER_INVALID` joins the structured command diagnostic set.
- CPU-dynamic count resolvers, non-throw readiness execution, multi-draw extensions, render bundles, and automatic scheduling remain separate future decisions.
