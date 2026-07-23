# Scratch Render/Pass Native Parity Audit

Status: accepted; implementation, specification review, independent review, and browser gate complete
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
| Render override constants | `GPUVertexState` and `GPUFragmentState` inherit `GPUProgrammableStage.constants`. | Independent snapshotted `vertexConstants` and `fragmentConstants`; no shared alias. | Native descriptors, mutation-after-call, invalid record/value, compute regression tests. | verified |
| Nullable vertex buffers | `GPUVertexState.buffers` is a sequence of nullable layouts and preserves indices. | Explicit null accepted; hole/undefined rejected; only non-null slots require draw buffers. | Native slot preservation and draw binding tests. | verified |
| Nullable fragment targets | `GPUFragmentState.targets` is a sequence of nullable target states and preserves shader locations. | Explicit null accepted; hole/undefined rejected. | Native slot preservation and pipeline/pass slot compatibility tests. | verified |
| Nullable color attachments | `GPURenderPassDescriptor.colorAttachments` is a sequence of nullable attachments. | Explicit null accepted; no view/access/epoch for null; hole/undefined rejected. | Native descriptor, ledger, and epoch tests. | verified |
| Multisample resolve | Source sample count is greater than one; target sample count is one; render extents and formats match; resolve view is non-3D and renderable; format supports resolve. | `resolveTarget` plus optional immutable view descriptor; texture or surface lifecycle; direct native resolve. | Valid native path and sample/format/extent/usage/alias/resize failures. | Node and browser verified |
| Resolve retention | Resolve writes the single-sampled target independently of source `storeOp`. | Persistent resolve target advances once; surface has no persistent epoch; discarded/transient source is not readable. | Store/discard/transient/readiness/epoch tests. | verified |
| Read-only depth/stencil | Read-only aspects set native flags and omit that aspect's load/store/clear operations. | Independent flags; read-only aspect is a pass read; writable aspect is a pass write. | Depth-only, stencil-only, mixed flags, lowering, and readiness tests. | Node and browser verified |
| Attachment conflict footprint | WebGPU permits sampling from an attachment aspect declared read-only and rejects writable aliasing. | Internal texture/mip/layer/aspect footprint; public epoch remains whole-resource. | Legal read-only depth sampling and overlapping writable rejection tests. | verified |
| `maxDrawCount` | Render pass descriptor accepts an unsigned 64-bit draw-count hint with default 50,000,000. | Optional non-negative JavaScript safe integer, frozen and lowered unchanged. | Native descriptor and invalid integer tests. | verified |
| Viewport | Render pass encoder `setViewport()` owns finite coordinates, dimensions, and depth range. | Every draw resolves an explicit viewport; omission/full means current attachment. | Independent draws, bounds, finite values, and resize tests. | Node and browser verified |
| Scissor | Render pass encoder `setScissorRect()` owns integer in-bounds rectangle state. | Every draw resolves an explicit scissor; omission/full means current attachment. | Independent draws, integer/range, and resize tests. | Node and browser verified |
| Blend/stencil dynamic state | Render pass encoder owns blend constant and stencil reference state. | Every draw sets an immutable authored or normalized default value. | Native order, snapshots, invalid values, and independence tests. | verified |
| Native buffer clear | Command encoder `clearBuffer()` requires `COPY_DST`, aligned in-range offset/size, and allows zero size. | `ClearBufferCommand` plus `submission.clear`; direct native operation; zero-size no-op. | Alignment/range/usage/order/epoch/native-failure tests. | verified |

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
| Pipeline/pass sample-count mismatch | `SCRATCH_PIPELINE_SAMPLE_COUNT_MISMATCH` |
| Pipeline/pass depth-stencil format or presence mismatch | `SCRATCH_PIPELINE_DEPTH_STENCIL_MISMATCH` |
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

## Final Specification Cross-Check

The final audit used fixed local copies of the official sources:

- WebGPU CRD 2026-07-14, SHA-256
  `23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30`;
- WGSL CRD 2026-07-16, SHA-256
  `2ae2de9464930086cb7c611951262bfd4c989a312802e30162cfd246567d66aa`.

The cross-check confirmed programmable-stage constants, nullable ordered slots,
resolve constraints, independent depth/stencil read-only flags, `maxDrawCount`,
per-draw encoder state, and native `clearBuffer()`. It also found and corrected two
facts that the first implementation missed:

- render-pipeline/pass layout compatibility includes sample count and exact
  depth/stencil-format presence, while color-format equality ignores trailing nulls;
- resolve capability is feature-dependent for tier-one signed-normalized formats,
  `rg11b10ufloat`, `bgra8unorm-srgb`, and `rgba16float`.

## Completion Record

Implementation and public type evidence are present on the feature branch. The final
sequential gates passed on 2026-07-23:

- `npm test`: 974 passing, 2 pending;
- `npm run typecheck`: passed, including package, examples, and WebGPU declarations;
- `npm run build`: passed, including the standalone `renderPassFeatures` page; and
- `git diff --check`: passed.

Primary automated evidence lives in
`tests/scratch-render-pipeline-async.test.js`,
`tests/scratch-pipeline-command.test.js`,
`tests/scratch-render-pass-native-parity.test.js`,
`tests/scratch-render-state-clear.test.js`,
`tests/scratch-command-lifecycle.test.js`,
`tests/examples-structure.test.js`, and `tests/types/public-api.ts`.

Exactly one independent review found five actionable compatibility and validation
issues: missing sample-count/depth-presence layout checks, trailing-null equality,
read-only clear rejection, and invalid clear-descriptor normalization. The fixed
specification cross-check found the resolve-format feature-table omission. All six
were closed in the single final correction and covered by regression tests.

The bounded headed-browser gate used Chrome 150.0.7871.130 on an Apple Metal 3
adapter. Its first attempt ended before page acceptance because the verification
harness serialized a closure incorrectly; the permitted infrastructure retry passed:

- `renderPassFeatures` proved sparse color slots, 4x MSAA resolve, independent
  viewport/scissor state, and output at both 960x720 and 800x600;
- `renderToTexture` remained nonblank before and after the same resize;
- `helloGAW` completed 120 observed five-stage frames across one resize with stable
  graph identity, matching producer/read epochs, zero uncaptured errors, and zero
  device losses; and
- all three pages had nonblank pixel ranges and no console errors, page errors,
  failed requests, HTTP failures, or WebGPU validation warnings.

The accepted screenshots are retained under the ignored
`output/playwright/render-pass-native-parity-v1/` evidence directory.
