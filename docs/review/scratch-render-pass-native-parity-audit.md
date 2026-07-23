# Scratch Render/Pass Native Parity Audit

Status: implementation pending
Date: 2026-07-23
Baseline: `18208cadccd8d091758436e2f398b8d62d3d83e8`
Decision: ADR-046
WebGPU source: Candidate Recommendation Draft, 14 July 2026
WGSL source: Candidate Recommendation Draft, 16 July 2026

## Fixed Scope

This audit is the bounded acceptance matrix for render pipeline constants, nullable
render slots, multisample resolve, depth/stencil read-only aspects, render-pass draw
limits, independent per-draw dynamic state, and native buffer clear. A row is complete
only when the public contract, native lowering, structured validation, resource
facts, automated evidence, and documentation agree.

Later WebGPU or WGSL editor-draft additions are follow-up facts. They cannot add work
to this matrix.

## Normative Matrix

| Capability | Normative WebGPU fact | Fixed Scratch contract | Required evidence | Status |
| --- | --- | --- | --- | --- |
| Render override constants | `GPUVertexState` and `GPUFragmentState` inherit `GPUProgrammableStage.constants`. | Independent snapshotted `vertexConstants` and `fragmentConstants`; no shared alias. | Native descriptors, mutation-after-call, invalid record/value, compute regression tests. | pending |
| Nullable vertex buffers | `GPUVertexState.buffers` is a sequence of nullable layouts and preserves indices. | Explicit null accepted; hole/undefined rejected; only non-null slots require draw buffers. | Native slot preservation and draw binding tests. | pending |
| Nullable fragment targets | `GPUFragmentState.targets` is a sequence of nullable target states and preserves shader locations. | Explicit null accepted; hole/undefined rejected. | Native slot preservation and pipeline/pass slot compatibility tests. | pending |
| Nullable color attachments | `GPURenderPassDescriptor.colorAttachments` is a sequence of nullable attachments. | Explicit null accepted; no view/access/epoch for null; hole/undefined rejected. | Native descriptor, ledger, and epoch tests. | pending |
| Multisample resolve | Source sample count is greater than one; target sample count is one; render extents and formats match; resolve view is non-3D and renderable; format supports resolve. | `resolveTarget` plus optional immutable view descriptor; texture or surface lifecycle; direct native resolve. | Valid native path and sample/format/extent/usage/alias/resize failures. | pending |
| Resolve retention | Resolve writes the single-sampled target independently of source `storeOp`. | Persistent resolve target advances once; surface has no persistent epoch; discarded/transient source is not readable. | Store/discard/transient/readiness/epoch tests. | pending |
| Read-only depth/stencil | Read-only aspects set native flags and omit that aspect's load/store operations. | Independent flags; read-only aspect is a pass read; writable aspect is a pass write. | Depth-only, stencil-only, mixed flags, lowering, and readiness tests. | pending |
| Attachment conflict footprint | WebGPU permits sampling from an attachment aspect declared read-only and rejects writable aliasing. | Internal texture/mip/layer/aspect footprint; public epoch remains whole-resource. | Legal read-only depth sampling and overlapping writable rejection tests. | pending |
| `maxDrawCount` | Render pass descriptor accepts an unsigned 64-bit draw-count hint with default 50,000,000. | Optional non-negative JavaScript safe integer, frozen and lowered unchanged. | Native descriptor and invalid integer tests. | pending |
| Viewport | Render pass encoder `setViewport()` owns finite coordinates, dimensions, and depth range. | Every draw resolves an explicit viewport; omission/full means current attachment. | Independent draws, bounds, finite values, and resize tests. | pending |
| Scissor | Render pass encoder `setScissorRect()` owns integer in-bounds rectangle state. | Every draw resolves an explicit scissor; omission/full means current attachment. | Independent draws, integer/range, and resize tests. | pending |
| Blend/stencil dynamic state | Render pass encoder owns blend constant and stencil reference state. | Every draw sets an immutable authored or normalized default value. | Native order, snapshots, invalid values, and independence tests. | pending |
| Native buffer clear | Command encoder `clearBuffer()` requires `COPY_DST`, aligned in-range offset/size, and allows zero size. | `ClearBufferCommand` plus `submission.clear`; direct native operation; zero-size no-op. | Alignment/range/usage/order/epoch/native-failure tests. | pending |

## Diagnostic Matrix

| Invalid fact | Primary code |
| --- | --- |
| Render-stage constants record/value | `SCRATCH_PIPELINE_CONSTANTS_INVALID` |
| Nullable target array hole/undefined/invalid state | `SCRATCH_PIPELINE_TARGET_STATE_INVALID` |
| Nullable color attachment hole/undefined/invalid source | `SCRATCH_PASS_COLOR_ATTACHMENT_INVALID` |
| Resolve source/target incompatibility | `SCRATCH_PASS_RESOLVE_ATTACHMENT_INVALID` |
| Invalid `maxDrawCount` | `SCRATCH_PASS_MAX_DRAW_COUNT_INVALID` |
| Invalid authored or resolved per-draw state | `SCRATCH_COMMAND_RENDER_STATE_INVALID` |
| Invalid clear target/alignment/range/usage | `SCRATCH_COMMAND_CLEAR_BUFFER_INVALID` |
| Null-slot pipeline/pass mismatch | `SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH` |
| Writable attachment overlap | `SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT` |
| Read-only uninitialized content | Existing readiness/content-indeterminate code |
| Native validation/internal/OOM/device loss | Existing submission native-observation code |

## Resource-Fact Rules

- Null slots have no resource fact.
- A retained color source contributes one pass write. A discarded or transient source
  contributes the physical write history but finishes indeterminate rather than ready.
- A persistent resolve target contributes one pass write and one produced parent
  epoch. A surface resolve target contributes lease and observation facts only.
- Read-only attachment aspects contribute reads. If every present depth/stencil
  aspect is read-only, the parent texture has no write epoch.
- Multiple writable aspects of one depth/stencil attachment still produce at most one
  parent epoch.
- Clear of a non-empty buffer region contributes one parent-buffer write. Zero-size
  clear contributes no access, epoch, potential write, or native command.

## Explicit Follow-Ups

The following current-spec capabilities are deliberately not claimed by this audit:

- render bundles;
- external textures;
- immediate data and `setImmediates`;
- public debug marker commands;
- shader compilation hints;
- adapter option expansion;
- mapped buffer leases and direct texture readback;
- public subresource/aspect epochs; and
- complete WebGPU or WGSL parity.

## Completion Record

Pending implementation, automated gates, type-contract evidence, and headed-browser
evidence.
