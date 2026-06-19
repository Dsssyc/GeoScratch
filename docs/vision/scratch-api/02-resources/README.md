# Resources

Status: Vision draft
Date: 2026-06-20

## Decision

A `Resource` is a logical handle owned by a `ScratchRuntime`. It is not just a thin wrapper around one `GPUBuffer` or `GPUTexture`.

The logical resource records stable identity and reconstruction information. The physical GPU object can be replaced when data changes, size changes, or the device is lost.

## Core Concepts

Every resource should expose or internally track:

- runtime owner
- logical id
- label
- descriptor shape
- current physical GPU object
- version number
- readiness state
- pending dirty ranges or replacement
- disposal state

The resource version increments when the physical binding target changes. Bind sets and pipelines can use versions to lazily rebuild only when needed.

## Resource Kinds

Target resource families:

- `BufferResource`
- `TextureResource`
- `SamplerResource`
- `ShaderModuleResource`
- frame-scoped borrowed surface texture views

Surface texture views are not persistent `TextureResource` objects.

## BufferResource

Buffers should support:

- explicit usage declarations
- optional initial data
- dirty range tracking
- direct write requests
- copy source and copy destination usage
- storage, vertex, index, uniform, indirect, and map usage where applicable

Static data should not require a per-frame callback. Dynamic data should mark dirty ranges and let the frame prepare step batch uploads.

Example shape:

```ts
const positions = scratch.buffer({
    label: 'positions',
    usage: ['vertex', 'storage', 'copyDst'],
    data: new Float32Array(...),
    layout: [
        { name: 'position', format: 'float32x3' },
    ],
})

positions.write(nextPositions, { offset: 0 })
```

## TextureResource

Textures should support:

- explicit usage declarations
- fixed size or size provider
- format and sample count
- mip policy
- view cache keyed by view descriptor
- resize invalidation
- storage texture read/write declarations

Example shape:

```ts
const sceneColor = scratch.texture({
    label: 'scene color',
    size: () => surface.size,
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

`dirty` means the resource is logically usable but needs preparation before recording commands that depend on the new data. `empty`, `lost`, and `disposed` are not usable.

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
