# Pipelines 与 Commands

状态: Vision draft
日期: 2026-07-11

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

### ExternalImageUploadCommand

`ExternalImageUploadCommand` 表达原生 immediate queue operation `GPUQueue.copyExternalImageToTexture()`。它是 upload，而不是第五种 `CopyCommand` direction:

```ts
commandKind: 'upload'
uploadKind: 'external-image'
```

另外两种 upload variant 也显式区分为 `uploadKind: 'buffer'` 与 `uploadKind: 'texture'`。external-image descriptor 按身份保留 canonical `GPUCopyExternalImageSource`，并暴露 `sourceOrigin`、`flipY`、目标 texture `origin`、`mipLevel`、`colorSpace`、`premultipliedAlpha` 和显式 width/height。destination aspect 固定为 `all`，`depthOrArrayLayers` 固定为 `1`。

当前完整 source union 都可接受: `ImageBitmap`、`ImageData`、`HTMLImageElement`、`HTMLVideoElement`、`VideoFrame`、`HTMLCanvasElement` 与 `OffscreenCanvas`。跨 realm 的 platform getter brand check 会拒绝任意 record，而不依赖 realm-local `instanceof`。构造会锁定 command fields，但不要求 source 已加载。执行会重新校验 image、video、frame 与 data source 的准确公开 dimension fields。Canvas dimensions 也可能来自当前 WebGL drawing buffer 或 `ImageBitmapRenderingContext` internal output bitmap；canvas 没有无副作用的 context-mode query，因此 Scratch 把这项 context-specific source-range check 留给原生 content timeline，并把同步 `OperationError` 分类为 invalid input。

降低使用 canonical `GPUCopyExternalImageSourceInfo` 与 `GPUCopyExternalImageDestInfo`，并要求 command runtime 自己的 queue。pixels 在原生 queue method 调用时捕获。Scratch 不调用 `getContext()` 检查 canvas、不提取 CPU pixels、不使用 `writeTexture()`、不关闭或 dispose source，也不为 source 发明 resource epoch。

合格 target 必须是 single-sampled 2D plain color texture，同时具有 `COPY_DST` 与 `RENDER_ATTACHMENT` usage，并使用设备已启用的 renderable `unorm`、`unorm-srgb`、`float` 或 `ufloat` format。直接执行与 submission 共用同一套 validation、native-call、failure 与 target-epoch path。见 ADR-030。

第一版 `ReadbackCommand` 已为 buffer source 实现。它使用显式 source `contentEpoch`，通过 `SubmissionBuilder.readback(...)` 进入 submission 顺序，在该位置只 staging 一次，并通过 `result({ after })` 返回关联的 `ReadbackOperation`。直接 texture readback、mapped lease 与 staging budget policy 仍属于未来工作。

原生 indexed 与 indirect execution 已实现。Scratch 会把静态 vertex draw、静态 indexed draw、indirect vertex draw、indirect indexed draw、静态 dispatch 和 indirect dispatch 直接降低到对应的 WebGPU encoder method。CPU-dynamic resolver closure 仍是未来工作，等待具体的 `SubmissionContext` 与 tracked dynamic-value contract。

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

Draw 与 dispatch execution contract 会在构造时完成 normalization 并锁定。它们的 pipeline、bind/index/vertex state、count、dynamic offsets、resource declarations、readiness policy 与 fallback reference 不能在 validation 和 encoding 之间漂移; 被引用的 bind set 也会暴露同一份不可变的 normalized binding table。`dispose()` 仍是显式可变的 lifecycle transition，并通过只读 `isDisposed` state 暴露，而不是可写 flag。

Pipeline 与 command validation findings 应使用 `09-diagnostics-validation` 中的共享 `ScratchDiagnostic` envelope。`Command` diagnostics 应以 command 自身作为 `subject`，并把相关 resources、pass specs、pipelines 或 bind sets 放进 `related`，而不是只写在 prose 里。

Query command 会写入 indexed `QuerySetResource` slots。resolve query set 会把字节写入 destination buffer，并推进该 buffer 的 `contentEpoch`; 它不会让数据自动 CPU-visible，CPU 访问仍需创建或消费 `ReadbackOperation`。

## DrawCommand

当前实现的原生 count contract 支持静态 vertex 值、静态 indexed 值与 indirect buffer:

```ts
type DrawCount =
    | { vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number }
    | { indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number }
    | { indirect: BufferResource, offset?: number }
```

静态 indexed count 必须带 `indexBuffer`; 静态 vertex count 禁止携带它。Descriptor 与 runtime 都要求 direct、indexed 和 indirect count fields 互斥。Indirect count 在没有 `indexBuffer` 时选择 `drawIndirect`，携带时选择 `drawIndexedIndirect`。Draw 构造要求 render pipeline，并要求 pipeline 声明的每个 vertex-buffer slot 都有对应 binding。Direct count 使用 WebGPU integer domain，并允许 zero-count no-op。已知的静态 no-op 不会推进 declared output epoch，也不会创建 producer fact; indirect command 因 Scratch 不读取 GPU argument bytes 而继续作为潜在 writer。Index-buffer offset 按所选 format 对齐; binding size 保留 WebGPU 原生的非负 byte-range 语义，包括 zero，以及末端不落在完整 index element 上的 range。静态 `firstIndex + indexCount` 必须落在 bound range 所含的完整 indices 内，strip pipeline 还要求 bound format 与 `stripIndexFormat` 一致; indirect argument 内容不会为同类 count-range 检查而被 CPU 读取。

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

CPU-dynamic resolver 仍是依赖场景状态 count 的未来选项; 下例是目标语法，不是当前 public API:

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

当 compute 产生 draw arguments 时，indirect count 是已实现且推荐的 GPU-driven 路径。Indirect buffer 与可选 index buffer 还必须以所需 content epoch 出现在 `resources.read` 中。Scratch 会校验 usage、alignment、range、ownership、disposal、readiness 与 epoch，但不会在 CPU 上检查 argument bytes。

## DispatchCommand

当前实现的 dispatch count 采用相同原生模型:

```ts
type DispatchCount =
    | { workgroups: [number, number?, number?] }
    | { indirect: BufferResource, offset?: number }
```

静态 workgroup dimension 允许 zero，并按 `maxComputeWorkgroupsPerDimension` 校验。Indirect dispatch 校验 12-byte GPU argument range，并保持 GPU-side。

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
- CPU 动态——只有在 CPU 侧工作(如剔除)之后才知道 → 未来的 resolver closure 或 tracked handle 是合理形式(见 `02-resources` 动态值)。值若已在某个句柄里，优先用句柄。
- GPU 动态——由 GPU 产生(例如 compute 写出 draw 或 dispatch arguments)→ 优先 `indirect`。它无需回读、全声明式、对 validation 可见。

可验证性阶梯，优先靠上: indirect buffer > 被追踪的句柄 > 闭包。

未来的 `SubmissionContext` 应暴露 runtime state、submission diagnostics、受追踪动态值和 producer epochs，但不表示一定存在 presentation surface。它不属于当前已实现的原生 count slice。

## Readiness Policy

Draw 与 Dispatch 已通过 discriminated descriptor 实现全部四种 readiness policy:

```ts
type ResourceReadinessPolicy =
    | 'throw'
    | 'skip-command'
    | 'skip-pass'
    | 'use-fallback'

type CommandReadinessDescriptor<FallbackCommand> =
    | {
        whenMissing: 'throw' | 'skip-command' | 'skip-pass'
        fallback?: never
    }
    | {
        whenMissing: 'use-fallback'
        fallback: FallbackCommand
    }
```

`DrawCommandDescriptor` 使用 `CommandReadinessDescriptor<DrawCommand>`，`DispatchCommandDescriptor` 使用 `CommandReadinessDescriptor<DispatchCommand>`。Fallback 必须是实际 command，并具有相同 command kind、runtime、未 disposed lifecycle，以及相同 declared-write resource identity set。重复 declared-write resource 会归一为一个 identity。有限 fallback chain 的 command ID 必须唯一，但可以改变 pipeline、bindings、fixed-function buffers、count 与 declared reads。Policy 与 fallback reference 均不可变；由于构造后仍可调用 `dispose()`，submission 会重新检查 lifecycle。

在 submission 时:

- `throw` 在所有 validation mode 下都会于 encoder 创建前对未 ready read 硬失败;
- `skip-command` 只省略该 command，不应用任何 declared read/write fact;
- `skip-pass` 会事务化省略整个 render/compute pass，包括 attachments 与 query writes;
- `use-fallback` 记录 primary attempt，并在同一 command position 解析 fallback。

只有最终选中的 command 会进入其既有原生 encoder method。选中的 Draw fallback 必须先与 pass 的准确 color target 数量/格式及 depth/stencil state 匹配。Indexed 与 indirect fallback 也遵守这一点; Scratch 在选择时不会检查 indirect argument bytes。预期的 skip/fallback 决策记录在 `SubmittedWork.executionOutcomes` 中，而不是 diagnostics。非法 contract 与 hard runtime failure 继续使用 `ScratchDiagnostic`。

当前只有 Draw 与 Dispatch 拥有这套完整 policy surface。Copy、ordered Readback 与 query Resolve descriptor 仍然只接受 `whenMissing: 'throw'`。

## 非目标

- 不让 command count 默认就是闭包。
- 不把 indirect draw 或 dispatch 隐藏成特殊高层特性。
- 当 WebGPU 缺少对应 core query type 时，不把 pipeline statistics 暴露成核心 command family。
- 不把 command membership 存在 pass spec 中。
- 不在 command 中编码 terrain、flow、tile 或 layer 概念。
- 不引入 `Material` 作为 `Program` + `BindSet` + render semantics 的快捷组合。
- 不把 pipeline 或 command validation 暴露成 prose-only errors。
