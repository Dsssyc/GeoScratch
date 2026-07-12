# Scratch Readback Staging And Mapping Audit / Scratch Readback Staging 与 Mapping 审计

Date: 2026-07-12
Status: Complete for ADR-034 scope

This audit is bilingual at the row level: each contract states the English fact
followed by its Chinese boundary. Evidence is executable and does not promote a
message, timing adjacency, or logical byte count into a stronger claim.

| ID | Contract / 契约 | Implementation evidence / 实现证据 | Attribution | Status |
| --- | --- | --- | --- | --- |
| R1 | Direct staging is acknowledged before encoder or queue use.<br>Direct staging 在 encoder 或 queue 使用前完成确认。 | `readback-staging.ts`; validation/OOM/native/scope/lifecycle fake tests. | Exact operation | Complete |
| R2 | Ordered command visibility follows one acknowledged reusable allocation.<br>Ordered command 仅在一个可复用 allocation 确认后可见。 | Promise-only factories; command fact absent before settlement; real Chrome probe. | Exact operation | Complete |
| R3 | `SubmissionBuilder.submit()` remains synchronous and non-thenable.<br>`submit()` 保持同步且不成为 thenable。 | Public contract test and headed Chrome probe. | Exact operation | Complete |
| R4 | Ordered staging is claimed before encoder effects and reused only sequentially.<br>Ordered slot 在 encoder effect 前 claim，且只能顺序复用。 | Busy preflight tests; 5,000 ordered reuses with no reuse-time allocation. | Exact operation | Complete |
| R5 | `SubmittedWork.readbacks` contains frozen serializable links, not live operations or handles.<br>Links 只保存冻结事实，不保存 live operation 或 handle。 | Link contract/type tests; schema-v3 JSON round trip in Chrome. | Exact operation | Complete |
| R6 | Direct readback does not await `after.done`; queue replay order supplies the dependency.<br>Direct readback 不等待 `after.done`，依靠已 replay 的 queue order。 | Source audit and deferred queue-completion test. | Exact operation | Complete |
| R7 | Mapping uses one buffer-specific `mapAsync()` transaction.<br>Mapping 只使用一个 buffer-specific `mapAsync()` transaction。 | `packages/geoscratch/src/scratch/readback-mapping.ts:255`; one-call source audit. | Exact operation | Complete |
| R8 | Validation, internal, OOM, map rejection, and scope settlement stay independent of Promise order.<br>各 native outcome 不由 Promise settle 顺序选择主因。 | Reverse-settlement and simultaneous device-loss tests. | Exact operation | Complete |
| R9 | Copy issue, mapping, mapped range, host copy, cleanup, budget, queue completion, and lifecycle recheck are distinct stages.<br>失败阶段使用结构化区分。 | Stable-code fake tests and schema-v3 stage contract. | Exact operation | Complete |
| R10 | One materialization owner prevents duplicate native work.<br>单一 materialization owner 阻止重复 native work。 | Retained-reader sharing and consume-on-read competition tests. | Exact operation | Complete |
| R11 | Cancel/dispose preserve terminal state while native map rejection is observed.<br>Cancel/dispose 在观察 native rejection 时保持终态。 | Deferred-map lifecycle tests; zero unhandled rejection. | Exact operation | Complete |
| R12 | Cleanup records `unmap` and `destroy` separately and never invents successful destruction.<br>Cleanup 区分 `unmap`/`destroy`，不虚构销毁成功。 | Cleanup outcome codes, `destroyRequested`, direct/ordered failure tests. | Exact operation | Complete |
| R13 | Current facts and finite budgets scale with live ownership, not runtime age.<br>Current facts 与有限 budget 随 live ownership 而非 runtime 年龄增长。 | 20,000 direct operations; 5,000 ordered reuses; recorder overflow terminal zeros. | Exact operation | Complete |
| R14 | Logical staging bytes are not physical residency; retained host bytes are separate.<br>Logical staging bytes 不是 physical residency，host bytes 单独计数。 | Runtime snapshot schema, docs, and stress facts. | Unknown for physical residency | Complete |
| R15 | Version 3 uses explicit resource, pipeline, command, and readback targets.<br>Version 3 使用显式宏观 target。 | Schema contract, captures/exports, headed JSON round trip. | Exact operation | Complete |
| R16 | Queue completion can identify only the enclosing replayed submission family.<br>Queue completion 只能定位 enclosing replayed submission family。 | `SubmittedWork.done` rejection wrapper and immutable links. | Enclosing operation family | Complete |
| R17 | Device loss near mapping is not fabricated as command causality.<br>Mapping 附近的 device loss 不伪造成 command 因果。 | Canonical device-loss incident plus retained simultaneous outcomes. | Temporal correlation | Complete |
| R18 | Real browser behavior and existing examples remain regression-gated.<br>真实浏览器行为与已有 examples 保持回归门禁。 | Headed Chrome exact bytes and 11-page regression matrix; zero console/page/request errors. | Exact operation for observed calls; Unknown beyond tested adapter | Complete |

## Native Call Inventory / Native 调用清单

| Call | Current site | Ownership | Result |
| --- | --- | --- | --- |
| Readback staging `GPUDevice.createBuffer()` | `packages/geoscratch/src/scratch/readback-staging.ts:142` | Shared direct and ordered allocation transaction | Covered; no staging allocation remains in submission encoding |
| Readback `GPUBuffer.mapAsync()` | `packages/geoscratch/src/scratch/readback-mapping.ts:255` | Shared direct and ordered mapping transaction | Covered; no second mapping path remains |

`readback.ts`, `command.ts`, and `submission.ts` contain no additional readback
staging `createBuffer()` call. `readback.ts` contains no direct `mapAsync()` and
does not await `after.done`. The public entrypoints expose no staging handle.

## Attribution Vocabulary / 归因词汇

- **Exact operation**: a balanced scope or caught synchronous call is attached
  to the operation that issued it. / 平衡 scope 或同步 catch 可定位到发起它的
  operation。
- **Enclosing operation family**: completion covers the replayed submission but
  not one unique command. / completion 覆盖 replayed submission，不能唯一定位
  command。
- **Temporal correlation**: device loss overlaps a mapping but does not prove
  that mapping caused it. / device loss 与 mapping 时间重叠，但不证明因果。
- **Unknown**: native physical residency, driver padding, free VRAM, and behavior
  outside the tested adapter remain unknown. / physical residency、driver
  padding、free VRAM 与未测试 adapter 行为保持 unknown。

## Explicit Follow-Up Boundary / 明确后续边界

Texture readback, mapped-view leases, stale-operation warning/eviction,
sampler/query/bind-group creation provenance, general encoder/finalization/
queue-submit scopes, raw `runtime.device` tracking, legacy example migration,
and an automatic render graph are not implemented by ADR-034. GPU-native
texture-to-buffer and buffer-to-texture copies remain explicit `CopyCommand`
directions; no CPU roundtrip is presented as their replacement.
