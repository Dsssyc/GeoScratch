# Bindings

Status: Vision draft
Date: 2026-07-06

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

Buffer entries (uniform and storage) should support an optional dynamic-offset flag, so one large buffer can be bound once and a per-dispatch or per-draw slice selected by offset — a common compute batching pattern.

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
- compare bound resource `allocationVersion` values before use
- lazily rebuild bind groups when bound resource allocation versions change
- expose readiness of bound resources to command validation

The normalized binding table and its entries are immutable after `BindSet` construction. Commands therefore validate and encode against the same slot-to-resource mapping. The resources themselves retain their explicit content, allocation, and lifecycle transitions; allocation changes continue to invalidate the cached bind group through `allocationVersion`.

`BindSet` does not rebuild merely because a bound resource's `contentEpoch` changes. Content changes affect dependency validation and readback, not the physical binding target.

`BindSet` is not a material parameter object. It supplies concrete resources for an explicit `BindLayout`; it does not own shader source, generated accessor modules, pipeline state, render style, object assignment, draw counts, or dispatch counts. A command is the place where a pipeline and bind sets meet for one executable action.

## Shader Inspection And Cross-Check

Shader reflection is not the source of truth and is not on the core runtime path. Explicit `BindLayout` stays authoritative. But reflection should be promoted from "scaffolding only" to a *guard* against the most common binding error: a `BindLayout` that disagrees with the shader on binding index, type, or visibility.

Helper and guard directions:

```ts
const report = scratch.inspectShader(shader).compareBindLayouts([terrainLayout])

const draft = scratch.inspectShader(shader).suggestBindLayout({ group: 0 })
```

The cross-check is constrained so it never blocks legitimate work:

- dev-only - no hard dependency on a specific WGSL parser in the production path
- default `warn`, not `throw` - a parser lagging the WGSL spec would otherwise emit false errors on legitimate-but-unusual layouts
- per-entry suppressible - an intentional superset layout can silence a specific check
- cross-check only - it compares explicit layout against the shader; it never generates the authoritative layout

Reflection must not become the source of truth for production layout creation.

Cross-check findings should use the shared diagnostic envelope from `09-diagnostics-validation`, with the `BindLayoutEntry` as `subject` and the reflected `ShaderBinding` plus `Program` as `related` context.

## Explicit Is The Contract

The shader and the bind layout should both be intentionally authored. This keeps unusual WebGPU layouts possible and avoids binding the kernel to a specific WGSL parser or reflection implementation.

## Non-Goals

- Do not store vertex or index input state in `BindSet`.
- Do not store draw or dispatch counts in `BindSet`.
- Do not store command readiness policy in `BindSet`.
- Do not use `BindSet` as a material, style, or scene-object parameter bundle.
- Do not emit bind validation failures as prose-only errors.
- Do not use shader reflection as the primary runtime layout mechanism.
