# Scratch ReadbackCommand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first-class buffer-only `ReadbackCommand` ordered-staging path without changing the existing lazy `runtime.readback(...)` contract.

**Architecture:** `ReadbackCommand` declares an explicit buffer source epoch and is validated as a read-only submission step. Submission encoding allocates and fills a runtime-owned `MAP_READ | COPY_DST` staging buffer at the command's exact step, then creates one scheduled `ReadbackOperation` tied to the returned `SubmittedWork`; scheduled materialization waits and maps that existing buffer without submitting another copy. The normal `ReadbackOperation` constructor retains its lazy staging behavior.

**Tech Stack:** TypeScript ES modules, WebGPU command encoders, Mocha/Chai, npm workspaces, TypeScript declaration tests.

---

## Baseline

- Base commit: `6c7ecfa`, containing all four WebGPU-native `CopyCommand` directions.
- Working branch: `socu/scratch-readback-command`.
- Fresh baseline: `npm test` reports `293 passing`.
- Source constraints: Scratch core stays TypeScript-only; new public failures use `ScratchDiagnostic`; the source is buffer-only and requires `GPUBufferUsage.COPY_SRC`.

## Phase 1: Public Contract And Core Ordered Staging

**Files:**
- Create: `tests/scratch-readback-command.test.js`
- Modify: `tests/public-entry.test.js`
- Modify: `packages/geoscratch/src/scratch/command.ts`
- Modify: `packages/geoscratch/src/scratch/runtime.ts`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `packages/geoscratch/src/scratch/submission.ts`
- Modify: `packages/geoscratch/src/scratch/readback.ts`

- [ ] Write RED tests proving `ReadbackCommand` is public, both runtime factories return it, `.readback(command)` records the step, `result({ after })` returns staged bytes, repeated result lookup is referentially stable, and materialization does not increase the fake encoder copy count.

- [ ] Run `npm test -- --grep "ReadbackCommand"` and confirm failure is caused by the missing export/factories.

- [ ] Add this public contract in `command.ts`:

```ts
export type ReadbackCommandDescriptor = {
    label?: string
    source: BufferCopyCommandSourceDescriptor
    sourceOffset?: number
    byteLength?: number
    range?: ReadbackRange
    retain?: ReadbackRetentionPolicy
    whenMissing: 'throw'
}

export type ReadbackCommandResultOptions = {
    after: SubmittedWork
}
```

- [ ] Implement `ReadbackCommand` with `commandKind: 'readback'`, normalized `{ resource, contentEpoch }`, one normalized range, `assertRuntime`, `assertUsable`, `dispose`, internal submitted-result registration, and structured diagnostics for invalid descriptors or missing submitted results.

- [ ] Add `ScratchRuntime.createReadbackCommand(...)`, `ScratchRuntime.readbackCommand(...)`, Scratch entrypoint exports, `SubmissionBuilder.readback(...)`, and `'readback'` in `SubmissionStepKind`.

- [ ] During submission encoding, create one `MAP_READ | COPY_DST` staging buffer, encode one `copyBufferToBuffer`, record a source read access, and defer command-to-operation registration until `SubmittedWork` exists.

- [ ] Add an internal scheduled `ReadbackOperation` construction path. It must begin with the submitted staging buffer, skip source epoch/allocation revalidation after staging has occurred, wait for `after.done`, map/copy bytes, and preserve existing consume/retain/cancel/dispose behavior.

- [ ] Run `npm test -- --grep "ReadbackCommand|ReadbackOperation"` and confirm the core behavior is GREEN.

- [ ] Run `npm run typecheck` and commit the verified phase with `git commit -m "Add Scratch ordered readback command"`.

## Phase 2: Submission Validation And Ledger Facts

**Files:**
- Modify: `tests/scratch-readback-command.test.js`
- Modify: `tests/scratch-submitted-work-epochs.test.js`
- Modify: `packages/geoscratch/src/scratch/submission.ts`

- [ ] Add RED tests for incompatible step values, wrong runtime, disposed commands, missing `COPY_SRC`, invalid ranges, empty sources, future/stale epochs, `warn` report behavior, `off` behavior, and same-submission producer epochs.

- [ ] Run the focused tests and confirm each new validation group fails for the intended missing behavior.

- [ ] Validate `ReadbackCommand` ownership/usability as a hard structural check, then pass `[command.source]` through the existing readiness simulation. Do not mark its source ready because the step is read-only.

- [ ] Record exactly one `read` access whose origin has `stepKind: 'readback'`, `commandKind: 'readback'`, and the command id. Confirm readback alone creates no producer epoch; when an earlier same-submission write produces the source, preserve that producer epoch on the scheduled operation.

- [ ] Run `npm test -- --grep "ReadbackCommand|SubmittedWork resource epoch ledger"` and `npm run typecheck`; commit with `git commit -m "Validate Scratch ordered readback submissions"`.

## Phase 3: Lifecycle, Types, And Regression Coverage

**Files:**
- Modify: `tests/scratch-readback-command.test.js`
- Modify: `tests/scratch-readback-retention.test.js` only if shared lifecycle coverage requires it
- Modify: `tests/types/public-api.ts`
- Modify: `packages/geoscratch/src/scratch/readback.ts`

- [ ] Add RED tests proving scheduled `consume-on-read`, scheduled `until-dispose`, cancellation/disposal, map failure, result lookup against unrelated work, and readability after the source advances after staging.

- [ ] Add type-contract uses for `ReadbackCommandDescriptor`, `ReadbackCommandResultOptions`, both factories, builder `.readback(...)`, `result({ after })`, and both package entrypoints.

- [ ] Run `npm test -- --grep "ReadbackCommand|ReadbackOperation retention"` and `npm run typecheck`; make only lifecycle/type changes required to turn the group GREEN.

- [ ] Commit with `git commit -m "Cover Scratch ordered readback lifecycle"`.

## Phase 4: Decision Record And Vision Status

**Files:**
- Create: `docs/decisions/ADR-026-scratch-readback-command-ordered-staging.md`
- Modify: `docs/vision/scratch-api/04-pipelines-commands/README.md`
- Modify: `docs/vision/scratch-api/04-pipelines-commands/README_zh.md`
- Modify: `docs/vision/scratch-api/07-transfers-epochs/README.md`
- Modify: `docs/vision/scratch-api/07-transfers-epochs/README_zh.md`

- [ ] Record that `ReadbackCommand` is only the exact-order staging escape hatch, normal `ReadbackOperation` remains default, scheduled materialization performs no second copy, reads use explicit epoch validation, readback writes no user epoch, and texture readback/budgets/leases remain future work.

- [ ] Update only implementation-status wording in both English/Chinese vision pairs and align examples with the actual public runtime factory shape.

- [ ] Run `git diff --check`, inspect the bilingual diff for factual parity, and commit with `git commit -m "Document Scratch ordered readback staging"`.

## Phase 5: Completion Audit And Integration

- [ ] Run `npm run typecheck`.
- [ ] Run `npm test -- --grep "ReadbackCommand|ReadbackOperation|SubmittedWork resource epoch ledger"`.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Run `find packages/geoscratch/src/scratch \\( -name '*.js' -o -name '*.d.ts' \\) -print` and require empty output.
- [ ] Run `rg -n "\\b[Mm]aterial\\b|material-like" packages/geoscratch/src/scratch` and require empty output.
- [ ] Re-read the source Goal and map every acceptance item to current source, focused tests, typecheck/build output, static gates, and documentation evidence.
- [ ] Use `finishing-a-development-branch` before integrating the verified branch into `dev-feature`.
