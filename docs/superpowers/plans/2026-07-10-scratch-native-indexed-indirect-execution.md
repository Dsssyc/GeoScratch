# Scratch Native Indexed And Indirect Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Scratch's WebGPU-native indexed and indirect draw/dispatch contract without CPU readback or a parallel compatibility API.

**Architecture:** Extend the existing `DrawCommand` and `DispatchCommand` count contracts with static indexed and indirect variants. Typed descriptor unions reject invalid index/count pairings, command construction validates fixed-function buffers and their explicit epoch declarations, and existing submission readiness/ledger machinery records those reads without introducing a second scheduler. A real browser example uses `dispatchWorkgroupsIndirect` to generate two draw argument buffers on the GPU, then consumes them with `drawIndirect` and `drawIndexedIndirect` in the same submission.

**Tech Stack:** TypeScript ES modules, WebGPU, Mocha/Chai, TypeScript declaration tests, Vite examples, Playwright browser verification.

---

## Baseline And Invariants

- Base commit: `54d113d` on `dev-feature`.
- Feature branch: `socu/scratch-native-indirect-execution`.
- Clean baseline: `npm test` reports `309 passing`.
- Scratch remains TypeScript source-first; no same-source `.js` or handwritten `.d.ts` files.
- New public failures use `ScratchDiagnostic`; no prose-only errors.
- No implementation may map, read back, or inspect indirect argument bytes on the CPU.
- Dynamic resolver closures, readiness-policy execution, readback leases/budgets, render bundles, multi-draw, and automatic scheduling remain out of scope.

## Requirement-To-Evidence Map

| Requirement | Authoritative evidence |
| --- | --- |
| Static non-indexed, static indexed, indirect non-indexed, indirect indexed draw | encoder action assertions in `tests/scratch-native-indirect-execution.test.js` |
| Static and indirect dispatch | encoder action assertions in the same test plus existing compute tests |
| Invalid TypeScript pairings rejected | `@ts-expect-error` checks in `tests/types/public-api.ts` and `npm run typecheck` |
| INDEX/INDIRECT usage, alignment, range, runtime, disposal | diagnostic-code assertions in the focused test |
| Explicit fixed-function reads and epochs | constructor diagnostics plus submission warn/throw tests |
| Same-submission GPU producer/consumer | submission ledger tests and the real `indirectExecution` example |
| No CPU roundtrip | source scan and browser network/console/runtime inspection |
| Bilingual design truth | ADR-027, paired vision diffs, and parity review |
| Native one-to-one parity | persisted audit matrix covering six encoder methods |

## Task 1: Public Contract And RED Type Tests

**Files:**
- Create: `tests/scratch-native-indirect-execution.test.js`
- Modify: `tests/types/public-api.ts`
- Modify: `packages/geoscratch/src/scratch/command.ts`
- Modify: `packages/geoscratch/src/scratch/index.ts`

- [x] Add runtime RED tests that import the new public count/index types through their observable factories and request static indexed plus all indirect forms.
- [x] Add `@ts-expect-error` cases for indexed count without `indexBuffer` and non-indexed static count with `indexBuffer`; run `npm run typecheck` and confirm the directives are not yet satisfied by the missing union.
- [x] Define `StaticIndexedDrawCount`, `IndirectCommandCount`, `DrawCount`, `DispatchCount`, `DrawIndexBufferBinding`, and normalized index-binding types.
- [x] Make `DrawCommandDescriptor` a union whose indexed branch requires `indexBuffer`, while its non-indexed branch forbids it; keep indirect mode selected by index-buffer presence.
- [x] Export all public types from both `geoscratch` and `geoscratch/scratch`.
- [x] Run `npm run typecheck` and focused tests; commit with `git commit -m "Add Scratch indexed indirect command contracts"`.

## Task 2: Static Indexed Draw And Direct Count Semantics

**Files:**
- Modify: `tests/scratch-native-indirect-execution.test.js`
- Modify: `tests/scratch-pipeline-command.test.js`
- Modify: `tests/scratch-test-utils.js`
- Modify: `packages/geoscratch/src/scratch/command.ts`

- [x] Write RED tests for `setIndexBuffer` followed by `drawIndexed`, both index formats, normalized ranges, illegal pairings at runtime, and `SCRATCH_COMMAND_INDEX_BUFFER_INVALID`.
- [x] Add RED tests proving zero vertex/index/instance counts and zero direct dispatch dimensions are legal, while fractional/out-of-u32 values and out-of-i32 `baseVertex` fail with `SCRATCH_COMMAND_COUNT_INVALID`.
- [x] Add `setIndexBuffer` and `drawIndexed` recording to the fake render encoder.
- [x] Normalize index bindings, validate `INDEX` usage, element alignment, positive aligned size, in-buffer range, runtime, and disposal.
- [x] Normalize static draw arguments as u32 values except signed-i32 `baseVertex`; preserve WebGPU zero-count no-op behavior.
- [x] Validate direct dispatch counts as u32 values not exceeding `runtime.deviceLimits.maxComputeWorkgroupsPerDimension`.
- [x] Run focused tests, existing draw/compute tests, and `npm run typecheck`; commit with `git commit -m "Add Scratch static indexed draws"`.

## Task 3: Native Indirect Lowering And Buffer Validation

**Files:**
- Modify: `tests/scratch-native-indirect-execution.test.js`
- Modify: `tests/scratch-test-utils.js`
- Modify: `packages/geoscratch/src/scratch/command.ts`

- [x] Write RED tests for `drawIndirect`, `drawIndexedIndirect`, and `dispatchWorkgroupsIndirect`, including exact encoder parameters and ordering after pipeline/bind/index setup.
- [x] Write RED diagnostics tests for non-buffer values, wrong runtime, disposed buffers, missing `INDIRECT` usage, offsets not divisible by four, and 16/20/12-byte range overflows.
- [x] Add native indirect call recording to fake render/compute encoders without interpreting argument bytes.
- [x] Normalize indirect counts once with operation-specific required byte length and lower directly to the native encoder method.
- [x] Ensure `assertUsable()` covers optional index and indirect buffers and disposal never mutates user resources.
- [x] Run focused tests and typecheck; commit with `git commit -m "Add Scratch native indirect execution"`.

## Task 4: Explicit Read Contract, Epoch Validation, And Ledger

**Files:**
- Modify: `tests/scratch-native-indirect-execution.test.js`
- Modify: `tests/scratch-submitted-work-epochs.test.js`
- Modify: `packages/geoscratch/src/scratch/command.ts`
- Modify: `packages/geoscratch/src/scratch/submission.ts`

- [x] Write RED constructor tests proving every vertex, index, and indirect buffer needs one matching `resources.read` descriptor and reports `SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE` with a machine-readable role.
- [x] Write RED submission tests for empty, future, stale, same-submission-produced, and already-ready indirect/index reads under throw/warn/off validation.
- [x] Validate explicit fixed-function reads after resource normalization; do not infer or capture a live epoch.
- [x] Reuse the existing readiness simulation and resource-access recording so indirect/index reads remain ordinary declared reads.
- [x] Prove those reads do not advance content epochs or create producer epochs, while earlier GPU writes remain producer facts.
- [x] Run focused ledger tests, draw/compute regressions, and typecheck; commit with `git commit -m "Validate Scratch indirect resource epochs"`.

## Task 5: Real GPU Indirect Execution Example

**Files:**
- Create: `examples/indirectExecution/index.html`
- Create: `examples/indirectExecution/main.js`
- Modify: `examples/index.html`
- Modify: `examples/vite.config.js`
- Modify: `tests/examples-structure.test.js`

- [ ] Write a failing structure test requiring a neutral `indirectExecution` entry and prohibiting readback/map APIs in its source.
- [ ] Build one compute pipeline that is launched through `dispatchWorkgroupsIndirect` and writes non-indexed plus indexed draw argument buffers as storage/indirect resources.
- [ ] Render both argument buffers in the same Scratch submission through `drawIndirect` and `drawIndexedIndirect`; include a real `INDEX` buffer for the indexed path.
- [ ] Expose the example in the browser with a neutral title and no `scratch` flag in its path or visible name.
- [ ] Run example structure tests and `npm run build`; commit with `git commit -m "Add native indirect execution example"`.

## Task 6: ADR, Bilingual Vision, And Native Parity Audit

**Files:**
- Create: `docs/decisions/ADR-027-scratch-native-indexed-indirect-execution.md`
- Create: `docs/review/scratch-native-command-parity-audit.md`
- Modify: `docs/vision/scratch-api/04-pipelines-commands/README.md`
- Modify: `docs/vision/scratch-api/04-pipelines-commands/README_zh.md`
- Modify: `docs/vision/scratch-api/05-passes-submissions-scheduler/README.md`
- Modify: `docs/vision/scratch-api/05-passes-submissions-scheduler/README_zh.md`
- Modify: `docs/vision/scratch-api/09-diagnostics-validation/README.md`
- Modify: `docs/vision/scratch-api/09-diagnostics-validation/README_zh.md`

- [ ] Record index/count pairing, exact native lowering, fixed-function read epochs, zero-count semantics, no-CPU rule, and dynamic-resolver deferral in ADR-027.
- [ ] Update both language versions with identical implementation-status facts and add `SCRATCH_COMMAND_INDEX_BUFFER_INVALID`.
- [ ] Persist a six-row parity matrix for `draw`, `drawIndexed`, `drawIndirect`, `drawIndexedIndirect`, `dispatchWorkgroups`, and `dispatchWorkgroupsIndirect`; every row must point to public type, source lowering, validation, ledger behavior, tests, and docs.
- [ ] Run bilingual diff review, `git diff --check`, focused tests, and typecheck; commit with `git commit -m "Document Scratch native indirect execution"`.

## Task 7: Browser Verification, Review, Completion Audit, And Integration

- [ ] Start the Vite dev server and open `indirectExecution` in a WebGPU-capable Chromium instance.
- [ ] Verify no console/page errors, a nonblank canvas by screenshot plus pixel inspection, and both indexed/non-indexed output regions visible.
- [ ] Run `npm run typecheck`, focused tests, `npm test`, `npm run build`, `git diff --check`, source-only scans, no-readback scan, and no-material scan.
- [ ] Review the entire branch against the pasted Goal requirement by requirement; fix findings, rerun affected checks, and re-review.
- [ ] Use `finishing-a-development-branch`, merge the verified branch into `dev-feature`, remove the worktree, delete the feature branch, and confirm only local `main` and `dev-feature` remain.
