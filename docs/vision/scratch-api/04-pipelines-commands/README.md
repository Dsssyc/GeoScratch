# Pipelines And Commands

Status: Vision draft
Date: 2026-07-16

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

Every executable command exposes a one-way lifecycle.
All normalized command construction facts and payload/resource references are locked:
each public property is non-writable, and normalized nested layout/origin/extent
shapes are frozen. An absent optional fact is materialized as a non-enumerable own
`undefined` property before the command becomes non-extensible, so inherited prototype
writes cannot inject a new normalized value. `label` participates in the same lock for
Draw and Dispatch whether present or absent. Every executable command prototype is
frozen, so lifecycle, validation, and encoding behavior cannot be replaced after module
publication. Upload bytes and external-image source contents remain application-owned
mutable payloads by identity; locking a command never freezes those contents or a
referenced Resource's own lifecycle.
`isDisposed` is a read-only observation backed by private state; `dispose()` is
irreversible, and neither assignment nor property shadowing can make a disposed command
usable again. `ResolveQuerySetCommand` owns one deeply frozen source snapshot. Its
`querySet`, `firstQuery`, and `queryCount` observations are derived from that snapshot, so
submission readiness and native encoding cannot inspect different slot ranges.

Command-kind authority is also closed inside the module. Every successfully constructed
executable command registers its exact command-family discriminator in one
module-private `WeakMap`; command guards require both the exact built-in prototype and
that private brand. Submission and fallback validation use those guards rather than
public `instanceof`. Command construction likewise admits render and compute pipelines
only through `isRenderPipeline()` / `isComputePipeline()` and bind sets only through
`isBindSet()`, each backed by its owning module's private state map. Resource and query
operands use their own closed brands. Replacing `Symbol.hasInstance`, supplying an
`assertRuntime()`-shaped record, subclassing, or using
`Object.create(CommandClass.prototype)` therefore cannot inject forged Pipeline,
BindSet, or Command facts into construction, fallback resolution, submission, or native
encoding.

### Texture Allocation Replacement

`TextureResource.resize()` is a Promise-returning resource-lifecycle operation, not a `Command`, upload, copy, or submission step. It creates no encoder, queue action, resource-access entry, producer epoch, or content write. While native scopes settle, the old allocation remains current; acknowledged changed resize advances `allocationVersion`, preserves `contentEpoch`, and marks the replacement empty.

Pass specs retain `TextureViewSpec` values rather than physical views. Render attachments lower them against the current allocation inside each submission. Texture upload, external-image upload, and every texture copy direction retain the logical TextureResource and resolve its current physical texture. Persistent texture bindings are different: BindSet preparation owns their allocation-scoped views, so replacement makes the set stale and the application must explicitly prepare it before a pre-existing command can be reused.

That reuse does not bypass validation. Upload and copy commands revalidate mip, origin, extent, layer, and sample constraints against the current allocation before encoder or queue effects. BindSet preparation revalidates each TextureViewSpec against its BindLayout and current allocation; command preflight requires that prepared snapshot to remain current. Render attachments accept native-renderable `2d`, `2d-array`, and `3d` views with one mip and one selected array layer. Color slots require a color-renderable format. A `2d-array` view selects that layer through `baseArrayLayer`; a `3d` view spans the current logical mip depth and the pass selects one `depthSlice`. Submission revalidates the view and `depthSlice` against the current allocation and requires all color attachment regions to be pairwise disjoint before command encoder creation, without applying texture-binding-only constraints. Distinct array layers and distinct 3D `depthSlice` values remain valid. A fixed required `contentEpoch` remains exact: preserving the numeric epoch across replacement does not make the empty new allocation readable.

### ExternalImageUploadCommand

`ExternalImageUploadCommand` represents the native immediate queue operation `GPUQueue.copyExternalImageToTexture()`. It is an upload rather than a fifth `CopyCommand` direction:

```ts
commandKind: 'upload'
uploadKind: 'external-image'
```

The other upload variants are explicitly discriminated as `uploadKind: 'buffer'` and `uploadKind: 'texture'`. The external-image descriptor retains a canonical `GPUCopyExternalImageSource` by identity and exposes `sourceOrigin`, `flipY`, target texture `origin`, `mipLevel`, `colorSpace`, `premultipliedAlpha`, and explicit width/height. Destination aspect is fixed to `all` and `depthOrArrayLayers` to `1`.

The complete current source union is accepted: `ImageBitmap`, `ImageData`, `HTMLImageElement`, `HTMLVideoElement`, `VideoFrame`, `HTMLCanvasElement`, and `OffscreenCanvas`. Cross-realm-safe platform getter brand checks reject arbitrary records without requiring realm-local `instanceof`. Construction locks command fields without requiring the source to be loaded. Execution revalidates the exact public dimension fields for image, video, frame, and data sources. Canvas dimensions may instead be the current WebGL drawing buffer or an `ImageBitmapRenderingContext` internal output bitmap; because the canvas does not expose a side-effect-free context-mode query, Scratch leaves that context-specific source-range check to the native content timeline and classifies its synchronous `OperationError` as invalid input.

Lowering uses canonical `GPUCopyExternalImageSourceInfo` and `GPUCopyExternalImageDestInfo` and requires the command runtime's own queue. The same queue-ownership rule applies to direct buffer and texture uploads before any native or logical effect. Pixels are captured when the native queue method is called. Scratch does not call `getContext()` to inspect a canvas, extract CPU pixels, use `writeTexture()`, close or dispose the source, or invent a source resource epoch.

Eligible targets are single-sampled 2D plain color textures with both `COPY_DST` and `RENDER_ATTACHMENT` usage and a device-enabled renderable `unorm`, `unorm-srgb`, `float`, or `ufloat` format. Direct execution and submission use the same validation, native-call, failure, and target-epoch path. See ADR-030.

The buffer `ReadbackCommand` path is implemented through Promise-only `createReadbackCommand()` / `readbackCommand()` factories. A command becomes visible only after one reusable staging slot is acknowledged, uses an explicit source `contentEpoch`, enters submission order through `SubmissionBuilder.readback(...)`, stages once at that position, and returns the associated `ReadbackOperation` through `result({ after })`. Direct texture readback and mapped leases remain future work; finite pending-operation and staging-byte budgets are implemented runtime policy.

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

DrawCommand and DispatchCommand use one closed read-epoch contract:

```ts
type CommandResourceReadEpoch = number | 'current-at-step'

type CommandResourceReadDescriptor = {
    readonly resource: BufferResource | TextureResource
    readonly contentEpoch: CommandResourceReadEpoch
}
```

A number requires the exact simulated epoch and keeps stale/read-before-write diagnostics. `'current-at-step'` resolves the content immediately before the final selected command at its explicit submission position, after prior step effects and before its own writes. The declaration is immutable and reusable; resolution does not rewrite it. Bare resources, aliases such as `latest`, callbacks, closures, setters, and compatibility overloads are rejected. Vertex, index, and indirect buffers use the same declaration mode. Copy, Readback, and query-slot sources remain exact numeric contracts.

Commands that write resource contents advance `contentEpoch`. Commands that replace physical GPU objects advance `allocationVersion`. The two effects are separate so a compute write does not accidentally imply bind group invalidation.

### Native Observation Boundary

Command execution participates in its enclosing submission observation. In the
default summary mode, one submission-family scope bundle surrounds all command
encoding and queue actions; it does not claim one failing command. A finite
`nativeSubmissionDetail: 'step'` capture can instead place a balanced scope
bundle around a standalone or pass-command location and report
`exact-operation` attribution to that location.

Every referenced BindSet must already be `prepared`. Command preflight checks
its immutable slot table, prepared allocation snapshot, Program requirements,
named dynamic offsets, and declared resource access before encoder creation.
Submission may create submission-scoped attachment views by lowering a pass-owned
`TextureViewSpec` against the current allocation. It never creates a persistent binding
texture view or bind group, calls `prepare()`, waits, retries, or repairs stale binding
state. BindSet preparation is an independently acknowledged
`bind-set-preparation` operation.

Draw and dispatch execution contracts are normalized and locked at construction. Their pipeline, bind/index/vertex state, count, dynamic offsets, resource declarations, readiness policy, and fallback reference cannot drift between validation and encoding; referenced bind sets expose the same immutable normalized binding table. `dispose()` remains the explicit mutable lifecycle transition, exposed through a read-only `isDisposed` state rather than a writable flag.

Pipeline and command validation findings should use the shared `ScratchDiagnostic` envelope from `09-diagnostics-validation`. `Command` diagnostics should identify the command as `subject` and put related resources, pass specs, pipelines, or bind sets in `related` instead of prose.

Query commands write indexed `QuerySetResource` slots. Resolving a query set writes bytes into a destination buffer and advances that buffer's `contentEpoch`; it does not make CPU-visible data until a `ReadbackOperation` is created or consumed.

## DrawCommand

The implemented native count contract supports static vertex values, static indexed values, and indirect buffers:

```ts
type DrawCount =
    | { vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number }
    | { indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number }
    | { indirect: BufferRegion }
```

An indexed static count requires `indexBuffer`; a static vertex count forbids it. Direct, indexed, and indirect count fields are mutually exclusive in the descriptor and at runtime. An indirect count selects `drawIndirect` without `indexBuffer` and `drawIndexedIndirect` with it. Draw construction requires a render pipeline and one binding for every vertex-buffer slot declared by that pipeline. Every vertex `BufferRegion` starts at a 4-byte-aligned parent-buffer offset, matching `setVertexBuffer`; this is independent of attribute stride and shader layout. Direct count values use WebGPU integer domains and allow zero-count no-ops. A known static no-op does not advance declared output epochs or create producer facts; an indirect command remains a potential writer because Scratch does not inspect GPU argument bytes. Index-buffer offsets follow the selected format's alignment; binding sizes preserve WebGPU's non-negative native byte-range semantics, including zero and ranges that do not end on a complete index element. Static `firstIndex + indexCount` must fit within the complete indices in the bound range, and strip pipelines require the bound format to match `stripIndexFormat`; indirect argument contents are not inspected for equivalent CPU-side count-range checks.

Static values are the default path:

```ts
const vertexBuffer = await runtime.createBuffer({
    label: 'triangle vertices',
    size: vertexBytes.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
})
const vertexRegion = vertexBuffer.region()
const drawTriangle = runtime.createDrawCommand({
    label: 'draw triangle',
    pipeline: trianglePipeline,
    bindSets: [],
    vertexBuffers: [
        { slot: 0, region: vertexRegion },
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

CPU-dynamic resolver closures remain future work and are not accepted by the
current public API. Direct count fields remain immutable. When CPU work already
packs a native indirect-argument record, a stable `UploadCommand` may update that
record in a `COPY_DST | INDIRECT` buffer and a stable command may keep referring
to its indirect region. The dynamic value is explicit resource data, not a count
closure or a mutation of the command descriptor.

Indirect counts are the implemented, preferred GPU-driven path when compute produces draw arguments. The indirect and optional index buffers must also appear in `resources.read` with their required content epochs. Scratch validates usage, alignment, range, ownership, disposal, readiness, and epochs without inspecting argument bytes on the CPU.

An indirect record need not be GPU-produced. CPU culling may update the same
record through an ordered upload before the draw. The upload advances the
buffer epoch, the draw declares a `'current-at-step'` read, and SubmittedWork
retains the producer/read chain. This CPU-to-GPU write is not a GPU-to-CPU
roundtrip and requires no mapping or readback.

## DispatchCommand

The implemented dispatch count follows the same native model:

```ts
type DispatchCount =
    | { workgroups: [number, number?, number?] }
    | { indirect: BufferRegion }
```

Static workgroup dimensions allow zero and are checked against `maxComputeWorkgroupsPerDimension`. Indirect dispatch validates a 12-byte GPU argument range and remains GPU-side.

Example:

```ts
const simulate = runtime.createDispatchCommand({
    label: 'simulate particles',
    pipeline: simulationPipeline,
    bindSets: [ { set: simulationSet } ],
    count: { workgroups: [64, 64, 1] },
    resources: {
        read: [ { resource: flowTexture, contentEpoch: flowTexture.contentEpoch } ],
        write: [particleBuffer],
    },
    whenMissing: 'skip-command',
})
```

## Query Commands

Query commands expose WebGPU query mechanics without inventing profiling abstractions that the platform does not provide.

```ts
const resolveTiming = runtime.createResolveQuerySetCommand({
    label: 'resolve timing',
    source: {
        querySet: timingQueries,
        slots: [
            { index: 0, contentEpoch: 1 },
            { index: 1, contentEpoch: 1 },
        ],
    },
    destination: timingBuffer.region(),
    whenMissing: 'throw',
})
```

`ResolveQuerySetCommand` is a copy/resolve command. Its source is an explicit contiguous set of indexed query slots with required slot content epochs, and its destination must be a buffer with query-resolve usage plus any later copy/readback usage the workflow needs. Later CPU access still uses `ReadbackOperation`.

Occlusion query brackets are render-pass-only command-like encoder actions:

```ts
runtime.createBeginOcclusionQueryCommand({ querySet: visibilityQueries, index: tileIndex })
runtime.createEndOcclusionQueryCommand()
```

They require the active render pass to own the same `occlusionQuerySet`, cannot be nested, and write one indexed query slot.

## Acknowledged Pipeline Creation

Scratch pipeline construction is asynchronous and symmetric for render and
compute:

```ts
const render = await runtime.createRenderPipeline(renderDescriptor)
const compute = await runtime.createComputePipeline(computeDescriptor)
```

Only `createRenderPipelineAsync()` and `createComputePipelineAsync()` are valid
native lowering paths. A pipeline wrapper is returned only after one native
pipeline Promise, shader compilation information, validation/internal/OOM
scopes around the supporting shader module and pipeline layout, and lifecycle
checks have all settled. All scope pops are issued before the first `await`;
the implementation does not assume any Promise settlement order.

The exported pipeline classes remain valid `instanceof` targets, but direct and
subclass construction are closed with an internal token. A successful wrapper
owns one immutable bounded `compilationReport`. Warnings and information remain
successful evidence. Compilation errors, pipeline rejection, supporting-object
errors, structural Promise failures, disposal, and device loss reject the
factory with one structured `ScratchDiagnosticError`; no pending wrapper enters
a Draw or Dispatch command.

Pipeline creation and compilation are initialization work. Command encoding,
pass lowering, queue submission, and `SubmittedWork` add no hidden compilation,
scope, operation record, or wait.

## Count Triage

Draw and dispatch counts span three cases; choose by what the count actually depends on:

- Static, known at record time → use the literal form (`{ vertexCount: 3 }`, `{ workgroups: [64, 64, 1] }`). Do not wrap a constant in a closure.
- CPU-dynamic — known only after CPU-side work such as culling → use an uploaded indirect-argument record when the application can express the native ABI as explicit resource data. A resolver closure or tracked scalar handle remains future work for cases that do not use such a record (see `02-resources`, dynamic values).
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
