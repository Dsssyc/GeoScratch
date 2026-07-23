# ADR-047: Add Declarative Per-Command Immediate Data

## Status

Accepted

## Date

2026-07-23

## Context

Scratch already exposes explicit asynchronous runtime creation, stable render and
compute pipelines, immutable DrawCommand and DispatchCommand objects, explicit
submission order, resource readiness and content epochs, and bounded native-error
observation. Small high-frequency values still have to be represented as buffer
resources even when WebGPU and WGSL expose immediate data specifically for that use.

The 14 July 2026 WebGPU Candidate Recommendation Draft and 16 July 2026 WGSL
Candidate Recommendation Draft define one complete native path:

- `GPU.wgslLanguageFeatures` reports automatically enabled WGSL language extensions;
- the `immediate_address_space` language extension enables `var<immediate>`;
- `GPUSupportedLimits.maxImmediateSize` bounds the immediate byte range;
- `GPUPipelineLayoutDescriptor.immediateSize` declares that range;
- `GPUBindingCommandsMixin.setImmediates()` copies bytes into encoder immediate
  slots; and
- draw and dispatch validation requires every `AccessibleSlots(T)` slot used by the
  entry point's immediate variable to have been initialized.

Exposing native partial `setImmediates(offset, data)` calls as independent Scratch
commands would make a DrawCommand or DispatchCommand depend on mutable state left by
earlier encoder calls. That would weaken the local, declarative command model and
reintroduce a WebGL-style state-history requirement.

Conversely, freezing immediate values when a Command is constructed would make a
stable command unsuitable for frame-varying values. Scratch needs stable command
identity while preserving a deterministic input snapshot for each submission
attempt.

## Decision

### Runtime language-feature facts

`ScratchRuntime` exposes:

```ts
readonly wgslLanguageFeatures: readonly string[]
```

Runtime creation snapshots `gpu.wgslLanguageFeatures`, removes duplicates, sorts the
names deterministically, and freezes the result. A platform without that member
produces an empty list. Scratch exposes no mutable native set and no native GPU object
through this fact.

### Program language-feature contract

`ProgramDescriptor` gains:

```ts
requiredLanguageFeatures?: Iterable<string>
```

`Program.requiredLanguageFeatures` remains a caller-owned contract in the same sense
as the existing Program facts. Program creation validates the current Runtime
capability. Every future render or compute Pipeline creation materializes, snapshots,
and revalidates the Program requirement before native issue. Mutation after native
pipeline issue cannot rewrite that transaction.

WGSL language extensions remain distinct from `GPUFeatureName` device features.
Scratch does not parse, add, or rewrite WGSL `requires` directives. The Program field
is an explicit capability contract that can be validated independently of source
inspection.

Unavailable language features use
`SCRATCH_PROGRAM_LANGUAGE_FEATURE_UNAVAILABLE`.

### Pipeline immediate range

Render and compute pipeline descriptors gain:

```ts
immediateSize?: number
```

Both Pipeline wrappers expose one immutable normalized `immediateSize`. Omission
normalizes to zero. A nonzero value must be:

- a non-negative JavaScript safe integer;
- representable as `GPUSize32`;
- a multiple of four;
- no greater than `runtime.deviceLimits.maxImmediateSize`; and
- paired with a Program whose snapshotted required language features include
  `immediate_address_space`.

Scratch lowers the value directly to
`GPUPipelineLayoutDescriptor.immediateSize`. Pipeline-layout identity and equality
facts include it. Pipeline descriptors, diagnostics, and retained evidence may record
the size but never an immediate payload.

Invalid size or capability coupling uses
`SCRATCH_PIPELINE_IMMEDIATE_SIZE_INVALID`.

### Complete immediate state per executable command

DrawCommand and DispatchCommand descriptors gain:

```ts
immediateData?: CommandImmediateData

type CommandImmediateData =
    | ArrayBuffer
    | ArrayBufferView
    | LayoutUploadView
```

A Pipeline with `immediateSize === 0` forbids the field. A Pipeline with a nonzero
size requires it. The source's visible byte length must equal the Pipeline size
exactly. Scratch never truncates, pads, clamps, performs typed-element conversion, or
accepts a callback, getter, resolver closure, or partial range.

ArrayBuffer uses its complete visible bytes. An ArrayBufferView uses only the view's
visible byte range. LayoutUploadView uses its explicit byte offset and length inside
`bytes.buffer`; the explicit range may differ from the `bytes` view's own visible
subrange, matching the existing upload contract. Its four public fields are
materialized once during Command construction so accessor failures cannot escape the
structured diagnostic envelope. This byte-oriented contract deliberately avoids
native `dataOffset` and `dataSize` element-unit differences for TypedArrays.

The Command freezes source identity and expected byte length, not source contents.
Application code may update those contents between submissions while reusing the same
Command.

### Per-submission snapshot

Submission preparation first resolves readiness, fallback, skip-command, and
skip-pass control flow. It then materializes immediate data only for final executable
DrawCommand and DispatchCommand steps.

For each actual step, preparation:

1. verifies that the source is still readable and has the exact expected byte length;
2. copies its current visible bytes into a private `Uint8Array`;
3. retains that immutable attempt-local snapshot through preflight and encoding; and
4. performs no native or logical effect if any snapshot or later preflight fails.

Skipped primary commands and rolled-back passes do not have their immediate sources
read. A selected fallback uses only its own source. Repeated use of one Command in a
submission resolves one snapshot per actual step.

Detached, resized, forged, or otherwise incompatible sources use
`SCRATCH_COMMAND_IMMEDIATE_DATA_INVALID`.

### Native lowering

Each actual render command with a nonzero range lowers in this order:

```text
setPipeline
setImmediates(0, completeSnapshot)
setViewport / setScissor / setBlendConstant / setStencilReference
setVertexBuffer / setIndexBuffer
setBindGroup
draw / drawIndexed / drawIndirect / drawIndexedIndirect
```

Each actual compute command with a nonzero range lowers in this order:

```text
setPipeline
setImmediates(0, completeSnapshot)
setBindGroup
dispatchWorkgroups / dispatchWorkgroupsIndirect
```

Zero-size Pipelines issue no `setImmediates()` call. A nonzero command issues exactly
one complete call, with no cross-command deduplication. Consequently every command
initializes every slot in its declared range and cannot depend on preceding encoder
history. This is stricter than native partial update while preserving every
shader-observable final immediate state.

Native synchronous throws and scoped validation remain owned by the existing
submission native-observation transaction and are attributed to the command-encode
location. No side encoder or queue path is added.

### LayoutCodec compatibility

`LayoutCodecUsage` gains `'immediate'`.

Current scalar, vector, and `mat4x4f` fields may be lowered for immediate use. A
LayoutSpec containing an array field is not immediate-compatible because WGSL rejects
an immediate array and any structure containing an array member.
`LayoutArtifact.usageCompatibility.immediate` records this fact explicitly.

A LayoutUploadView is accepted as Command immediate data only when its artifact
declares immediate compatibility. Codec-generated WGSL remains a struct/accessor
module. It does not inject `requires immediate_address_space;` or
`var<immediate>`.

Raw ArrayBuffer and ArrayBufferView paths remain available so LayoutCodec's current
type vocabulary does not narrow the native WGSL capability.

### Resource and evidence boundaries

Immediate data is command encoder input, not a Scratch Resource:

- no BufferResource is created;
- no `allocationVersion` or `contentEpoch` exists;
- no resource-read or resource-write ledger entry is added;
- no UploadCommand or `queue.writeBuffer()` path is used; and
- no temporary compute pipeline is created.

SubmittedWork, diagnostics, capture, and export evidence may retain source kind,
visible byte length, expected size, LayoutArtifact hashes, Program/Pipeline/Command
identities, language-feature names, and native stage. They must not retain payload
bytes, typed values, payload hashes, WGSL source, or native handles.

## Alternatives Considered

### Public partial SetImmediatesCommand

Rejected. It would make an executable command's meaning depend on previous mutable
encoder state and would require an agent to reconstruct command history before
understanding one Draw or Dispatch.

### Freeze values at Command construction

Rejected. It would force applications to rebuild Command objects for ordinary
frame-varying values and would contradict the existing stable-command model.

### Model immediate data as an UploadCommand or BufferResource

Rejected. That would fabricate allocation, transfer, epoch, and resource-ledger
semantics for a native command-encoder data path.

### Support only LayoutCodec values

Rejected. LayoutCodec is the preferred structured authoring path, but its current
type set is intentionally smaller than the complete WGSL immediate store-type set.
Raw bytes preserve native expressiveness.

### Parse WGSL to infer requirements and size

Rejected. Explicit Program and Pipeline contracts remain authoritative. Shader
inspection may later provide diagnostics, but it cannot replace the declared API or
rewrite source.

## Consequences

- Render and compute commands gain a small, direct, frame-variable data path without
  resource allocation or CPU-to-GPU buffer transfer semantics.
- Every Command remains locally understandable and independent of preceding encoder
  history.
- Every submission attempt has deterministic bytes even when the caller mutates a
  persistent source after `submit()` begins.
- Runtime, Program, Pipeline, LayoutCodec, Command, submission, diagnostics, examples,
  and public types all require coordinated updates.
- RenderBundle, GPUExternalTexture, public debug markers, partial immediate updates,
  tracked dynamic callbacks, `buffer_view`, broader LayoutCodec types, and complete
  WebGPU/WGSL parity remain separate follow-up decisions.
