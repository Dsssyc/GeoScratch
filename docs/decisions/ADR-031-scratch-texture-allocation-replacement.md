# ADR-031: Replace Texture Allocations Behind Stable Logical Resources

## Status

Accepted

## Date

2026-07-11

## Later Refinement

ADR-032 supersedes this decision's synchronous allocation acknowledgement and failure boundary. `TextureResource.resize()` is now Promise-returning, keeps the old allocation installed while validation and out-of-memory scopes settle, and commits only after scoped native acknowledgement. The stable identity, size-only replacement, version/epoch, downstream invalidation, and no-queue-wait decisions below remain accepted.

## Context

Scratch models a GPU resource as a stable logical object with two independent
version axes: `allocationVersion` identifies its current physical allocation,
while `contentEpoch` identifies logical content produced in that allocation.
The existing `TextureResource` creates one `GPUTexture` and caches views from
that allocation, but it has no public operation for replacing the allocation
when an application explicitly changes the texture extent.

Surface-sized render targets therefore cannot yet retain their logical
identity across an explicit surface resize. Reconstructing the whole resource
graph in application code would also discard reusable `BindSet`, `PassSpec`,
and `Command` objects even though those objects refer to the logical texture,
not to one permanent `GPUTexture`.

WebGPU creates a texture through `GPUDevice.createTexture()` and permits
`GPUTexture.destroy()` to release its storage after previously submitted uses
complete. Texture replacement is consequently a resource-lifecycle operation;
it is not queue work and does not require a CPU wait for queue completion.

## Decision

### Stable logical identity

Add `TextureResource.resize(size)`. A changed normalized size replaces the
physical `GPUTexture` behind the same `TextureResource` object. The resource's
runtime, id, label, object identity, format, usage, dimension, mip-level count,
sample count, view-format contract, and texture-binding view dimension remain
unchanged.

This operation is a lasting primitive. Future tracked or derived size values
must lower to the same explicit allocation-replacement behavior rather than
introducing a parallel replacement mechanism.

### Size-only contract

Construction and resize share one public `TextureResourceSize` grammar:

```ts
type TextureResourceSize =
    | Readonly<{
        width: number
        height?: number
        depthOrArrayLayers?: number
    }>
    | readonly [number, number?, number?]
```

Resize changes only width, height, and depth or array-layer count. Format,
usage, dimension, mip-level count, sample count, `viewFormats`,
`textureBindingViewDimension`, label, and runtime ownership are immutable.
General texture reconfiguration is outside this decision.

### Complete physical descriptor

Scratch materializes and retains the complete supported creation descriptor:

```text
label
size
mipLevelCount
sampleCount
dimension
format
usage
viewFormats
textureBindingViewDimension
```

The normalized size and the materialized `viewFormats` iterable are immutable
snapshots. Caller mutation after construction cannot change a later physical
replacement. Stable identity, descriptor, lifecycle, version, physical
texture, and view-cache state use ECMAScript-private backing slots and are
exposed only through read-only getters. Concrete `TextureResource` handles are
non-extensible and reject subclass construction, so own-property or prototype
shadowing cannot counterfeit those getters. `gpuTexture` may return a
different identity after resize but cannot be assigned by a caller.
Allocation and content transition functions remain module-internal and are
absent from both package entrypoints, so `TextureResource.resize()` is the
only public texture replacement path.

### Deterministic validation

Before replacement, Scratch validates the requested size grammar, positive
integer dimensions, device 2D dimension and layer limits, retained mip-level
validity, retained sample-count constraints, transient-attachment descriptor
constraints, and format block dimensions. Only `undefined` optional size
members receive WebGPU defaults; `null` is invalid input. It also validates the
resource, runtime, device lifecycle, and native `createTexture()` capability.

Deterministic size failures use
`SCRATCH_RESOURCE_DESCRIPTOR_INVALID`. ADR-032 adds operation-specific
validation, out-of-memory, native-exception, and error-scope diagnostics and
preserves the original native error as the diagnostic cause when available.

### Acknowledge before swap

A changed resize performs these observable steps:

1. Normalize and validate the requested size.
2. Derive the next complete physical descriptor.
3. Create the replacement `GPUTexture` inside the ADR-032 validation and
   out-of-memory scope boundary.
4. After both scope promises acknowledge success, install the new texture and descriptor, update the
   normalized size, clear the allocation-scoped view cache, advance
   `allocationVersion` exactly once, and mark the resource `empty`.
5. Destroy the previous `GPUTexture`.

If normalization, native issue, validation, OOM, scope settlement, or lifecycle handling fails, the old texture,
descriptor, views, versions, content epoch, and readiness remain unchanged.
The old allocation is never destroyed before a replacement exists.

Scratch calls `oldTexture.destroy()` immediately after the swap. It does not
call `queue.onSubmittedWorkDone()` first: WebGPU defers physical reclamation
until previously submitted operations using that texture have completed.

### No-op and version semantics

Normalized equality is a true no-op. It does not create or destroy a texture,
clear a view cache, rebuild a bind group, change either version, or alter
readiness.

A changed resize has exactly these logical effects:

```text
allocationVersion = previous allocationVersion + 1
contentEpoch = previous contentEpoch
state = empty
```

Replacement is not content production. The next successful write advances
from the preserved `contentEpoch`; it does not restart from zero.

### Downstream invalidation

Cached `GPUTextureView` objects are allocation-scoped and are discarded on
replacement. A raw view retained by application code remains stale and Scratch
does not attempt to repair it.

`BindSet` compares resource allocation versions, derives the replacement view
from the bind layout's explicit view dimension, revalidates that view against
the current mip/layer extent, and lazily builds one new bind group on next use.
Render attachments preflight their current view before command encoder
creation and explicitly select one 2D mip-level array layer from the current
texture. All attachments in the pass must also retain matching current render
extents and sample counts. On devices without `core-features-and-limits`, an
omitted `textureBindingViewDimension` is derived again from the current
allocation: one layer is `2d`, multiple layers are `2d-array`. A stable
binding consumer whose view dimension no longer matches therefore fails
preflight; core-feature devices may continue to bind an explicit single-layer
`2d` view, and an explicitly preserved `2d-array` binding contract remains
stable in compatibility mode. This is a bind-group validation constraint, not
a generic texture-view or render-attachment constraint. Upload,
external-image upload, and all texture-copy
directions lower against the current physical texture and revalidate current
mip, origin, extent, and layer ranges before a queue side effect.

Stable pass and command objects survive because they retain logical resources.
Readiness and required-epoch validation treat a replacement as empty even
though its logical content epoch is preserved. A `ReadbackOperation` captured
against the old allocation rejects materialization as allocation-stale, while
an earlier `SubmittedWork` remains an immutable historical report of the
allocation it used.

### Explicit surface coordination

Texture resize has no hidden `Surface` ownership or subscription. Applications
coordinate explicitly:

```ts
surface.resize(nextSurfaceSize)
await target.resize(surface.size)
```

Scratch does not install a `ResizeObserver`, poll canvas dimensions, scan
runtime textures, or accept a size-provider closure in this slice. Future
derived size values remain separate policy and must invoke this primitive.

## Alternatives Considered

### Recreate the logical TextureResource

Rejected. It breaks stable identity, forces graph-wide application rewiring,
and discards reusable logical pass, binding, and command objects.

### Model resize as submission work

Rejected. `GPUDevice.createTexture()` is immediate resource creation rather
than an encoder or queue command. Inventing a submission step would fabricate
resource-access and producer-epoch facts.

### Destroy before creating the replacement

Rejected. A deterministic, native, validation, OOM, scope-settlement, or
lifecycle failure would leave the logical resource without a usable allocation
and violate failure atomicity.

### Wait for queue completion before destruction

Rejected. WebGPU already delays reclamation until prior uses complete. A wait
would add an unnecessary CPU synchronization stall.

### Automatically follow Surface size

Rejected. Resource lifecycle and presentation lifecycle are separate. Hidden
coupling cannot express which textures should follow which surface and would
introduce policy into the kernel.

### Add a persistent logical texture-view resource

Rejected for this slice. Existing internal consumers can recreate views from
the current texture, while independently retained raw views have explicit
allocation-scoped lifetime.

## Consequences

- Surface-sized and application-sized textures can change extent without
  changing logical identity.
- Complete descriptor retention becomes a required invariant for every
  replacement.
- Logical identity, provenance, and physical allocation state cannot be
  rewritten through public fields, getter shadowing, subclass construction, or
  an upcast to `Resource`.
- Allocation and content history remain factually separate.
- Existing binding, pass, transfer, readback, and ledger paths must prove that
  they resolve or validate the current allocation at use time.
- Resize performs no queue action, command encoding, producer recording, or
  queue-completion wait.
- Asynchronous native validation and allocation errors are acknowledged through
  ADR-032's Promise-returning scoped operation before replacement commit.
