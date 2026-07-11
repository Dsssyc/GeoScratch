# Resources

Status: Vision draft
Date: 2026-07-06

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
- `QuerySetResource` (indexed timestamp / occlusion query slots, feature-gated where required)
- presentation-submission-scoped borrowed surface texture views

Surface texture views are not persistent `TextureResource` objects.

`QuerySetResource` follows WebGPU's `GPUQuerySet` naming. The `Set` suffix does not mean an unordered mathematical set. A query set is an indexed slot resource with a fixed `count`; pass instrumentation and query commands write specific query indices, and resolve commands copy an explicit index range into a buffer.

Core query types are intentionally limited to current WebGPU query primitives:

```ts
type QuerySetType = 'timestamp' | 'occlusion'
```

`timestamp` query sets require the `timestamp-query` feature. `occlusion` query sets belong to render passes. Query sets are resources for ownership, lifetime, usage validation, and slot epoch tracking, but they are not bindable shader resources.

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
const positions = await scratch.buffer({
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

Persistent buffer creation is one Promise-returning allocation operation. Scratch validates and normalizes the descriptor before issuing exactly one native allocation inside matching validation and out-of-memory scopes. The logical buffer is registered only after both scopes settle successfully; a failed candidate never becomes a live resource.

## Buffer Layout

A buffer is raw bytes; its layout declares how those bytes are typed and is the single source of truth for byte interpretation on both the GPU side (vertex layout / WGSL struct) and the CPU side (readback views).

Layout is **compositional**, not a fixed set of modes. A buffer is a sequence of **segments**; each segment is an array (`count`) of an **element**; an element is either a scalar/vector `format` or a nested `struct` of named fields — and struct fields are elements too, so structs nest.

```ts
const sim = await scratch.buffer({
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

### Layout Artifact And Codec

The layout compiler should emit an inspectable `LayoutArtifact` and an optional `LayoutCodec` (see `08-programs-codecs`):

- `LayoutArtifact` is data: resolved byte offsets, stride, padding, alignment mode, total byte length, usage lowering, and structural hash.
- `LayoutCodec` is preparation logic: CPU writers, upload byte views, readback view factories, and WGSL accessor modules derived from the same artifact.

This is the preferred path for CPU arrays that need GPU-aligned storage-buffer layout:

```text
source array -> CPU writer fills GPU-aligned bytes -> one explicit UploadCommand
```

The writer skips padding on the CPU and writes one contiguous upload range. It avoids per-structure CPU/GPU calls and avoids a GPU repack pass that would temporarily require a second full buffer in VRAM. Raw packed buffers remain possible as an escape hatch, but the default model should not force WGSL authors to manually reproduce storage-buffer padding.

External AoS feature schemas can lower into this grammar by producing a compatible `LayoutSpec` or precomputed `LayoutArtifact`. If their memory is already GPU-aligned, upload may use a direct bulk view; otherwise the CPU writer performs the alignment step before the explicit upload.

## TextureResource

`TextureResource` is a stable logical resource whose current `GPUTexture` allocation may be replaced explicitly. Construction and replacement share one size grammar:

```ts
type TextureResourceSize =
    | Readonly<{
        width: number
        height?: number
        depthOrArrayLayers?: number
    }>
    | readonly [number, number?, number?]

const sceneColor = await scratch.texture({
    label: 'scene color',
    size: surface.size,
    format: 'rgba16float',
    usage: ['render', 'sample', 'copySrc'],
})

surface.resize(nextSize)
await sceneColor.resize(surface.size)
```

`TextureResource.resize()` is a size-only resource-lifecycle operation. It preserves logical object identity, id, runtime, label, format, usage, dimension, mip-level count, sample count, `viewFormats`, `textureBindingViewDimension`, and `contentEpoch`. Scratch snapshots the complete physical descriptor, including a materialized immutable `viewFormats` iterable, so caller mutation cannot alter a later replacement.

Stable identity (`runtime`, `id`, `label`, `resourceKind`), descriptor, lifecycle, readiness, allocation/content provenance, physical texture, and view-cache facts use ECMAScript-private backing slots and are exposed only through read-only getters. Concrete `TextureResource` handles are non-extensible and reject subclass construction, so own-property and prototype shadowing cannot counterfeit those facts; an upcast to `Resource` cannot turn them into writable fields either. Allocation and content transition functions are module-internal, are not exported from either package entrypoint, and are not object methods exposed to package consumers; `resize()` is the only public size-replacement path. Optional height and layer members default only when they are `undefined`; `null` is invalid. Deterministic validation also preserves the complete WebGPU transient-attachment contract: usage is exactly `TRANSIENT_ATTACHMENT | RENDER_ATTACHMENT`, `viewFormats` is empty, dimension is `2d`, mip-level count is `1`, and depth or array-layer count is `1`.

A changed resize is a Promise-returning create-before-swap transaction. Scratch normalizes and validates the requested size, keeps the old allocation installed while the candidate's validation and out-of-memory scopes settle, then installs the acknowledged allocation, clears allocation-scoped views, advances `allocationVersion` once, sets `state = empty`, and destroys the old texture. The next successful content producer advances from the preserved `contentEpoch`. Any candidate failure leaves every old allocation fact installed; Scratch does not destroy first or wait for queue completion. A second changed resize while one is pending fails structurally.

Normalized same-size resize is an already-resolved Promise and a true no-op; it opens no native error scope. Raw `GPUTextureView` values are allocation-scoped; every `createView()` call validates its mip, layer, and dimension against the current allocation before native creation. Bind sets derive a current view from their bind-layout dimension, while render attachments preflight and explicitly select one 2D mip-level array layer before encoder creation; all attachments in that pass must still have matching current render extents and sample counts. Without `core-features-and-limits`, an omitted `textureBindingViewDimension` is re-derived for each allocation (`2d` for one layer, `2d-array` for multiple), so a binding consumer that no longer matches fails before native bind-group creation. Core-feature devices can keep an explicit single-layer `2d` binding after layer growth; compatibility-mode binding persistence requires an explicit compatible contract such as `2d-array`. The derived binding dimension does not invalidate an otherwise valid raw view or render attachment. Resize accepts no `Surface`, observer, or size-provider callback. Future tracked values must lower into the same explicit primitive rather than replace it.

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
- Runtime-varying value computed from other tracked sources (for example a future texture size derived from a surface) → a **derived value**: the runtime can inspect its dependency, subscribe to it for invalidation, and lower a detected change into `TextureResource.resize()`.
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

The implemented Draw/Dispatch path resolves this policy from the resource state at the command's exact submission position. `skip-command` applies no command read/write fact, `skip-pass` transactionally discards every command and pass-level effect, and `use-fallback` resolves a same-kind command without mutating either command or resource. Only selected commands can advance content epochs or create producer facts.

Expected absence is observable through `SubmittedWork.executionOutcomes`; it is not a warning/error. Required-epoch stale/future diagnostics are separate and apply only after a command is selected. The current implementation state remains `empty | ready | disposed`; this readiness execution does not introduce additional streaming lifecycle states. `CopyCommand`, `ReadbackCommand`, and `ResolveQuerySetCommand` remain `throw`-only.

## Non-Goals

- Do not encode tile, LoD, terrain, flow, or projection policy in resources.
- Do not have resources directly rebuild bind groups through callbacks.
- Do not force all dynamic counts or readiness checks through CPU closures.
- Do not add a hidden texture size-provider or surface subscription alongside `TextureResource.resize()`.
- Do not make surface swapchain textures persistent resources.
- Do not expose core `resource.write()` methods; upload is an explicit transfer.
- Do not expose core `resource.toArray()` / `resource.toBytes()` methods; readback creates an explicit operation.
