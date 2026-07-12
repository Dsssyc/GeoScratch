# Scratch Readback Final Parity Audit / Scratch Readback 最终事实核对

Date: 2026-07-12
Status: Complete on the feature branch

## Fixed Baselines / 固定基线

- Original JavaScript source baseline / 原始 JavaScript 源码基线:
  `20bb393df570ff1914a6789e9bd422d59ddfecc8`
- Goal-start TypeScript baseline / 本 Goal 起点 TypeScript 基线:
  `f3e73062bb352009a2118bf9960de062b1296ebe`
- Audit target / 审计目标:
  `socu/scratch-readback-staging-mapping-provenance`

The JavaScript baseline is authoritative for functionality that existed before
the TypeScript clean cut. It contains direct `ReadbackOperation`, but no
`ReadbackCommand`. The Goal-start TypeScript baseline is therefore separately
authoritative for later layout, retention, epoch, ordered-copy, producer, and
failed-submission behavior. Neither baseline is treated as a compatibility
constraint where ADR-034 explicitly replaces it.

JavaScript 基线负责证明早期已实现功能没有丢失；它尚未包含
`ReadbackCommand`。Goal 起点 TypeScript 基线负责证明后来实现的 layout、
retention、epoch、ordered copy、producer 与 failed-submission 行为没有回退。
ADR-034 明确替代的行为不伪装成“原样兼容”。

## JavaScript Baseline Matrix / JavaScript 基线矩阵

| ID | Baseline fact / 基线事实 | Current result / 当前结果 | Classification | Evidence |
| --- | --- | --- | --- | --- |
| J1 | Runtime is asserted active and source is validated as same-runtime `BufferResource`.<br>校验 runtime 与 source ownership。 | Same checks remain before readback work. | Preserved | `normalizeSource()`, lifecycle tests |
| J2 | Source requires `COPY_SRC` usage.<br>Source 必须带 `COPY_SRC`。 | Same stable diagnostic remains. | Preserved | `SCRATCH_RESOURCE_USAGE_MISSING` |
| J3 | Range defaults to the remaining buffer and rejects invalid bounds.<br>Range 默认读取剩余区间并校验边界。 | Direct and ordered paths retain equivalent bounds. | Preserved | `normalizeRange()`, `normalizeReadbackCommandRange()` |
| J4 | `after` must be same-runtime `SubmittedWork`.<br>`after` 必须来自同一 runtime。 | Identity validation and producer link remain. | Preserved | `normalizeAfter()` |
| J5 | Request captures source `contentEpoch` and `allocationVersion`.<br>请求捕获 source epoch/version。 | Captures remain and now reject stale direct sources structurally. | Preserved and strengthened | `assertReadbackSourceCurrent()` |
| J6 | Copy uses source offset, zero staging offset, and exact byte length.<br>Copy 保留 offset 与精确 byte length。 | Both paths encode the same GPU-native copy geometry. | Preserved | `copyBufferToBuffer()` sites |
| J7 | `toBytes()` and typed `toArray()` return host-owned views.<br>保留 bytes 与 typed-array 读取。 | Public methods and divisibility validation remain. | Preserved | public API/type tests |
| J8 | `getMappedRange(0, byteLength)` is copied with `slice(0)` before cleanup.<br>Mapped range 在 cleanup 前复制为 owned bytes。 | Shared mapping path retains exact range and owned copy. | Preserved | mapping tests, parity runner |
| J9 | `cancel()` and `dispose()` expose terminal lifecycle states.<br>保留 cancel/dispose 终态。 | Terminal states remain; pending staging is now released and native rejection observed. | Preserved and strengthened | lifecycle-race tests |
| J10 | Constructor and `stagingBuffer` were publicly mutable.<br>Constructor 与 staging handle 曾公开可变。 | Constructors are closed; no public staging getter or entrypoint export exists. | Superseded by ADR-034 | constructor/source audits |
| J11 | Direct staging was used immediately after synchronous `createBuffer()`.<br>旧路径未确认 allocation 即使用。 | Scoped validation/OOM acknowledgement completes before encoder or queue use. | Superseded by ADR-034 | staging fake tests |
| J12 | Direct readback awaited `after.done` before copy submission.<br>旧路径等待全 submission completion。 | Copy is submitted after already-replayed queue work without awaiting `after.done`. | Superseded by ADR-034 | queue-order test, source audit |
| J13 | Direct readback added a broad `onSubmittedWorkDone()` wait before mapping.<br>旧路径增加全 queue wait。 | The staging buffer's `mapAsync()` is the host-availability barrier. | Superseded by ADR-034 | one-map inventory |
| J14 | Copy, mapping, range, host-copy, and cleanup failures collapsed into `SCRATCH_READBACK_MAP_FAILED`.<br>失败被压成一个通用 code。 | Stable stage-specific diagnostics and outcomes replace it; the generic code is absent. | Superseded by ADR-034 | diagnostic parity runner |
| J15 | Concurrent calls could issue duplicate work, and a `failed` operation could incidentally retry.<br>并发调用可能重复执行，failed 后可能隐式重试。 | One materialization owner is enforced; failed materialization is terminal and repeats its first stable code without native work. | Superseded by ADR-034 | concurrency and repeated-failure tests |

## Goal-Start TypeScript Matrix / Goal 起点 TypeScript 矩阵

| ID | Goal-start fact / Goal 起点事实 | Current result / 当前结果 | Classification | Evidence |
| --- | --- | --- | --- | --- |
| T1 | `toLayoutView()` uses source `LayoutArtifact`.<br>由 source layout 生成 readback view。 | Layout-derived view remains unchanged. | Preserved | layout readback tests |
| T2 | `consume-on-read` and `until-dispose` are explicit retention modes.<br>两种 retention mode 显式存在。 | Both remain; retained concurrent readers receive separate clones. | Preserved and strengthened | retention/mapping tests |
| T3 | Direct readback detects stale `contentEpoch`.<br>检测 stale content epoch。 | Same diagnostic remains before native copy. | Preserved | `SCRATCH_READBACK_SOURCE_EPOCH_STALE` |
| T4 | Direct readback detects stale allocation version.<br>检测 stale allocation version。 | Same diagnostic remains before native copy. | Preserved | `SCRATCH_READBACK_SOURCE_ALLOCATION_STALE` |
| T5 | Producer epoch is found from exact submitted resource history.<br>从 submitted history 找到 producer epoch。 | Reverse lookup and producer-before-readback rule remain. | Preserved | producer tests, `findReadbackProducerEpoch()` |
| T6 | Ordered descriptor retains explicit source epoch, range, retention, and `whenMissing: 'throw'`.<br>Ordered descriptor 保留显式 contract。 | Promise factory normalizes the same immutable contract before allocation. | Preserved | command contract tests |
| T7 | Readback is represented as a read-only submission access.<br>Readback 在 ledger 中是 read access。 | Access remains read-only and does not advance source content epoch. | Preserved | submission ledger tests |
| T8 | Ordered copy occurs at its declared submission step.<br>Ordered copy 位于声明 step。 | The pre-acknowledged slot is encoded at that exact step and queue segment. | Preserved | submission-order tests |
| T9 | `result({ after })` selects one exact command/work pair.<br>Result 精确关联 command/work。 | Exact WeakMap lookup remains; no latest-result alias exists, and disposal cannot orphan an already-submitted result. | Preserved and strengthened | command result/lifecycle tests |
| T10 | One command may appear only once in one builder.<br>同一 builder 不允许重复 command。 | Duplicate preflight remains and sequential cross-submission reuse adds busy preflight. | Preserved and strengthened | duplicate/busy tests |
| T11 | Ordered staging was allocated during submission encoding.<br>Ordered staging 曾在 submit 内分配。 | One slot is acknowledged in the Promise-only factory before command visibility. | Superseded by ADR-034 | factory/staging tests |
| T12 | `SubmissionBuilder.submit()` is synchronous.<br>`submit()` 同步返回。 | It remains non-thenable and performs no conditional readback wait. | Preserved | type, Node, and Chrome probes |
| T13 | Partial queue replay triggers delayed cleanup after GPU completion.<br>部分 replay 后延迟清理 staging。 | Submitted claims still defer physical reuse/release; unsubmitted claims release immediately. | Preserved and strengthened | failed-submission tests |
| T14 | Once ordered copy is staged, later source disposal does not invalidate staged bytes.<br>Ordered copy 完成后 source disposal 不丢弃 staging bytes。 | Scheduled materialization still relies on owned staging rather than the disposed source handle. | Preserved | staged-source disposal tests |
| T15 | Public names are exported from both package entrypoints.<br>两个 package entrypoint 保持 public names。 | `ReadbackCommand`, `ReadbackOperation`, and `SubmittedReadbackLink` remain public; ownership helpers stay internal. | Preserved and strengthened | entrypoint/type audit |
| T16 | Existing non-legacy consumers explicitly create ordered commands.<br>普通 consumer 显式创建 ordered command。 | All current consumers `await` the Promise-only factory; legacy renderers are untouched. | Migrated by ADR-034 | docs/example contract tests |

## New ADR-034 Facts / ADR-034 新事实

| ID | Fact / 事实 | Result | Evidence |
| --- | --- | --- | --- |
| N1 | Schema version is a clean-cut `3`; command/readback targets are explicit. | Complete | schema, capture, export, and JSON tests |
| N2 | `SubmittedWork.readbacks` is deeply immutable and serializable. | Complete | contract/type/Chrome tests |
| N3 | Direct and ordered paths share one staging allocator and one mapping call site. | Complete | source inventory and native-call audit |
| N4 | Mapping retains fixed-order scope, Promise, device-loss, lifecycle, mapped-range, host-copy, and cleanup outcomes; queue completion records enclosing-family incidents separately. | Complete | fake settlement and queue-completion tests |
| N5 | Pending and staging budgets fail before their governed native side effects and emit budget provenance. | Complete | runtime facts and staging tests |
| N6 | Current ownership facts and historical evidence have independent bounded memory models. | Complete | 20,000 direct / 5,000 ordered stress |
| N7 | Texture readback, mapped leases, generic encoder/submit scopes, and raw-device tracking remain unimplemented. | Explicit non-goal | ADR-034 and main audit |

## Executable Audit / 可执行审计

Run from the repository root:

```sh
node tests/audits/scratch-readback-final-parity.mjs
```

The runner loads both fixed commits with `git show`, verifies the Goal-start
commit is an ancestor of `HEAD`, compares old diagnostics and behavior markers,
checks explicit replacements, hashes all current readback/provenance modules,
and audits public/internal entrypoint boundaries. Current result:

- old JavaScript diagnostics: 9 unique codes; no missing code except the
  explicitly split generic map code
- preserved JavaScript behavior checks: 12/12
- preserved Goal-start TypeScript behavior checks: 16/16
- explicit ADR-034 replacements: 10/10

This runner is intentionally not part of default `npm test`: shallow source
archives and shallow CI clones may not contain the two fixed historical commits.
The default test suite instead locks the current behavior and the existence of
this reproducible audit.

## Strict Re-review / 严格复审

The final correctness review found and closed four implementation gaps:

- pending-budget and staging-allocation failures now retain the exact readback,
  source, command, and submission facts available at each ownership boundary;
- queue-completion rejection emits one command-targeted incident per immutable
  readback link while retaining enclosing-family attribution;
- `activeMappings` follows mapping-operation begin/settlement rather than the
  shorter public readback-fact lifetime, including cancel/runtime-dispose races;
- command disposal no longer makes an already-submitted historical result
  unreachable, while still forbidding submission or reuse.

The follow-up review found no remaining required issue across correctness,
readability, architecture, security, and performance. The implementation adds
no dependency, source payload, mutable native handle, unbounded recorder, or
success-path scan. Queue-completion incidents are failure-only and mapping
ownership accounting is constant-time.

## Final Gate Record / 最终门禁记录

The feature branch was verified after the final runtime and audit changes:

- `git diff --check`: passed
- `npm test`: 642 passing
- `npm run typecheck`: passed
- `npm run build`: package and standalone examples passed
- `node tests/audits/scratch-readback-final-parity.mjs`: 12/12 JavaScript,
  16/16 Goal-start TypeScript, and 10/10 explicit replacements passed
- `node tests/stress/scratch-readback-staging-mapping.mjs`: 20,000 direct and
  5,000 ordered operations passed with zero terminal ownership
- `node tests/benchmarks/scratch-readback-staging-mapping.mjs`: all seven
  profiles and five rounds passed structural gates
- `node tests/browser/scratch-readback-staging-mapping.mjs`: headed Chrome 150
  on Apple Metal 3 returned exact direct/ordered bytes and passed all 11 pages

The runtime changes from strict review required a fresh browser run. Its exact
adapter facts, recorder evidence, timings, and interpretation limits are
retained in `scratch-readback-staging-mapping-performance.md`.

## Verdict / 结论

No source-backed behavior from either applicable baseline is silently missing.
Preserved behavior is present on the TypeScript path; changed behavior is
explicitly superseded by ADR-034 and tested as the clean target state. No legacy
API, synchronous ordered factory, public staging handle, CPU roundtrip, or
version-2 compatibility path is retained.
