# Passes, Frames 与 Scheduler

状态: Vision draft
日期: 2026-06-20

## 决策

使用持久 `PassSpec` 表达稳定 pass 形状。使用 `Frame` 把 pass specs 与当前帧 command 列表绑定。

第一版 scheduler 采用显式 frame 顺序加依赖校验。自动排序或 render-graph scheduling 后续可以作为上层编排模式构建。

## PassSpec

`PassSpec` 描述稳定 encoder 边界和 attachment 形状。

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
})
```

Compute pass spec 示例:

```ts
const simulationPass = scratch.pass.compute({
    label: 'simulation',
})
```

Pass spec 不存储 command。这能避免上一帧残留 command list 存活到下一帧。

## Frame

`Frame` 是当前帧 builder 和提交单位:

```ts
scratch.frame({ validation: 'throw' })
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
```

Frame 职责:

- 按用户顺序收集 pass-command pairs
- 校验 runtime ownership
- 校验 pass 与 command compatibility
- 校验 resource read/write order
- prepare dirty resources
- 解析 command readiness policies
- 跳过 empty passes
- 记录 GPU commands
- 提交 command buffers

## Dependency Validation

核心 scheduler 不自动排序 commands。它校验显式顺序。

检查示例:

- command 使用了其他 runtime 的 resource
- command 使用了 disposed 或 lost resource
- command 在 frame prepare 或写入前读取资源
- 同一 pass 未显式允许时同时读写同一 resource
- surface current texture view 在所属 frame 外使用
- render command 被插入 compute pass
- dispatch command 被插入 render pass
- dispatch 的 workgroup 数超过 `maxComputeWorkgroupsPerDimension`
- 绑定的 storage buffer 范围超过 device storage-binding 限制

Validation modes:

```ts
type FrameValidationMode = 'off' | 'warn' | 'throw'
```

开发期应优先使用 `throw`。生产或性能 profiling 可选择 `warn` 或 `off`。

## Readiness Policy 的关系

Dependency validation 与 resource readiness policy 是两件事。

- Validation 检查 frame 顺序与 ownership 是否自洽。
- `whenMissing` 检查所需资源未 ready 时如何处理。

即使启用了 validation，command 仍需要显式 readiness policy。

## 未来上层编排

自动排序不进入第一版核心 scheduler。未来上层可提供:

```ts
scratch.schedule(commands, {
    strategy: 'topological',
}).into(frame)
```

该层可以基于 command read/write 声明构建，不需要改变核心 frame 模型。

## 非目标

- 不把 pass spec 做成当前帧 commands 的可变容器。
- 不把自动 render graph 排序作为默认 core 行为。
- 不向需要 WebGPU 级控制的用户隐藏 frame order。
- 不在 scratch scheduler 中编码 geospatial layer order。
