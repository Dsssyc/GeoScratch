# Scratch Async Pipeline Creation And Compilation Provenance Plan

> **Execution rule:** use strict RED/GREEN/refactor evidence, commit each verified phase, and leave the final branch unmerged for explicit approval.

**Goal:** Convert Scratch render and compute pipeline creation to native async
transactions and extend bounded GPU provenance with source-free compilation
evidence and pipeline-discriminated facts.

**Architecture:** Validate and snapshot locally, open three supporting-object
error scopes, issue one shader module, one pipeline layout, compilation info,
and one matching async pipeline call in a single uninterrupted turn, pop every
scope before awaiting, then join all outcomes and recheck lifecycle before
installing a pipeline. Schema-v2 evidence uses resource/pipeline target unions;
current facts remain separate from bounded history.

**Technology:** TypeScript ES modules, WebGPU, Mocha/Chai, Vite, Playwright.

## Phase 1: Integrate The Provenance Foundation

1. Fast-forward `dev-feature` to the approved provenance branch.
2. Run `npm test`, `npm run typecheck`, and `npm run build`.
3. Remove the integrated worktree and branch only after all gates pass.
4. Create `socu/scratch-async-pipeline-provenance` from integrated
   `dev-feature` in an isolated worktree.

## Phase 2: Freeze The Async Contract

**Files:**

- Add `docs/decisions/ADR-033-scratch-async-pipeline-creation.md`.
- Add this plan.
- Update pipeline, Program, runtime, diagnostics, and overview vision modules in
  English and Chinese.
- Add focused documentation and public-type tests.

1. Lock Promise-only render and compute factories and closed constructors.
2. Lock schema-v2 target unions and pipeline/current facts.
3. Lock compilation mapping, source exclusion, evidence bounds, and stable
   failure categories.
4. Lock the uninterrupted scope/native issue turn and promise-order agnosticism.
5. Lock submission hot-path exclusion and legacy classification.
6. Run the new tests against the old implementation and retain expected RED
   evidence before production edits.

## Phase 3: Build The Fake Native State Machine

**Files:**

- Expand `tests/scratch-test-utils.js`.
- Add `tests/scratch-async-pipeline-creation.test.js`.

1. Add controllable shader compilation information.
2. Add controllable render/compute async pipeline resolve/reject behavior and a
   structural `GPUPipelineError` test value.
3. Add supporting-object validation/internal/OOM failures and synchronous
   throws.
4. Allow compilation, pipeline, scope, and device-loss settlement in arbitrary
   order.
5. Assert exact issue/pop ordering and zero native effects after local failure.

## Phase 4: Migrate Provenance To Schema V2

**Files:**

- Modify `gpu-operation.ts`, `runtime-diagnostics.ts`, public exports, and type
  fixtures.
- Expand provenance regression tests.

1. Introduce resource/pipeline operation target unions.
2. Migrate operations, incidents, pending facts, snapshots, captures, queries,
   and exported evidence to version 2.
3. Preserve resource allocation, replacement, disposal, pressure, aggregate,
   query, and deep-capture semantics one-to-one.
4. Add pipeline operation and incident variants without optional-field guessing.
5. Run the complete existing provenance suite and JSON/immutability tests.

## Phase 5: Build Compilation Evidence

**Files:**

- Add an internal pipeline-compilation module.
- Modify Program/pipeline internals only where immutable snapshot facts are
  required.
- Expand async pipeline tests and public types.

1. Combine Program modules with one explicit separator contract.
2. Compute combined/per-module hashes and UTF-16 offset/line spans.
3. Join modules with exactly one U+000A separator and map zero-based half-open
   UTF-16 spans across LF, CRLF, empty modules, separators, and
   non-ASCII source without inventing unknown locations.
4. Normalize module facts and native messages in order under 256-module,
   64-message, 4096-code-unit, and shared 64-KiB limits, with explicit omission
   counts and no valid-Program rejection caused only by evidence truncation.
5. Prove full WGSL and excerpts never enter default, incident, capture, or
   exported evidence.

## Phase 6: Build The Render Transaction

**Files:**

- Refactor `pipeline.ts` and `runtime.ts`.
- Migrate render pipeline tests, type fixtures, Scratch examples, and README
  snippets.

1. Move render normalization/validation before native work.
2. Close direct/subclass construction with an internal token.
3. Begin one pending pipeline operation and issue one fully balanced native
   transaction.
4. Classify compilation, pipeline, support-object, synchronous, structural, and
   lifecycle failures into one incident and `ScratchDiagnosticError`.
5. Install one wrapper/current fact only after acknowledged success.
6. Verify every render descriptor field and DrawCommand behavior against the
   old lowering.

## Phase 7: Build The Compute Transaction

**Files:**

- Extend `pipeline.ts`, `runtime.ts`, tests, examples, and README snippets.

1. Reuse the same transaction state machine without hiding render/compute
   descriptor differences.
2. Preserve compute entry points, constants, bind layouts, Program requirements,
   and DispatchCommand behavior one-to-one.
3. Migrate every Scratch compute consumer to await the ordinary Promise.
4. Verify no immediate native pipeline call remains in Scratch.

## Phase 8: Bound Current And Historical Pipeline Facts

**Files:**

- Extend runtime diagnostics and pipeline lifecycle integration.
- Expand stress, capture, lifecycle, and schema tests.

1. Add pending/live pipeline facts whose size follows pending/live pipelines.
2. Remove current facts on disposal without native-destroy claims.
3. Add operation/incident capacity-zero, default, overwrite, and deep-capture
   stress coverage.
4. Prove lifecycle subscriptions and pending details are released on every
   settlement path.
5. Prove allocation incidents remain factually unchanged after schema migration.

## Phase 9: Evidence, Audit, And Final Review

**Files:**

- Add async pipeline audit, performance report, benchmark, and browser verifier.
- Update both READMEs, package READMEs, active intelligent-friendly review,
  graphics-kernel vision, and `AGENTS.md`.

1. Inventory every shader-module, pipeline-layout, immediate/async pipeline,
   constructor/factory, test/example, and similarly named legacy call site.
2. Benchmark render/compute issue and settlement separately, empty/populated
   reports, recorder profiles, cache-labeled cold/warm samples, retained
   evidence, and lifecycle subscribers. Publish no universal percentage.
3. Use headed WebGPU Chrome for valid render/compute, invalid WGSL, invalid
   descriptor, console/uncaptured-error gates, and existing example pixel gates.
4. Compare old/new render and compute lowering one-to-one.
5. Compare behavior to current GPUWeb specifications and emitted declarations.
6. Run fresh-context adversarial review, fix every confirmed finding, and repeat
   all gates.
7. Run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`,
   browser tests, benchmarks, and final source inventories.
8. Confirm a clean worktree and wait for explicit merge approval.
