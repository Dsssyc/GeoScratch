# Scratch Submission Native Final Parity Audit / Scratch Submission Native 最终事实核对

Date: 2026-07-13
Status: Complete on the feature branch
Decision: ADR-035

## Fixed Baseline / 固定基线

- Goal-start TypeScript baseline / Goal 起点 TypeScript 基线:
  `a69c79a2f6789330f108aff5031a6d5e11fd59c4`
- Strict-review implementation checkpoint / 严格复审实现检查点:
  `d200e26cd5907d58fc13e7da9f57709d681b1eb9`
- Audit target / 审计目标:
  `socu/scratch-submission-native-provenance`

The baseline is authoritative for queue order, segmentation, partial replay,
readiness, epochs, queries, readback, pipeline/binding, native copy, external
upload, and queue-completion behavior present at Goal start. It is not a
compatibility constraint where ADR-035 deliberately replaces schema version 3,
mutable `SubmittedWork`, queue-only `done`, unobserved native issue boundaries,
or ready-only content state.

该基线负责证明 Goal 起点已有的 queue order、segmentation、partial replay、
readiness、epoch、query、readback、pipeline/binding、native copy、external
upload 与 queue completion 行为没有静默丢失。ADR-035 明确 clean-cut 替代的
schema v3、mutable `SubmittedWork`、queue-only `done`、未观察 native issue
boundary 与 ready-only content state 不伪装成兼容行为。

## Unchanged Source / 字节级不变源码

The executable audit hashes five artifacts against the fixed baseline:

- `packages/geoscratch/src/scratch/command.ts`: byte-for-byte unchanged
- `packages/geoscratch/src/scratch/binding.ts`: byte-for-byte unchanged
- `examples/m_demLayer/main.js`: byte-for-byte unchanged
- `examples/m_flowLayer/main.js`: byte-for-byte unchanged
- `examples/x_helloGAW/main.js`: byte-for-byte unchanged

Therefore the four native copy directions, draw/dispatch pipeline lowering,
bind-group cache/invalidation behavior, and
`GPUQueue.copyExternalImageToTexture()` payload/call model remain the exact
Goal-start implementation. Submission wrappers add observation without
rewriting those command implementations. The three legacy examples, including
the separate DEM Layer and Flow Layer implementations, remain untouched.

因此四种 native copy 方向、draw/dispatch pipeline lowering、bind-group
cache/invalidation，以及 `GPUQueue.copyExternalImageToTexture()` payload/call
模型均保持 Goal 起点源码。Submission wrapper 只增加 observation，没有改写这些
command implementation。三个 legacy example 保持不变，DEM Layer 与 Flow Layer
仍是两个独立实现。

## Preserved Matrix / 保留行为矩阵

| Area | Goal-start fact / 起点事实 | Final result / 最终结果 | Classification |
| --- | --- | --- | --- |
| Queue order | Complete plan and queue capability validation precede encoder/queue work; `steps` define one replay order. | Readback claims now also complete before observation scopes; issue instrumentation does not reorder, merge, retry, or skip actions. | Preserved and strengthened |
| Segmentation | Upload actions finish the active encoder segment and later encoder work starts a new segment. | The same `finishEncoderSegment()` and discriminated queue timeline remain; summary scopes stay outside segmentation decisions. | Preserved |
| Partial replay | Only queue calls that return successfully commit prepared logical effects; failed/later actions do not. | The successful prefix remains committed and is now guarded by native settlement even when a later call throws and no `SubmittedWork` returns. | Preserved and strengthened |
| Synchronous exceptions | `submit()` is synchronous, non-thenable, non-retryable after replay starts, and releases unsubmitted readback claims. | Every scope is synchronously popped; ignored settlement is internally observed; prefix write truth is guarded. | Preserved and strengthened |
| Readiness | Throw/warn/off and fallback/skip resolution complete before native command work. | Existing policy behavior remains; `indeterminate` reads hard-fail in every mode and cannot be downgraded. | Preserved and strengthened |
| Epochs | Preparation snapshots/restores live state; effects advance monotonically only after successful replay. | Delayed failure never rolls back history and changes current state only at the exact still-current allocation/epoch. | Preserved and strengthened |
| Queries | Timestamp/occlusion writes and resolve reads use explicit indexed slot epochs. | Slots add `indeterminate`, epoch guards, hard read rejection, and later explicit producer recovery. | Preserved and strengthened |
| Readback | Ordered claims, immutable links, producer lookup, one mapping owner, retention, and layout views remain. | Direct copy issue is observed independently; ordered bytes gate on submission outcome; direct indeterminate source fails before staging. | Preserved and strengthened |
| Pipeline/binding | Pipeline ownership/compatibility and lazy bind-group lowering are explicit. | `command.ts` and `binding.ts` are identical; lazy creation is enclosed during command encoding but remains independently deferred. | Preserved |
| External upload | Source identity/call fields are captured by the command and replay calls the native queue API in declared order. | Command source is identical; queue action receives summary/detailed observation without CPU pixel extraction or `writeTexture()` lowering. | Preserved |
| Queue completion | Effectful work registers `onSubmittedWorkDone()` after final replay; effect-free work completes locally. | `done` joins completion, native settlement, and lifecycle until completion; queue failure remains enclosing-family evidence. | Preserved and strengthened |

## ADR-035 Replacements / ADR-035 明确替代

The runner proves 14 intentional replacements:

1. schema v3 is replaced cleanly by schema v4;
2. submission target/operation/incident variants replace fabricated lower-level targets;
3. mutable public `SubmittedWork` construction is replaced by private backing state and one token-guarded factory;
4. queue-only `done` is replaced by fixed-order native/completion/lifecycle joining;
5. an unobserved submission native timeline is replaced by summary/off/finite-detailed policy;
6. ready-only resource content is replaced by explicit `indeterminate` state;
7. ready-only query slots are replaced by explicit `indeterminate` state;
8. raw direct-readback copy issue is replaced by the shared observation transaction;
9. ordered mapping-only byte trust is replaced by submission-outcome gating;
10. absent observation policy/budget is replaced by finite runtime policy and current facts;
11. absent detailed capture is replaced by finite `nativeSubmissionDetail: 'step'`;
12. delayed failure without an epoch guard is replaced by whole-target guarded indeterminacy;
13. direct readback's epoch/allocation-only check is strengthened with current-content truth;
14. scope-limited lifecycle coverage is replaced by completion-window lifecycle observation with temporal attribution.

以上替代均是 ADR-035 的 target-state clean cut；没有 version-3 conversion、同步
creation alias、legacy submission API 或隐式 CPU roundtrip。

## Executable Audit / 可执行审计

Run from the repository root:

```sh
node tests/audits/scratch-submission-native-final-parity.mjs
```

The runner loads the fixed commit with `git show`, verifies it is an ancestor of
`HEAD`, hashes every audited source, checks 17 preserved behavior facts and 14
intentional replacements, and compares diagnostics and public exports. Final
result:

- unchanged source checks: 5/5
- preserved behavior checks: 17/17
- intentional replacements: 14/14
- Goal-start diagnostics: 83; missing: 0
- Goal-start package exports: 284; missing: 0
- Goal-start scratch exports: 188; missing: 0

The previous readback fixed-baseline runner was also rerun: 12/12 original
JavaScript behaviors, 16/16 prior Goal-start TypeScript behaviors, and 10/10
ADR-034 replacements still pass.

该 runner 不进入默认 `npm test`，因为 shallow archive/clone 未必包含固定历史
commit；默认测试会锁住当前行为与 runner/document 的存在。

## Strict Review / 严格复审

The five-axis review found and closed five concrete gaps:

1. A partially replayed prefix had no content guard when a later queue action
   threw and `submit()` returned no work object. The prefix now attaches to
   native settlement; failed/unreplayed targets remain unchanged.
2. Ordered-readback claims occurred after summary scopes opened. Claims now
   complete before observation reservation, and reservation failure releases
   them without native work.
3. Direct readback checked epoch/allocation but not current indeterminate state.
   `SCRATCH_READBACK_SOURCE_CONTENT_INDETERMINATE` now fails before staging.
4. Device loss after scope settlement but before queue completion could escape
   `done`, and lifecycle attribution could become exact in detailed mode. `done`
   now owns that window and lifecycle remains temporal.
5. Overlapping scope/done lifecycle subscribers could record duplicate
   submission incidents. Completion now reuses a native-settlement lifecycle
   outcome and records a new incident only for the later window; effect-free
   work installs no lifecycle owner.

Each fix started with a failing regression and passed targeted and full-suite
GREEN verification. Follow-up review found no remaining required issue:

- **Correctness:** queue order, failure atomicity, epoch guards, simultaneous
  outcome ordering, ignored Promise handling, and terminal ownership are tested.
- **Readability:** new behavior remains in internal observation/content helpers;
  no new public scheduler/material abstraction or compatibility branch appears.
- **Architecture:** command/binding lowering is unchanged; raw device/queue,
  direct `execute(queue)`, manual `encode(nativeEncoder)`, and independent lazy
  bind-group acknowledgement remain honestly deferred.
- **Security:** no dependency, secret, user bytes, WGSL, mutable handle, stack,
  or raw device-loss prose was added to retained evidence.
- **Performance:** summary remains three scopes independent of work count;
  off/effect-free remain zero; history/evidence/current-owner gates are finite
  and every stress/benchmark profile ends with zero lifecycle subscribers.

Two isolated read-only reviewer agents were started with separate core and
readback scopes. Neither returned a result after repeated waits and an explicit
stop-and-report request; both were closed while still running. They are not
counted as review evidence. No external cross-model CLI was invoked during the
autonomous Goal because it had no explicit per-invocation authorization. The
recorded strict review is therefore the local adversarial review backed by the
five RED/GREEN regressions above, not a claimed independent-model approval.

## Final Gate Record / 最终门禁记录

- `npm test`: 724 passing
- `npm run typecheck`: package, public API, and canonical WebGPU declarations passed
- `npm run build`: package and all standalone examples passed
- source inventory: 37/37 call sites classified, 0 unresolved
- stress: 20,000 summary + 20,000 off passed; terminal pending observations,
  effectful works, subscribers, scopes, and unhandled rejections all zero
- benchmark: 11 profiles x 5 rounds = 55 structurally verified rounds; no timing threshold
- headed Chrome: Chrome 150.0.7871.115 / Apple Metal 3; exact direct/ordered
  `[2, 4, 6, 8]`; real delayed validation captured; 11/11 nonblank pages; zero
  unexpected console/page/request errors
- readback final parity: 12/12 + 16/16 + 10/10
- submission final parity: 5/5 unchanged + 17/17 preserved + 14/14 replacements
- `git diff --check`: passed
- tracked secret scan and generated-artifact audit: passed

Exact timings, evidence bytes, adapter facts, attribution limits, and terminal
snapshots are retained in
`scratch-submission-native-provenance-performance.md` and
`scratch-submission-native-provenance-audit.md`.

## Verdict / 结论

No source-backed Goal-start behavior is silently missing. Preserved behavior is
present on the TypeScript path; changed behavior is explicitly superseded by
ADR-035 and tested as the clean target state. There is no remaining correctness,
architecture, security, performance, or public-contract blocker on the feature
branch.

Remaining deferred native families are explicit rather than mislabeled:

- direct `execute(queue)`
- manual `encode(nativeEncoder)`
- independent lazy bind-group acknowledgement
- raw `runtime.device` / `runtime.queue` activity
- persistent sampler/query-set/bind-layout acknowledgement

The branch stops here. Merge, push, branch deletion, worktree removal, and
legacy example migration require separate user approval.
