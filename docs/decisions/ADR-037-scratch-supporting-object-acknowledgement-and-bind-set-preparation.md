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
pushes scopes in the exact nesting order out-of-memory, internal, then
validation, issues exactly one native create call, and pops in reverse order:
validation, internal, then out-of-memory. Every pop is issued before the first
`await`. Synchronous throws, rejected scope settlement, and resolved scoped
errors remain distinct evidence.

After every independently issued scope has settled, Scratch rechecks runtime and
device lifecycle, then constructs and registers the wrapper. A lifecycle change
cannot short-circuit scope settlement or replace an already observed synchronous
native or scoped failure as the causal primary. It is retained as secondary
evidence. Failure or cancellation never registers a current object. Query-set
candidates call native `destroy()` when available; candidates without native
destruction are dereferenced without a false destruction claim.

Sampler validation covers the complete current native descriptor. Query-set
validation covers positive count and limits, timestamp feature preflight, and
occlusion without a fabricated feature. Pipeline-statistics queries remain
outside core WebGPU and unsupported.

Unsupported query features or types reject the factory Promise with a structured
diagnostic. `QueryUnsupportedPolicy` and its `warn-disable` or `disable` object
modes are removed: an acknowledged factory either returns a usable QuerySet or
returns no object.

`BindLayout` is authoritative only for native binding ABI. Its immutable entries
contain group and binding indices, stable names, visibility, buffer binding type,
`hasDynamicOffset`, `minBindingSize`, sampled texture shape, storage texture
access/format/dimension, and sampler type. Names and binding indices are unique.
It owns no resource, `LayoutArtifact`, Program, source, command policy, or scene
semantics. Reflection remains an optional cross-check.

Pipeline lowering uses `BindLayout.group` as the native sequence index rather than
caller array order. Sparse groups retain WebGPU's nullable pipeline-layout slots:
groups 0 and 2 lower to `[group0, null, group2]`. Scratch does not create or own an
empty supporting object for the gap.

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

An already prepared call whose current snapshot is unchanged returns one cached
resolved Promise for that preparation generation and performs no operation,
scope, native create, or generation change. `stale` is derived whenever state is
observed or used by comparing the current allocation snapshot with the committed
snapshot. Resources do not retain reverse BindSet listener graphs, and allocation
replacement does not walk or mutate dependent BindSets.

For each unique texture-view candidate, Scratch independently pushes scopes in
the exact order OOM, internal, validation, calls `GPUTexture.createView()` once,
then pops validation, internal, and OOM. It then builds one bind-group candidate
and applies the same scope order around exactly one
`GPUDevice.createBindGroup()` call. Every native create and pop is issued before
the first `await`.

After independent settlement, Scratch selects the primary failure by stable
causal order and retains secondary evidence. Lifecycle notification may explain
why the transaction cannot commit, but cannot short-circuit the pending scope
joins or outrank an earlier synchronous native issue or scoped failure. Scratch
then rechecks runtime, device, object lifecycle, and the complete allocation
snapshot. The lifecycle result is appended before failure selection even when
native failures already exist, so it remains visible as secondary incident
evidence. Native views, bind group, snapshot hash, and generation commit
atomically. Failed candidates are dereferenced; no partial candidate becomes
current.

Primary-failure selection never follows Promise settlement order or native
message text. It sorts complete unbounded transaction facts by this fixed tuple:

1. transaction stage: descriptor/preflight, synchronous native issue, scope
   settlement, resolved scoped error, lifecycle recheck, snapshot recheck, then
   commit;
2. native issue sequence: texture views in normalized binding-index order,
   followed by the bind group; and
3. scope order within one issue: validation, internal, then OOM.

Within lifecycle recheck, runtime disposal precedes device loss, BindSet and
BindLayout disposal, then bound-resource disposal. Snapshot drift follows all
lifecycle failures. The first fact is primary and every remaining independent or
derivative fact is retained as bounded related evidence. Lifecycle collection does
not return after its first match: it records every applicable runtime, device, object,
layout, and distinct bound-resource fact, then applies the fixed ordering once.
If device loss is primary, the runtime-wide `device-loss` incident and the cancelled
operation's `exact-operation` `supporting-object-failure` incident are both retained;
the rejected Promise exposes the latter and relates the former.

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

On devices without `core-features-and-limits`, a sampled or storage texture view
used in a bind group must cover the parent texture's complete array-layer range:
`baseArrayLayer` is `0` and `arrayLayerCount` equals `depthOrArrayLayers`. This is
a native binding restriction, not a blanket prohibition on constructing logical
layer-subset views for other operations.

Unsupported combinations are rejected, not normalized to convenient defaults.
Scratch performs deterministic feature, format, stage, limit, usage, range, and
shape checks where possible; acknowledged native scopes remain final evidence
for implementation-dependent validation.

### Program requirements and dynamic offsets

Program layout requirements own typed shader expectations. Pipeline creation snapshots
those requirements and joins them with BindLayout ABI: group/binding, binding type,
visibility, dynamic-offset contract, nonzero `minBindingSize`, ABI lower bound,
features, and limits. The successful Pipeline retains that immutable snapshot. Command
preflight joins the Pipeline requirement snapshot, not a later mutable Program property,
with the actual BufferRegion: ownership, lifecycle, range, usage, alignment, canonical
ABI compatibility, exact schema compatibility, and current allocation snapshot.
`LayoutArtifact` is not moved into BindLayout.

Dynamic offsets belong to one immutable Command BindSet invocation and are
provided by binding name. Exact coverage, finite non-negative integer range,
alignment, and effective bounds are validated at Command construction. Scratch
prelowers one immutable native sequence and its matching immutable entry sequence
in binding-index order. Submission revalidates current allocation bounds and alignment
against those snapshots; it does not filter or sort entries, sort names, or rebuild the
native sequence. Dynamic offsets do not mutate a region, BindSet snapshot, or generation.

### Pass attachments

Persistent pass attachments store `TextureViewSpec`, but have no preparation
API. Deterministic validation happens before encoder creation. Submission creates
attachment views under its native observation boundary, attributes failures to
the submission, pass, slot, view, resource, and allocation snapshot, and never
caches the view across submissions. Surface presentation remains a borrowed
submission-scoped current texture and view.

Pass timestamp writes require at least one in-range `begin` or `end` query index.
When both are present they must be distinct, matching native WebGPU validation;
Scratch rejects duplicates while creating the persistent PassSpec, before encoder
creation.

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
