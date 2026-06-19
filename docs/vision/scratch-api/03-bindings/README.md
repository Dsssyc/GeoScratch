# Bindings

Status: Vision draft
Date: 2026-06-20

## Decision

The old `Binding` concept should be split into `BindLayout` and `BindSet`.

`BindLayout` describes stable shader binding shape. `BindSet` binds concrete resources to that shape and owns bind group cache invalidation.

Vertex buffers, index buffers, indirect buffers, draw counts, dispatch counts, and executable state do not belong in `BindSet`.

## BindLayout

`BindLayout` is explicit in the core API:

```ts
const terrainLayout = scratch.bindLayout({
    label: 'terrain group',
    group: 0,
    entries: [
        { binding: 0, name: 'camera', type: 'uniform', visibility: ['vertex'] },
        { binding: 1, name: 'nodes', type: 'read-storage', visibility: ['vertex'] },
        { binding: 2, name: 'dem', type: 'texture', sampleType: 'float', visibility: ['fragment'] },
        { binding: 3, name: 'linear', type: 'sampler', visibility: ['fragment'] },
    ],
})
```

Core layout descriptors should map predictably to WebGPU bind group layout entries.

Supported entry families should include:

- uniform buffer
- read-only storage buffer
- writable storage buffer
- sampled texture
- storage texture
- sampler
- external texture, when supported

## BindSet

`BindSet` binds resources by layout entry name:

```ts
const terrainSet = scratch.bindSet(terrainLayout, {
    camera: cameraBuffer,
    nodes: nodeBuffer,
    dem: demTexture,
    linear: linearSampler,
})
```

Responsibilities:

- validate that all required slots are provided
- validate runtime ownership
- cache the `GPUBindGroup`
- compare resource versions before use
- lazily rebuild bind groups when bound resource versions change
- expose readiness of bound resources to command validation

## Shader Inspection

Shader reflection should not be required in the core runtime path.

Allowed helper direction:

```ts
const report = scratch.inspectShader(shader).compareBindLayouts([terrainLayout])

const draft = scratch.inspectShader(shader).suggestBindLayout({ group: 0 })
```

Reflection is a development helper for validation or scaffolding. It must not become the source of truth for production layout creation.

## Explicit Is The Contract

The shader and the bind layout should both be intentionally authored. This keeps unusual WebGPU layouts possible and avoids binding the kernel to a specific WGSL parser or reflection implementation.

## Non-Goals

- Do not store vertex or index input state in `BindSet`.
- Do not store draw or dispatch counts in `BindSet`.
- Do not store command readiness policy in `BindSet`.
- Do not use shader reflection as the primary runtime layout mechanism.
