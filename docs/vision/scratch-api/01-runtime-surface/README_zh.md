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

`Surface` 拥有:

- `GPUCanvasContext`
- canvas 或 `OffscreenCanvas`
- presentation format
- alpha mode 与 configure options
- 当前 presentation texture 访问
- resize policy

## 所有权规则

- 一个 resource 只属于一个 `ScratchRuntime`。
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
target.resize(surface.size)
```

`TextureResource.resize()` 会在同一个逻辑 texture 后方替换物理 allocation。size 发生变化时，`allocationVersion` 递增，`contentEpoch` 保持不变，replacement allocation 保持 empty，直到后续 content-producing operation 写入。这不是 surface 的职责，也不会增加 submission 或 queue work。

Core 不安装 `ResizeObserver`，不轮询 canvas dimensions，不注册隐藏 surface subscription，不扫描 runtime textures，也不推断哪个 resource 跟随哪个 surface。未来 tracked 或 derived dimensions 可以调用同一个显式 resize primitive，但不能建立第二条 allocation-replacement 路径。

## Device Loss

`ScratchRuntime` 拥有 device-loss 处理。Device loss 后:

- 物理 GPU 对象全部失效
- 逻辑资源可以保留为可重建描述
- caches 必须丢弃
- surfaces 必须基于替换 device 重新 configure
- 如果依赖可重建，commands 与 pass specs 可以作为逻辑描述保留

第一版实现可以选择保守失败模式，但 API 不应让后续 rehydration 无法实现。

## 非目标

- 不把全局 device 作为核心契约。
- 不把 runtime 创建绑定到 canvas 创建。
- 不在 core 中提供 React、Vue、Svelte 或其他框架生命周期 helper。
- 不让 `Surface` 负责资源缓存或调度。
