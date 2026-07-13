# Scratch Submission Native Outcome And Provenance V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Scratch-owned submission and direct-readback issue path bounded native error observation, immutable machine-readable outcomes, and conservative content-indeterminacy semantics without making submission asynchronous or changing queue order.

**Architecture:** Effectful submission attempts reserve one bounded native-observation owner before native work. The default summary mode wraps the entire synchronous encoding/replay transaction in one constant-size validation/internal/OOM scope bundle, while finite deep capture may snapshot a per-stage detailed plan. `SubmittedWork` exposes a resolving immutable `nativeOutcome` Promise and a rejecting `done` Promise that joins native observation with queue completion; delayed failure marks only still-current potential writes indeterminate without rewriting epochs or historical ledgers.

**Tech Stack:** TypeScript ES modules, WebGPU, Mocha, Chai, controllable fake WebGPU, Vite, Playwright/Chrome verification.

---

## Fixed Baseline

- Goal-start commit: `a69c79a2f6789330f108aff5031a6d5e11fd59c4`.
- Branch: `socu/scratch-submission-native-provenance`.
- Baseline verification: 642 tests passing, public/WebGPU typechecks passing, package/examples build passing, readback fixed-baseline audit passing.
- Previous readback feature branch was fast-forwarded into `dev-feature`, verified, and removed before this worktree was created.

## Invariants Applied To Every Task

- `SubmissionBuilder.submit()` remains synchronous, non-thenable, and physically replays queue actions in declared order in the calling turn.
- Preflight finishes before the first native side effect; observation never substitutes for Scratch validation.
- Every pushed scope is popped in reverse order before submit returns or throws, and every resulting Promise is internally observed.
- Summary mode uses one constant-size scope bundle per effectful attempt; detailed scopes exist only for a capture plan snapshotted at attempt start.
- Native outcome selection follows fixed issue/stage order, never Promise settlement order or native message parsing.
- Queue completion, native scopes, synchronous exceptions, device loss, lifecycle changes, readback mapping, and host copy remain independent outcomes.
- Delayed failure never rolls back `contentEpoch`, mutates historical `SubmittedWork`, or poisons a later confirmed epoch.
- Default evidence never retains WGSL, upload bytes, mapped bytes, command payloads, native handles, mutable builders, or unbounded location lists.
- Raw `runtime.device` and `runtime.queue` calls remain outside Scratch attribution.
- No compatibility schema, constructor bypass, permanent detailed mode, hidden replay, or automatic recovery.

## File Responsibility Map

- `packages/geoscratch/src/scratch/submission-native-observation.ts`: scope policy, reservation, synchronous issue plans, settlement joining, immutable native outcomes, and internal ownership.
- `packages/geoscratch/src/scratch/submission.ts`: preflight, physical timeline replay, submitted facts, `SubmittedWork`, and integration with native observation.
- `packages/geoscratch/src/scratch/resource.ts`: current resource readiness including indeterminate content and guarded recovery.
- `packages/geoscratch/src/scratch/query-set.ts`: query-slot indeterminacy and guarded recovery.
- `packages/geoscratch/src/scratch/readback.ts`: direct copy issue observation and ordered-result native-outcome gate; mapping remains delegated.
- `packages/geoscratch/src/scratch/gpu-operation.ts`: schema-v4 submission target, operation/incident/location facts, and immutable factories.
- `packages/geoscratch/src/scratch/runtime-diagnostics.ts`: observation policy/budget, current facts, bounded history, capture detail snapshot, queries, and export.
- `packages/geoscratch/src/scratch/runtime.ts`: diagnostics policy initialization and runtime lifecycle cancellation.
- `tests/scratch-test-utils.js`: independently controlled native issue errors, scope settlements, queue completion, and call inventory.
- `tests/scratch-submission-native-contract.test.js`: public/schema/policy/immutability contract.
- `tests/scratch-submission-native-observation.test.js`: summary/off/detailed scope and settlement behavior.
- `tests/scratch-submission-content-indeterminacy.test.js`: delayed failure, epoch guard, read hard failure, and recovery.
- `tests/scratch-submission-native-source-audit.test.js`: exact Scratch-owned native call inventory and ownership boundary.

### Task 1: Record ADR-035 And RED Public Contracts

**Files:**
- Create: `docs/decisions/ADR-035-scratch-submission-native-outcome-provenance.md`
- Create: `tests/scratch-submission-native-contract.test.js`
- Modify: `docs/review/scratch-api-intelligent-friendly-review.md`
- Modify: `docs/vision/scratch-api/05-passes-submissions-scheduler/README.md`
- Modify: `docs/vision/scratch-api/05-passes-submissions-scheduler/README_zh.md`

- [ ] Write ADR-035 with synchronous submit, summary/off policy, finite detailed capture, fixed native stages/locations, immutable `nativeOutcome`, strengthened `done`, schema v4, indeterminate content, and explicit non-goals.
- [ ] Add RED tests for default `submissionScopes: 'summary'`, explicit off, finite positive `maxPendingNativeObservations`, closed `SubmittedWork` construction, immutable properties, resolving `nativeOutcome`, and schema version 4 with submission targets.
- [ ] Add RED tests proving effect-free submission has `no-native-work`, remains non-thenable, and opens no scopes.
- [ ] Run `npm test -- --grep "scratch submission native contract"`; record failures as missing API/schema rather than weakening assertions.
- [ ] Commit ADR, plan, and RED tests as `Record submission native provenance contract`; RED failures are intentional and listed in the commit body or progress notes.

### Task 2: Extend Fake WebGPU Native Issue Controls

**Files:**
- Modify: `tests/scratch-test-utils.js`
- Create: `tests/scratch-submission-native-fake.test.js`

- [ ] Add ordered call facts for encoder creation, pass begin/end, command calls, finish, buffer/texture/external queue actions, submit, completion, push/pop scopes, and scope settlement.
- [ ] Add independent synchronous throw and asynchronous validation/internal/OOM controls for each native issue family without changing default fake behavior.
- [ ] Add deferred scope-pop resolution/rejection and arbitrary settlement order, preserving native issue order.
- [ ] Model one captured error per filter/scope, contagious invalid encoder/command-buffer behavior, and application-owned outer scopes.
- [ ] Prove fake calls can settle reverse-order and simultaneously without leaking unhandled rejections.
- [ ] Run `npm test -- --grep "fake WebGPU submission native"` RED/GREEN and existing fake allocation/pipeline/readback suites.
- [ ] Commit as `Extend fake WebGPU submission outcomes`.

### Task 3: Clean-Cut Provenance Schema Version 4

**Files:**
- Modify: `packages/geoscratch/src/scratch/gpu-operation.ts`
- Modify: `packages/geoscratch/src/scratch/runtime-diagnostics.ts`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `packages/geoscratch/src/index.ts`
- Modify: schema-version tests under `tests/`
- Modify: `tests/types/public-api.ts`

- [ ] Add `ScratchGpuSubmissionOperationTarget` with only submission identity and a separate discriminated `ScratchSubmissionNativeLocation` union.
- [ ] Add `submission-native-observation` operation, `submission-failure` incident, fixed native stage/action/category/status unions, and bounded immutable `ScratchSubmissionNativeOutcome` facts.
- [ ] Add exhaustive target/location/stage validation before diagnostics-controller mutation.
- [ ] Advance records, incidents, snapshots, captures, evidence, and query results to version 4 in one cut; remove every version-3 assertion without adding conversion or dual output.
- [ ] Add `submissionId`, location kind, native stage, and outcome status query filters while preserving resource/pipeline/command/readback queries.
- [ ] Keep pressure and readback memory semantics unchanged; submission observation receives a separate aggregate/current-fact family.
- [ ] Run schema tests RED/GREEN plus all provenance, pipeline, allocation, and readback diagnostics suites.
- [ ] Commit as `Migrate GPU provenance to schema v4`.

### Task 4: Add Native Observation Policy And Ownership

**Files:**
- Create: `packages/geoscratch/src/scratch/submission-native-observation.ts`
- Modify: `packages/geoscratch/src/scratch/runtime-diagnostics.ts`
- Modify: `packages/geoscratch/src/scratch/runtime.ts`
- Create: `tests/scratch-submission-native-observation.test.js`

- [ ] Normalize `submissionScopes: 'summary' | 'off'` with summary default and finite positive `maxPendingNativeObservations`; reject invalid policy before requesting a device.
- [ ] Reserve one observation owner before native work and fail budget exhaustion with a structured diagnostic before encoder/queue effects.
- [ ] Implement summary, off, no-native-work, and finite detailed plan snapshots without importing submission implementation into diagnostics.
- [ ] In summary mode push OOM, internal, then validation once, issue the whole transaction synchronously, pop validation/internal/OOM in `finally`, and retain every pop Promise immediately.
- [ ] In detailed mode scope every declared location exactly once while keeping the location plan fixed for the attempt; deduplicate instrumentation when multiple captures request detail.
- [ ] Publish current/peak pending observations and policy/budget facts; release each owner exactly once after success, failure, scope failure, runtime disposal, or device loss.
- [ ] Ensure `operationCapacity: 0` disables successful history only, not current facts, scopes, failures, or cleanup.
- [ ] Run observation tests through summary/off/detailed/budget/lifecycle/reverse-settlement RED/GREEN.
- [ ] Commit as `Add bounded submission native observation`.

### Task 5: Integrate The Full Submission Native Boundary

**Files:**
- Modify: `packages/geoscratch/src/scratch/submission.ts`
- Modify: `packages/geoscratch/src/scratch/command.ts`
- Modify: `packages/geoscratch/src/scratch/pass.ts`
- Modify: `tests/scratch-submission-native-observation.test.js`
- Modify: queue-order/readiness/submitted-work tests

- [ ] Build the detailed location plan from the already-resolved immutable submission plan before native work.
- [ ] Wrap encoder creation, pass begin/end, standalone/pass command encoding, encoder finish, queue writes, external-image upload, and command-buffer submit without moving the native calls out of the synchronous submit stack.
- [ ] Preserve command-buffer segmentation, upload boundaries, readback claims, partial replay, and exactly-once logical effect application.
- [ ] Retain synchronous native exceptions as independent outcomes and propagate the existing structured throw after every scope is popped/observed.
- [ ] Add bounded native debug labels always and per-command debug groups only in finite detailed mode; balance groups through exceptions.
- [ ] Prove summary scope count is constant for one versus many commands/actions and off/effect-free count is zero.
- [ ] Run native-observation, queue-order, readiness, epoch-ledger, external-upload, copy, query, render, and compute suites.
- [ ] Commit as `Observe submission native boundaries`.

### Task 6: Close SubmittedWork And Publish Native Outcome

**Files:**
- Modify: `packages/geoscratch/src/scratch/submission.ts`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `packages/geoscratch/src/index.ts`
- Modify: `tests/scratch-submission-native-contract.test.js`
- Modify: `tests/types/public-api.ts`

- [ ] Move every `SubmittedWork` fact into ECMAScript-private state with read-only getters; freeze arrays/reports/outcomes at construction.
- [ ] Close external and subclass construction with an internal constructor token while retaining public `instanceof` and type identity.
- [ ] Add always-resolving `nativeOutcome` and internally observed rejecting `done`; preserve no-native-work and explicit-unobserved statuses.
- [ ] Join native scope settlement and queue completion independently, retain simultaneous outcomes, and choose the thrown diagnostic by fixed stage/issue order.
- [ ] Keep `report` preflight-only and immutable; do not append asynchronous diagnostics after exposure.
- [ ] Preserve ordered readback links and mapping independence; queue completion remains enclosing-family evidence.
- [ ] Run public contract, type, submitted-work, queue completion, readback command, and ignored-Promise tests.
- [ ] Commit as `Publish immutable submission native outcomes`.

### Task 7: Implement Content Indeterminacy

**Files:**
- Modify: `packages/geoscratch/src/scratch/resource.ts`
- Modify: `packages/geoscratch/src/scratch/buffer.ts`
- Modify: `packages/geoscratch/src/scratch/texture.ts`
- Modify: `packages/geoscratch/src/scratch/query-set.ts`
- Modify: `packages/geoscratch/src/scratch/submission.ts`
- Create: `tests/scratch-submission-content-indeterminacy.test.js`

- [ ] Add `indeterminate` to current resource and query-slot readiness state without mixing it with disposal/allocation identity.
- [ ] Snapshot every persistent potential write and produced epoch in `SubmittedWork` before asynchronous settlement.
- [ ] On observed native failure, observation failure, or queue completion rejection, mark all still-current potential writes indeterminate without decrementing epochs or changing historical facts.
- [ ] Ignore a delayed failure when the current target epoch has advanced beyond the failed submission; retain the historical native failure on the submitted work.
- [ ] Reject every indeterminate resource/query read before native effects in every validation/readiness mode with stable structured diagnostics.
- [ ] Let a later explicit known producer advance a new epoch and restore ready state according to the existing whole-resource/whole-slot granularity.
- [ ] Keep surface-current ephemeral output out of persistent indeterminacy facts.
- [ ] Run indeterminacy tests plus all resource, readiness, query, copy, render, compute, resize, and epoch suites.
- [ ] Commit as `Track indeterminate submission content`.

### Task 8: Observe Direct And Ordered Readback Issue Outcomes

**Files:**
- Modify: `packages/geoscratch/src/scratch/readback.ts`
- Modify: `packages/geoscratch/src/scratch/readback-ownership.ts`
- Modify: `packages/geoscratch/src/scratch/submission.ts`
- Modify: readback staging/mapping/command tests

- [ ] Wrap direct readback encoder creation, copy encoding, finish, and submit in the shared observation policy with a readback target.
- [ ] Await direct copy observation and mapping outcomes independently before returning bytes; preserve every simultaneous failure stage.
- [ ] Make ordered materialization observe the associated submission native outcome before exposing bytes without awaiting broad queue completion.
- [ ] Reject ordered bytes on an observed staging-copy family failure; retain explicit `unobserved` provenance when policy is off.
- [ ] Preserve the existing rule that queue-completion rejection alone does not rewrite a separately successful mapping outcome.
- [ ] Prove direct/ordered cancellation, disposal, retention, command reuse, and cleanup ownership return to terminal zero.
- [ ] Run every readback suite and fixed readback parity audit.
- [ ] Commit as `Observe readback copy issue outcomes`.

### Task 9: Publish Bilingual Contracts And Consumer Migration

**Files:**
- Modify: `README.md`, `README_zh.md`
- Modify: `packages/geoscratch/README.md`, `packages/geoscratch/README_zh.md`
- Modify: bilingual vision modules `01`, `02`, `04`, `05`, `07`, and `09`
- Modify: `docs/review/scratch-api-intelligent-friendly-review.md`
- Modify: `examples/scratch_helloTriangle/main.js`
- Modify: `examples/scratch_helloVertexBuffer/main.js`
- Modify: `examples/scratch_uniformTriangle/main.js`
- Modify: `examples/scratch_computeReadback/main.js`
- Modify: `examples/scratch_textureSampling/main.js`
- Modify: `examples/scratch_renderToTexture/main.js`
- Modify: `examples/indirectExecution/main.js`
- Modify: `examples/readinessPolicies/main.js`
- Modify: `examples/submissionOrder/main.js`
- Modify: `examples/externalImageUpload/main.js`
- Modify: `examples/textureResize/main.js`
- Create: `tests/scratch-submission-native-docs.test.js`

- [ ] Publish summary/off policy, budget, `nativeOutcome`, strengthened `done`, indeterminate content, attribution limits, and finite detailed capture consistently in both languages.
- [ ] Update public examples to observe `done`/`nativeOutcome` where they advertise completion, without adding visible instructional UI or changing stable example names.
- [ ] Preserve all three legacy labels and leave DEM/Flow/Hello GAW implementations unchanged.
- [ ] Document that lazy bind-group creation may be enclosed by command observation but is not independently acknowledged.
- [ ] Keep mapped leases, texture readback, persistent supporting-object acknowledgement, tracked dynamic values, render graph, and raw-device tracking explicit non-goals.
- [ ] Run docs tests, `npm run typecheck`, and `npm run build`.
- [ ] Commit as `Document submission native outcomes`.

### Task 10: Source Audit, Stress, Benchmark, And Browser Proof

**Files:**
- Create: `tests/scratch-submission-native-source-audit.test.js`
- Create: `tests/stress/scratch-submission-native-provenance.mjs`
- Create: `tests/benchmarks/scratch-submission-native-provenance.mjs`
- Create: `tests/browser/scratch-submission-native-provenance.mjs`
- Create: `docs/review/scratch-submission-native-provenance-audit.md`
- Create: `docs/review/scratch-submission-native-provenance-performance.md`

- [ ] Inventory every Scratch-owned encoder/pass/finish/queue native call and prove it is inside the declared owner or explicitly deferred.
- [ ] Add 20,000 summary and 20,000 off submissions, recorder overflow, delayed settlement, budget exhaustion, ignored promises, finite detailed capture, and terminal-zero structural gates.
- [ ] Benchmark effect-free, off, summary, finite detailed, one/many commands, one/many queue actions, immediate/deferred settlement, issue, observation, and done boundaries without machine-specific pass thresholds.
- [ ] Run headed Chrome valid probes for synchronous submit, observed success, queue order, direct/ordered readback bytes, and all 11 existing pages.
- [ ] Add a real delayed native validation probe using a valid Scratch path whose shader binding minimum size is checked at draw/dispatch time; require captured structured failure and zero uncaptured console errors.
- [ ] Record adapter/browser/environment, scope counts, evidence sizes, terminal facts, and attribution limits without claiming physical residency or unique command causality from summary scopes.
- [ ] Commit source/stress tooling, benchmark evidence, and browser/audit evidence as separate verified checkpoints.

### Task 11: Fixed-Baseline Parity And Strict Completion Review

**Files:**
- Create: `tests/audits/scratch-submission-native-final-parity.mjs`
- Create: `docs/review/scratch-submission-native-final-parity-audit.md`
- Modify only files required by review findings.

- [ ] Compare Goal-start `a69c79a` behavior in `submission.ts`, `command.ts`, `binding.ts`, `readback.ts`, runtime diagnostics, resource/query state, and fake GPU against the final implementation.
- [ ] Produce explicit preserved/superseded matrices for queue order, segmentation, partial replay, synchronous exceptions, readiness, epochs, queries, readback, pipeline, external upload, and queue completion.
- [ ] Run a five-axis correctness/readability/architecture/security/performance review; fix every required finding and re-run the review.
- [ ] Re-run fresh `npm test`, `npm run typecheck`, `npm run build`, source audit, stress, benchmark, headed Chrome, readback parity, submission parity, diff check, and secret scan.
- [ ] Confirm no pending observation, scope owner, lifecycle subscriber, unhandled rejection, unexpected listener, generated tracked artifact, or uncommitted change remains.
- [ ] Do not merge, push, delete the feature branch, or remove the worktree.
- [ ] Mark the Goal complete only when every objective and verification row has direct current-state evidence.
