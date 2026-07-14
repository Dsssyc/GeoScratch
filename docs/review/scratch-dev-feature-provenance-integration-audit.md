# Dev-Feature Provenance Integration Audit / dev-feature Provenance 集成审计

Date: 2026-07-13
Status: Complete

## Scope / 范围

This audit records how the completed Scratch submission native provenance work
was integrated without losing either the implemented Goal or the replacement
repository guidance supplied for `dev-feature`.

本审计记录 Scratch submission native provenance Goal 如何并入
`dev-feature`，同时保留用户明确替换的仓库指导，并拒绝会倒退已接受 ADR 的
未提交 vision 修改。

## Fixed Inputs / 固定输入

- Goal-start implementation baseline: `a69c79a2f6789330f108aff5031a6d5e11fd59c4`
- High-level contributor-guidance checkpoint: `71717c4`
- Verified feature head: `b9cd70d98a95724cf56aee736c55daabbc77a78e`
- Local merge commit: `0057b88c0facca5b1afa27e83a847f84b541bf74`
- Accepted submission implementation contract: ADR-035
- Current fixed-baseline evidence: `scratch-persistent-binding-views-final-audit.md`

The former standalone submission final-parity check is superseded as an active
audit. Its historical evidence remains available in Git history and is consumed
through the current clean-cut audit instead of teaching the removed binding model.

The feature branch was a linear 15-commit descendant of `a69c79a`. The local
merge used the normal `ort` strategy and produced no textual conflict.

## Tree Equality / Tree 一致性

Immediately after the merge, this comparison:

```sh
git diff --name-status b9cd70d..dev-feature
```

reported only:

```text
M AGENTS.md
M tests/scratch-external-image-upload-docs.test.js
M tests/scratch-texture-resize-docs.test.js
```

All Scratch TypeScript implementation, public exports, ordinary examples,
ADR-035 documentation, fake WebGPU behavior, stress/benchmark/browser tools,
and Goal-specific tests were byte-for-byte identical to the verified feature
head. The three intended differences move implementation detail out of
`AGENTS.md` while retaining ADR/vision routing and the corresponding test gates.

## Pre-Merge Working-Tree Adjudication / 合并前工作树裁决

The original `dev-feature` worktree contained one accepted guidance change and
nine coupled vision edits. They were separated before merge rather than being
silently combined.

| Files | Decision | Evidence |
| --- | --- | --- |
| `AGENTS.md` | Preserved as the user-supplied replacement guidance. | It keeps the high-level Scratch target, ADR/vision/review routing, TypeScript source boundary, diagnostics rule, and `0.x.x` clean-cut policy without duplicating accepted ADR internals. |
| `00-overview` English/Chinese | Rejected as a stale rollback. | It removed acknowledged allocation, async pipeline, compilation, and bounded diagnostic facts already accepted by ADR-032/033 and implemented before this Goal. |
| `02-resources` English/Chinese | Rejected as a stale rollback. | It changed Promise-returning buffer/texture examples back to synchronous calls, reintroduced `derived(() => surface.size)` and `invalidateSize()`, and removed the sole explicit `TextureResource.resize()` transition from ADR-031/032. |
| `03-bindings` English/Chinese | Rejected as a stale rollback. | It removed current-allocation view validation, compatibility-mode dimension checks, and allocation-version bind-group invalidation proven by ADR-031 tests and browser evidence. |
| `04-pipelines-commands` English/Chinese | Rejected as a stale rollback. | It removed accepted ExternalImageUpload, texture replacement, async pipeline, readiness fallback, and readback contracts from ADR-028/030/031/033/034 and moved the document date backwards. |
| `scratch-graphics-kernel.md` | Rejected as a stale rollback. | It restored implicit size-provider direction and deleted the bounded native-operation evidence model that motivated ADR-032 through ADR-035. |

The English/Chinese edits were treated as one contract in every row. No
one-language fragment was retained independently.

## Divergent Remote Reference Adjudication / 分叉远端引用裁决

After local branch cleanup, every remaining local and remote-tracking reference
was compared with `dev-feature`. `main`, `origin/main`, `origin/dev-feature`, and
`unaLoo/main` contain no commit that is absent from `dev-feature`. The sole
divergent reference is `unaLoo/dev` at
`e4133c4f5ce952244601937a2a28e0ba4d861466`. Compared with the audited
`dev-feature` checkpoint `a6422d5fb51babff0b62ee62971ad53cdce686c1`, it has
17 commits from February-March 2025 that are absent from `dev-feature`, while
that checkpoint has 200 commits absent from the old branch.

Those 17 commits are not a second valid implementation line:

- the final old tree mixes TypeScript, JavaScript, and hand-written declaration
  files under the obsolete root `src/` layout, moves the prior implementation to
  `old_js_src/`, and still points package metadata at missing `src/scratch.js`
  and `src/scratch.d.ts` entrypoints;
- `npm test` exits with `No test files found`; its `.ts` files under `test/` are
  log-driven browser probes rather than Mocha assertions;
- a strict no-emit TypeScript check fails at `vec3i.ts` because the literal
  `vec3ii` is outside its declared `NumericType` union;
- `npm run build` fails before module transformation because `index.html`
  retains unresolved Git conflict markers;
- an AST comparison of the final public `src/scratch.ts` against the current
  package entrypoint finds 84 of 86 old public names retained. The only absent
  names are `MapRef` and `mRef`;
- `MapRef` is coupled to legacy `StorageBuffer.registerMapRange()`, misspells
  `length` as `lenght`, reports invalid ranges through `console.error` without
  halting, and hides queue write plus staging-map read operations behind
  callbacks. That contract conflicts with the accepted explicit transfer,
  readback lifecycle, resource ownership, and structured-diagnostic model;
- the two terrain commits are debugging experiments: they disable Flow inside
  the combined DEM page, change terrain constants and output appearance, add a
  global key listener, and flatten line elevation. They do not preserve the
  accepted separate DEM Layer and Flow Layer examples and have no executable
  regression evidence.

Therefore no commit or file from `unaLoo/dev` was merged. Its already-retained
public capabilities remain on the current package paths, while its two unique
public names and terrain experiments were explicitly rejected as unvalidated,
architecturally superseded work. The remote-tracking reference was inspected but
not deleted or pushed; remote mutation is outside this local consolidation.

## Executable Evidence / 可执行证据

- Verified feature head: `724 passing`.
- Original dirty `dev-feature`: `635 passing / 7 failing`.
- The seven failures directly identified removed async-pipeline,
  ExternalImageUpload, texture-resize, binding-invalidation, and contributor
  routing contracts.
- Guidance-only checkpoint after isolating the stale vision edits: `642 passing`.
- Merged `dev-feature`: `724 passing`.
- `npm run typecheck`: package, public API, and canonical WebGPU declaration
  consumers passed.
- `npm run build`: package and all standalone examples passed.
- Submission fixed-baseline parity: 5/5 unchanged sources, 17/17 preserved
  behaviors, and 14/14 intentional ADR-035 replacements.
- Readback fixed-baseline parity: 12/12 original JavaScript behaviors, 16/16
  prior TypeScript behaviors, and 10/10 intentional ADR-034 replacements.
- Goal-start diagnostics: 83 with zero missing.
- Goal-start public exports: 284 package names and 188 scratch names with zero
  missing.
- Submission stress rerun: 20,000 summary plus 20,000 off submissions passed;
  pending observations, effectful work, lifecycle subscribers, native scope
  depth, and unhandled rejections all ended at zero.
- Benchmark rerun: 11 profiles and 55 rounds passed structural gates without a
  machine-specific timing threshold.
- Headed Chrome 150.0.7871.115 on Apple Metal 3 passed the 11-page nonblank
  matrix, exact direct/ordered `[2, 4, 6, 8]` readback, synchronous valid submit,
  and real delayed validation at encoder finalization/queue submission with zero
  unexpected console, page, request, or uncaptured failures.

The isolated nine-file patch also failed `git apply --check` against the merged
`02-resources` and `04-pipelines-commands` modules because ADR-035 had advanced
the same contracts. It was not a second valid implementation line.

## Goal Contract Review / Goal 契约复核

The merged tree retained every locked result at the provenance-consolidation
checkpoint. This list is historical evidence, not the current Scratch target contract:

- synchronous, non-thenable `SubmissionBuilder.submit()` and unchanged physical
  queue order;
- constant-size summary observation, explicit off mode, and finite detailed
  capture;
- immutable resolving `SubmittedWork.nativeOutcome` and joined `done`;
- resource/query `indeterminate` content with epoch guards and later confirmed
  writer recovery;
- direct and ordered readback native-outcome boundaries;
- unchanged legacy DEM Layer, Flow Layer, and Hello GAW implementations.

Current replacement: schema v5 and acknowledged explicit BindSet preparation.
The persistent-binding clean cut supersedes the checkpoint's schema-v4 target shapes
and deferred/lazy supporting-object language. `SamplerResource`, `QuerySetResource`,
`BindLayout`, and initial `BindSet` creation are Promise-only acknowledged factories;
an existing stale `BindSet` is repaired only through explicit allocation-bound
`BindSet.prepare()`, never through submission-time lazy native creation.

## Verdict / 结论

`dev-feature` contains the complete verified feature tree plus the explicitly
approved high-level repository guidance. No competing local implementation or
accepted vision delta remains. The nine-file vision patch was a stale rollback,
not mergeable work, and was discarded only after its contents, failures, and
contract conflicts were classified here. The only divergent remote-tracking
reference was also classified and contains no accepted implementation that must
be recovered into `dev-feature`.
