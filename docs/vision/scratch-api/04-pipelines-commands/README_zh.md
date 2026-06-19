# Pipelines 与 Commands

状态: Vision draft
日期: 2026-06-20

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

- per-frame command counts
- resource readiness policy
- pass membership
- 具体 bind set resource versions

## Command

统一使用 `Command` 作为名称，因为它最接近 GPU command buffer 模型。

目标 command 家族:

- `DrawCommand`
- `DispatchCommand`
- `CopyCommand`
- `UploadCommand`
- 未来必要时加入显式 clear 或 resolve command

每个 command 应声明:

- label
- pipeline 或 raw encoder action
- bind sets
- read resources
- written resources
- readiness policy
- 适用时的 static、dynamic 或 indirect count

## DrawCommand

Draw count 应支持静态值、动态 resolver、indirect buffer。

```ts
type DrawCount =
    | { vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number }
    | { indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number }
    | { indirect: BufferResource, offset?: number }
    | ((frame: FrameContext) => DrawCount)
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
    | ((frame: FrameContext) => DispatchCount)
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
