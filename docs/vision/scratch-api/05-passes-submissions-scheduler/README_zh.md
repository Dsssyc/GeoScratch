# Passes, Submissions 与 Scheduler

状态: Vision draft
日期: 2026-07-12

## 决策

使用持久 `PassSpec` 表达稳定 pass 形状。使用 `Submission` 作为 scratch 核心 GPU-kernel 提交模型，把 pass specs 与当前 command 列表绑定。

旧的 `Frame` 名称不再作为 scratch core model。frame 是应用或 presentation cadence; submission 是送往 GPU queue 的工作。一个 submission 可以 present 到 surface，也可以是 compute-only/offscreen。

第一版 scheduler 采用显式 submission 顺序加依赖校验。自动排序或 render-graph scheduling 后续可以作为上层编排模式构建。

## PassSpec

`PassSpec` 描述稳定 encoder 边界、attachment 形状，以及 timestamp writes 或 occlusion query-set ownership 这类 pass-level instrumentation。

Render pass spec 示例:

```ts
const scenePass = runtime.createRenderPass({
    label: 'scene',
    color: [
        {
            target: sceneColor.view(),
            load: 'clear',
            store: 'store',
            clear: [0, 0, 0, 1],
        },
    ],
    depth: {
        target: depthTexture.view({ aspect: 'depth-only' }),
        depthLoad: 'clear',
        depthStore: 'store',
        depthClear: 1,
    },
    occlusionQuerySet: visibilityQueries,
    timestampWrites: {
        querySet: renderTiming,
        begin: 0,
        end: 1,
    },
})
```

Compute pass spec 示例:

```ts
const simulationPass = runtime.createComputePass({
    label: 'simulation',
    timestampWrites: {
        querySet: simulationTiming,
        begin: 0,
        end: 1,
    },
})
```

`timestampWrites` 降低为 WebGPU pass descriptor timestamp writes，并要求 `timestamp` query set。`occlusionQuerySet` 仅用于 render pass，并要求 `occlusion` query set。Query result transfer 不隐含在 pass spec 中; resolve 与 readback 仍然是显式 command 或 operation。

Attachment 按实际逻辑 view 校验，而不是只看 parent texture。持久
`TextureViewSpec` 必须包含 `RENDER_ATTACHMENT` view usage，并满足完整的
renderable-view shape。归一化后的 view format 是唯一 attachment format；可选
pass metadata 必须与它精确一致。Color slot 要求 color-renderable format；
depth/stencil renderable format 只能用于 depth/stencil attachment。显式 Surface view descriptor 必须保留已配置
format、`2d` single-mip/single-layer all-aspect RGBA view，以及 `0` 或
`RENDER_ATTACHMENT` usage。带 `TRANSIENT_ATTACHMENT` usage 的 view 对 color
以及每个可写 depth/stencil aspect 都要求 `load: 'clear'` 和
`store: 'discard'`。Scratch 会把它们作为 transient default，并拒绝冲突的显式
值。提供的 `depthClear` 必须有限且位于 `[0, 1]`。
当可写 depth 默认或显式解析为 `depthLoad: 'clear'` 且调用方没有提供值时，
Scratch 会把 `depthClear` 归一化为 `1`；它绝不会发出缺少所需原生 clear value
的 clear operation。
Texture-backed attachment 可以使用原生可渲染的 `2d`、`2d-array` 或 `3d`
view，并要求单个 mip 与单个选定 array layer。`2d-array` view 通过
`baseArrayLayer` 选择 layer。`3d` color view 覆盖 current logical mip depth，
且 pass 必须提供一个范围内的 `depthSlice`；非 `3d` attachment 拒绝
`depthSlice`。Color clear 只接受精确四个有限分量的 sequence，或字段完整且值
有限的 `{ r, g, b, a }` dictionary。Stencil clear 被限制在
`GPUStencilValue`/`GPUSize32` 范围内。Render pass 可以只有 depth，但不能同时
省略 color 与 depth/stencil attachment。Submission preflight 要求 color
attachment region pairwise disjoint。同一 texture 上选择相同 mip 与 array layer，
或相同 3D `depthSlice` 的 view 会重叠；不同 layer 与 slice 仍然合法。同一个
canvas context 在 Surface 创建阶段另有单一 live owner 门禁。Submission 仍会
防御性比较 Surface context identity，并在借用 current texture 或创建 encoder
之前拒绝 alias。

Pass spec 不存储 command。这能避免上一轮 submission 残留 command list 存活到下一轮。

## Submission

`SubmissionBuilder` 记录一条显式 pass-command 序列。它不是 display frame，也不暗示 presentation:

```ts
const submitted = runtime.createSubmission({ validation: 'throw' })
    .compute(simulationPass, [
        simulateParticles,
    ])
    .render(scenePass, [
        drawTerrain,
        drawParticles,
    ])
    .render(outputPass, [
        compositeToSurface,
    ])
    .submit()

const nativeOutcome = await submitted.nativeOutcome
await submitted.done
```

概念拆分:

- `SubmissionBuilder` 负责记录并校验当前 pass-command 序列。
- `SubmittedWork` 由 `.submit()` 返回，持有 submitted-work id、始终 resolve 的
  `nativeOutcome`、强化后的 `done` promise、execution outcomes、resource
  accesses、producer epochs、potential writes、diagnostics，以及 readback
  operations 使用的 links。

`SubmittedWork` 不应是 thenable。等待使用 `await submitted.done`，而不是 `await submitted`。这样 submitted-work object 仍然可 inspect，并与 `ReadbackOperation` 保持一致: object 本身不是 promise。

Submission 职责:

- 按用户顺序收集 pass-command pairs
- 校验 runtime ownership
- 校验 pass 与 command compatibility
- 校验 resource read/write order
- prepare 显式 transfer operations
- 把 command readiness policies 解析成唯一 pre-encoder execution plan
- 跳过 empty passes
- 只记录该 plan 最终选中的 commands
- 按 runtime policy 观察 Scratch-owned native issue boundaries
- 提交 command buffers
- 返回 `SubmittedWork`

### Ordered Readback Preparation 与 Links

无论 builder 是否包含 readback，`SubmissionBuilder.submit()` 都保持同步。
因此 ordered readback preparation 必须在 hot submission call 之前完成:

```ts
const readbackCommand = await runtime.createReadbackCommand(descriptor)
const submitted = runtime.submission().readback(readbackCommand).submit()
const bytes = await readbackCommand.result({ after: submitted }).toBytes()
```

Promise-only factory 会校验 immutable command descriptor，并确认一个可复用
staging allocation。Submission preflight 随后在 encoder creation 前 claim 该
slot。同一 command 的第二次并发使用会在 encoder 或 queue effect 前结构化
失败；成功 materialization 会把 slot 归还，以供顺序复用。Submission
encoding 与 replay 期间不发生 staging allocation。

每个 ordered step 产生一个冻结且可序列化的 link:

```ts
type SubmittedReadbackLink = Readonly<{
    commandId: string
    operationId: string
    stepIndex: number
    sourceResourceId: string
    allocationVersion: number
    contentEpoch: number
    stagingAllocationOperationId: string
}>
```

`SubmittedWork.readbacks` 保存 links，不保存 mutable operations、command
payloads、mapped bytes 或 native buffers。Queue completion rejection 会变成
`SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED`，但不会改写关联 readback
operation 独立的 mapping outcome。每个 immutable link 还会产生一个位于
`queue-completion` 阶段、归因为 `enclosing-operation-family` 的
`readback-failure` incident：completion barrier 只能标识 replayed submission
family，不能证明某一个 command 是原因。

### Native Outcome 与 Completion

`SubmissionBuilder.submit()` 保持同步且 non-thenable。完整 Scratch preflight
在 observation reservation 或 native effect 前完成；随后 encoding 与 queue
action 按声明的物理顺序发生，最后方法才返回。所有 Scratch error scope 都在
return 或 throw 前按逆序 pop，其 settlement Promise 被保留并立即观察，但 queue
call 不会被移入 microtask。

Ordered-readback ownership claim 也属于该 preflight。busy/disposed claim 会在
observation scope 前失败；若 observation reservation 本身失败，所有已取得 claim
都会在 encoder 或 queue work 前释放。

Runtime diagnostics policy 是 `submissionScopes: 'summary' | 'off'`。默认
`summary` mode 为完整 effectful attempt 预留一个有限 owner，并打开一个常数
规模的 validation/internal/OOM bundle。它报告
`enclosing-operation-family` attribution 与 issued locations，不虚构唯一失败
command。`off` 不打开 scope，并发布诚实的 unobserved provenance。
Effect-free work 不使用 owner 或 native scope。

`SubmittedWork.nativeOutcome` 始终 resolve 为 deeply frozen、
JSON-serializable 的 version-5 result。status 只能是:

```ts
type ScratchSubmissionNativeOutcomeStatus =
    | 'no-native-work'
    | 'observed-succeeded'
    | 'observed-failed'
    | 'unobserved'
    | 'observation-failed'
```

Outcome 按固定 stage/issue 顺序保留有界 locations 与每项 retained independent
failure fact，不会通过 reject 丢掉并发证据。`SubmittedWork.report` 仍是 immutable
synchronous preflight report，return 后绝不改写。

`SubmittedWork.done` 联合 native observation、`queue.onSubmittedWorkDone()`，
以及 queue completion 结算前的 runtime/device lifecycle。任一适用边界证明失败，
或 observation 本身无法 settle 时，它以一个结构化 submission diagnostic reject。
迟到的 lifecycle event 使用 `lifecycle-recheck` 与 `temporal-correlation`
attribution，永远不能升级为 `exact-operation`；若 native settlement 已保留同一
outcome，则不重复记录 incident。`done` 不等待 readback `mapAsync()`、
mapped-range access、host copy、retention、mapped leases、cancellation 或
cleanup。Queue completion 仍只是 enclosing-family evidence，不能定位唯一
command，也不能把独立成功的 mapping 改写为失败。

Per-location detail 只存在于有限 diagnostics capture:

```ts
const capture = runtime.diagnostics.capture({
    maxOperations: 128,
    maxDurationMs: 5_000,
    maxEvidenceBytes: 256 * 1024,
    nativeSubmissionDetail: 'step',
})

// 在有限 submission 中复现，必要时显式停止。
const report = capture.stop()
```

Detailed mode 分别为 encoder creation/finalization、pass begin/end、
standalone/pass command 与 queue action 建立 scope。它可以把
`exact-operation` attribution 指向 scoped location，但不一定能定位该 location
内部的唯一 native call。多个 active detailed capture 共享一份在 attempt 开始时
快照的 instrumentation plan，绝不复制 native issue call。

每个 submission 还发布 immutable `potentialWrites`。当 native observation
失败、observation settlement 失败或 queue completion reject 时，只有 allocation
与 produced epoch 仍为 current 的 write 才变成 `indeterminate`。Epoch 与历史
ledger 永不回滚。后续 acknowledged producer 会保护或恢复更新的 epoch；Surface
presentation target 不进入持久 indeterminate state。

若后续同步 native exception 令 replay 中止且没有返回 `SubmittedWork`，同一个
native-settlement guard 只覆盖已经成功 replay 的 action prefix；失败和未 replay
action 不发布 write effect。

### 构造与提交之间的 Resize

`TextureResource.resize()` 不会增加 submission step。它是返回 Promise 的 resource allocation transaction，不是 queue work。candidate scope settle 期间旧 allocation 保持 current，submission encoding 不会隐藏等待；若某个 submission 必须使用 replacement，应用需要先显式 await resize。`SubmissionBuilder` 保存逻辑 pass、command、resource 与 `TextureViewSpec` reference；preflight 与 encoding 会校验 submission 时实际 current 的 allocation。Texture-backed color 与 depth/stencil attachment 会保留其 `2d`、`2d-array` 或 `3d` 逻辑 view shape。过期的 mip/layer descriptor、越出范围的 `3d` `depthSlice`、重叠的 color attachment region，或不匹配的 current render extents/sample counts，都会在 command encoder creation 或 ledger mutation 前失败。Native attachment view 是 submission-scoped，通过 `SubmittedWork` 观察，且绝不会被 `PassSpec` 缓存或 prepare。Attachment 不受 compatibility-mode texture-binding dimension 约束。

Resize 自身不记录 resource access、producer epoch、command buffer、queue action 或 completion registration。replacement 虽然保留 `contentEpoch` 数值，但初始为 empty。后续 write 可以在同一 submission 中让它 ready，供更后的 read 使用；两份 ledger 此时都记录新的 `allocationVersion` 与下一个 `contentEpoch`。

Submission 完成后，`SubmittedWork.resourceAccesses` 与 `producerEpochs` 保持为 immutable historical record，描述该 submission 实际使用的 allocation 与 content facts。之后的 texture resize 不能改写这些 arrays，也不能改变已有 `done` promise。

## 物理 Queue 时间线

`SubmissionBuilder.steps` 在 encoder-backed work 与 queue-side upload 之间定义一个全序。把 command 记录进 encoder 不等于把它送入 queue: `GPUQueue.writeBuffer(...)` 和 `GPUQueue.writeTexture(...)` 在调用时进入 queue，而 copy、readback staging、resolve、compute 与 render work 只有在 finished command buffer 被 submit 时才进入 queue。

因此 submission lowering 分三阶段:

1. 在创建 encoder 或接触 `GPUQueue` 前，完成 readiness、fallback、dependency validation、ownership、lifecycle 与 pass compatibility 解析。
2. 准备完整的内部 discriminated queue-action timeline。基于临时 content-state snapshot，按声明 step 顺序模拟逻辑 resource access 与 epoch effect，并编码 command-buffer segments，但此时不调用 queue write 或 submit method。replay 前恢复 live content state。
3. 按准确顺序 replay 已准备 timeline，只在对应 queue call 成功后提交该 action 的逻辑 effects，并在最后一个 action 入队后注册 `queue.onSubmittedWorkDone()`。

内部 action family 是 command buffer、buffer upload、texture upload 与 external-image upload。它们是显式 variant，不是任意 callback，也不是 public scheduler API。

command-buffer segment 是一段最大的连续 executed encoder-backed steps。queue-side upload 会结束前一段，并与后一段隔开:

```text
copy + compute -> buffer upload -> texture upload -> render + readback
```

降低为:

```text
submit(copy + compute)
writeBuffer
writeTexture
submit(render + readback)
```

连续 upload 不创建空 command buffer。skipped command、skipped pass 与 effect-free empty pass 不创建 segment。没有 upload boundary 的 encoder-only work 仍保持一个 encoder、一个 command buffer 和一次 `queue.submit(...)`。

`SubmittedWork.commandBuffers` 按物理 queue 顺序包含每个真实 segment。upload-only work 的 command-buffer array 为空，但仍在最后一次 queue write 后注册 completion。effect-free work 不创建 encoder 或 queue action，并使用已 resolve 的 `done` promise。见 ADR-029。

每个 resolved upload 都会在 encoder 创建前重新校验 live data range 与所需 queue method。replay 一旦开始，builder 就不可重试: 意外的同步 queue failure 不能重复先前 action，且只有成功入队的 action 才提交其 prepared logical effects。即使 `submit()` 随后 throw，这些已提交的 prefix effect 仍由该 attempt 的 native settlement guard 覆盖。

### External Image Queue Actions

`ExternalImageUploadCommand` 以 `uploadKind: 'external-image'` 和下列内部 prepared action 进入同一全序:

```ts
{ kind: 'external-image-upload', command, effects }
```

与 buffer 和 texture upload 一样，它会结束前一 encoder segment，并隔开后续 encoder-backed work。连续 external upload 不创建空 command buffer; external-upload-only work 保持 `SubmittedWork.commandBuffers` 为空，并在最后一次 queue call 后注册 `done`。

所有 external upload 都会在第一个 encoder 或 queue side effect 前完成 preflight。Preparation 只模拟非空 target write，并在 replay 前恢复 live state。Replay 在 action 的准确位置调用 `GPUQueue.copyExternalImageToTexture()`，且 only after the native queue call succeeds 才提交 prepared target effect。zero-width 或 zero-height action 仍保留在物理 timeline 中，但不携带 target effect、resource access、producer epoch 或 simulated readiness。

如果原生调用同步抛错，replay 会停止。先前成功 action 保留已提交效果，failed 与 later action 不提交 effect，builder 保持不可重试。由于 `submit()` 抛错且不返回 `SubmittedWork`，未 replay readback 的 staging buffer 会立即销毁；已被 submitted command buffer 引用的 staging 会在 `queue.onSubmittedWorkDone()` settle 后销毁。原生异常按 external-image command diagnostic contract 包装，而不是转成通用 queue callback failure。见 ADR-030。

## Resolved Readiness Execution

`submit()` 会在创建 WebGPU command encoder 前完成 readiness resolution。Resolved plan 包含 validation report、resolved render/compute steps、最终模拟 resource/query state，以及 execution-outcome drafts。Encoding 只消费这些 resolved steps; 不会重新访问原始 builder command lists，也不会再次决定 policy。

Draw/Dispatch resolution 在精确 command position 发生:

- missing `throw` command 在所有 validation mode 下都会于 encoder 或 resource side effect 前失败;
- missing `skip-command` request 被省略，不产生 read、write、ready-state 或 producer fact;
- missing `skip-pass` request 会移除整个 pass;
- missing `use-fallback` request 会解析同 kind fallback chain，只有最终选中的 command 才参与 dependency validation 与 encoding。

每个 pass 都基于克隆的 readiness state、query-slot state 和 pass-local dependency findings 解析。被跳过的 pass 会丢弃所有 clone，包括较早 command writes、render attachment load/clear/store、color/depth epochs、timestamp writes、occlusion query writes 与 optional findings。即使 draw 被逐个跳过，只要 attachment operation 仍存在，render pass 就继续执行。没有 selected command 且无 side effect 的 compute pass 记为 `skipped-empty`，不会开始 native pass。

`SubmittedWork.executionOutcomes` 是不可变的控制流 ledger。每个 render/compute step 先记录 pass summary，再按原始 request 顺序记录 Draw/Dispatch command outcomes。Pass 的 `requestedCommandIds` 保留原始 pass command sequence; `encodedCommandIds` 保留实际 sequence，包括选中的 fallback。每次 command attempt 都记录 policy 与完整 missing-resource state/epoch facts。所有 outcomes、attempts、missing facts、subjects、nested arrays 与 top-level array 均被冻结。

正常 skip/fallback 结果不是 diagnostics。`resourceAccesses` 与 `producerEpochs` 只在编码 resolved command 和已执行 pass effect 时捕获，因此不会包含 skipped-primary 或 skipped-pass ghost。

## Presentation 是 Submission 的一种模式

Submission 可以 present，但 presentation 不是核心提交单元的定义:

- 没有 surface target -> compute-only 或 offscreen submission
- 有 surface output -> 借用 surface current texture view 的 presentation submission

CPU/GPU 数据移动是显式的。Upload、copy、render 写入、compute 写入与 readback staging 都进入同一套 submission order 和 epoch validation。结果通过 `ReadbackOperation` 回到 CPU，例如 `await readback.toArray()`，而不是通过 `buffer.toArray()`。完整模型见 `07-transfers-epochs`。

应用代码仍然可以有 `renderFrame()` 或 animation-frame loop。这个应用层 frame 可以创建一个或多个 scratch submissions，但它不是 scratch core type。

## Dependency Validation

核心 scheduler 不自动排序 commands。它校验显式顺序。

检查示例:

- command 使用了其他 runtime 的 resource
- command 使用了 disposed 或 lost resource
- command 在 submission prepare 或写入前读取某个 content epoch
- 同一 pass 未显式允许时同时读写同一 resource
- surface current texture view 在所属 presentation submission 外使用
- render command 被插入 compute pass
- dispatch command 被插入 render pass
- dispatch 的 workgroup 数超过 `maxComputeWorkgroupsPerDimension`
- 绑定的 storage buffer 范围超过 device storage-binding 限制

原生 indexed 与 indirect command 使用和 shader resource 相同的 declared-read validation 路径。Vertex、index 与 indirect buffer 必须声明显式 required content epoch。同一 submission 中的前序 upload 或 GPU command 可以产生该 epoch; 后续 fixed-function read 会进入 `SubmittedWork.resourceAccesses`，但不会推进 resource epoch。Indirect argument 内容保持为 GPU data，不会为了 scheduler validation 被复制到 CPU。

Submission simulation 与 encoding 共用 command 的 potential-write 判定。静态 count 已知不会执行 invocation 的 direct draw 或 dispatch 不会把 declared output 标成 ready，也不会创建 write 或 producer ledger entry。Indirect count 保持 opaque，因此其 declared write 会在不进行 host inspection 的前提下被保守视为 potential producer。

Validation modes:

```ts
type SubmissionValidationMode = 'off' | 'warn' | 'throw'
```

开发期应优先使用 `throw`。生产或性能 profiling 可选择 `warn` 或 `off`。

Validation findings 应使用 `09-diagnostics-validation` 中的共享 `ScratchDiagnostic` envelope。Submission validation 应在 work 被提交时把确定性的 diagnostic report 挂到 `SubmittedWork` 上; 在 `throw` mode 下应抛出结构化 diagnostic error，而不是 prose-only `Error`。

## Readiness Policy 的关系

Dependency validation 与 resource readiness policy 是两件事。

- Validation 检查最终选中的 submission 顺序、required epochs 与 ownership 是否自洽。
- `whenMissing` 控制所需 resource 在该位置没有可读内容时如何处理。

`SubmissionValidationMode` 控制 optional dependency finding 的 disposition，而不改变 readiness control flow。`off` 仍然解析 skip/fallback 并保留 execution outcomes。Draw 与 Dispatch 实现全部四种 policy; Copy、Readback 与 Resolve 仍然只支持 `throw`。

## 未来上层编排

自动排序不进入第一版核心 scheduler。未来上层可提供:

```ts
scratch.schedule(commands, {
    strategy: 'topological',
}).into(submission)
```

该层可以基于 command read/write 声明构建，不需要改变核心 `Submission` 模型。

## 非目标

- 不把 pass spec 做成当前 submission commands 的可变容器。
- 不把自动 render graph 排序作为默认 core 行为。
- 不向需要 WebGPU 级控制的用户隐藏 submission order。
- 不在 scratch scheduler 中编码 geospatial layer order。
- 不把 submission validation 暴露成 prose-only errors。
- 不把 `Frame` 作为 scratch core submission type; frame cadence 属于 geo、app 或 presentation layers。
- mapped leases、texture readback、external-texture frame lifetime、tracked dynamic values、render graph ownership 与 raw-device tracking 均不属于本 submission-native-outcome slice。
