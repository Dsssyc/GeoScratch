# Pipelines And Commands

Status: Vision draft
Date: 2026-07-06

## Decision

`Program` describes shader source contracts. `Pipeline` describes stable WebGPU executable state for one `Program` entry point. `Command` describes one executable GPU action.

This replaces the older pattern where shader code, binding, range, executable flags, pipeline, and pass membership were coupled.

See `08-programs-codecs` for the source-level `Program`, layout codec, and shader-composition model. This module starts at the executable pipeline and command layer.

## Pipelines

Render pipelines own stable state:

- program or shader modules, shader stages, and entry points
- bind layouts
- vertex buffer layouts
- primitive state
- depth and stencil state
- color target compatibility
- multisample state
- pipeline cache key

Compute pipelines own:

- program or shader module, shader stage, and entry point
- bind layouts
- constants
- pipeline cache key

Pipelines do not own:

- per-submission command counts
- resource readiness policy
- pass membership
- concrete bind set resource allocation versions
- material or style parameters
- scene-object assignment

Pipelines are allowed to cache compiled GPU state. They are not allowed to become the place where concrete resources, visual semantics, and shader code are bundled into a material-like object.

## Command

`Command` is the canonical term because it is closest to the GPU command buffer model.

Target command families:

- `DrawCommand`
- `DispatchCommand`
- `CopyCommand`
- `UploadCommand`
- `ResolveQuerySetCommand`
- `ReadbackCommand` as an explicit ordered-staging escape hatch that produces a `ReadbackOperation`
- `BeginOcclusionQueryCommand` / `EndOcclusionQueryCommand` as render-pass-only query brackets
- future explicit clear or attachment-resolve commands, if needed

Every command should declare:

- label
- pipeline or raw encoder action
- bind sets
- resources read
- resources written
- content epoch effects for written resources
- readiness policy
- static, dynamic, or indirect count where relevant

Commands that write resource contents advance `contentEpoch`. Commands that replace physical GPU objects advance `allocationVersion`. The two effects are separate so a compute write does not accidentally imply bind group invalidation.

Pipeline and command validation findings should use the shared `ScratchDiagnostic` envelope from `09-diagnostics-validation`. `Command` diagnostics should identify the command as `subject` and put related resources, pass specs, pipelines, or bind sets in `related` instead of prose.

Query commands write indexed `QuerySetResource` slots. Resolving a query set writes bytes into a destination buffer and advances that buffer's `contentEpoch`; it does not make CPU-visible data until a `ReadbackOperation` is created or consumed.

## DrawCommand

Draw count should support static values, dynamic resolvers, and indirect buffers.

```ts
type DrawCount =
    | { vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number }
    | { indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number }
    | { indirect: BufferResource, offset?: number }
    | ((context: SubmissionContext) => DrawCount)
```

Static values are the default path:

```ts
const vertexBuffer = scratch.buffer({
    label: 'triangle vertices',
    usage: ['vertex', 'copyDst'],
    size: vertexBytes.byteLength,
})

const trianglePipeline = scratch.pipeline.render({
    label: 'triangle pipeline',
    program: triangleProgram,
    vertexBuffers: [
        {
            arrayStride: 20,
            stepMode: 'vertex',
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                { shaderLocation: 1, offset: 8, format: 'float32x3' },
            ],
        },
    ],
    targets: [{ format: surface.format }],
})

const drawTriangle = scratch.command.draw({
    label: 'draw triangle',
    pipeline: trianglePipeline,
    bindSets: [],
    vertexBuffers: [
        { slot: 0, buffer: vertexBuffer },
    ],
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
    count: context => ({
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
    | ((context: SubmissionContext) => DispatchCount)
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

## Query Commands

Query commands expose WebGPU query mechanics without inventing profiling abstractions that the platform does not provide.

```ts
const resolveTiming = scratch.command.resolveQuerySet({
    label: 'resolve timing',
    querySet: timingQueries,
    first: 0,
    count: 2,
    destination: timingBuffer,
    destinationOffset: 0,
})
```

`ResolveQuerySetCommand` is a copy/resolve command. Its source is an indexed query range, and its destination must be a buffer with query-resolve usage plus any later copy/readback usage the workflow needs. Later CPU access still uses `ReadbackOperation`.

Occlusion query brackets are render-pass-only command-like encoder actions:

```ts
scratch.command.beginOcclusionQuery({ querySet: visibilityQueries, index: tileIndex })
scratch.command.endOcclusionQuery()
```

They require the active render pass to own the same `occlusionQuerySet`, cannot be nested, and write one indexed query slot.

## Count Triage

Draw and dispatch counts span three cases; choose by what the count actually depends on:

- Static, known at record time → use the literal form (`{ vertexCount: 3 }`, `{ workgroups: [64, 64, 1] }`). Do not wrap a constant in a closure.
- CPU-dynamic — known only after CPU-side work such as culling → a resolver closure is legitimate, or a count read from a tracked handle (see `02-resources`, dynamic values). Prefer the handle when the value already lives in one.
- GPU-dynamic — produced on the GPU (e.g. compute writes draw or dispatch arguments) → prefer `indirect`. It needs no readback, is fully declarative, and is visible to validation.

Verifiability ladder, prefer the top: indirect buffer > tracked handle > closure.

`SubmissionContext` is the context of the current submission. It exposes runtime state, submission diagnostics, tracked dynamic values, and producer epochs without implying a presentation surface exists.

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
- Do not expose pipeline statistics as a core command family while WebGPU lacks that core query type.
- Do not store command membership in pass specs.
- Do not encode terrain, flow, tile, or layer concepts in commands.
- Do not introduce `Material` as a shortcut for `Program` + `BindSet` + render semantics.
- Do not expose pipeline or command validation as prose-only errors.
