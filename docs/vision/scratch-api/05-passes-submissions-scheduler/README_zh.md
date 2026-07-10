# Passes, Submissions 与 Scheduler

状态: Vision draft
日期: 2026-07-06

## 决策

使用持久 `PassSpec` 表达稳定 pass 形状。使用 `Submission` 作为 scratch 核心 GPU-kernel 提交模型，把 pass specs 与当前 command 列表绑定。

旧的 `Frame` 名称不再作为 scratch core model。frame 是应用或 presentation cadence; submission 是送往 GPU queue 的工作。一个 submission 可以 present 到 surface，也可以是 compute-only/offscreen。

第一版 scheduler 采用显式 submission 顺序加依赖校验。自动排序或 render-graph scheduling 后续可以作为上层编排模式构建。

## PassSpec

`PassSpec` 描述稳定 encoder 边界、attachment 形状，以及 timestamp writes 或 occlusion query-set ownership 这类 pass-level instrumentation。

Render pass spec 示例:

```ts
const scenePass = scratch.pass.render({
    label: 'scene',
    color: [
        {
            target: sceneColor,
            load: 'clear',
            store: 'store',
            clear: [0, 0, 0, 1],
        },
    ],
    depth: {
        target: depthTexture,
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
const simulationPass = scratch.pass.compute({
    label: 'simulation',
    timestampWrites: {
        querySet: simulationTiming,
        begin: 0,
        end: 1,
    },
})
```

`timestampWrites` 降低为 WebGPU pass descriptor timestamp writes，并要求 `timestamp` query set。`occlusionQuerySet` 仅用于 render pass，并要求 `occlusion` query set。Query result transfer 不隐含在 pass spec 中; resolve 与 readback 仍然是显式 command 或 operation。

Pass spec 不存储 command。这能避免上一轮 submission 残留 command list 存活到下一轮。

## Submission

`SubmissionBuilder` 记录一条显式 pass-command 序列。它不是 display frame，也不暗示 presentation:

```ts
const submitted = scratch.submission({ validation: 'throw' })
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

await submitted.done
```

概念拆分:

- `SubmissionBuilder` 负责记录并校验当前 pass-command 序列。
- `SubmittedWork` 由 `.submit()` 返回，持有 submitted-work id、`done` promise、execution outcomes、resource accesses、producer epochs、diagnostics，以及 readback operations 使用的链接信息。

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
- 提交 command buffers
- 返回 `SubmittedWork`

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
