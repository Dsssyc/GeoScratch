# Bindings

Status: Vision draft
Date: 2026-07-13

## Decision

Scratch separates native binding ABI from concrete resource selection:

- `BindLayout` is the authoritative, immutable WebGPU binding ABI.
- `BindSet` freezes one name-to-resource-view mapping and owns one acknowledged prepared native snapshot.
- `Program.layoutRequirements` carries typed shader schema expectations.
- `Command` combines a pipeline, bind-set invocations, dynamic offsets, and explicit resource access for one executable action.

Vertex buffers, index buffers, indirect arguments, counts, readiness policy, shader source, and scene or material semantics do not belong in `BindSet`.

## BindLayout

Bind-layout creation is Promise-only because success claims a persistent native `GPUBindGroupLayout`:

```ts
const terrainLayout = await runtime.createBindLayout({
    label: 'terrain group',
    group: 0,
    entries: [
        {
            binding: 0,
            name: 'camera',
            type: 'uniform',
            visibility: [ 'vertex' ],
            minBindingSize: 256,
        },
        {
            binding: 1,
            name: 'nodes',
            type: 'read-storage',
            visibility: [ 'vertex' ],
            hasDynamicOffset: true,
        },
        {
            binding: 2,
            name: 'dem',
            type: 'texture',
            sampleType: 'float',
            viewDimension: '2d',
            visibility: [ 'fragment' ],
        },
        {
            binding: 3,
            name: 'linear',
            type: 'sampler',
            samplerType: 'filtering',
            visibility: [ 'fragment' ],
        },
    ],
})
```

Scratch preflights names, binding indices, visibility, device features, limits, buffer type, dynamic-offset contract, `minBindingSize`, sampled-texture shape, storage-texture access/format/dimension, and sampler type. The acknowledged transaction issues exactly one native layout creation call and registers the object only after validation, internal, and OOM scopes settle and lifecycle facts are rechecked.

The acknowledged layout instance is non-extensible and `BindLayout.prototype` is frozen. Its native layout, identity, lifecycle observation, and validation methods therefore remain one authority after publication rather than caller-replaceable prototype behavior.

Supporting-object acknowledgement joins every scope issued around the same
native issue before selecting a result. A concurrent runtime-disposal or
device-loss lifecycle fact cannot race that join, hide an already observed
native/scope failure, or become primary merely because it settled first. Scratch
orders the complete evidence as synchronous native issue, structural scope
failure, validation, internal, OOM, runtime disposal, then device loss; later
lifecycle facts remain bounded secondary evidence. The same rule applies to
sampler, QuerySet, BindLayout, and BindSet preparation candidates. Runtime
disposal and device loss are not mutually exclusive: when both are observed,
both remain in that fixed order.

When device loss is the primary supporting-object failure, Scratch retains two
different scopes of evidence: the runtime-wide `device-loss` incident and an
`exact-operation` `supporting-object-failure` incident linked to the cancelled
creation/preparation operation. The thrown diagnostic points to the latter and
relates the former; neither incident substitutes for the other.

Pipeline lowering treats `BindLayout.group` as the native pipeline-layout index. Caller array order is not semantic: sparse groups produce explicit `null` slots, so groups `0` and `2` lower to `[group0, null, group2]`. Current WebGPU defines `bindGroupLayouts` as a nullable sequence and initializes omitted indices as native `null` slots; Scratch does not synthesize empty `GPUBindGroupLayout` objects for those gaps. Limits that WebGPU defines across a complete `GPUPipelineLayout` are checked again over the concatenated entries from every non-null group. Two layouts that are individually within a dynamic-buffer or per-stage slot limit can therefore still be rejected together before any native pipeline object is issued.

The persistent matrix covers:

- uniform, read-only storage, and read-write storage buffers;
- filtering, non-filtering, and comparison samplers;
- float, unfilterable-float, depth, signed-integer, and unsigned-integer sampled textures, including every native-valid view dimension and multisampled constraints;
- write-only, read-only, and read-write storage textures with explicit format and native-valid `1d`, `2d`, `2d-array`, or `3d` dimensions.

On a device without `core-features-and-limits`, WebGPU bind-group validation
requires every bound sampled or storage texture view to use `baseArrayLayer: 0`
and an `arrayLayerCount` equal to the parent texture's complete layer count. A
layer-subset `TextureViewSpec` can remain a valid logical/native view for other
operations, but Scratch rejects it as a persistent binding on such a device.

Sampler normalization preserves the numeric semantics of WebGPU's
`[Clamp] unsigned short maxAnisotropy`: numeric inputs are clamped to
`[0, 65535]` and rounded to the nearest integer with ties going to the even
integer before descriptor hashing or native issue. Scratch then applies the
WebGPU requirements that the normalized value is at least `1` and values above
`1` use linear mag, min, and mipmap filters. The typed Scratch descriptor still
requires a JavaScript `number`; it does not add string or object coercion.

The `storage` buffer binding follows WebGPU's read-write storage contract. Every
command that binds it must declare the parent buffer in both `resources.read` and
`resources.write`. The required read epoch must already be available, so a new
buffer must be initialized by an explicit upload, copy, or earlier GPU producer
before the command can use the binding.

`externalTexture` is deliberately excluded until its frame/task lifetime has a separate contract. Shader reflection may cross-check an explicit layout, but it is never the production source of truth.

## BindSet

The only persistent binding values accepted by core are:

```ts
Record<string, BufferRegion | TextureViewSpec | SamplerResource>
```

Whole buffers, whole textures, native GPU objects, and legacy wrappers are rejected. Resource selection is explicit and many-to-many:

```ts
const terrainSet = await runtime.createBindSet(terrainLayout, {
    camera: cameraBuffer.region({ size: 256, layout: cameraLayout }),
    nodes: sharedBuffer.region({ offset: 4096, size: 16384, layout: nodeLayout }),
    dem: demTexture.view({ dimension: '2d' }),
    linear: linearSampler,
})
```

The binding table is immutable. Its read-only snapshot owns a private map, freezes both
the snapshot instance and its prototype, and therefore cannot have `get()`, `values()`,
or iteration redirected after construction. Validation, preparation, and encoding all
observe the same slot table. A different logical resource mapping requires a different
BindSet. Content writes do not change native binding shape and never invalidate
preparation.

The BindSet instance is non-extensible and `BindSet.prototype` is frozen. In particular,
`preparationState`, lifecycle observations, `assertPrepared()`, and `prepare()` cannot be
replaced to disguise a stale allocation snapshot or recover an old native bind group.

Binding identity authority is closed independently of those public observations.
Successful `BindLayout` and `BindSet` construction installs one corresponding
module-private `WeakMap` state record. `isBindLayout()` and `isBindSet()` require both
the exact built-in prototype and that private record before any `assertRuntime()`,
lifecycle, preparation, pipeline-layout, shader-inspection, or native binding work.
A record that merely supplies similarly named methods is not a binding object; public
`instanceof`, replacement of `Symbol.hasInstance`, subclass prototypes, and
`Object.create(BindLayout.prototype)` / `Object.create(BindSet.prototype)` do not grant
authority.

`await runtime.createBindSet(...)` returns only an initially prepared object. Preparation privately creates allocation-scoped texture views and one bind group, then commits them atomically after native scope acknowledgement and lifecycle/snapshot rechecks. Identical texture views may be deduplicated only inside that one candidate. There is no runtime-wide or cross-BindSet native-view cache.

## Preparation Lifecycle

A BindSet exposes:

- `preparationState`: `preparing | prepared | stale | disposed`;
- `prepareGeneration`;
- `preparedSnapshotHash`;
- current and last preparation/incident identifiers.

Allocation replacement inside an already-bound logical resource makes the snapshot stale. Submission never prepares, waits, retries, or repairs it:

```ts
await colorTexture.resize(nextSize)

// The logical view and slot mapping are unchanged, but the native snapshot is stale.
await colorSet.prepare()
```

A stale, preparing, failed, or disposed set fails structurally before encoder creation. Successful re-preparation increments generation exactly once. Failure leaves the set stale and discards all candidate native references; explicit retry is allowed.

Concurrent calls for the same current snapshot share one in-flight Promise. A call that observes a different snapshot while preparation is pending fails with a structured conflict diagnostic; it is not queued or restarted in the background. Allocation drift, disposal, runtime shutdown, or device loss prevents commit.

## Dynamic Offsets

Dynamic offsets belong to an immutable command invocation, not mutable BindSet state:

```ts
const draw = runtime.createDrawCommand({
    pipeline,
    bindSets: [ {
        set: terrainSet,
        dynamicOffsets: {
            nodes: 1024,
        },
    } ],
    count: { vertexCount: 3 },
    resources,
    whenMissing: 'throw',
})
```

Every dynamic entry must be named, including explicit zero. Missing, extra, fractional, negative, non-finite, or out-of-range values fail during command construction. Scratch normalizes names into native binding-index order once and stores an immutable offset sequence. Submission performs no name sorting or offset-sequence reconstruction.

For a buffer binding:

```text
effectiveOffset = region.offset + dynamicOffset
effectiveSize = region.size
```

Bounds and uniform/storage alignment are revalidated against the current allocation before encoder creation. Different commands may reuse one prepared BindSet with different offsets without changing its snapshot or generation.

## Program Compatibility

Validation remains layered:

1. Pipeline creation compares `Program.layoutRequirements` with `BindLayout` ABI facts: group/binding, visibility, buffer type, dynamic-offset contract, `minBindingSize`, device features, and limits.
2. Command preflight compares the bound `BufferRegion` with the Program requirement: runtime/lifecycle, current allocation, usage, range, alignment, canonical ABI compatibility, and exact canonical schema compatibility.
3. Declared command resource access must cover every buffer or texture read/write implied by bindings, including storage-texture access.

`abiHash` and `schemaHash` are bounded diagnostic identifiers, not collision-proof evidence. Compatibility also compares immutable canonical signatures and reports a bounded structural difference.

## Non-Goals

- No mutable rebinding or `BindSet.set()`.
- No hidden resource search, shader-driven auto-binding, or reverse resource-to-BindSet graph.
- No submission-time native binding creation or automatic preparation.
- No raw ordered dynamic-offset array overload.
- No vertex/index state, counts, readiness policy, material, style, scene, or layer semantics in `BindSet`.
- No prose-only binding validation errors.
