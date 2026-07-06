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
        load: 'clear',
        store: 'store',
        clear: 1,
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
- `SubmittedWork` 由 `.submit()` 返回，持有 submitted-work id、`done` promise、producer epochs、diagnostics，以及 readback operations 使用的链接信息。

`SubmittedWork` 不应是 thenable。等待使用 `await submitted.done`，而不是 `await submitted`。这样 submitted-work object 仍然可 inspect，并与 `ReadbackOperation` 保持一致: object 本身不是 promise。

Submission 职责:

- 按用户顺序收集 pass-command pairs
- 校验 runtime ownership
- 校验 pass 与 command compatibility
- 校验 resource read/write order
- prepare 显式 transfer operations
- 解析 command readiness policies
- 跳过 empty passes
- 记录 GPU commands
- 提交 command buffers
- 返回 `SubmittedWork`

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

Validation modes:

```ts
type SubmissionValidationMode = 'off' | 'warn' | 'throw'
```

开发期应优先使用 `throw`。生产或性能 profiling 可选择 `warn` 或 `off`。

Validation findings 应使用 `09-diagnostics-validation` 中的共享 `ScratchDiagnostic` envelope。Submission validation 应在 work 被提交时把确定性的 diagnostic report 挂到 `SubmittedWork` 上; 在 `throw` mode 下应抛出结构化 diagnostic error，而不是 prose-only `Error`。

## Readiness Policy 的关系

Dependency validation 与 resource readiness policy 是两件事。

- Validation 检查 submission 顺序与 ownership 是否自洽。
- `whenMissing` 检查所需资源未 ready 时如何处理。

即使启用了 validation，command 仍需要显式 readiness policy。

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
