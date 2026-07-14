# Runtime 与 Surface

状态: Vision draft
日期: 2026-07-12

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
- pipeline 与 acknowledged supporting-object registries；每个 BindSet 私有拥有自己的 prepared bind group
- submission scheduler 默认配置
- device-loss 状态
- 当前 GPU operation facts 与有界 diagnostic evidence
- 当前 readback command/operation ownership 与有限 staging budgets

`Surface` 拥有:

- `GPUCanvasContext`
- canvas 或 `OffscreenCanvas`
- 完整 presentation configuration：format、usage、view formats、color space、
  optional tone mapping 与 alpha mode
- 当前 presentation texture 访问
- resize policy

## 所有权规则

- 一个 resource 只属于一个 `ScratchRuntime`。
- runtime 的 `GPU`、adapter、device、queue 与 feature/limit snapshot 在创建后
  都是不可变 ownership fact；应用代码不能在 diagnostics 或 allocation
  底层替换 native device。
- runtime disposal 与 device-loss 属性是 runtime-owned lifecycle transition
  的只读观察值。
- 一个 `GPUCanvasContext` 同一时间只由一个 live `Surface` claim，因此也只由
  一个 `ScratchRuntime` 配置。
- 一个 runtime 的资源不能被另一个 runtime 记录的 command 使用。
- surface current texture 是 presentation-submission-scoped，不允许作为持久 resource 保存。
- dispose surface 不会 dispose runtime。
- dispose runtime 会使其 resources、surfaces、pipelines、bind sets、commands 全部失效。

## Canvas Context 独占 Ownership

创建 `Surface` 时，会先 claim 对应 `GPUCanvasContext`，之后才允许改变 canvas
尺寸或调用 `GPUCanvasContext.configure()`。无论来自同一个 runtime 还是另一个
runtime，同一 context 上的第二个 live `Surface` 都会收到
`SCRATCH_SURFACE_CONTEXT_IN_USE`。Diagnostic 同时标识 attempted Surface 与当前
owner；拒绝过程不产生 canvas、configure 或 runtime registry 副作用。后续每个
Surface operation 都会重新核对 receiver 是否为精确 owner；forged 或 stale alias
会在 lifecycle 或 presentation effect 前收到
`SCRATCH_SURFACE_CONTEXT_NOT_OWNED`。

Surface 的 ownership、configuration 与 lifecycle 字段都是只读 observation。
精确 receiver 对应的单个 module-private state record 是权威事实，其中也包含
terminal disposal。未类型化 JavaScript 的字段改写不能转移 claim、发布 candidate
configuration、伪造 live owner 可替换状态或阻止 cleanup；`dispose()` 始终会清理
最初 claim 的 context，并从最初的 runtime unregister。

`Surface.configure()` 是覆盖 format、usage、view formats、color space、optional
tone mapping、alpha mode 与 size 的同步 candidate transaction。Iterable 与
dictionary input 会在 native issue 前完成 materialize。Canvas resize 与 native
configure 返回后，Scratch 要求 `GPUCanvasContext.getConfiguration()` 及 canvas
尺寸都反映 candidate，之后才 commit 私有状态。失败会产生
`SCRATCH_SURFACE_CONFIGURATION_FAILED`，尽可能恢复调用前的真实 canvas 尺寸与
previous native configuration，验证恢复结果，并且绝不发布 candidate facts。
异步 native validation 仍遵循 WebGPU error model，Scratch 不会虚构同步成功或失败。

每次 managed use 前，Scratch 都会调用
`GPUCanvasContext.getConfiguration()`，把其中的 device、format、usage、view
formats、color space、tone mapping、alpha mode 与 current canvas size 同私有
committed facts 比较。直接 native configure/unconfigure 或 canvas-size drift 因此
会在 current-texture/encoder effect 前产生
`SCRATCH_SURFACE_CONFIGURATION_STALE`。应用可显式调用 `surface.configure()` 或
`surface.resize()` 修复 owned configuration；submission 绝不隐式修复。

`Surface.dispose()` 会 unconfigure context 并释放 claim。只有完成这次显式
lifecycle transition 后，replacement Surface 才能重新 claim。构造过程若在
claim 后失败，也会释放尚未 commit 的 claim。即使不符合规范的 native
`unconfigure()` 抛错，logical disposal、runtime unregister 与 claim release 仍会
完成，之后再报告结构化 `SCRATCH_SURFACE_UNCONFIGURE_FAILED`。Runtime disposal
会保留该 failure，继续完成其余 owned cleanup 与 device destruction，最后重新
抛出第一个 retained failure。Scratch 不维护带隐式共享配置的多个 wrapper。

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

## 异步 Supporting-Object Ownership

持久 SamplerResource、QuerySetResource、BindLayout 与 BindSet factory 同样是
Promise-only runtime transaction:

```ts
const sampler = await runtime.createSampler(samplerDescriptor)
const querySet = await runtime.createQuerySet(queryDescriptor)
const layout = await runtime.createBindLayout(layoutDescriptor)
const set = await runtime.createBindSet(layout, bindings)
```

每个 candidate 只在 native issue、scope acknowledgement 与 lifecycle recheck
成功后注册。Constructor 与同步 bypass 均关闭。BindSet 创建还会完成 generation-one
preparation；后续 allocation replacement 会让它 stale，并要求显式
`await set.prepare()`。Submission 保持同步，绝不执行、等待或重试该工作。

## Readback Ownership 与 Budgets

Readback ownership 属于 runtime，不属于全局 queue helper 或 resource
convenience method。Runtime 创建只接受已经实现的有限 policy:

```ts
const runtime = await ScratchRuntime.create({
    readback: {
        maxPendingOperations: 16,
        maxStagingBytes: 64 * 1024 * 1024,
    },
})
```

`runtime.readbackPolicy` 是冻结的 normalized snapshot。runtime fact graph
报告当前 readback commands、active 或 retained operations、current/peak
staging bytes、current/peak retained host bytes 与 active mappings。这些是
current ownership facts，不随 runtime 年龄增长。GPU staging bytes 是
Scratch logical allocation facts，不是 physical residency 或 free-VRAM
measurement；retained host bytes 单独计数。

创建 direct `ReadbackOperation` 保持同步，因为此时不分配资源。第一次
materialization 会先预留 budget 并确认一个 ephemeral staging buffer，之后
才允许 encoder 或 queue 使用它。Ordered factory 只能返回 Promise，因为
可复用 staging slot 必须在 `ReadbackCommand` 可见前完成确认:

```ts
const command = await runtime.createReadbackCommand(descriptor)
const alias = await runtime.readbackCommand(descriptor)
```

不存在同步 ordered factory、pending wrapper、submit-time lazy allocation、
隐藏 retry 或 public native staging handle。`SubmissionBuilder.submit()` 保持
同步，并且不等待 mapping 或 host-copy 完成。

## Submission Native Observation Ownership 与 Budgets

Submission native observation 是 runtime-owned diagnostics policy。Runtime
创建暴露完整 persistent policy surface:

```ts
const runtime = await ScratchRuntime.create({
    diagnostics: {
        submissionScopes: 'summary',
        maxPendingNativeObservations: 64,
    },
})
```

`summary` 是默认值。每个 effectful submission 或 direct readback 只预留一个
native-observation owner，并用一个常数规模的 validation、internal 与
out-of-memory scope bundle 包围完整 native issue family。scope 数量不随
pass、command、encoder segment 或 queue action 数量增长。`off` 不打开这些
scope，并报告显式 `unobserved` provenance；它不会把 queue completion 解释成
native validation acknowledgement。Effect-free submission 不预留 owner，并
报告 `no-native-work`。

`maxPendingNativeObservations` 是 unsettled submission 与 direct-readback
observation 共享的有限上限。budget 耗尽会在 encoder 或 queue effect 前失败，
而不是静默降级到 `off`。always-current fact graph 暴露
`submissionScopes`、`maxPendingNativeObservations`、
`currentPendingNativeObservations`、`peakPendingNativeObservations` 与
`currentEffectfulSubmittedWork`。这些事实随 unsettled ownership 变化，不随
runtime 年龄增长；有界 operation/incident history 是另一项 retention concern。

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
