# ADR-037: Acknowledge Supporting Objects And Prepare Bind Sets Explicitly

## Status

Accepted

## Date

2026-07-13

## Context

WebGPU returns samplers, query sets, bind-group layouts, texture views, and bind
groups synchronously, while validation, internal, out-of-memory, and device
lifecycle outcomes can settle asynchronously. Scratch currently exposes
synchronous constructors and factories for these objects and lazily creates or
rebuilds bind groups during command use. That presents unacknowledged candidates
as durable state and hides native creation inside submission.

The current BindSet also accepts whole resources and rebuilds after allocation
changes. It cannot represent static buffer ranges, storage textures, an
inspectable preparation transaction, or deterministic concurrency behavior.

## Decision

### Public sync and async boundary

Pure logical objects remain synchronous: `LayoutCodec`, `LayoutArtifact`,
`BufferRegion`, `TextureViewSpec`, `Program`, `Command`, `PassSpec`, and
`SubmissionBuilder`.

The runtime factory pairs `createSampler()`/`sampler()`,
`createQuerySet()`/`querySet()`, `createBindLayout()`/`bindLayout()`, and
`createBindSet()`/`bindSet()` return ordinary native Promises only. There are no
synchronous overloads, `T | Promise<T>` unions, thenables, pending proxies,
background installation paths, public constructors, subclass bypasses, or
static factories. Exported classes remain usable for types and `instanceof`.

### Acknowledged sampler, query-set, and bind-layout creation

Each factory normalizes and preflights its complete descriptor, allocates a
provisional identity and stable label, begins exactly one matching operation,
pushes validation, internal, and out-of-memory scopes, issues exactly one native
create call, and pops every scope before the first `await`. Synchronous throws
and asynchronous scope outcomes remain distinct evidence.

After settlement Scratch rechecks runtime and device lifecycle, then constructs
and registers the wrapper. Failure or cancellation never registers a current
object. Query-set candidates call native `destroy()` when available; candidates
without native destruction are dereferenced without a false destruction claim.

Sampler validation covers the complete current native descriptor. Query-set
validation covers positive count and limits, timestamp feature preflight, and
occlusion without a fabricated feature. Pipeline-statistics queries remain
outside core WebGPU and unsupported.

`BindLayout` is authoritative only for native binding ABI. Its immutable entries
contain group and binding indices, stable names, visibility, buffer binding type,
`hasDynamicOffset`, `minBindingSize`, sampled texture shape, storage texture
access/format/dimension, and sampler type. Names and binding indices are unique.
It owns no resource, `LayoutArtifact`, Program, source, command policy, or scene
semantics. Reflection remains an optional cross-check.

### Immutable BindSet contract

`BindSet` accepts only:

```ts
Record<string, BufferRegion | TextureViewSpec | SamplerResource>
```

It rejects whole resources, native WebGPU objects, legacy wrappers, and
compatibility unions. The normalized slot table is immutable. Rebinding another
logical resource requires another BindSet. Content changes do not invalidate a
prepared bind group; physical allocation changes make its snapshot stale.

`await runtime.bindSet(...)` exposes only an initially prepared object. A failed
initial candidate is never registered. Existing objects expose
`prepare(): Promise<void>` and inspectable `preparing`, `prepared`, `stale`, and
`disposed` states together with preparation generation, prepared snapshot hash,
in-flight operation ID, last successful operation ID, and last incident ID.

Submission accepts only the exact prepared snapshot. Stale, preparing, failed,
or disposed state fails structurally before encoder creation. Submission never
calls `prepare()`, creates a persistent texture view, creates a bind group,
retries, or falls back to an older allocation.

### Snapshot, concurrency, and atomic commit

A preparation snapshot includes acknowledged BindLayout identity, immutable
binding-table signature, parent resource identities and allocation versions,
BufferRegion ranges and layout hashes, TextureViewSpec hashes and normalized
descriptors, and sampler allocation versions.

Concurrent preparation of the same snapshot shares the exact underlying
Promise. A call that sees a different current snapshot while another is pending
fails with a structured conflict; it is not queued and does not trigger an
automatic retry. Allocation drift or lifecycle change before settlement blocks
commit. A pending transaction cannot revive a disposed object.

For each unique texture-view candidate, Scratch independently pushes validation,
internal, and OOM scopes, calls `GPUTexture.createView()` once, and pops all
scopes immediately. It then builds one bind-group candidate, independently
scopes exactly one `GPUDevice.createBindGroup()` call, and pops those scopes.
Every native create and pop is issued before the first `await`.

After independent settlement, Scratch selects the primary failure by stable
causal order and retains secondary evidence. It rechecks runtime, device, object
lifecycle, and the complete allocation snapshot. Native views, bind group,
snapshot hash, and generation commit atomically. Failed candidates are
dereferenced; no partial candidate becomes current.

### Persistent binding parity

Scratch supports every core persistent WebGPU binding family except
`externalTexture`:

- uniform, read-only storage, and writable storage buffers with static range,
  dynamic offset, and `minBindingSize`;
- filtering, non-filtering, and comparison samplers;
- float, unfilterable-float, depth, signed-integer, and unsigned-integer sampled
  textures across every native-valid view dimension and multisample contract;
  and
- write-only, read-only, and read-write storage textures with explicit format
  and native-valid `1d`, `2d`, `2d-array`, and `3d` dimensions.

Unsupported combinations are rejected, not normalized to convenient defaults.
Scratch performs deterministic feature, format, stage, limit, usage, range, and
shape checks where possible; acknowledged native scopes remain final evidence
for implementation-dependent validation.

### Program requirements and dynamic offsets

Program layout requirements own typed shader expectations. Pipeline creation
joins Program requirements with BindLayout ABI: group/binding, binding type,
visibility, dynamic-offset contract, nonzero `minBindingSize`, ABI lower bound,
features, and limits. Command preflight joins the Program requirement with the
actual BufferRegion: ownership, lifecycle, range, usage, alignment, canonical
ABI compatibility, exact schema compatibility, and current allocation snapshot.
`LayoutArtifact` is not moved into BindLayout.

Dynamic offsets belong to one immutable Command BindSet invocation and are
provided by binding name. Exact coverage, finite non-negative integer range,
alignment, and effective bounds are validated at Command construction. Scratch
prelowers one immutable native sequence in binding-index order. Submission does
not sort names or rebuild the sequence. Dynamic offsets do not mutate a region,
BindSet snapshot, or generation.

### Pass attachments

Persistent pass attachments store `TextureViewSpec`, but have no preparation
API. Deterministic validation happens before encoder creation. Submission creates
attachment views under its native observation boundary, attributes failures to
the submission, pass, slot, view, resource, and allocation snapshot, and never
caches the view across submissions. Surface presentation remains a borrowed
submission-scoped current texture and view.

## Alternatives Considered

### Prepare on every use

Rejected. It would turn an explicit immutable command model into a hidden state
machine, add native and Promise churn to frame loops, and repeat the ambiguity of
stateful predecessor APIs.

### Lazy repair after allocation replacement

Rejected. Submission would gain an implicit asynchronous side effect and could
silently bind a different allocation than the caller validated.

### Mutable BindSet updates

Rejected. Mutation complicates snapshot identity and concurrent command reuse.
Another logical binding table is represented by another BindSet.

### Global view or bind-group cache

Rejected. Candidate ownership and replacement invalidation would become shared,
unbounded, and difficult to diagnose.

## Consequences

- Awaited factories become honest acknowledgement boundaries.
- Initial BindSet creation is slower than pure logical construction but produces
  a prepared reusable object.
- Steady-state use performs no preparation operation or native binding creation.
- Allocation replacement requires an explicit `prepare()` call and yields one
  inspectable generation transition.
- The API intentionally removes all synchronous and lazy compatibility paths in
  the same `0.x.x` change.
