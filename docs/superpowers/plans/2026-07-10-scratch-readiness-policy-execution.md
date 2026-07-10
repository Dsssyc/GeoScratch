# Scratch Readiness Policy Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every readiness policy currently exposed by `DrawCommand` and `DispatchCommand` control actual submission execution, with immutable outcomes that agree with the resource and producer ledgers.

**Architecture:** Replace the current validation-only readiness walk with one pre-encoder resolution pass that returns a validation report, resolved render/compute command lists, simulated resource/query state, and execution outcomes. Render and compute passes resolve against cloned simulation state so `skip-pass` is transactional; fallback resolution follows same-kind immutable command references and validates only the final command that can execute. Encoding consumes the resolved plan exactly once.

**Tech Stack:** TypeScript ES modules, WebGPU, Mocha/Chai, TypeScript declaration tests, Vite examples, Playwright browser verification.

---

## Baseline And Invariants

- Base commit: `564a481` on `dev-feature`.
- Feature branch: `socu/scratch-readiness-policy-execution`.
- Clean baseline: `npm test` reports `327 passing`; `npm run typecheck` passes.
- Scratch remains TypeScript source-first; no same-source `.js` or handwritten `.d.ts` files.
- `CopyCommand`, `ReadbackCommand`, and `ResolveQuerySetCommand` remain compile-time `whenMissing: 'throw'` only.
- Readiness policy resolves missing content only; runtime ownership, disposal, pass incompatibility, invalid buffers/ranges, and device loss remain hard failures.
- Normal skip/fallback control flow is recorded in execution outcomes, not emitted as warning/error diagnostics.
- Encoding must consume one resolved plan; it must not independently re-resolve the original steps.
- CPU dynamic resolvers, additional resource states, automatic sorting, readback expansion, multi-draw, and render bundles remain out of scope.

## Requirement-To-Evidence Map

| Requirement | Authoritative evidence |
| --- | --- |
| Readiness descriptor union | `@ts-expect-error` checks in `tests/types/public-api.ts` and `npm run typecheck` |
| Runtime fallback boundary validation | `SCRATCH_COMMAND_FALLBACK_INVALID` assertions in `tests/scratch-readiness-policy-execution.test.js` |
| `throw` remains hard in every validation mode | pre-encoder tests with fake encoder creation counts |
| `skip-command` removes actual reads/writes | fake encoder actions, resource epochs, `resourceAccesses`, and `producerEpochs` |
| `skip-pass` is transactional | earlier-write rollback plus attachment/timestamp/occlusion epoch tests |
| fallback chain selects one actual command | exact requested/attempted/executed ids and native encoder action tests |
| downstream readiness uses actual outputs | same-submission producer/consumer tests after skip and fallback |
| immutable execution ledger | mutation tests over outcomes, attempts, missing facts, and arrays |
| Browser behavior | `examples/readinessPolicies`, Playwright screenshot, pixels, console, and `data-status` |
| Design truth | ADR-028, paired vision updates, intelligent-friendly review, and eight-row audit |

## Task 1: Public Readiness Contract And RED Type Tests

**Files:**
- Create: `tests/scratch-readiness-policy-execution.test.js`
- Modify: `tests/types/public-api.ts`
- Modify: `packages/geoscratch/src/scratch/command.ts`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `packages/geoscratch/src/index.ts`

- [x] Add `@ts-expect-error` cases for bare `use-fallback`, fallback supplied with `throw`/`skip-command`/`skip-pass`, Draw fallback to Dispatch, and Dispatch fallback to Draw. Run `npm run typecheck`; confirm RED because current descriptors have no typed fallback pairing.
- [x] Define and export the exact discriminated contract:

```ts
export type CommandReadinessDescriptor<FallbackCommand> =
    | { whenMissing: 'throw' | 'skip-command' | 'skip-pass', fallback?: never }
    | { whenMissing: 'use-fallback', fallback: FallbackCommand }
```

- [x] Remove `whenMissing` from shared Draw/Dispatch descriptor bases and intersect each legal execution descriptor with `CommandReadinessDescriptor<DrawCommand>` or `CommandReadinessDescriptor<DispatchCommand>`.
- [x] Expose immutable normalized `fallback?: DrawCommand` / `fallback?: DispatchCommand` fields on commands without adding a legacy descriptor or alias.
- [x] Add positive public type cases for all four policies and both command kinds; export the generic descriptor from `geoscratch` and `geoscratch/scratch`.
- [x] Run `npm run typecheck` and focused constructor tests; commit with `git commit -m "Add Scratch readiness policy contracts"`.

## Task 2: Runtime Fallback Contract Validation

**Files:**
- Modify: `tests/scratch-readiness-policy-execution.test.js`
- Modify: `packages/geoscratch/src/scratch/command.ts`

- [x] Write RED runtime tests for missing fallback, forbidden fallback on non-fallback policies, wrong command kind, wrong runtime, disposed fallback, declared-write identity mismatch, repeated/self reference, and a forged cycle. Assert `SCRATCH_COMMAND_READINESS_POLICY_MISSING` or `SCRATCH_COMMAND_FALLBACK_INVALID` with structured `expected`, `actual`, `subject`, and `related` facts.
- [x] Normalize readiness policy and fallback once during command construction. Validate fallback kind/runtime/lifecycle and compare declared write resources as identity sets, not mutable array order.
- [x] Walk the immutable fallback chain with a visited-command set; reject any repeated id before submission resolution.
- [x] Lock the fallback property with the rest of the command contract and add post-construction mutation tests.
- [x] Verify existing static/indexed/indirect Draw/Dispatch tests remain green; commit with `git commit -m "Validate Scratch fallback command contracts"`.

## Task 3: Resolved Submission Plan And `skip-command`

**Files:**
- Modify: `tests/scratch-readiness-policy-execution.test.js`
- Modify: `tests/scratch-submitted-work-epochs.test.js`
- Modify: `packages/geoscratch/src/scratch/submission.ts`

- [ ] Write RED tests proving an empty read under `skip-command` emits no native command, read access, write access, content epoch, producer epoch, or simulated-ready fact in `off`, `warn`, and `throw` validation modes.
- [ ] Add a RED downstream test where a command skipped as a producer leaves its output empty and causes the next command's own policy to resolve from that real state.
- [ ] Replace `validateSubmissionBeforeEncoding()` with a preflight result containing `report`, resolved steps, simulated states, and mutable outcome drafts. The resolved command list must be the only list used by encoding.
- [ ] Resolve each Draw/Dispatch against all missing read requirements at its exact submission position. Keep `throw` as a hard pre-encoder diagnostic; for `skip-command`, omit the command and do not mark writes.
- [ ] Apply optional stale/future epoch validation only to commands selected for execution.
- [ ] Run focused readiness and epoch tests plus `npm run typecheck`; commit with `git commit -m "Resolve Scratch skip-command execution"`.

## Task 4: Transactional `skip-pass`

**Files:**
- Modify: `tests/scratch-readiness-policy-execution.test.js`
- Modify: `tests/scratch-pass-submission.test.js`
- Modify: `tests/scratch-depth-stencil-attachments.test.js`
- Modify: `tests/scratch-query-set.test.js`
- Modify: `packages/geoscratch/src/scratch/submission.ts`

- [ ] Write RED compute tests where an earlier dispatch appears to write and a later dispatch selects `skip-pass`; prove the earlier simulated write is rolled back and no compute pass begins.
- [ ] Write RED render tests proving a skipped pass does not clear/store color/depth attachments, advance attachment epochs, emit timestamp writes, or advance occlusion query slots.
- [ ] Clone readiness and query-slot simulation at each render/compute pass boundary. Resolve the complete pass against the clones and commit them only when the pass executes.
- [ ] If any command resolves `skip-pass`, discard every resolved command and every cloned side effect for the pass.
- [ ] Preserve pass-side effects when individual commands use `skip-command`; record a compute pass with no commands and no pass side effects as `skipped-empty`.
- [ ] Run focused pass/query/epoch tests and typecheck; commit with `git commit -m "Make Scratch skip-pass transactional"`.

## Task 5: Fallback Resolution And Execution Outcome Ledger

**Files:**
- Modify: `tests/scratch-readiness-policy-execution.test.js`
- Modify: `tests/scratch-native-indirect-execution.test.js`
- Modify: `tests/scratch-submitted-work-epochs.test.js`
- Modify: `tests/types/public-api.ts`
- Modify: `packages/geoscratch/src/scratch/submission.ts`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `packages/geoscratch/src/index.ts`

- [ ] Write RED tests for primary-to-fallback execution, multi-level fallback, fallback-to-skip-command, fallback-to-skip-pass, fallback-to-throw, and fallback dependency diagnostics. Assert that only the final selected command reaches the fake encoder.
- [ ] Add RED coverage for a native indirect fallback to prove fallback selection never inspects GPU argument bytes and preserves the existing WebGPU lowering.
- [ ] Define and export `SubmissionMissingResource`, `SubmissionCommandReadinessAttempt`, `SubmissionCommandExecutionOutcome`, `SubmissionPassExecutionOutcome`, and `SubmissionExecutionOutcome` exactly as required by the Goal.
- [ ] Add `readonly executionOutcomes` to `SubmittedWork`. Record one pass outcome per render/compute step and one command outcome per requested Draw/Dispatch, including stable attempted and executed command ids.
- [ ] Freeze every outcome, attempt, missing-resource fact, nested id array, and the top-level array.
- [ ] Ensure resource accesses and producer epochs are captured only from resolved commands; add cross-ledger tests that reject skipped-write and primary-write ghosts.
- [ ] Run focused outcome/native/epoch tests, `npm run typecheck`, and existing submission regressions; commit with `git commit -m "Record Scratch readiness execution outcomes"`.

## Task 6: Real Browser Readiness Policy Example

**Files:**
- Create: `examples/readinessPolicies/index.html`
- Create: `examples/readinessPolicies/main.js`
- Modify: `examples/index.html`
- Modify: `examples/vite.config.js`
- Modify: `tests/examples-structure.test.js`

- [ ] Write a failing structure test requiring the neutral `readinessPolicies` example, public `geoscratch` imports, all three non-throw policy strings, `executionOutcomes` inspection, and no mapping/readback APIs.
- [ ] Build a ready fallback DrawCommand and an empty primary DrawCommand so `use-fallback` renders a visible region and the outcome identifies both requested and executed ids.
- [ ] Add an optional DrawCommand using `skip-command`; prove its requested id is absent from encoded ids and its visual region is absent.
- [ ] Render known content into an offscreen target, then submit a second pass with `skip-pass` that would otherwise clear/replace it; composite the preserved target to the surface.
- [ ] Set `canvas.dataset.status = 'ready'` only after checking the expected pass/command outcomes. Do not map or read GPU data.
- [ ] Run structure tests and `npm run build`; commit with `git commit -m "Add readiness policy execution example"`.

## Task 7: ADR, Bilingual Vision, And Eight-Row Audit

**Files:**
- Create: `docs/decisions/ADR-028-scratch-readiness-policy-execution.md`
- Create: `docs/review/scratch-readiness-policy-execution-audit.md`
- Modify: `docs/vision/scratch-api/02-resources/README.md`
- Modify: `docs/vision/scratch-api/02-resources/README_zh.md`
- Modify: `docs/vision/scratch-api/04-pipelines-commands/README.md`
- Modify: `docs/vision/scratch-api/04-pipelines-commands/README_zh.md`
- Modify: `docs/vision/scratch-api/05-passes-submissions-scheduler/README.md`
- Modify: `docs/vision/scratch-api/05-passes-submissions-scheduler/README_zh.md`
- Modify: `docs/vision/scratch-api/09-diagnostics-validation/README.md`
- Modify: `docs/vision/scratch-api/09-diagnostics-validation/README_zh.md`
- Modify: `docs/review/scratch-api-intelligent-friendly-review.md`

- [ ] Record the descriptor union, same-kind fallback, write-set equivalence, resolved-plan boundary, transactional pass semantics, outcome ledger, validation-mode separation, and deferred command families in ADR-028.
- [ ] Update paired vision files with identical implementation-status facts and add `SCRATCH_COMMAND_FALLBACK_INVALID` to the diagnostic model.
- [ ] Persist an eight-row Draw/Dispatch x policy audit; every row must point to public types, resolution source, native encoding, readiness/epoch behavior, outcomes, diagnostics, tests, and docs.
- [ ] Update the intelligent-friendly review to record that expected streaming absence is observable control flow rather than a warning/error.
- [ ] Run bilingual diff review, `git diff --check`, focused tests, and typecheck; commit with `git commit -m "Document Scratch readiness policy execution"`.

## Task 8: Browser Verification, Strict Review, Completion Audit, And Integration

- [ ] Start the Vite dev server and load `readinessPolicies` in WebGPU-capable Chromium.
- [ ] Verify `data-status=ready`, no console/page errors, a nonblank screenshot, expected fallback pixels, absent skipped-command region, and preserved skip-pass content.
- [ ] Run `npm run typecheck`, focused policy tests, `npm test`, `npm run build`, `git diff --check`, source-only scans, no-readback scan, and no-material scan.
- [ ] Review the complete branch against every Goal requirement. Perform fresh-context adversarial review, fix all valid findings, rerun affected checks, and re-review before claiming completion.
- [ ] Confirm the eight-row audit, public exports, documentation status, execution/resource/producer ledger consistency, and exact branch history.
- [ ] Use `finishing-a-development-branch`, fast-forward merge into `dev-feature`, rerun tests on the merged result, remove the worktree, delete the feature branch, and confirm only local `main` and `dev-feature` remain.
