# Runtime 与 Surface

状态: Vision draft
日期: 2026-06-30

## 决策

核心 API 使用显式异步 `ScratchRuntime`。Runtime 不绑定 canvas。呈现目标由独立 `Surface` 对象建模。

这符合 WebGPU 生命周期:

```text
GPUAdapter -> GPUDevice -> resources / queues / commands
canvas -> GPUCanvasContext -> configured presentation surface
```

与 WebGL 不同，GPU 执行上下文不是 canvas context。多 canvas、compute-only、offscreen、worker 工作流都要求这种分离。

## 目标形状

```ts
const scratch = await ScratchRuntime.create({
    powerPreference: 'high-performance',
    requiredFeatures: [],
    requiredLimits: {},
})

const surface = scratch.surface(canvas, {
    format: 'preferred',
    alphaMode: 'premultiplied',
})
```

`ScratchRuntime` 拥有:

- `GPUDevice`
- `GPUQueue`
- device limits 和 features
- resource registry
- pipeline 与 bind group caches
- submission scheduler 默认配置
- device-loss 状态
- 当前 GPU operation facts 与有界 diagnostic evidence

`Surface` 拥有:

- `GPUCanvasContext`
- canvas 或 `OffscreenCanvas`
- presentation format
- alpha mode 与 configure options
- 当前 presentation texture 访问
- resize policy

## 所有权规则

- 一个 resource 只属于一个 `ScratchRuntime`。
- runtime 的 `GPU`、adapter、device、queue 与 feature/limit snapshot 在创建后
  都是不可变 ownership fact；应用代码不能在 diagnostics 或 allocation
  底层替换 native device。
- runtime disposal 与 device-loss 属性是 runtime-owned lifecycle transition
  的只读观察值。
- 一个 surface 同一时间只由一个 `ScratchRuntime` 配置。
- 一个 runtime 的资源不能被另一个 runtime 记录的 command 使用。
- surface current texture 是 presentation-submission-scoped，不允许作为持久 resource 保存。
- dispose surface 不会 dispose runtime。
- dispose runtime 会使其 resources、surfaces、pipelines、bind sets、commands 全部失效。

## Surface 不是 TextureResource

Surface 可以产生当前 presentation texture view，但不应继承或伪装成 `TextureResource`。

原因:

- swapchain texture 是逐 presentation submission 借用的
- 它不是长期逻辑资源
- 它的生命周期由浏览器呈现系统控制
- 如果像普通 texture 一样缓存，会污染 allocation/content epoch 语义

应使用 presentation-submission-scoped borrowed handle:

```ts
submission.render(outputPass, [compositeTo(surface.currentView(submission))])
```

最终语法可以变化，但语义边界不应变化。

这里的 `Submission` 指 `05` / `07` 定义的核心 submission builder。compute-only submission 没有 surface current texture; 只有 presentation submission 能借用 surface current texture view。

## 显式协调 Surface 与 Resource Resize

`Surface` 与持久 `TextureResource` allocation 分属不同 ownership。应用若希望 offscreen texture 跟随 surface，需要显式协调两次 lifecycle operation:

```ts
surface.resize(nextSize)
await target.resize(surface.size)
```

`TextureResource.resize()` 是返回 Promise 的 allocation transaction。原 allocation 在原生 validation 与 out-of-memory scope settle 期间保持 current。size 成功变化时，`allocationVersion` 递增，`contentEpoch` 保持不变，replacement allocation 保持 empty，直到后续 content-producing operation 写入。这不是 surface 的职责，也不会增加 submission 或 queue work。

Core 不安装 `ResizeObserver`，不轮询 canvas dimensions，不注册隐藏 surface subscription，不扫描 runtime textures，也不推断哪个 resource 跟随哪个 surface。未来 tracked 或 derived dimensions 可以调用同一个显式 resize primitive，但不能建立第二条 allocation-replacement 路径。

## 异步 Pipeline Ownership

Render 与 compute pipeline factory 是 runtime-owned asynchronous
transaction:

```ts
const renderPipeline = await runtime.createRenderPipeline(renderDescriptor)
const computePipeline = await runtime.createComputePipeline(computeDescriptor)
```

runtime 不发布 pending pipeline wrapper。shader-module 与 pipeline-layout
scope、compilation information 以及原生 async pipeline Promise settle 期间，
它只保留一个有界 pending fact。commit 前会重新检查 runtime、device、
Program 与每个 BindLayout。dispose 或 device loss 会取消 transaction，且不
安装 current pipeline fact。current pipeline facts 的规模随 live pipelines
变化；历史 operation 留在有界 recorder 中。Pipeline 创建不会给
`SubmissionBuilder.submit()` 增加工作或等待。

## Device Loss

`ScratchRuntime` 拥有 device-loss 处理。Device loss 后:

- 物理 GPU 对象全部失效
- 逻辑资源可以保留为可重建描述
- caches 必须丢弃
- surfaces 必须基于替换 device 重新 configure
- 如果依赖可重建，commands 与 pass specs 可以作为逻辑描述保留

Device loss 会产生一个有界 runtime incident，其中包含 pending-operation 与 current-resource 上下文。临近 operation 只是时间相关证据，不是因果证明。listener 与每个 covered allocation 始终绑定同一个不可替换的 runtime-owned device。runtime 不会自动重试 allocation、重建设备、rehydrate resource 或 replay submission。

第一版实现可以选择保守失败模式，但 API 不应让后续 rehydration 无法实现。

## 非目标

- 不把全局 device 作为核心契约。
- 不把 runtime 创建绑定到 canvas 创建。
- 不在 core 中提供 React、Vue、Svelte 或其他框架生命周期 helper。
- 不让 `Surface` 负责资源缓存或调度。
