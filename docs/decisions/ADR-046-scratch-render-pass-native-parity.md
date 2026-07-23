# ADR-046: Complete the Current Scratch Render/Pass Native Parity Slice

## Status

Accepted

## Date

2026-07-23

## Context

Scratch already expresses stable render and compute pipelines, persistent pass specs,
immutable draw and dispatch commands, explicit submission order, resource readiness,
content epochs, surface leases, and native error observation. The current examples
prove that this model can express complete application render graphs without reaching
through `ScratchRuntime` to a raw device or queue.

The render path still omits a bounded set of WebGPU Candidate Recommendation Draft
capabilities:

- programmable-stage override constants on render pipelines;
- nullable vertex-buffer, color-target, and color-attachment slots;
- multisample color resolve;
- depth/stencil read-only aspects;
- `maxDrawCount`;
- render-pass dynamic state with deterministic per-draw ownership; and
- native command-encoder buffer clear.

These are general WebGPU operations rather than application-shaped conveniences.
Without them, a consumer must either bypass Scratch or simulate native behavior using
CPU writes, additional pipelines, or encoder state whose owner is not visible in the
command graph.

This decision is based on the 14 July 2026 WebGPU Candidate Recommendation Draft and
the 16 July 2026 WGSL Candidate Recommendation Draft. Later editor-draft additions
are follow-up facts and do not expand this decision.

## Decision

### Render pipeline state

`RenderPipelineDescriptor` gains independent immutable
`vertexConstants?: Readonly<Record<string, number>>` and
`fragmentConstants?: Readonly<Record<string, number>>` fields. Scratch snapshots
these records before asynchronous native issue and lowers them to the matching
`GPUVertexState.constants` and `GPUFragmentState.constants`. A single ambiguous
render `constants` alias is not introduced. Existing compute constants retain their
current contract.

The following ordered pipeline fields accept explicit `null`:

```ts
vertexBuffers?: readonly (GPUVertexBufferLayout | null)[]
targets: readonly (GPUColorTargetState | null)[]
```

Slot positions are semantic. Scratch preserves each `null` in native descriptors,
rejects sparse holes and `undefined`, requires draw bindings only for non-null vertex
slots, and rejects a binding authored for a null slot.

### Render pass state

`RenderPassSpecDescriptor.color` becomes:

```ts
readonly (RenderPassColorAttachmentSpec | null)[]
```

An explicit null lowers to native null and has no view, access, readiness, or epoch
effect. Sparse holes and `undefined` are invalid.

A color attachment may name:

```ts
resolveTarget?: Surface | TextureViewSpec
resolveViewDescriptor?: Readonly<GPUTextureViewDescriptor>
```

The source must be multisampled and the resolve target single-sampled. Scratch
validates current allocations, render extents, formats, render-attachment usage,
renderable views, non-overlap, and resolve support before encoding. A surface resolve
target uses the same prepared-surface lease and native-observation lifecycle as a
surface source attachment. A persistent texture resolve target is one pass-level
write and advances its parent content epoch once after successful encoding. A surface
does not acquire a fabricated persistent epoch.

Resolve support follows the fixed CRD's per-format feature requirements rather than
a format-name shortcut. In particular, tier-one signed-normalized formats,
`rg11b10ufloat`, and core-feature formats are accepted only when their defining
device feature is present.

The source attachment remains a write even when it resolves. `store: 'store'`
retains readable source content. `store: 'discard'` and transient source attachments
do not advertise readable retained content. The resolve target is the retained result
when it is persistent.

Depth/stencil attachment specs gain independent `depthReadOnly?: boolean` and
`stencilReadOnly?: boolean`. A read-only aspect has no load/store/clear operations,
must already contain readable content, and contributes a pass-level read. A writable
aspect contributes a pass-level write. Parent texture epochs remain whole-resource:
no writable aspect means no write epoch, while one or more writable aspects advance
the parent at most once.

Internal same-pass conflict validation uses texture, mip, layer/depth slice, and
aspect footprints. This permits a draw to sample an overlapping read-only depth
aspect and still rejects access overlapping a writable attachment aspect. The public
resource ledger and epoch API remain parent-resource facts.

Before encoding a draw, Scratch compares the complete render-pass layout required by
WebGPU: color formats are equal after ignoring trailing null slots, depth/stencil
formats are equal including absence, and sample counts are equal.

`RenderPassSpecDescriptor` also gains immutable `maxDrawCount?: number`. It accepts a
non-negative safe integer and lowers unchanged to
`GPURenderPassDescriptor.maxDrawCount`. Scratch makes no performance or success
guarantee from this hint.

### Per-draw render state

Each `DrawCommand` owns an immutable `renderState?: DrawRenderState`:

```ts
type DrawRenderState = Readonly<{
    viewport?: 'full-attachment' | Readonly<{
        x: number
        y: number
        width: number
        height: number
        minDepth?: number
        maxDepth?: number
    }>
    scissor?: 'full-attachment' | Readonly<{
        x: number
        y: number
        width: number
        height: number
    }>
    blendConstant?: Readonly<GPUColor>
    stencilReference?: number
}>
```

Omitted viewport and scissor mean the current full attachment. Omitted depth range,
blend constant, and stencil reference mean `0..1`, transparent black, and zero.
Scratch resolves full-attachment values from the current pass extent at submission
time, validates without clamping, and lowers a complete state before every draw.
Consequently, a draw never depends on state left by a previous draw. Scratch does not
expose public mutable set-state commands.

### Native buffer clear

`ScratchRuntime.createClearBufferCommand({ label?, target: BufferRegion })` creates an
immutable command with `commandKind: 'clear'`. `SubmissionBuilder.clear(command)`
places it in explicit queue order. A non-empty target lowers directly to
`GPUCommandEncoder.clearBuffer()` and is a parent-buffer write participating in
dependency validation, potential writes, native observation, and content epochs.

The target must have `COPY_DST` usage, a current allocation, a four-byte aligned
offset and size, and an in-range extent. A zero-size region is a physical and logical
no-op. Scratch does not add a texture-clear command because WebGPU exposes no
equivalent general command-encoder operation.

### Diagnostics

New deterministic validation uses the existing `ScratchDiagnostic` envelope:

| Code | Meaning |
| --- | --- |
| `SCRATCH_PIPELINE_CONSTANTS_INVALID` | A render-stage constants record or value is invalid. |
| `SCRATCH_PIPELINE_TARGET_STATE_INVALID` | A render target array contains a hole, `undefined`, or invalid non-null state. |
| `SCRATCH_PIPELINE_SAMPLE_COUNT_MISMATCH` | A render pipeline and pass use different sample counts. |
| `SCRATCH_PASS_COLOR_ATTACHMENT_INVALID` | A color attachment array or non-null source attachment is invalid. |
| `SCRATCH_PASS_RESOLVE_ATTACHMENT_INVALID` | A resolve source/target pair violates resolve constraints. |
| `SCRATCH_PASS_MAX_DRAW_COUNT_INVALID` | `maxDrawCount` is not a non-negative safe integer. |
| `SCRATCH_COMMAND_RENDER_STATE_INVALID` | Authored or pass-resolved draw state is invalid. |
| `SCRATCH_COMMAND_CLEAR_BUFFER_INVALID` | A clear target, alignment, range, or usage is invalid. |

Existing codes remain authoritative for vertex-layout mismatch, depth/stencil
attachment shape, pipeline/pass compatibility, wrong runtime, disposed resources,
resource access conflicts, readiness failures, and asynchronous native validation,
internal, out-of-memory, or device-loss outcomes.

## Alternatives Considered

### Public set-state commands

Rejected. They would make command meaning depend on preceding encoder history and
reintroduce the mutable-state reasoning burden that immutable Scratch commands are
designed to remove.

### CPU or compute emulation for clear and resolve

Rejected. WebGPU already exposes direct GPU-native operations. Emulation would add
hidden resources, ordering, and failure modes while weakening parity.

### Compress null slots

Rejected. Vertex slots, fragment target locations, and attachment indices are part of
the native contract. Renumbering changes program and pipeline meaning.

### Promote aspect-level epochs to the public API

Rejected for this slice. Aspect-aware footprints are necessary for correct
same-pass validation, but changing the public epoch model would expand resource and
submission contracts beyond this bounded goal.

## Consequences

- Common MSAA, sparse attachment, per-draw dynamic-state, and buffer-clear workflows
  remain entirely inside Scratch.
- Commands remain immutable and independently understandable by a developer or agent.
- Resolve, discard, transient, and read-only effects become explicit in readiness and
  epoch evidence.
- ADR-023's rejection of read-only same-pass depth sampling and its statement that
  resolve remains future work are superseded by this decision.
- Scratch still does not claim complete WebGPU parity.
- Layout codec expansion, program language/limit declarations, external textures,
  render bundles, immediate data, mapped leases, direct texture readback, adapter
  options, compilation hints, public debug markers, and automatic render graphs
  remain outside this decision.
