# 传输与 Epoch

状态: Vision draft
日期: 2026-06-30

## 决策

`Submission` 是核心提交单元。CPU/GPU 数据移动不是 `Resource` 方法; 它应表达为显式 transfer operation 与 command。

`Resource` 是逻辑身份加状态，不是 host transfer 句柄。upload、readback、copy、render 写入和 compute 写入都进入同一套 epoch 模型，使 runtime 能校验读取的是哪份内容、绑定的是哪个物理 GPU 对象。

这取代早先的"资源即 readback 句柄"模型。它解决异步 readback、提交单元、GPU 计时/查询缺口，同时不把 `buffer.toArray()` 或 `buffer.write()` 纳入核心资源契约。

## Submission 是提交单元

`SubmissionBuilder` 记录 passes 与 commands 并提交。Presentation 只是其中一种模式，而不是它的定义:

- 带 surface 输出 -> 使用 presentation-submission-scoped surface texture view 的 presentation submission
- 不带 surface -> compute 或 offscreen submission

`.submit()` 返回 `SubmittedWork`，这是带 `done` promise 的可 inspect 句柄，底层是 `queue.onSubmittedWorkDone`。完成等待与数据传输是两件事: await `submitted.done` 只说明已提交 GPU 工作完成了，不会自动把数据搬到 CPU，也不会自动从 CPU 搬到 GPU。

```ts
const submitted = scratch.submission()  // no surface -> compute submission
    .compute(simulationPass, [simulate])
    .submit()

await submitted.done                    // GPU completion, not host readback
```

因此 `Submission` 是唯一核心提交概念。scratch core model 中不额外引入 `Frame` 或 `Batch` 类型。

## Epoch 模型

每个 resource 应暴露或内部追踪:

- runtime owner
- logical id
- descriptor shape
- 当前 physical GPU object
- `allocationVersion`
- `contentEpoch`
- readiness state
- last writer 或 producer submission
- pending transfer operations
- disposal state

`allocationVersion` 在 physical binding target 改变时递增:

- buffer 或 texture replacement
- resize
- device-loss rehydration
- 改变 GPU object 或 view compatibility 的 descriptor 变化

`allocationVersion` 是 `BindSet`、view cache、render attachment 和 command cache 在复用前比较的对象。单纯内容写入不应触发 bind group 重建，除非它也改变了物理 binding target。

`contentEpoch` 在 bytes 或 texels 变化时递增:

- `UploadCommand`
- `CopyCommand` 的目标写入
- `DrawCommand` 的 render attachment 写入
- `DispatchCommand` 的 storage buffer 或 storage texture 写入
- render pass clear、resolve、store 操作
- 如果未来进入 API，显式 clear、resolve、mipmap generation command 也属于内容写入

`contentEpoch` 可以先按整个 resource 追踪，之后在有价值时细化到 buffer range 或 texture region。关键契约是: readback 与 dependency validation 讨论 content epoch; binding invalidation 讨论 allocation version。

## Upload

CPU-to-GPU 写入是显式 transfer command:

```ts
const uploadPositions = scratch.command.upload({
    label: 'upload positions',
    target: positions,
    data: positionsArray,
    range: { offset: 0 },
})

scratch.submission()
    .upload(uploadPositions)
    .submit()
```

核心层没有 `positions.write(...)` 方法。未来可以在核心之上添加 convenience helper，但它必须降低为显式 upload operation，并暴露 target、range、readiness 和 epoch effects。

Upload 会推进目标写入范围的 `contentEpoch`，并记录 producing submission。如果 upload 分配路径需要替换物理 GPU 对象，则还会推进 `allocationVersion`。

## Readback

GPU-to-CPU 读取创建显式 `ReadbackOperation`:

```ts
const submitted = scratch.submission()
    .compute(simulationPass, [simulate])
    .submit()

const readback = scratch.readback({
    source: particles.segment('positions'),
    after: submitted,
})

const values = await readback.toArray()
```

`toArray()` 与 `toBytes()` 属于 readback operation，不属于 `BufferResource` 或 `TextureResource`。该 operation 捕获 source resource、range 或 region、layout view、producer submission，以及 source `contentEpoch`。

性质:

- **显式等待点。** Host access 是 transfer result 上的 `await`，绝不是藏在 resource getter 里的透明 stall。
- **Epoch 捕获。** readback 读取 readback request 或声明的 `after` submission 捕获的 content epoch。它不能静默漂移到 resource 的最新内容。
- **自动 staging。** runtime 持有 `MAP_READ` staging resources。常见 readback 下用户 buffer 不需要 map usage，但 source 需要合适的 copy usage 或显式 resolve 路径。
- **由 layout 派生视图。** `02-resources` 的 buffer layout 决定结果是 `TypedArray`、bytes，还是 layout-derived structured view。AoS 字段是 strided 的，除非显式 deinterleave，否则不承诺为一个连续 typed array。

## Readback Operation 生命周期

runtime 应追踪 `ReadbackOperation` 对象，而不是追踪某个 JavaScript `Promise` 是否被 await。Promise 消费在 JavaScript 中不是可靠契约: promise 可以被传到别处、被包装、通过 `.then()` 观察，或被保留但不 await。runtime-owned operation 才是可观察、可诊断的对象。

目标 operation 状态:

```ts
type ReadbackState =
    | 'requested'
    | 'scheduled'
    | 'submitted'
    | 'mapping'
    | 'ready'
    | 'consumed'
    | 'cancelled'
    | 'failed'
    | 'disposed'
```

状态语义:

- `requested` -> 已捕获 source、range 或 region、layout view 与 content epoch。
- `scheduled` -> 已选择 copy、resolve 或 map 路径。
- `submitted` -> GPU work 已在飞行中。它可能无法撤回，但结果仍可标记为不再需要。
- `mapping` -> staging copy 已存在，正在等待 `mapAsync` 或等价 host 可用性。
- `ready` -> CPU 可读结果已存在，但尚未消费或显式 retain。
- `consumed` -> `toArray()` 或 `toBytes()` 已返回 owned copy，runtime staging 可释放。
- `cancelled` -> 调用方声明不再需要结果。已提交的 GPU work 仍可能完成，但 runtime 应丢弃结果并释放 staging。
- `failed` -> device loss、copy 前 source disposal、map failure、validation error 或 budget failure 导致无法得到可用结果。
- `disposed` -> user-facing operation 已关闭。runtime 可以保留内部 cleanup record，直到 in-flight GPU work 和 staging release 结束。之后再读取会以 diagnostic error 失败。

默认 host-copy 读取采用 **consume-on-read**:

```ts
const result = await readback.toArray()  // returns an owned copy
// operation transitions to consumed; staging can be freed
```

如果需要重复读取，调用方应显式选择 retention:

```ts
const readback = scratch.readback({
    source: particles.segment('positions'),
    after: submitted,
    retain: 'until-dispose',
})
```

Zero-copy 或 mapped view 必须以 lease 表达，因为 mapped range 在 unmap 后失效:

```ts
const lease = await readback.map()
try {
    const view = lease.view
    // inspect the mapped data
} finally {
    lease.dispose()
}
```

只有 lease 暴露 mapped view。operation 追踪 active leases; 如果 lease 在 operation 或 runtime dispose 前没有释放，开发期 validation 应告警。

`cancel()` 与 `dispose()` 是显式操作:

```ts
readback.cancel('no longer visible')
readback.dispose()
```

`cancel()` 表示结果不再需要。`dispose()` 释放本地 operation 所有权; 若 operation 仍在飞行中，它等价于 cancel 加 user-facing detachment，同时 runtime 保留足够内部状态以便稍后释放 staging。dispose 后，`toArray()`、`toBytes()` 与 `map()` 都应以结构化 diagnostic reject。

少数情况下，如果 copy 或 resolve 点必须放进 command graph 的特定位置，使用 `ReadbackCommand`:

```ts
const readParticles = scratch.command.readback({
    label: 'read particle positions',
    source: particles.segment('positions'),
})

const submitted = scratch.submission()
    .compute(simulationPass, [simulate])
    .readback(readParticles)
    .submit()

const values = await readParticles.result({ after: submitted }).toArray()
```

`ReadbackCommand` 是 ordered-staging 逃生口，不是默认 readback 路径，并且它最终仍产生显式 `ReadbackOperation`。

## Copy

GPU-to-GPU copy 是显式 command:

```ts
const copyHistory = scratch.command.copy({
    label: 'copy color to history',
    source: sceneColor,
    target: historyColor,
    region: sceneRegion,
})
```

Copy 读取 source `contentEpoch`，并推进 target `contentEpoch`。如果 copy target 需要新的物理资源，则 allocation replacement 通过独立的 `allocationVersion` 表达。

## 渲染资源

同一模型覆盖图形资源:

- render pass attachment 是声明式写入。它的 store、clear、resolve 行为会推进 attachment resource 的 `contentEpoch`。
- 后续 pass 采样该 texture 时，声明读取已产生的 `contentEpoch`。
- depth 与 stencil attachment 使用同一规则。load/store policy 与 read-as-texture 用法必须足够显式，供 dependency validation 判断。
- surface current texture 是借来的 presentation-submission-scoped target，不是持久 `TextureResource`。它不能在获取它的 presentation submission 之外保留。
- render target resize 会推进 `allocationVersion`，并使依赖旧物理对象的 cached views、bind sets、pass attachments 与 commands 失效。
- TAA history、trails、迭代仿真纹理这类 temporal resources 都是普通资源; 它们的 previous-frame contents 由 content epochs 表达，而不是内核里的特殊一等特性。

## Timing 与 Query

GPU timing 复用同一套 transfer 模型:

- `QuerySetResource` 是 timestamp 或 occlusion query 的资源种类，按需 feature-gated。
- `timestampWrites` 附着在 pass specs 上。
- Query 结果通过显式 copy/resolve 写入 buffer，再由 `ReadbackOperation` 读取。

Pipeline statistics 不是当前 WebGPU core contract 的一部分，除非未来目标明确支持，否则不进入核心设计。

## Retention、预算与诊断

Readback retention 是 runtime policy，不是隐藏 garbage collection。默认策略应保守:

- operation 保留到 consumed、cancelled、disposed 或 failed
- pending operation 过旧时在开发期告警
- ready operation 长时间未消费时在开发期告警
- staging budget 超限时 fail fast 或发出高严重度诊断
- 除非 operation 显式声明 evictable，否则绝不静默淘汰 readback result

配置形状示例:

```ts
const runtime = await ScratchRuntime.create({
    readback: {
        staleAfterSubmissions: 3,
        staleAfterMs: 250,
        maxPendingOperations: 16,
        maxStagingBytes: 64 * 1024 * 1024,
        onBudgetExceeded: 'throw',
    },
})
```

候选 diagnostic codes:

```ts
type ReadbackDiagnosticCode =
    | 'SCRATCH_READBACK_STALE_PENDING'
    | 'SCRATCH_READBACK_READY_UNCONSUMED'
    | 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED'
    | 'SCRATCH_READBACK_CANCELLED'
    | 'SCRATCH_READBACK_SOURCE_DISPOSED_BEFORE_COPY'
    | 'SCRATCH_READBACK_RUNTIME_DISPOSED'
    | 'SCRATCH_READBACK_LEASE_NOT_RELEASED'
```

每条 readback diagnostic 都应携带足够上下文，使 agent 或人无需解析 prose 也能修复问题:

```ts
type ReadbackDiagnostic = {
    code: ReadbackDiagnosticCode
    severity: 'info' | 'warn' | 'error'
    operationId: string
    label?: string
    state: ReadbackState
    sourceResourceId: string
    allocationVersion: number
    contentEpoch: number
    rangeOrRegion?: unknown
    producerSubmissionId?: string
    ageInSubmissions?: number
    ageInMs?: number
    stagingBytes?: number
    hint?: string
}
```

通用 validation diagnostics 是更大的设计议题，但 readback-specific diagnostics 应从一开始就遵循这种 machine-readable pattern。

## 非目标

- 不暴露核心 `resource.toArray()` 或 `resource.toBytes()` 糖。
- 不暴露核心 `resource.write()` 糖。
- 不隐藏 upload、readback 或 copy submission。
- 不让 `ReadbackCommand` 成为默认路径。
- 不把自动 render-graph sorting 放进核心 scheduler。
- 不把 ping-pong、history buffer、readback ring 等常见模式做成内核一等特性。
