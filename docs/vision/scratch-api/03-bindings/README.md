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

The persistent matrix covers:

- uniform, read-only storage, and writable storage buffers;
- filtering, non-filtering, and comparison samplers;
- float, unfilterable-float, depth, signed-integer, and unsigned-integer sampled textures, including every native-valid view dimension and multisampled constraints;
- write-only, read-only, and read-write storage textures with explicit format and native-valid `1d`, `2d`, `2d-array`, or `3d` dimensions.

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

The binding table is immutable. A different logical resource mapping requires a different BindSet. Content writes do not change native binding shape and never invalidate preparation.

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
