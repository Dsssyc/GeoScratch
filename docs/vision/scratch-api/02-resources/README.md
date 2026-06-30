# Resources

Status: Vision draft
Date: 2026-06-30

## Decision

A `Resource` is a logical handle owned by a `ScratchRuntime`. It is not just a thin wrapper around one `GPUBuffer` or `GPUTexture`.

The logical resource records stable identity and reconstruction information. The physical GPU object can be replaced when descriptor shape changes, size changes, or the device is lost. Ordinary content changes should advance a content epoch without replacing the physical binding target.

## Core Concepts

Every resource should expose or internally track:

- runtime owner
- logical id
- label
- descriptor shape
- current physical GPU object
- `allocationVersion`
- `contentEpoch`
- readiness state
- pending transfer operations or replacement
- disposal state

`allocationVersion` increments when the physical binding target changes. Bind sets, view caches, pass attachments, and commands can use it to lazily rebuild only when needed.

`contentEpoch` increments when bytes or texels change. Upload, copy, render attachment writes, storage writes, clears, resolves, and mip generation are content producers. Readback and dependency validation use content epochs; bind-group invalidation uses allocation versions.

## Resource Kinds

Target resource families:

- `BufferResource`
- `TextureResource`
- `SamplerResource`
- `ShaderModuleResource`
- `QuerySetResource` (timestamp / occlusion, feature-gated)
- presentation-submission-scoped borrowed surface texture views

Surface texture views are not persistent `TextureResource` objects.

## BufferResource

Buffers should support:

- explicit usage declarations
- optional initialization source lowered to an explicit upload
- dirty range tracking for pending transfer preparation
- copy source and copy destination usage
- storage, vertex, index, uniform, indirect, and map usage where applicable

Static data should not require a per-submission callback. Dynamic data should be represented by explicit upload/copy commands or tracked handles that produce upload commands during submission preparation.

Example shape:

```ts
const positions = scratch.buffer({
    label: 'positions',
    usage: ['vertex', 'storage', 'copyDst'],
    struct: [
        { name: 'position', format: 'float32x3' },
    ],
})

const uploadPositions = scratch.command.upload({
    target: positions,
    data: nextPositions,
    range: { offset: 0 },
})
```

## Buffer Layout

A buffer is raw bytes; its layout declares how those bytes are typed and is the single source of truth for byte interpretation on both the GPU side (vertex layout / WGSL struct) and the CPU side (readback views).

Layout is **compositional**, not a fixed set of modes. A buffer is a sequence of **segments**; each segment is an array (`count`) of an **element**; an element is either a scalar/vector `format` or a nested `struct` of named fields — and struct fields are elements too, so structs nest.

```ts
const sim = scratch.buffer({
    usage: ['storage', 'copySrc'],
    segments: [
        // a segment of structs (AoS region)
        { name: 'particles', count: 1000, struct: [
            { name: 'pos', format: 'float32x3' },
            { name: 'vel', format: 'float32x3' },
        ] },
        // a segment of scalars (SoA region)
        { name: 'flags', count: 1000, format: 'sint8' },
    ],
})
```

The familiar shapes are just points in this one grammar:

- **Homogeneous** — one segment, scalar element.
- **AoS** — one segment, struct element.
- **SoA** — many segments, scalar elements.
- **SoA of AoS** — many segments, some with struct elements (above).

A single-segment buffer may inline the element as sugar — top-level `format` + `count`, or `struct` + `count` — which is exactly a one-segment layout.

The runtime computes offsets, stride, and padding from the declared layout for the target usage and exposes them, so the CPU views and the GPU interpretation stay in sync without hand-computed padding. Two constraints:

- **Alignment / padding.** WGSL storage structs follow alignment rules (`vec3<f32>` aligns to 16, struct size rounds up to its largest member) that differ from the looser vertex-attribute rules. A segment bound separately as a storage binding with a dynamic offset must start on `minStorageBufferOffsetAlignment` (commonly 256); the runtime pads and reports the real byte offsets.
- **Sub-32-bit types.** WGSL has no `i8`/`u8` storage scalar. An 8-bit field is fine as a vertex attribute (`sint8x4`, `unorm8x4`) and for readback, but a compute shader reads it as `u32` and unpacks. Choose the field type by who consumes it.

Readback follows the same composition through an explicit `ReadbackOperation` (see `07-transfers-epochs`). A segment is addressed by name: a scalar segment can yield a `TypedArray` through `await readback.toArray()` after creating `scratch.readback({ source: buf.segment('flags'), after })`; a struct segment yields an `ArrayBuffer` plus layout-derived `ArrayBufferView`s. AoS fields are strided, so they use a `DataView` or an explicit deinterleaved copy rather than one fixed typed array. Core resources do not expose `buf.toArray()` / `buf.toBytes()` sugar.

## TextureResource

Textures should support:

- explicit usage declarations
- fixed size or size provider
- format and sample count
- mip policy
- view cache keyed by view descriptor
- resize invalidation
- storage texture read/write declarations
- attachment write and sampled-read declarations

Example shape:

```ts
const sceneColor = scratch.texture({
    label: 'scene color',
    size: derived(() => surface.size, [surface]),
    format: 'rgba16float',
    usage: ['render', 'sample', 'copySrc'],
})

sceneColor.invalidateSize()
```

## Readiness State

Resources should have explicit state. The exact enum may evolve, but the model should distinguish:

```ts
type ResourceState =
    | 'empty'
    | 'ready'
    | 'dirty'
    | 'resizing'
    | 'lost'
    | 'disposed'
```

`dirty` means the resource is logically usable but has pending preparation requested by an explicit transfer or replacement operation before recording commands that depend on the new data. `empty`, `lost`, and `disposed` are not usable.

## Dynamic Values: Prefer Tracked Values Over Closures

Values that feed a resource (size, initial or updated data) are sometimes static and sometimes runtime-varying. Express them by what they encode:

- Static value, known at construction time → pass it directly; do not wrap it in a thunk.
- Runtime-varying data → a stable handle whose contents change and can lower into explicit upload commands, or a GPU resource written by prior commands.
- Runtime-varying value computed from other tracked sources (e.g. texture size from the surface) → a **derived value**: the runtime can inspect its dependency, subscribe to it for invalidation, and check it during validation.
- Last resort → a raw closure, only when no handle or derived value can express the case.

A tracked handle or derived value is inspectable and invalidation-aware; a bare `size: () => surface.size` closure is a black box — the runtime must poll it every submission and cannot know when or why it changed. This rule generalizes to command counts (`04-pipelines-commands`).

## Missing Resource Policy

The missing/readiness policy does not belong to the resource. It belongs to the command or pass using the resource because the same resource can have different semantics in different contexts.

```ts
type ResourceReadinessPolicy =
    | 'throw'
    | 'skip-command'
    | 'skip-pass'
    | 'use-fallback'
```

This policy must be explicitly declared at the usage point.

## Non-Goals

- Do not encode tile, LoD, terrain, flow, or projection policy in resources.
- Do not have resources directly rebuild bind groups through callbacks.
- Do not force all dynamic counts or readiness checks through CPU closures.
- Do not make surface swapchain textures persistent resources.
- Do not expose core `resource.write()` methods; upload is an explicit transfer.
- Do not expose core `resource.toArray()` / `resource.toBytes()` methods; readback creates an explicit operation.
