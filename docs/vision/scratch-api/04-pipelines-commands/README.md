# Pipelines And Commands

Status: Vision draft
Date: 2026-06-30

## Decision

`Pipeline` describes stable GPU program state. `Command` describes one executable GPU action.

This replaces the older pattern where binding, range, executable flags, pipeline, and pass membership were coupled.

## Pipelines

Render pipelines own stable state:

- shader stages and entry points
- bind layouts
- vertex buffer layouts
- primitive state
- depth and stencil state
- color target compatibility
- multisample state
- pipeline cache key

Compute pipelines own:

- shader stage and entry point
- bind layouts
- constants
- pipeline cache key

Pipelines do not own:

- per-submission command counts
- resource readiness policy
- pass membership
- concrete bind set resource versions

## Command

`Command` is the canonical term because it is closest to the GPU command buffer model.

Target command families:

- `DrawCommand`
- `DispatchCommand`
- `CopyCommand`
- `UploadCommand`
- `ReadbackCommand` as an explicit staging escape hatch, not the default readback path
- future explicit clear or resolve commands, if needed

Every command should declare:

- label
- pipeline or raw encoder action
- bind sets
- resources read
- resources written
- readiness policy
- static, dynamic, or indirect count where relevant

## DrawCommand

Draw count should support static values, dynamic resolvers, and indirect buffers.

```ts
type DrawCount =
    | { vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number }
    | { indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number }
    | { indirect: BufferResource, offset?: number }
    | ((context: FrameContext) => DrawCount)
```

Static values are the default path:

```ts
const drawTriangle = scratch.command.draw({
    label: 'draw triangle',
    pipeline,
    bindSets: [],
    count: { vertexCount: 3 },
    resources: {
        read: [],
        write: [surfaceColor],
    },
    whenMissing: 'throw',
})
```

Dynamic resolvers are optional for scene-dependent counts:

```ts
const drawTerrain = scratch.command.draw({
    label: 'draw terrain',
    pipeline: terrainPipeline,
    bindSets: [terrainSet],
    vertex: terrainVertex,
    index: terrainIndex,
    count: frame => ({
        indexCount: terrain.visibleIndexCount,
        instanceCount: terrain.visibleTileCount,
    }),
    resources: {
        read: [demTexture, lodMap],
        write: [sceneColor, depth],
    },
    whenMissing: 'skip-command',
})
```

Indirect counts are the preferred GPU-driven path when compute produces draw arguments.

## DispatchCommand

Dispatch count follows the same model:

```ts
type DispatchCount =
    | { workgroups: [number, number?, number?] }
    | { indirect: BufferResource, offset?: number }
    | ((context: FrameContext) => DispatchCount)
```

Example:

```ts
const simulate = scratch.command.dispatch({
    label: 'simulate particles',
    pipeline: simulationPipeline,
    bindSets: [simulationSet],
    count: { workgroups: [64, 64, 1] },
    resources: {
        read: [flowTexture],
        write: [particleBuffer],
    },
    whenMissing: 'skip-command',
})
```

## Count Triage

Draw and dispatch counts span three cases; choose by what the count actually depends on:

- Static, known at record time → use the literal form (`{ vertexCount: 3 }`, `{ workgroups: [64, 64, 1] }`). Do not wrap a constant in a closure.
- CPU-dynamic — known only after CPU-side work such as culling → a resolver closure is legitimate, or a count read from a tracked handle (see `02-resources`, dynamic values). Prefer the handle when the value already lives in one.
- GPU-dynamic — produced on the GPU (e.g. compute writes draw or dispatch arguments) → prefer `indirect`. It needs no readback, is fully declarative, and is visible to validation.

Verifiability ladder, prefer the top: indirect buffer > tracked handle > closure.

`FrameContext` is the context of the current submission. The name follows the `Frame` builder, but it does not imply a presentation surface exists.

## Readiness Policy

Every command must explicitly declare what happens when required resources are not ready:

```ts
type ResourceReadinessPolicy =
    | 'throw'
    | 'skip-command'
    | 'skip-pass'
    | 'use-fallback'
```

This avoids conflating streaming data absence with wiring bugs.

## Non-Goals

- Do not make command counts closures by default.
- Do not hide indirect draw or dispatch behind a special high-level feature.
- Do not store command membership in pass specs.
- Do not encode terrain, flow, tile, or layer concepts in commands.
