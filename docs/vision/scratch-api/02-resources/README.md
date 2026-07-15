# Resources

Status: Vision draft
Date: 2026-07-13

## Decision

Scratch resources are stable logical containers. Interpretation and subresource selection live in immutable values rather than mutable resource-global layout state.

The truthful hierarchy is:

```text
Resource
    BufferResource
    TextureResource
    SamplerResource
    QuerySetResource
```

`Resource` owns runtime identity, label, descriptor, kind, allocation lifecycle, and disposal. Only Buffer and Texture own scalar content state, `contentEpoch`, readiness, and known logical footprint. Sampler has no content or readiness semantics. QuerySet tracks state and epoch per indexed slot, not as one scalar object-wide fact.

`BindLayout` and `BindSet` are acknowledged supporting objects, not Resource subclasses. Presentation current textures are submission-scoped borrowed targets, not persistent resources.

Resource-kind authority is closed inside the module. `BufferResource`,
`TextureResource`, `SamplerResource`, and `QuerySetResource` are registered in
module-private `WeakSet` brands at successful construction, and every internal
validation/lowering branch uses those brands. Public `instanceof` remains an ergonomic
JavaScript observation, not an authorization boundary: replacing
`Symbol.hasInstance`, wrapping a raw native object, or using
`Object.create(ResourceClass.prototype)` cannot promote a caller object into a Scratch
resource or bypass runtime ownership, allocation version, content epoch, and lifecycle
facts.

Raw resource descriptors are canonical Scratch inputs, not values left for
implicit Web IDL coercion. Buffer `size` must already be an exact non-negative
safe-integer `GPUSize64`; texture extents, mip counts, and sample counts must
already be positive safe-integer `GPUIntegerCoordinate` values within the native
32-bit domain. Buffer and texture usage must already be integer
`GPUFlagsConstant` values in `[0, 0xffffffff]`. Invalid labels and booleans are
rejected instead of being silently omitted or coerced. This keeps the retained
logical descriptor identical to the descriptor Scratch actually issues. Native `1d`
textures cannot have mipmaps, so `mipLevelCount` must be `1`; Scratch rejects a larger
count before native issue. Valid single-level `1d` textures and their persistent views
remain available subject to the native extent, sample, format, and usage constraints.

## Allocation And Content

`allocationVersion` changes only when a logical resource installs a different physical native allocation. `contentEpoch` changes when bytes or texels are produced. These facts are independent:

- upload, copy, render/storage writes, clear, resolve, and mip generation advance content;
- texture resize replaces allocation, preserves content history, and marks the replacement empty;
- content-only writes never invalidate a prepared BindSet;
- allocation replacement makes each affected BindSet stale until explicit `prepare()` succeeds.

Scratch reports only logical footprint it can derive. It does not claim physical residency or attribute aggregate OOM to one resource.

## BufferResource And BufferRegion

`BufferResource` is a raw physical byte container. It does not own a global layout, element count, or typed byte length. Its current `gpuBuffer` is private-backed authority: the resource instance is non-extensible and the public prototype is frozen, so binding, copy, disposal, and observation cannot be redirected to different native allocations through prototype replacement.

```ts
const storage = await runtime.createBuffer({
    label: 'shared storage',
    size: 1 << 20,
    usage: GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.STORAGE,
})

const whole = storage.region()
const records = storage.region({
    offset: 4096,
    size: 16384,
    layout: recordLayout,
})
```

`BufferRegion` is a frozen, non-extensible logical value created only by `BufferResource.region()` or another region. It stores one parent buffer, normalized absolute `offset` and `size`, and an optional `LayoutArtifact` witness. It owns no memory, identity, epoch, readiness, allocation version, or disposal state.

```ts
const rawChild = records.subregion({ offset: 256, size: 512 })
const typedChild = rawChild.interpretAs(recordLayout)
```

Subregion offsets are relative to the source region and immediately normalize to the parent buffer. Layout is not inherited implicitly. Overlap is legal. `interpretAs()` creates another frozen view without moving bytes; typed-to-typed reinterpretation requires canonical ABI compatibility. A deliberately different physical interpretation must be created explicitly from the parent buffer.

Every range consumer uses BufferRegion: uploads, readback, all buffer sides of copies, vertex/index bindings, indirect arguments, query resolve destinations, and persistent buffer bindings. Parent disposal invalidates every use. Allocation replacement causes bounds, usage, and alignment to be revalidated against the current native allocation.

## LayoutArtifact And LayoutCodec

`LayoutCodec` synchronously prepares CPU packing, WGSL accessors, and readback views from one immutable `LayoutArtifact`:

```ts
const codec = layoutCodec({
    name: 'Particle',
    fields: [
        { name: 'position', type: 'vec3f' },
        { name: 'mass', type: 'f32' },
    ],
}, {
    usage: [ 'storage', 'readback' ],
})

const particleLayout = codec.artifact
```

Each artifact exposes two separate facts:

- `abiHash` identifies normalized GPU-visible alignment, offsets, sizes, strides, and physical types;
- `schemaHash` identifies logical names, field names/order, nesting, and semantic types.

Short hashes are bounded identifiers, not collision-proof proof. Scratch also retains and compares immutable canonical ABI/schema signatures. Typed Program requirements default to exact schema compatibility; native binding separately validates ABI, usage, range, and alignment. ABI-compatible schema reinterpretation is never automatic.

Layout lowering publishes an artifact only when every array count, byte-size product,
field offset/end, and final alignment round-up remains a non-negative
JavaScript safe integer representable by the generated WGSL `u32` constants, whose
maximum is `0xffffffff`. Overflow in either domain fails closed with
`SCRATCH_LAYOUT_UNSUPPORTED_FORMAT` and structured arithmetic facts; Scratch never
publishes an internally self-invalid `LayoutArtifact`.

`usageCompatibility.uniform` is the portable WGSL uniform-address-space result without
the optional `uniform_buffer_standard_layout` language extension. The common
host-shareable/storage ABI is retained rather than silently repacked: every array field
must have both a 16-byte-aligned field offset and an `arrayStride` divisible by 16.
Scalar and `vec2` arrays with natural 4-byte or 8-byte stride therefore report
`uniform: false`, while aligned `vec3`, `vec4`, and `mat4x4` arrays remain compatible.
Extension-specific compatibility must become an explicit capability-aware contract; it
must not silently widen this portable fact.

## TextureResource And TextureViewSpec

`TextureResource` is a stable logical texture whose current `GPUTexture` allocation may be replaced explicitly:

```ts
const color = await runtime.createTexture({
    label: 'scene color',
    size: surface.size,
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
})

const sampled = color.view({
    dimension: '2d',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
})
```

`TextureResource.view()` is synchronous. It normalizes all descriptor defaults and returns a frozen `TextureViewSpec`; it never calls native `createView()` and never exposes a `GPUTextureView`. The spec remains attached to the logical texture and is revalidated against every later allocation.

View usage is validated as a real native contract, not only as a bit subset. A view of a transient attachment must retain the texture's exact usage. A view with `RENDER_ATTACHMENT` usage must use a device-enabled renderable format, while a view with `STORAGE_BINDING` usage must use a plain color format with at least one device-enabled storage access mode. Texture allocation preflight applies the same render/storage format capability facts. Scratch keeps those facts in one internal table shared with storage-texture BindLayout validation so the logical recipe cannot survive until native `createView()` with a deterministically invalid usage/format pair.

BindSet preparation privately owns allocation-scoped native views for its candidate snapshot. Render attachments lower `TextureViewSpec` into submission-scoped native views and observe their native outcome through `SubmittedWork`; they are never cached across submissions. A raw `texture.gpuTexture.createView()` call is an explicit escape from Scratch ownership, versioning, diagnostics, and repair guarantees.

`TextureResource.resize()` is a Promise-returning create-before-swap transaction. It keeps the old allocation current until the candidate is acknowledged, then atomically installs the replacement, advances `allocationVersion` once, preserves `contentEpoch`, marks content empty, and destroys the old texture. Failure or lifecycle cancellation leaves the old allocation installed. A normalized same-size resize is a true no-op.

A logical view descriptor that is incompatible with the replacement causes deterministic preflight failure. A compatible view remains the same logical object; dependent BindSets become stale and require explicit preparation, while persistent pass specs lower the current allocation at each submission.

## SamplerResource

Sampler creation is Promise-only:

```ts
const sampler = await runtime.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
})
```

Scratch validates the complete native descriptor, issues one `createSampler()` candidate under validation/internal/OOM scopes, and registers it only after acknowledgement and lifecycle rechecks. The acknowledged `gpuSampler` identity is private-backed and immutable: callers can observe it but cannot replace the native handle used by binding, including through prototype replacement. The resource instance is non-extensible and its public getter prototype is frozen. SamplerResource has allocation lifecycle and disposal, but no scalar content state, content epoch, readiness, or footprint.

## QuerySetResource

Query-set creation follows the same acknowledged candidate protocol:

```ts
const queries = await runtime.createQuerySet({
    type: 'timestamp',
    count: 2,
})
```

Core query types are `timestamp` and `occlusion`. Timestamp requires the native feature; occlusion does not fabricate one. The acknowledged `type`, `count`, and `gpuQuerySet` identity are private-backed immutable facts, so slot publication, native resolve, and disposal always refer to the same allocation. Prototype replacement cannot redirect those getters: the resource instance is non-extensible and the getter prototype is frozen. `queries.slot(index)` and `queries.slots()` return frozen indexed snapshots containing `state` and `contentEpoch`. QuerySetResource has no scalar content epoch or ambiguous whole-object readiness. Pipeline statistics remain outside core WebGPU and outside Scratch core.

## Readiness

Buffer and Texture content state is:

```ts
type ResourceState = 'empty' | 'ready' | 'indeterminate'
```

`indeterminate` means a delayed native or queue failure prevents Scratch from proving that still-current content matches its historical epoch. It never rolls an epoch back. A later explicit producer advances a new epoch and restores `ready`. Indexed query slots use the same content-state vocabulary independently.

Disposal is allocation lifecycle, exposed separately through `resource.isDisposed`; it is never folded into scalar or indexed content state.

Indeterminate reads fail structurally as
`SCRATCH_COMMAND_RESOURCE_CONTENT_INDETERMINATE`,
`SCRATCH_QUERY_SLOT_CONTENT_INDETERMINATE`, or
`SCRATCH_PASS_ATTACHMENT_CONTENT_INDETERMINATE`, according to the subject.

Readiness policy belongs to the Command or Pass using content, not to the container. It cannot hide `indeterminate` content or bypass lifecycle, ownership, usage, range, schema, or binding validation.

## Non-Goals

- No resource-global mutable layout or implicit typed buffer interpretation.
- No public Scratch-managed native texture-view cache.
- No runtime resource search or reverse dependency graph.
- No automatic BindSet preparation after allocation replacement.
- No physical VRAM estimate presented as known fact.
- No scene, material, style, layer, terrain, or flow policy in Scratch core.
