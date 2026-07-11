# Pipelines And Commands

Status: Vision draft
Date: 2026-07-11

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

`CopyCommand` covers WebGPU-native GPU-side copy directions: buffer-to-buffer, texture-to-texture, buffer-to-texture, and texture-to-buffer. CPU upload and CPU readback remain explicit transfer/readback operations rather than substitutes for these command encoder copies.

### Texture Allocation Replacement

`TextureResource.resize()` is a resource-lifecycle operation, not a `Command`, upload, copy, or submission step. It creates no encoder, queue action, resource-access entry, producer epoch, or content write. A changed resize advances `allocationVersion`, preserves `contentEpoch`, and marks the replacement empty.

Pass specs and commands retain logical resources rather than one physical texture. At submit or encode time, render attachments, texture uploads, external-image uploads, all texture copy directions, and texture bindings resolve the current physical texture or a current view. Commands created before resize therefore remain reusable when their immutable descriptor still fits.

That reuse does not bypass validation. Upload and copy commands revalidate mip, origin, extent, layer, and sample constraints against the current allocation before encoder or queue effects. Texture bindings revalidate the bind-layout view dimension against both the current layer range and compatibility-mode effective texture binding dimension. Render attachments revalidate a single 2D mip/layer view before command encoder creation and fail when compatibility-mode derivation no longer permits that view. A fixed required `contentEpoch` remains exact: preserving the numeric epoch across replacement does not make the empty new allocation readable.

### ExternalImageUploadCommand

`ExternalImageUploadCommand` represents the native immediate queue operation `GPUQueue.copyExternalImageToTexture()`. It is an upload rather than a fifth `CopyCommand` direction:

```ts
commandKind: 'upload'
uploadKind: 'external-image'
```

The other upload variants are explicitly discriminated as `uploadKind: 'buffer'` and `uploadKind: 'texture'`. The external-image descriptor retains a canonical `GPUCopyExternalImageSource` by identity and exposes `sourceOrigin`, `flipY`, target texture `origin`, `mipLevel`, `colorSpace`, `premultipliedAlpha`, and explicit width/height. Destination aspect is fixed to `all` and `depthOrArrayLayers` to `1`.

The complete current source union is accepted: `ImageBitmap`, `ImageData`, `HTMLImageElement`, `HTMLVideoElement`, `VideoFrame`, `HTMLCanvasElement`, and `OffscreenCanvas`. Cross-realm-safe platform getter brand checks reject arbitrary records without requiring realm-local `instanceof`. Construction locks command fields without requiring the source to be loaded. Execution revalidates the exact public dimension fields for image, video, frame, and data sources. Canvas dimensions may instead be the current WebGL drawing buffer or an `ImageBitmapRenderingContext` internal output bitmap; because the canvas does not expose a side-effect-free context-mode query, Scratch leaves that context-specific source-range check to the native content timeline and classifies its synchronous `OperationError` as invalid input.

Lowering uses canonical `GPUCopyExternalImageSourceInfo` and `GPUCopyExternalImageDestInfo` and requires the command runtime's own queue. Pixels are captured when the native queue method is called. Scratch does not call `getContext()` to inspect a canvas, extract CPU pixels, use `writeTexture()`, close or dispose the source, or invent a source resource epoch.

Eligible targets are single-sampled 2D plain color textures with both `COPY_DST` and `RENDER_ATTACHMENT` usage and a device-enabled renderable `unorm`, `unorm-srgb`, `float`, or `ufloat` format. Direct execution and submission use the same validation, native-call, failure, and target-epoch path. See ADR-030.

The first `ReadbackCommand` slice is implemented for buffer sources. It uses an explicit source `contentEpoch`, enters submission order through `SubmissionBuilder.readback(...)`, stages once at that position, and returns the associated `ReadbackOperation` through `result({ after })`. Direct texture readback, mapped leases, and staging-budget policy remain future work.

Native indexed and indirect execution is implemented. Scratch lowers static vertex draws, static indexed draws, indirect vertex draws, indirect indexed draws, static dispatches, and indirect dispatches directly to the corresponding WebGPU encoder methods. CPU-dynamic resolver closures remain future work pending a concrete `SubmissionContext` and tracked dynamic-value contract.

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

Draw and dispatch execution contracts are normalized and locked at construction. Their pipeline, bind/index/vertex state, count, dynamic offsets, resource declarations, readiness policy, and fallback reference cannot drift between validation and encoding; referenced bind sets expose the same immutable normalized binding table. `dispose()` remains the explicit mutable lifecycle transition, exposed through a read-only `isDisposed` state rather than a writable flag.

Pipeline and command validation findings should use the shared `ScratchDiagnostic` envelope from `09-diagnostics-validation`. `Command` diagnostics should identify the command as `subject` and put related resources, pass specs, pipelines, or bind sets in `related` instead of prose.

Query commands write indexed `QuerySetResource` slots. Resolving a query set writes bytes into a destination buffer and advances that buffer's `contentEpoch`; it does not make CPU-visible data until a `ReadbackOperation` is created or consumed.

## DrawCommand

The implemented native count contract supports static vertex values, static indexed values, and indirect buffers:

```ts
type DrawCount =
    | { vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number }
    | { indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number }
    | { indirect: BufferResource, offset?: number }
```

An indexed static count requires `indexBuffer`; a static vertex count forbids it. Direct, indexed, and indirect count fields are mutually exclusive in the descriptor and at runtime. An indirect count selects `drawIndirect` without `indexBuffer` and `drawIndexedIndirect` with it. Draw construction requires a render pipeline and one binding for every vertex-buffer slot declared by that pipeline. Direct count values use WebGPU integer domains and allow zero-count no-ops. A known static no-op does not advance declared output epochs or create producer facts; an indirect command remains a potential writer because Scratch does not inspect GPU argument bytes. Index-buffer offsets follow the selected format's alignment; binding sizes preserve WebGPU's non-negative native byte-range semantics, including zero and ranges that do not end on a complete index element. Static `firstIndex + indexCount` must fit within the complete indices in the bound range, and strip pipelines require the bound format to match `stripIndexFormat`; indirect argument contents are not inspected for equivalent CPU-side count-range checks.

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
        read: [
            { resource: vertexBuffer, contentEpoch: vertexBuffer.contentEpoch },
        ],
        write: [surfaceColor],
    },
    whenMissing: 'throw',
})
```

CPU-dynamic resolvers remain a future option for scene-dependent counts; the following is target syntax, not current public API:

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

Indirect counts are the implemented, preferred GPU-driven path when compute produces draw arguments. The indirect and optional index buffers must also appear in `resources.read` with their required content epochs. Scratch validates usage, alignment, range, ownership, disposal, readiness, and epochs without inspecting argument bytes on the CPU.

## DispatchCommand

The implemented dispatch count follows the same native model:

```ts
type DispatchCount =
    | { workgroups: [number, number?, number?] }
    | { indirect: BufferResource, offset?: number }
```

Static workgroup dimensions allow zero and are checked against `maxComputeWorkgroupsPerDimension`. Indirect dispatch validates a 12-byte GPU argument range and remains GPU-side.

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
    source: {
        querySet: timingQueries,
        slots: [
            { index: 0, contentEpoch: 1 },
            { index: 1, contentEpoch: 1 },
        ],
    },
    destination: timingBuffer,
    destinationOffset: 0,
    whenMissing: 'throw',
})
```

`ResolveQuerySetCommand` is a copy/resolve command. Its source is an explicit contiguous set of indexed query slots with required slot content epochs, and its destination must be a buffer with query-resolve usage plus any later copy/readback usage the workflow needs. Later CPU access still uses `ReadbackOperation`.

Occlusion query brackets are render-pass-only command-like encoder actions:

```ts
scratch.command.beginOcclusionQuery({ querySet: visibilityQueries, index: tileIndex })
scratch.command.endOcclusionQuery()
```

They require the active render pass to own the same `occlusionQuerySet`, cannot be nested, and write one indexed query slot.

## Count Triage

Draw and dispatch counts span three cases; choose by what the count actually depends on:

- Static, known at record time → use the literal form (`{ vertexCount: 3 }`, `{ workgroups: [64, 64, 1] }`). Do not wrap a constant in a closure.
- CPU-dynamic — known only after CPU-side work such as culling → a future resolver closure or tracked handle is legitimate (see `02-resources`, dynamic values). Prefer the handle when the value already lives in one.
- GPU-dynamic — produced on the GPU (e.g. compute writes draw or dispatch arguments) → prefer `indirect`. It needs no readback, is fully declarative, and is visible to validation.

Verifiability ladder, prefer the top: indirect buffer > tracked handle > closure.

Future `SubmissionContext` work should expose runtime state, submission diagnostics, tracked dynamic values, and producer epochs without implying a presentation surface exists. It is not part of the implemented native count slice.

## Readiness Policy

Draw and Dispatch implement all four readiness policies through a discriminated descriptor:

```ts
type ResourceReadinessPolicy =
    | 'throw'
    | 'skip-command'
    | 'skip-pass'
    | 'use-fallback'

type CommandReadinessDescriptor<FallbackCommand> =
    | {
        whenMissing: 'throw' | 'skip-command' | 'skip-pass'
        fallback?: never
    }
    | {
        whenMissing: 'use-fallback'
        fallback: FallbackCommand
    }
```

`DrawCommandDescriptor` uses `CommandReadinessDescriptor<DrawCommand>` and `DispatchCommandDescriptor` uses `CommandReadinessDescriptor<DispatchCommand>`. A fallback must be an actual command with the same command kind, runtime, non-disposed lifecycle, and declared-write resource identity set. Repeated declared-write resources normalize to one identity. A finite fallback chain has unique command IDs and may change pipeline, bindings, fixed-function buffers, count, and declared reads. Policy and fallback references are immutable; submission rechecks lifecycle because `dispose()` remains possible after construction.

At submission time:

- `throw` hard-fails an unready read before encoder creation in every validation mode;
- `skip-command` omits only that command and applies no declared read/write facts;
- `skip-pass` transactionally omits the complete render/compute pass, including attachments and query writes;
- `use-fallback` records the primary attempt and resolves the fallback at the same command position.

Only the final selected command reaches its existing native encoder method. A selected Draw fallback must first match the pass's exact color target count/formats and depth/stencil state. This includes indexed and indirect fallbacks; Scratch does not inspect indirect argument bytes during selection. Expected skip/fallback decisions are recorded in `SubmittedWork.executionOutcomes`, not diagnostics. Invalid contracts and hard runtime failures continue to use `ScratchDiagnostic`.

This complete policy surface currently belongs only to Draw and Dispatch. Copy, ordered Readback, and query Resolve descriptors remain `whenMissing: 'throw'` only.

## Non-Goals

- Do not make command counts closures by default.
- Do not hide indirect draw or dispatch behind a special high-level feature.
- Do not expose pipeline statistics as a core command family while WebGPU lacks that core query type.
- Do not store command membership in pass specs.
- Do not encode terrain, flow, tile, or layer concepts in commands.
- Do not introduce `Material` as a shortcut for `Program` + `BindSet` + render semantics.
- Do not expose pipeline or command validation as prose-only errors.
