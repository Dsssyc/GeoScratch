# Scratch GPU Operation Provenance Implementation Plan

> **Execution rule:** implement this plan in order with red-green-refactor evidence and a verified commit after every phase. Do not merge this branch automatically.

**Goal:** Add a bounded runtime-owned GPU operation provenance system and make public persistent buffer allocation, texture allocation, and texture replacement truthfully asynchronous.

**Architecture:** Keep current runtime facts separate from bounded historical evidence. A runtime-private operation engine owns stable IDs, pending facts, exact error-scope issue boundaries, fixed-capacity operation and incident rings, and temporary deep captures. Public resources are committed only after the matching validation and out-of-memory scope promises settle successfully. The diagnostics facade exports frozen JSON facts only and never exposes resource or GPU handles.

**Technology:** TypeScript ES modules, WebGPU, Mocha/Chai, Vite, Playwright.

## Phase 1: Freeze The Contract

**Files:**
- Create: `docs/decisions/ADR-032-scratch-gpu-operation-provenance.md`
- Create: `docs/superpowers/plans/2026-07-11-scratch-gpu-operation-provenance.md`
- Modify: `docs/vision/scratch-api/00-overview/README.md`
- Modify: `docs/vision/scratch-api/00-overview/README_zh.md`
- Modify: `docs/vision/scratch-api/01-runtime-surface/README.md`
- Modify: `docs/vision/scratch-api/01-runtime-surface/README_zh.md`
- Modify: `docs/vision/scratch-api/02-resources/README.md`
- Modify: `docs/vision/scratch-api/02-resources/README_zh.md`
- Modify: `docs/vision/scratch-api/09-diagnostics-validation/README.md`
- Modify: `docs/vision/scratch-api/09-diagnostics-validation/README_zh.md`

1. Record Promise-returning public factories and resize, with no synchronous compatibility path.
2. Record the four separate retention models: current fact graph, bounded recorder, immutable incident, bounded deep capture.
3. Record exact attribution limits, OOM pressure caveats, native label policy, and deferred native operation families.
4. Verify documentation links and terminology with focused `rg` checks and `git diff --check`.
5. Commit as `Record GPU operation provenance contract`.

## Phase 2: Test And Build The Operation/Incident Data Model

**Files:**
- Create: `tests/scratch-gpu-operation-provenance.test.js`
- Modify: `tests/scratch-test-utils.js`
- Create: `packages/geoscratch/src/scratch/gpu-operation.ts`
- Modify: `packages/geoscratch/src/scratch/diagnostics.ts`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `tests/types/public-api.ts`

1. Add failing tests for stable operation/incident IDs, immutable JSON output, attribution subjects, native error serialization, and absence of GPU handles.
2. Extend the fake GPU with a real nested error-scope stack, filter matching, controllable asynchronous pop settlement, uncaptured errors, and controllable device loss.
3. Implement public readonly operation, incident, pressure, and diagnostic subject types plus internal frozen serialization helpers.
4. Run the focused test and type contract until green.
5. Commit as `Add GPU operation and incident facts`.

## Phase 3: Test And Build Bounded Diagnostics Retention

**Files:**
- Create: `packages/geoscratch/src/scratch/runtime-diagnostics.ts`
- Modify: `packages/geoscratch/src/scratch/runtime.ts`
- Expand: `tests/scratch-gpu-operation-provenance.test.js`
- Modify: `tests/scratch-runtime.test.js`
- Modify: `tests/runtime-performance-contracts.test.js`

1. Add failing tests for an always-current live fact snapshot, fixed operation/incident capacities, serialized-evidence budget accounting, monotonic sequences, overwrite counters, query filters, default stack omission, and readonly facade ownership.
2. Add failing tests for capture operation/duration/evidence limits, automatic stop, explicit stop, stack inclusion only during capture, non-thenability, and no queue wait.
3. Implement structural rings, fixed counters, current resource/pending-operation facts, pressure aggregates, and bounded capture sessions.
4. Add uncaptured-error and device-loss incident listeners with honest confidence, application-listener coexistence, and disposal cleanup.
5. Run focused tests and the stress case at one and two multiples beyond capacity.
6. Commit as `Add bounded runtime diagnostics recorder`.

## Phase 4: Test And Build Async Initial Allocation

**Files:**
- Create: `packages/geoscratch/src/scratch/native-allocation.ts`
- Modify: `packages/geoscratch/src/scratch/resource.ts`
- Modify: `packages/geoscratch/src/scratch/buffer.ts`
- Modify: `packages/geoscratch/src/scratch/texture.ts`
- Modify: `packages/geoscratch/src/scratch/runtime.ts`
- Expand: `tests/scratch-gpu-operation-provenance.test.js`
- Modify: `tests/scratch-resource.test.js`
- Modify: `tests/scratch-runtime.test.js`
- Modify: `tests/scratch-texture-sampler.test.js`
- Modify: `tests/types/public-api.ts`

1. Add failing tests for exact push order, exactly one native allocation call, both pops before first await, out-of-order pop settlement, synchronous throws, scope-pop failures, concurrent operations, and application-owned outer scopes.
2. Add failing tests that failed candidates never enter live facts, successful candidates begin at allocation version 1/content epoch 0/empty, native candidates are cleaned up, and diagnostic errors reference immutable incidents.
3. Implement one shared scoped native allocation helper. Push OOM then validation, issue one native call, pop validation then OOM synchronously, and await only after both pop promises exist.
4. Make runtime `createBuffer`/`buffer` and `createTexture`/`texture` return Promises through one canonical path. Make static factories async or remove them. Prevent direct public construction from bypassing the path.
5. Attach bounded logical-footprint and stable label facts without presenting them as physical VRAM.
6. Run focused tests, typecheck, and a source scan proving no public sync path remains.
7. Commit as `Make buffer and texture allocation fallible`.

## Phase 5: Test And Build Async Texture Replacement

**Files:**
- Modify: `packages/geoscratch/src/scratch/texture.ts`
- Modify: `packages/geoscratch/src/scratch/runtime-diagnostics.ts`
- Expand: `tests/scratch-gpu-operation-provenance.test.js`
- Modify: `tests/scratch-texture-resize.test.js`

1. Add failing tests for pending replacement facts, old-allocation usability, concurrent resize rejection, same-size resolved no-op without scopes, candidate cleanup, resource/runtime disposal races, and device loss.
2. Add failing tests for transactional success and rollback facts: exact allocation version, preserved content epoch, empty state on commit, unchanged views/state/version/epoch on failure, and old texture destruction only after success.
3. Implement one pending replacement per texture. Keep candidate private; commit atomically after scope success; restore no facts because old facts never changed before commit.
4. Run focused tests and existing resize/readiness/submission tests.
5. Commit as `Make texture replacement transactional`.

## Phase 6: Clean-Cut Consumer Migration

**Files:**
- Modify: affected `tests/*.test.js`
- Modify: affected `tests/types/*.ts`
- Modify: affected `examples/*/main.js`
- Modify: `README.md`
- Modify: `README_zh.md`
- Modify: package README files if they contain allocation examples
- Modify: `examples/README.md`
- Modify: affected ADR/review examples

1. Use `rg` to inventory every Scratch buffer/texture factory and every texture resize call site.
2. Change every affected caller to explicitly await the canonical Promise API.
3. Remove tests and docs that imply synchronous creation; do not add aliases, flags, overloads, duplicate demos, handwritten declarations, or source JavaScript twins.
4. Preserve `.js` suffixes in TypeScript ESM imports.
5. Run all focused tests, `npm test`, `npm run typecheck`, and `npm run build`.
6. Commit as `Migrate consumers to async GPU allocation`.

## Phase 7: Browser And Performance Evidence

**Files:**
- Modify: `examples/textureResize/main.js`
- Create: `docs/review/scratch-gpu-operation-provenance-performance.md`
- Add browser evidence assets only when they prove observable behavior
- Add a deterministic benchmark script or test fixture under `tests/` if required

1. Measure recorder-off, default-recorder, and deep-capture allocation issue/settlement separately; measure overwrite steady state, stack capture, temporary promises/records, retained evidence, and browser scope settlement.
2. Report environment and distinguish CPU issue time, device-process acknowledgement, retained evidence, and queue completion. Make no universal percentage claim.
3. Start `npm run dev` and use a WebGPU-capable browser to verify `textureResize`, `submissionOrder`, `externalImageUpload`, `readinessPolicies`, `indirectExecution`, `scratch_textureSampling`, and `scratch_renderToTexture`.
4. Capture page errors, console errors, request failures, dataset facts, native validation leakage, and desktop/mobile layout where affected. Never trigger real OOM.
5. Commit as `Record GPU allocation diagnostic evidence`.

## Phase 8: Complete The Audit And Adversarial Review

**Files:**
- Create: `docs/review/scratch-gpu-operation-provenance-audit.md`
- Modify: `docs/review/scratch-api-intelligent-friendly-review.md`
- Modify: `docs/vision/scratch-graphics-kernel.md`
- Modify: `docs/vision/scratch-api/05-passes-submissions-scheduler/README.md`
- Modify: `docs/vision/scratch-api/05-passes-submissions-scheduler/README_zh.md`
- Modify: `docs/vision/scratch-api/07-transfers-epochs/README.md`
- Modify: `docs/vision/scratch-api/07-transfers-epochs/README_zh.md`
- Modify: `AGENTS.md`

1. Inventory every native `createBuffer` and `createTexture` call site as covered, deterministically prevented, internal deferred, raw escape hatch, or unresolved defect.
2. Add one audit row per required contract with implementation, automated test, browser, documentation, and status evidence. No documentation-only completion claims.
3. Run a fresh-context adversarial review of the full branch diff against `dev-feature`, WebGPU scope semantics, emitted declarations, entrypoint parity, boundedness, and causality claims.
4. Fix every confirmed finding and repeat the review.
5. Run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, browser verification, and final source inventories.
6. Commit as `Complete GPU provenance audit` and leave the branch unmerged for explicit approval.
