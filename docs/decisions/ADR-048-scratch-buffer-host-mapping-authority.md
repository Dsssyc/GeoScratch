# ADR-048: Add Scratch Buffer Host Mapping Authority

## Status

Accepted

## Date

2026-07-23

## Context

Scratch models buffers as logical byte containers with stable identity,
allocation versions, content epochs, explicit transfers, and structured
diagnostics. The public `BufferResourceDescriptor` nevertheless still aliases
`GPUBufferDescriptor`, including `mappedAtCreation`, while Scratch exposes no
mapping lifecycle for the native mapped state that this field creates.

That is a correctness hole rather than a cosmetic parity gap. A caller can ask
Scratch to publish a buffer that is unavailable to the GPU, but neither the
resource nor submissions can explain why it is unavailable, who owns the
mapping, when CPU writes become current content, or how mapped views become
invalid.

The 16 July 2026 WebGPU Editor's Draft, revision
`99d2ded3335433260fd756abacc2d2b280999b8d`, defines the relevant native
contract:

- `mappedAtCreation: true` is valid without `MAP_READ` or `MAP_WRITE` and is
  intended for initial data;
- a mapped-at-creation buffer size must be a multiple of four;
- ordinary READ and WRITE mappings respectively require `MAP_READ` and
  `MAP_WRITE`;
- `mapAsync()` permits one pending or active mapping, requires an eight-byte
  offset and four-byte range size, and waits for prior GPU use of that buffer;
- a pending or mapped buffer is unavailable to GPU queue operations;
- `unmap()` cancels a pending map, detaches all returned `ArrayBuffer` views,
  discards READ-side mutations, and commits WRITE-side mutations; and
- `mapAsync()` resolving says nothing about unrelated buffers or queue work.

WGSL does not add a second mapping model. Host mapping changes how CPU code
owns bytes; shader layouts and WGSL access remain independent interpretations
of the same buffer contents.

## Decision

### Mapping is temporal authority, not descriptor shape

The ordinary public descriptor becomes:

```ts
type BufferResourceDescriptor = Omit<GPUBufferDescriptor, 'mappedAtCreation'>
```

`ScratchRuntime.createBuffer()` rejects any own `mappedAtCreation` field,
including `false`, with `SCRATCH_BUFFER_MAPPING_USE_EXPLICIT_FACTORY`. This is
a clean cut during `0.x.x`; there is no compatibility overload.

Scratch adds:

```ts
type MappedBufferResourceDescriptor =
    Omit<GPUBufferDescriptor, 'mappedAtCreation'>

type BufferMappingMode = 'read' | 'write'

type BufferMappingDescriptor = Readonly<{
    region: BufferRegion
    mode: BufferMappingMode
    signal?: AbortSignal
}>

type MappedBufferCreation = Readonly<{
    buffer: BufferResource
    lease: MappedBufferLease
}>
```

with these Runtime methods:

```ts
createMappedBuffer(
    descriptor: MappedBufferResourceDescriptor
): Promise<MappedBufferCreation>

mapBuffer(
    descriptor: BufferMappingDescriptor
): Promise<MappedBufferLease>
```

No `buffer()` alias is added for the mapped factory. The distinct name makes
the CPU ownership transition visible at the call site.

### Closed mapped-view lease

`MappedBufferLease` is a Scratch-owned, non-constructible, non-subclassable,
non-forgeable object. It exposes immutable identity and captured facts:

```ts
readonly id: string
readonly buffer: BufferResource
readonly region: BufferRegion
readonly mode: BufferMappingMode
readonly state: 'mapped' | 'released' | 'failed' | 'disposed'
readonly allocationVersion: number
readonly contentEpoch: number
readonly view: ArrayBuffer
dispose(): void
```

Only the `mapped` state exposes `view`. After release, failure, resource
disposal, Runtime disposal, or device loss, accessing the getter throws a
structured lifecycle diagnostic. A view obtained earlier is not cloned:
native `unmap()` or destruction detaches it according to WebGPU.

Normal `dispose()` is idempotent and calls native `unmap()` at most once. A
synchronous unmap failure records `failed`, marks possible WRITE content
indeterminate, and is never retried implicitly.

### Module-private per-buffer authority

Every Scratch `BufferResource` has one module-private O(1) authority record.
Its externally relevant states are available, pending, and mapped, but those
states are not exposed as a mandatory public preparation machine.

Mapping claims authority before native `mapAsync()`. A second mapping fails
locally with `SCRATCH_BUFFER_MAPPING_CONFLICT` before any native call.
Authority is released exactly once after failure, cancellation, or lease
termination.

The authority uses snapshot-and-recheck lifecycle epochs and callbacks. It
does not hold a lock across caller code or a Promise, does not serialize
unrelated buffers, and never retries automatically.

`AbortSignal` is the only caller cancellation mechanism for a pending ordinary
map. Aborting calls native `unmap()` once so the buffer can remain usable,
waits for the issued mapping and error scopes to settle, releases authority,
and rejects with `SCRATCH_BUFFER_MAPPING_ABORTED`. Scratch does not expose a
second operation-handle cancellation API.

Buffer, Runtime, and device lifecycle transitions use the same authority.
They cancel pending mapping or retire an active lease exactly once and remove
all listeners. Resource or Runtime disposal may then destroy the buffer; no
mapping path destroys a still-owned reusable buffer merely to cancel a map.

### Native acknowledgement

`createMappedBuffer()` issues one native `createBuffer()` candidate with
`mappedAtCreation: true` under the existing allocation scopes. The descriptor
must have a four-byte-aligned size. Scratch does not publish the resource or
lease until validation and out-of-memory scopes settle and Runtime lifecycle
is rechecked.

After acknowledgement, Scratch obtains exactly one whole-range mapped view,
installs the logical resource and mapping authority, and returns the frozen
creation pair. If mapped-range access or installation fails, the candidate is
unmapped/destroyed and no usable public pair escapes.

The logical resource descriptor omits `mappedAtCreation`: it is a temporal
creation path, not persistent allocation shape.

### GPU-use preflight

Pending and active mappings block every Scratch operation that would issue a
GPU use of that buffer:

- queue buffer uploads;
- buffer clear, copy, texture-buffer copy, and query resolve;
- readback source copies;
- vertex, index, and indirect buffer use;
- render or compute binding reads and writes; and
- any selected fallback that actually reaches execution.

The check occurs before the first native effect of a submission attempt.
Direct public command execution/encoding performs the same check locally.

Creating `BufferRegion`, packing or reading LayoutCodec host bytes, describing
a BindSet, and preparing a native bind group do not themselves transfer buffer
ownership to the GPU. They remain legal while mapped. Prepared bindings are
checked when a Draw or Dispatch actually uses them.

Raw `buffer.gpuBuffer` access remains an explicit untracked escape hatch.
Scratch cannot observe a caller mapping that raw object, and does not claim
authority, epoch, or diagnostic guarantees for that path.

### Content epochs

READ lease release never changes `contentEpoch`, even if JavaScript mutates
the returned view, because WebGPU discards those mutations.

Successful WRITE release, including mapped-at-creation, advances
`contentEpoch` exactly once and marks the resource ready. Scratch cannot
observe whether the caller changed a byte, so returning ownership after a
WRITE lease is always one logical producer.

Mapping never changes `allocationVersion` and never creates a Submission,
queue serial, command producer, or SubmittedWork fact.

If WRITE ownership may have exposed bytes but unmap or lifecycle completion is
uncertain, Scratch advances to a new indeterminate epoch. It never rolls back
to a previously ready epoch. A later confirmed producer may recover readiness.

### Structured bounded evidence

General mapping uses `buffer-mapping` operations with a truthful
`BufferResource` target and the `BufferRegion` as a related diagnostic
subject. Stable codes use the `SCRATCH_BUFFER_MAPPING_*` family and distinguish
local validation, native validation, internal error, out-of-memory, scope
settlement, Promise rejection, abort, mapped-range access, lifecycle change,
and release failure.

Schema v5 is retained. The change is additive:

- operation and incident discriminators gain buffer mapping variants;
- snapshots gain `bufferMappings`, containing only current pending or mapped
  facts; and
- snapshots gain a separate `bufferMapping` count/range summary.

General mappings do not increment allocation, readback, or
`readbackMemory.activeMappings` aggregates. Successful mappings do not replace
`lastAllocationOperationId` and do not appear as allocation churn.

The default ledger stores no mapped bytes, full descriptor, native handle, or
unbounded stack. Finite diagnostic capture may retain the already-bounded
descriptor and stack facts under existing budgets.

## Alternatives Considered

### Keep `mappedAtCreation` on `createBuffer()`

Rejected. It publishes a time-varying ownership state through an allocation
shape without returning the capability needed to release that state.

### Expose native `mapAsync()`, `getMappedRange()`, and `unmap()` directly

Rejected. It cannot maintain Scratch epochs, readiness, authority, or bounded
diagnostics and makes use-after-unmap easy.

### Await all submitted work before mapping

Rejected. Native `mapAsync()` is already the buffer-specific barrier. A broad
queue wait adds unrelated latency and invents a stronger guarantee than the
operation needs.

### Make BindSet preparation fail while mapped

Rejected. Mapping is dynamic content ownership, while BindSet preparation is
an allocation-shape artifact. Actual GPU use is the correct validation
boundary.

### Reuse readback mapping operations

Rejected. Readback owns a staging buffer, materializes an owned CPU copy, and
has readback-specific retention and memory budgets. A public zero-copy lease
has different ownership and must not distort readback facts.

## Consequences

- Scratch can express the complete core WebGPU host mapping lifecycle without
  a CPU-side data clone.
- Ordinary buffer creation can no longer hide a mapped native allocation.
- Submission and direct command paths require one additional O(1) authority
  check per distinct buffer use.
- WRITE lease release becomes an explicit content producer.
- General mapping diagnostics remain bounded and separate from readback.
- External textures, render bundles, direct texture readback, readback mapped
  leases, debug markers, shader-module decomposition, and broader LayoutCodec
  support remain separate goals.
