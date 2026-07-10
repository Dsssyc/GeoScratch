# Pipelines 与 Commands

状态: Vision draft
日期: 2026-07-06

## 决策

`Program` 描述 shader source contract。`Pipeline` 描述某个 `Program` entry point 的稳定 WebGPU 可执行状态。`Command` 描述一个可执行 GPU 动作。

这会替代旧模式中 shader code、binding、range、executable flags、pipeline、pass membership 混在一起的做法。

source-level `Program`、layout codec 与 shader composition 模型见 `08-programs-codecs`。本模块从可执行 pipeline 与 command 层开始。

## Pipelines

Render pipeline 拥有稳定状态:

- program 或 shader modules、shader stages 与 entry points
- bind layouts
- vertex buffer layouts
- primitive state
- depth 与 stencil state
- color target compatibility
- multisample state
- pipeline cache key

Compute pipeline 拥有:

- program 或 shader module、shader stage 与 entry point
- bind layouts
- constants
- pipeline cache key

Pipeline 不拥有:

- per-submission command counts
- resource readiness policy
- pass membership
- 具体 bind set resource allocation versions
- material 或 style 参数
- scene-object assignment

Pipeline 可以缓存编译好的 GPU state。它不能变成把具体资源、视觉语义和 shader code 打包在一起的 material-like object。

## Command

统一使用 `Command` 作为名称，因为它最接近 GPU command buffer 模型。

目标 command 家族:

- `DrawCommand`
- `DispatchCommand`
- `CopyCommand`
- `UploadCommand`
- `ResolveQuerySetCommand`
- `ReadbackCommand` 作为显式 ordered-staging 逃生口，并产生 `ReadbackOperation`
- `BeginOcclusionQueryCommand` / `EndOcclusionQueryCommand` 作为 render-pass-only query bracket
- 未来必要时加入显式 clear 或 attachment-resolve command

`CopyCommand` 覆盖 WebGPU 原生 GPU-side copy 方向: buffer-to-buffer、texture-to-texture、buffer-to-texture 与 texture-to-buffer。CPU upload 与 CPU readback 仍然是显式 transfer/readback operation，不能替代这些 command encoder copy。

第一版 `ReadbackCommand` 已为 buffer source 实现。它使用显式 source `contentEpoch`，通过 `SubmissionBuilder.readback(...)` 进入 submission 顺序，在该位置只 staging 一次，并通过 `result({ after })` 返回关联的 `ReadbackOperation`。直接 texture readback、mapped lease 与 staging budget policy 仍属于未来工作。

每个 command 应声明:

- label
- pipeline 或 raw encoder action
- bind sets
- read resources
- written resources
- written resources 的 content epoch effects
- readiness policy
- 适用时的 static、dynamic 或 indirect count

写入资源内容的 command 推进 `contentEpoch`。替换物理 GPU 对象的 command 推进 `allocationVersion`。两者分离，这样 compute 写入不会被误解为 bind group invalidation。

Pipeline 与 command validation findings 应使用 `09-diagnostics-validation` 中的共享 `ScratchDiagnostic` envelope。`Command` diagnostics 应以 command 自身作为 `subject`，并把相关 resources、pass specs、pipelines 或 bind sets 放进 `related`，而不是只写在 prose 里。

Query command 会写入 indexed `QuerySetResource` slots。resolve query set 会把字节写入 destination buffer，并推进该 buffer 的 `contentEpoch`; 它不会让数据自动 CPU-visible，CPU 访问仍需创建或消费 `ReadbackOperation`。

## DrawCommand

Draw count 应支持静态值、动态 resolver、indirect buffer。

```ts
type DrawCount =
    | { vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number }
    | { indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number }
    | { indirect: BufferResource, offset?: number }
    | ((context: SubmissionContext) => DrawCount)
```

静态值是默认路径:

```ts
const drawTriangle = scratch.command.draw({
    label: 'draw triangle',
    pipeline,
    bindSets: [],
    count: { vertexCount: 3 },
    resources: {
        read: [],
        write: [surfaceColor],
    },
    whenMissing: 'throw',
})
```

动态 resolver 只用于依赖场景状态的 count:

```ts
const drawTerrain = scratch.command.draw({
    label: 'draw terrain',
    pipeline: terrainPipeline,
    bindSets: [terrainSet],
    vertex: terrainVertex,
    index: terrainIndex,
    count: context => ({
        indexCount: terrain.visibleIndexCount,
        instanceCount: terrain.visibleTileCount,
    }),
    resources: {
        read: [demTexture, lodMap],
        write: [sceneColor, depth],
    },
    whenMissing: 'skip-command',
})
```

当 compute 产生 draw arguments 时，indirect count 是推荐的 GPU-driven 路径。

## DispatchCommand

Dispatch count 采用相同模型:

```ts
type DispatchCount =
    | { workgroups: [number, number?, number?] }
    | { indirect: BufferResource, offset?: number }
    | ((context: SubmissionContext) => DispatchCount)
```

示例:

```ts
const simulate = scratch.command.dispatch({
    label: 'simulate particles',
    pipeline: simulationPipeline,
    bindSets: [simulationSet],
    count: { workgroups: [64, 64, 1] },
    resources: {
        read: [flowTexture],
        write: [particleBuffer],
    },
    whenMissing: 'skip-command',
})
```

## Query Commands

Query command 暴露 WebGPU query 机制，但不发明平台并不提供的 profiling 抽象。

```ts
const resolveTiming = scratch.command.resolveQuerySet({
    label: 'resolve timing',
    source: {
        querySet: timingQueries,
        slots: [
            { index: 0, contentEpoch: 1 },
            { index: 1, contentEpoch: 1 },
        ],
    },
    destination: timingBuffer,
    destinationOffset: 0,
    whenMissing: 'throw',
})
```

`ResolveQuerySetCommand` 是 copy/resolve command。它的 source 是显式连续 indexed query slots，并声明每个 slot 需要的 content epoch；destination 必须是带有 query-resolve usage，以及该 workflow 后续所需 copy/readback usage 的 buffer。后续 CPU 访问仍然使用 `ReadbackOperation`。

Occlusion query bracket 是 render-pass-only 的 command-like encoder action:

```ts
scratch.command.beginOcclusionQuery({ querySet: visibilityQueries, index: tileIndex })
scratch.command.endOcclusionQuery()
```

它们要求 active render pass 拥有同一个 `occlusionQuerySet`，不能嵌套，并写入一个 indexed query slot。

## Count 分流

draw 与 dispatch count 分三种情况; 按 count 实际依赖什么来选:

- 静态、record 时即可得 → 用字面量形式(`{ vertexCount: 3 }`、`{ workgroups: [64, 64, 1] }`)。不要把常量包进闭包。
- CPU 动态——只有在 CPU 侧工作(如剔除)之后才知道 → resolver 闭包正当，或从一个被追踪的句柄读取 count(见 `02-resources` 动态值)。值若已在某个句柄里，优先用句柄。
- GPU 动态——由 GPU 产生(例如 compute 写出 draw 或 dispatch arguments)→ 优先 `indirect`。它无需回读、全声明式、对 validation 可见。

可验证性阶梯，优先靠上: indirect buffer > 被追踪的句柄 > 闭包。

`SubmissionContext` 是当前 submission 的上下文。它暴露 runtime state、submission diagnostics、受追踪动态值和 producer epochs，但不表示一定存在 presentation surface。

## Readiness Policy

每个 command 必须显式声明所需资源未 ready 时的行为:

```ts
type ResourceReadinessPolicy =
    | 'throw'
    | 'skip-command'
    | 'skip-pass'
    | 'use-fallback'
```

这能避免把流式数据缺失和接线错误混在一起。

## 非目标

- 不让 command count 默认就是闭包。
- 不把 indirect draw 或 dispatch 隐藏成特殊高层特性。
- 当 WebGPU 缺少对应 core query type 时，不把 pipeline statistics 暴露成核心 command family。
- 不把 command membership 存在 pass spec 中。
- 不在 command 中编码 terrain、flow、tile 或 layer 概念。
- 不引入 `Material` 作为 `Program` + `BindSet` + render semantics 的快捷组合。
- 不把 pipeline 或 command validation 暴露成 prose-only errors。
