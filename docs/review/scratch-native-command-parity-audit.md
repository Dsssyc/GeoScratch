# Scratch Native Draw And Dispatch Parity Audit

Status: complete for ADR-027
Date: 2026-07-10
Baseline: `54d113d`

## Scope

This audit compares Scratch's implemented draw/dispatch command surface one-to-one with the WebGPU render and compute encoder methods targeted by the current vision. It checks public types, direct native lowering, validation, explicit resource/epoch facts, automated tests, documentation, and real-browser evidence.

## Parity Matrix

| WebGPU method | Scratch contract | Native lowering | Validation and ledger | Automated evidence | Documentation |
| --- | --- | --- | --- | --- | --- |
| `draw` | `StaticDrawCount` without `indexBuffer` | `DrawCommand.encode` calls `passEncoder.draw` | u32 direct arguments; vertex buffers require explicit epoch reads | existing `scratch-pipeline-command.test.js`; zero-count coverage in `scratch-native-indirect-execution.test.js` | vision `04`; ADR-015 and ADR-027 |
| `drawIndexed` | `StaticIndexedDrawCount` plus `DrawIndexBufferBinding` | `setIndexBuffer` then `drawIndexed` | INDEX usage, format/alignment/range/runtime/disposal; index read in ledger | static indexed, uint16/uint32, pairing, diagnostic, and ledger tests | vision `04` and `09`; ADR-027 |
| `drawIndirect` | `IndirectCommandCount` without `indexBuffer` | `passEncoder.drawIndirect` | INDIRECT usage, 4-byte offset, 16-byte range; required read epoch | native lowering, invalid-buffer, same-submission producer, and ledger tests | vision `04` and `05`; ADR-027 |
| `drawIndexedIndirect` | `IndirectCommandCount` plus `DrawIndexBufferBinding` | `setIndexBuffer` then `drawIndexedIndirect` | combined index/indirect validation; 20-byte argument range; both reads in ledger | native lowering, range, same-submission producer, and real-browser example | vision `04`, `05`, and `09`; ADR-027 |
| `dispatchWorkgroups` | `StaticDispatchCount` | `DispatchCommand.encode` calls `dispatchWorkgroups` | u32 dimensions, zero allowed, device limit enforced | existing compute tests plus zero/limit tests | vision `04` and `05`; ADR-027 |
| `dispatchWorkgroupsIndirect` | `IndirectCommandCount` | `passEncoder.dispatchWorkgroupsIndirect` | INDIRECT usage, 4-byte offset, 12-byte range; required read epoch | native lowering, invalid-buffer, same-submission producer, ledger, and real-browser example | vision `04` and `05`; ADR-027 |

## Cross-Cutting Facts

- Public types are exported from both `geoscratch` and `geoscratch/scratch`.
- Type-contract tests reject indexed count without an index buffer and static vertex count with an index buffer.
- Fixed-function buffers are not inferred into the epoch model. Vertex, index, and indirect buffers require explicit `{ resource, contentEpoch }` declarations.
- Reads preserve `contentEpoch`; only declared writes create producer epochs.
- Indirect argument bytes are never mapped, read back, or decoded on the CPU.
- CPU-dynamic resolver closures are still a vision target and are not claimed as implemented.

## Browser Evidence

The `examples/indirectExecution` page was loaded in Chromium with WebGPU enabled at `http://127.0.0.1:5173/indirectExecution/`.

- canvas status: `ready`
- console errors: `0`
- console warnings: `0`
- screenshot size: `1200 x 818`
- non-indexed teal pixels at the primary color: `69,638`
- indexed orange pixels at the primary color: `69,638`
- background pixels at the primary color: `841,188`

The compute command is itself launched with `dispatchWorkgroupsIndirect`, writes both draw argument buffers on the GPU, and is followed in the same submission by `drawIndirect` and `drawIndexedIndirect`. The example source contains no readback or mapping call.

## Result

No native method in the six-row target set is missing. Every method has a public Scratch contract, direct encoder lowering, structured validation, epoch/ledger behavior, automated coverage, and documentation. The two indirect render methods and indirect dispatch are additionally exercised together in a real WebGPU browser.
