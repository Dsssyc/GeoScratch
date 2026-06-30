# Pipelines 与 Commands

状态: Vision draft
日期: 2026-06-30

## 决策

`Pipeline` 描述稳定 GPU 程序状态。`Command` 描述一个可执行 GPU 动作。

这会替代旧模式中 binding、range、executable flags、pipeline、pass membership 混在一起的做法。

## Pipelines

Render pipeline 拥有稳定状态:

- shader stages 与 entry points
- bind layouts
- vertex buffer layouts
- primitive state
- depth 与 stencil state
- color target compatibility
- multisample state
- pipeline cache key

Compute pipeline 拥有:

- shader stage 与 entry point
- bind layouts
- constants
- pipeline cache key

Pipeline 不拥有:

- per-submission command counts
- resource readiness policy
- pass membership
- 具体 bind set resource allocation versions

## Command

统一使用 `Command` 作为名称，因为它最接近 GPU command buffer 模型。

目标 command 家族:

- `DrawCommand`
- `DispatchCommand`
- `CopyCommand`
- `UploadCommand`
- `ReadbackCommand` 作为显式 ordered-staging 逃生口，并产生 `ReadbackOperation`
- 未来必要时加入显式 clear 或 resolve command

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

## DrawCommand

Draw count 应支持静态值、动态 resolver、indirect buffer。

```ts
type DrawCount =
    | { vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number }
    | { indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number }
    | { indirect: BufferResource, offset?: number }
    | ((context: FrameContext) => DrawCount)
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
    count: frame => ({
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
    | ((context: FrameContext) => DispatchCount)
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

## Count 分流

draw 与 dispatch count 分三种情况; 按 count 实际依赖什么来选:

- 静态、record 时即可得 → 用字面量形式(`{ vertexCount: 3 }`、`{ workgroups: [64, 64, 1] }`)。不要把常量包进闭包。
- CPU 动态——只有在 CPU 侧工作(如剔除)之后才知道 → resolver 闭包正当，或从一个被追踪的句柄读取 count(见 `02-resources` 动态值)。值若已在某个句柄里，优先用句柄。
- GPU 动态——由 GPU 产生(例如 compute 写出 draw 或 dispatch arguments)→ 优先 `indirect`。它无需回读、全声明式、对 validation 可见。

可验证性阶梯，优先靠上: indirect buffer > 被追踪的句柄 > 闭包。

`FrameContext` 是当前 submission 的上下文。命名跟随 `Frame` builder，但不表示一定存在 presentation surface。

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
- 不把 command membership 存在 pass spec 中。
- 不在 command 中编码 terrain、flow、tile 或 layer 概念。
