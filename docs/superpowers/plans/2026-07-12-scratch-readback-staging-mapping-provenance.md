# Scratch Readback Staging And Mapping Provenance V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make direct and ordered buffer readback use acknowledged staging allocations, one explicit mapping transaction, bounded schema-v3 provenance, and deterministic lifecycle cleanup without changing synchronous submission.

**Architecture:** Direct readback allocates one ephemeral staging buffer through a scoped asynchronous transaction immediately before its copy. Ordered readback commands are Promise-created around one acknowledged reusable staging slot, so submission remains synchronous and never encodes an unacknowledged buffer. Runtime diagnostics gain explicit command/readback targets, current readback facts, bounded operation/incident evidence, and separate GPU-staging versus CPU-retention accounting.

**Tech Stack:** TypeScript ES modules, WebGPU, Mocha, Chai, controllable fake WebGPU, Vite, Playwright/Chrome verification.

---

## Invariants Applied To Every Task

- Preserve source range, captured allocation/content epoch, layout view, retention, producer epoch, and exact ordered submission position.
- Never await `SubmittedWork.done` before issuing a direct readback copy or before calling `mapAsync()` on an already-submitted staging buffer.
- Never encode an ordered staging buffer until its allocation validation/OOM scopes have settled successfully.
- Never expose internal `GPUBuffer`, mapped `ArrayBuffer`, command payload, mutable operation, or `SubmittedWork` through diagnostics evidence.
- Keep `SubmissionBuilder.submit()` synchronous and queue replay in the calling turn.
- Use structured diagnostic codes and discriminated JSON facts; do not parse native message prose.
- Every native issue boundary pushes all required scopes, issues each native call once, pops in reverse order before the first await, and joins outcomes independent of settlement order.
- Every reservation, lifecycle subscription, staging slot, mapped range, host-retained byte count, pending operation, and current fact has an explicit release owner.
- No compatibility overload, sync alias, pending wrapper, source JavaScript duplicate, or hand-written declaration file.

## File Responsibility Map

- `packages/geoscratch/src/scratch/readback.ts`: public readback operation contract and host-copy lifecycle only.
- `packages/geoscratch/src/scratch/readback-staging.ts`: staging reservation, acknowledged allocation, slot ownership, transfer, and release state.
- `packages/geoscratch/src/scratch/readback-mapping.ts`: map issue/scopes, mapped-range copy, cancellation observation, and cleanup outcomes.
- `packages/geoscratch/src/scratch/readback-ownership.ts`: runtime registries for private commands/operations and constructor tokens.
- `packages/geoscratch/src/scratch/command.ts`: descriptor validation and public `ReadbackCommand` behavior; no native staging allocation.
- `packages/geoscratch/src/scratch/submission.ts`: ordered slot preflight/claim, copy encoding, immutable readback links, structured queue completion.
- `packages/geoscratch/src/scratch/gpu-operation.ts`: schema-v3 target/record/incident discriminated unions and immutable factories.
- `packages/geoscratch/src/scratch/runtime-diagnostics.ts`: current fact graph, bounded history, readback budgets, aggregates, queries, and capture.
- `packages/geoscratch/src/scratch/runtime.ts`: Promise command factories, operation factories, readback policy initialization, and disposal ordering.
- `tests/scratch-readback-provenance-contract.test.js`: schema/public/state contract and source-boundary audit.
- `tests/scratch-readback-staging.test.js`: direct and ordered allocation transactions, budget, reuse, and cleanup.
- `tests/scratch-readback-mapping.test.js`: map outcome matrix, concurrency, retention, cancellation, and cleanup.
- `tests/scratch-test-utils.js`: independently controllable buffer allocation, map, mapped-range, unmap, destroy, queue completion, and scope settlements.

### Task 1: Record ADR-034 And Contract Tests

**Files:**
- Create: `docs/decisions/ADR-034-scratch-readback-staging-mapping-provenance.md`
- Create: `tests/scratch-readback-provenance-contract.test.js`
- Modify: `docs/decisions/ADR-026-scratch-readback-command-ordered-staging.md`
- Modify: `docs/review/scratch-api-intelligent-friendly-review.md`

- [ ] Write ADR-034 with Promise-only command factories, acknowledged reusable slot, synchronous submit, immutable readback links, map-specific barrier, schema v3, budget/accounting, lifecycle races, and explicit non-goals.
- [ ] Mark ADR-026 allocation timing and unrestricted cross-submission reuse as superseded while preserving its ordered-copy, epoch, ledger, and explicit-result decisions.
- [ ] Add contract tests asserting both runtime command factories return ordinary Promises, constructors reject external/subclass construction, `SubmittedWork.readbacks` is immutable, operation objects expose no `stagingBuffer`, and schema evidence reports version 3 with `command`/`readback` targets.
- [ ] Run `npm test -- --grep "scratch readback provenance contract"` and record the expected RED failures caused by the current sync factories, schema v2, missing links, and public staging handle.
- [ ] Do not commit while RED; proceed directly to Tasks 2-4, then commit the contract with its minimal GREEN implementation.

### Task 2: Extend The Fake GPU Before Production Transactions

**Files:**
- Modify: `tests/scratch-test-utils.js`
- Create: `tests/scratch-readback-native-fake.test.js`

- [ ] Add buffer IDs and call records for allocation, copy, submit, completion, map issue/settlement, mapped-range access, unmap, and destroy without changing existing default behavior.
- [ ] Add deferred controls for `createBuffer` native throw, each error-scope result/failure, `mapAsync` resolve/reject, `getMappedRange` throw, host-copy source detachment, unmap/destroy throw, queue completion rejection, and device loss.
- [ ] Prove scopes capture the innermost matching error and may settle in arbitrary order while native issue order stays fixed.
- [ ] Run `npm test -- --grep "fake WebGPU readback"`; first observe RED for missing controls, then GREEN after fake-only implementation.
- [ ] Commit as `Extend fake WebGPU readback outcomes` after the fake suite and existing fake scope/pipeline suites pass.

### Task 3: Migrate Provenance To Schema Version 3

**Files:**
- Modify: `packages/geoscratch/src/scratch/gpu-operation.ts`
- Modify: `packages/geoscratch/src/scratch/runtime-diagnostics.ts`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `packages/geoscratch/src/index.ts`
- Modify: `tests/scratch-async-pipeline-contract.test.js`
- Modify: `tests/scratch-gpu-operation-provenance.test.js`
- Modify: `tests/types/public-api.ts`

- [ ] Add `ScratchGpuCommandOperationTarget` with `kind: 'command'`, command ID, and command kind; add `ScratchGpuReadbackOperationTarget` with readback ID, path, source identity/version/epoch, byte length, and optional command/submission/step facts.
- [ ] Add operation kinds `readback-staging-allocation`, `readback-mapping`, and `readback-staging-release`; add incident kind `readback-failure` and fixed failure-stage union.
- [ ] Make operation/incident target-kind validators exhaustive and reject target/kind mismatches before controller mutation.
- [ ] Advance records, incidents, snapshot, capture, and exported evidence to version 3 in one clean cut; update public queries with `commandId` and `readbackId`.
- [ ] Keep resource pressure limited to persistent resource facts; add separate readback memory facts for staging and retained host bytes.
- [ ] Run schema-focused tests RED before implementation, then `npm test -- --grep "schema v3|GPU operation provenance|bounded GPU diagnostics"` GREEN.
- [ ] Commit as `Migrate GPU provenance to schema v3`.

### Task 4: Add Runtime Readback Policy And Ownership Facts

**Files:**
- Create: `packages/geoscratch/src/scratch/readback-ownership.ts`
- Modify: `packages/geoscratch/src/scratch/runtime-diagnostics.ts`
- Modify: `packages/geoscratch/src/scratch/runtime.ts`
- Create: `tests/scratch-readback-runtime-facts.test.js`

- [ ] Normalize finite positive `readback.maxPendingOperations` and `readback.maxStagingBytes` options with conservative defaults from the accepted ADR; reject invalid options before requesting a device.
- [ ] Register current command slots and active/retained operations by identity; remove terminal operations only after cleanup ownership has ended.
- [ ] Reserve pending-operation and staging-byte budget before native allocation; rollback once on every failure and release once on every terminal path.
- [ ] Publish current/peak staging bytes, current/peak retained host bytes, active mappings, active operations, and command-slot state without native handles.
- [ ] Add runtime/operation/command lifecycle subscriptions whose cardinality returns to zero after success, failure, cancellation, disposal, and runtime loss.
- [ ] Run `npm test -- --grep "readback runtime facts"` through RED/GREEN and include 256-cycle boundedness coverage.
- [ ] Commit as `Track bounded readback runtime facts`.

### Task 5: Implement Acknowledged Direct Staging

**Files:**
- Create: `packages/geoscratch/src/scratch/readback-staging.ts`
- Modify: `packages/geoscratch/src/scratch/readback.ts`
- Create: `tests/scratch-readback-staging.test.js`

- [ ] Extract a staging allocation transaction that reserves budget, starts one provenance operation, pushes OOM then validation scopes, creates one buffer, pops validation then OOM, and awaits all outcomes before returning a usable slot.
- [ ] Preserve synchronous native exceptions, scope settlement failures, validation, OOM, lifecycle cancellation, and device loss as structurally distinct outcomes with exact attribution only where scope ownership proves it.
- [ ] In direct materialization, recheck source epoch/allocation before allocation and after acknowledgement, then encode/submit one copy without waiting for `after.done`.
- [ ] On failure before copy, destroy the candidate and release reservation without encoder or queue calls; after copy issue, cleanup observes in-flight ownership rather than fabricating rollback.
- [ ] Remove the public `stagingBuffer` field and keep the slot in private ownership storage.
- [ ] Run direct allocation tests through RED/GREEN plus existing compute/readback/retention/epoch suites.
- [ ] Commit as `Acknowledge direct readback staging`.

### Task 6: Make Ordered Readback Commands Promise-Created

**Files:**
- Modify: `packages/geoscratch/src/scratch/command.ts`
- Modify: `packages/geoscratch/src/scratch/runtime.ts`
- Modify: `packages/geoscratch/src/scratch/submission.ts`
- Modify: `tests/scratch-readback-command.test.js`
- Modify: `tests/scratch-submission-queue-order.test.js`

- [ ] Close public and subclass construction with an internal token and immutable private state.
- [ ] Make both runtime factories return `Promise<ReadbackCommand>` and allocate one acknowledged slot before constructing/registering the command.
- [ ] Replace command `encode()` allocation with an internal claim that rejects busy/disposed/wrong-runtime state before encoder creation or queue effects.
- [ ] Preserve one-use-per-builder and allow cross-submission reuse only after prior operation cleanup returns the slot to idle.
- [ ] Defer command disposal of a busy slot until submitted work/map cleanup can safely release it; destroy idle slots immediately and exactly once.
- [ ] Migrate every ordinary test/example call to explicit `await`; leave legacy renderer calls unchanged.
- [ ] Run ordered readback and queue-order suites through RED/GREEN.
- [ ] Commit as `Acknowledge ordered readback staging`.

### Task 7: Add Immutable Submitted Readback Links

**Files:**
- Modify: `packages/geoscratch/src/scratch/submission.ts`
- Modify: `packages/geoscratch/src/scratch/command.ts`
- Modify: `tests/scratch-readback-command.test.js`
- Modify: `tests/scratch-submitted-work-epochs.test.js`

- [ ] Allocate each scheduled operation ID during submission preparation so the returned `SubmittedWork` can freeze links before exposure.
- [ ] Publish `SubmittedReadbackLink` with command/operation/step/source/version/epoch/allocation-operation facts only.
- [ ] Keep `result({ after })` idempotent for an exact command/work pair and reject unrelated work without an implicit latest lookup.
- [ ] Wrap queue completion rejection in one structured submission diagnostic related to all affected readback links; do not wait for mapping or mutate execution outcomes.
- [ ] Prove links remain unchanged after source writes, command reuse, operation mapping, cancellation, disposal, and runtime disposal.
- [ ] Commit as `Link ordered readbacks to submitted work` after focused and ledger suites pass.

### Task 8: Implement One Mapping Transaction And Materialization Owner

**Files:**
- Create: `packages/geoscratch/src/scratch/readback-mapping.ts`
- Modify: `packages/geoscratch/src/scratch/readback.ts`
- Create: `tests/scratch-readback-mapping.test.js`
- Modify: `tests/scratch-readback-retention.test.js`

- [ ] Issue `mapAsync(READ, 0, byteLength)` once under OOM/internal/validation scopes where supported; pop before awaiting and observe map/scope/device/lifecycle outcomes independently.
- [ ] Classify map Promise rejection without promoting `OperationError` to OOM absent a captured `GPUOutOfMemoryError`.
- [ ] Separate mapping, mapped-range, host-copy, and cleanup failure stages and stable diagnostic codes.
- [ ] For `until-dispose`, share one in-flight materialization and return a fresh clone to each concurrent reader; release GPU staging after the first host copy.
- [ ] For `consume-on-read`, select one materialization owner and reject competing calls deterministically without issuing another copy or map.
- [ ] Make cancel/dispose during pending map cancel native mapping, suppress only the expected cancellation rejection, preserve terminal state, release slot/reservations, and avoid unhandled Promise rejection.
- [ ] Treat unmap/destroy failure as cleanup evidence; never erase already-owned bytes or claim successful native cleanup.
- [ ] Run mapping/retention/readback-command suites through the complete RED/GREEN outcome matrix.
- [ ] Commit as `Record readback mapping provenance`.

### Task 9: Migrate Public Consumers And Documentation

**Files:**
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `packages/geoscratch/src/index.ts`
- Modify: `tests/types/public-api.ts`
- Modify: `examples/externalImageUpload/main.js`
- Modify: `examples/submissionOrder/main.js`
- Modify: `examples/textureResize/main.js`
- Modify: `README.md`
- Modify: `README_zh.md`
- Modify: `examples/README.md`
- Modify: bilingual vision modules `01`, `05`, `07`, and `09`

- [ ] Export schema-v3, readback policy/fact/link, operation, and incident types through both public entrypoints.
- [ ] Prove both command factories are Promise-only and no constructor/static/sync bypass typechecks.
- [ ] Update examples with explicit awaited command creation while preserving stable names and machine-readable completion output.
- [ ] Update bilingual docs together, including buffer-specific map timing, submission boundary, budget semantics, evidence limits, and non-goals.
- [ ] Keep DEM/Flow/Hello GAW legacy labels and separate DEM/Flow implementations unchanged.
- [ ] Run `npm run typecheck`, example structure tests, and `npm run build`.
- [ ] Commit as `Publish acknowledged readback contracts`.

### Task 10: Stress, Benchmark, Browser, And Audit

**Files:**
- Create: `tests/benchmarks/scratch-readback-staging-mapping.mjs`
- Create: `tests/browser/scratch-readback-staging-mapping.mjs`
- Create: `docs/review/scratch-readback-staging-mapping-audit.md`
- Create: `docs/review/scratch-readback-staging-mapping-performance.md`
- Modify: `docs/review/scratch-gpu-operation-provenance-audit.md`
- Create: `tests/scratch-readback-staging-mapping-docs.test.js`

- [ ] Add 20,000 direct-operation churn, 5,000 ordered reuse, recorder overflow, capture, history-disabled, and no-readback submission baseline profiles with structural self-checks.
- [ ] Assert zero pending operations, mappings, lifecycle subscribers, reservations, and ephemeral staging at each terminal benchmark boundary.
- [ ] Inventory every Scratch `createBuffer`, `mapAsync`, `getMappedRange`, `unmap`, and staging destroy call; classify exact, family, temporal, unknown, deferred, and raw boundaries honestly.
- [ ] Run headed Chrome against `scratch_computeReadback`, `externalImageUpload`, `submissionOrder`, `textureResize`, and the prior 11-page matrix; assert exact bytes, nonblank canvases, and zero unexpected errors/incidents.
- [ ] Record environment and evidence without claiming real OOM, physical residency, or broad encoder/queue attribution.
- [ ] Commit benchmark/browser/audit evidence as separate verified commits.

### Task 11: Final Source-Parity And Completion Audit

**Files:**
- Modify only files required by review findings.

- [ ] Compare pre-goal `f3e7306` implementations of `readback.ts`, `command.ts`, and `submission.ts` behavior-by-behavior against the final TypeScript path.
- [ ] Produce a matrix for range validation, epoch/allocation capture, layout view, retention, ordered copy position, producer provenance, result identity, cancellation, disposal, failed submission cleanup, and queue segmentation.
- [ ] Run strict correctness/architecture/performance review; fix every required finding and re-review.
- [ ] Run fresh `npm test`, `npm run typecheck`, `npm run build`, benchmark, headed-browser verifier, native inventory, diff review, and secret scan.
- [ ] Confirm branch/worktree are clean and all required commits exist; do not merge, push, delete the branch, or remove the worktree.
- [ ] Report exact evidence, remaining native boundaries, and any documented vision difference. Mark the Goal complete only after every objective row has direct evidence.
