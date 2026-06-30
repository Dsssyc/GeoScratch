# 传输与 Epoch

状态: Vision draft
日期: 2026-06-30

## 决策

`Frame` 仍是 presentation 可选的提交单元。CPU/GPU 数据移动不是 `Resource` 方法; 它应表达为显式 transfer operation 与 command。

`Resource` 是逻辑身份加状态，不是 host transfer 句柄。upload、readback、copy、render 写入和 compute 写入都进入同一套 epoch 模型，使 runtime 能校验读取的是哪份内容、绑定的是哪个物理 GPU 对象。

这取代早先的"资源即 readback 句柄"模型。它解决异步 readback、提交单元、GPU 计时/查询缺口，同时不把 `buffer.toArray()` 或 `buffer.write()` 纳入核心资源契约。

## Frame 是提交单元

`Frame` 记录 passes 与 commands 并提交。Presentation 只是其中一种模式，而不是它的定义:

- 带 surface 输出 -> 使用 frame-scoped surface texture view 的 presentation frame
- 不带 surface -> compute 或 offscreen submission

`submit()` 可 await 以等待 GPU 完成，底层是 `queue.onSubmittedWorkDone`。完成等待与数据传输是两件事: await `submit()` 只说明已提交 GPU 工作完成了，不会自动把数据搬到 CPU，也不会自动从 CPU 搬到 GPU。

```ts
const submitted = scratch.frame()       // no surface -> compute submission
    .compute(simulationPass, [simulate])
    .submit()

await submitted                         // GPU completion, not host readback
```

因此 `Frame` 是唯一提交概念。核心模型中不额外引入 `Submission` 或 `Batch` 类型。

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

scratch.frame()
    .upload(uploadPositions)
    .submit()
```

核心层没有 `positions.write(...)` 方法。未来可以在核心之上添加 convenience helper，但它必须降低为显式 upload operation，并暴露 target、range、readiness 和 epoch effects。

Upload 会推进目标写入范围的 `contentEpoch`，并记录 producing submission。如果 upload 分配路径需要替换物理 GPU 对象，则还会推进 `allocationVersion`。

## Readback

GPU-to-CPU 读取创建显式 `ReadbackOperation`:

```ts
const submitted = scratch.frame()
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

少数情况下，如果 copy 或 resolve 点必须放进 command graph 的特定位置，使用 `ReadbackCommand`:

```ts
const readParticles = scratch.command.readback({
    label: 'read particle positions',
    source: particles.segment('positions'),
})

const submitted = scratch.frame()
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
- surface current texture 是借来的 frame-scoped target，不是持久 `TextureResource`。它不能在获取它的 frame 之外保留。
- render target resize 会推进 `allocationVersion`，并使依赖旧物理对象的 cached views、bind sets、pass attachments 与 commands 失效。
- TAA history、trails、迭代仿真纹理这类 temporal resources 都是普通资源; 它们的 previous-frame contents 由 content epochs 表达，而不是内核里的特殊一等特性。

## Timing 与 Query

GPU timing 复用同一套 transfer 模型:

- `QuerySetResource` 是 timestamp 或 occlusion query 的资源种类，按需 feature-gated。
- `timestampWrites` 附着在 pass specs 上。
- Query 结果通过显式 copy/resolve 写入 buffer，再由 `ReadbackOperation` 读取。

Pipeline statistics 不是当前 WebGPU core contract 的一部分，除非未来目标明确支持，否则不进入核心设计。

## 生命周期与诊断

- runtime-owned staging resources 在 `ReadbackOperation` resolve、cancel 或 dispose 时释放。
- 被请求但未 resolve 的 readback 是 runtime-owned pending operation，不是不可观察的 Promise leak。开发期 validation 可以对 stale pending readbacks 告警。
- 诊断应包含 resource id、allocation version、content epoch、range 或 region、producer submission，以及创建 pending transfer 的 operation。

## 非目标

- 不暴露核心 `resource.toArray()` 或 `resource.toBytes()` 糖。
- 不暴露核心 `resource.write()` 糖。
- 不隐藏 upload、readback 或 copy submission。
- 不让 `ReadbackCommand` 成为默认路径。
- 不把自动 render-graph sorting 放进核心 scheduler。
- 不把 ping-pong、history buffer、readback ring 等常见模式做成内核一等特性。
