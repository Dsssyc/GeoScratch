# Pipelines 与 Commands

状态: Vision draft
日期: 2026-07-24

## 决策

`ShaderModule` 拥有已确认的 WGSL source 与原生 compilation evidence。
`Program` 描述引用这些 module 的不可变 stage contract。`Pipeline` 描述一个
`Program` 的稳定 WebGPU 可执行状态。`Command` 描述一个可执行 GPU 动作。

这会替代旧模式中 shader code、binding、range、executable flags、pipeline、pass membership 混在一起的做法。

`ShaderModule`、`Program`、layout codec 与 source composition 模型见
`08-programs-codecs`。本模块从可执行 pipeline 与 command 层开始。

## Pipelines

Render pipeline 拥有稳定状态:

- 一个不可变 Program stage snapshot 与可复用的原生 ShaderModule
- 显式 BindLayout 或显式原生 `layout: "auto"`
- vertex buffer layouts，包括保留索引的显式 `null` slot
- stage 自有的 vertex 与可选 fragment override-constant snapshot
- primitive state
- depth 与 stencil state
- 可选 fragment state 与精确 color target compatibility，包括保留索引的显式
  `null` slot
- multisample state
- pipeline cache key

Compute pipeline 拥有:

- 一个不可变 Program compute-stage snapshot 与可复用的原生 ShaderModule
- 显式 BindLayout 或显式原生 `layout: "auto"`
- stage 自有 constants
- pipeline cache key

Pipeline 不拥有:

- per-submission command counts
- resource readiness policy
- pass membership
- 具体 bind set resource allocation versions
- material 或 style 参数
- scene-object assignment

Pipeline 保留已确认的原生 pipeline 与无源码 creation report。Shader source 与
compilation message 仍由 `ShaderModule` 拥有；pipeline 绝不重新创建 module。
它不能变成把具体资源、视觉语义和 shader code 打包在一起的 material-like object。

Stage constants 显式且相互独立:

```ts
const program = runtime.createProgram({
    vertex: { module: vertexModule, entryPoint: 'vsMain', constants: vertexConstants },
    fragment: { module: fragmentModule, entryPoint: 'fsMain', constants: fragmentConstants },
})
```

Program 构造会快照原生 `GPUPipelineConstantValue` domain。Pipeline descriptor
不再提供 stage、entry-point 或 constants alias。

省略 `layout` 表示零 BindLayout 的 explicit mode。Auto mode 必须显式选择:

```ts
const pipeline = await runtime.createComputePipeline({
    program,
    layout: { mode: 'auto' },
})
const group0 = await pipeline.getBindLayout({
    group: 0,
    entries: declaredBindingSchema,
})
```

派生 wrapper 记录 `origin: "native-derived"` 与
`validationConfidence: "native-authoritative"`。同一 group 的重复请求必须使用
相同 normalized schema。Explicit-layout pipeline 禁止派生 layout。

Render Program 可以省略 `fragment`。此时 Scratch 省略原生 fragment descriptor
并禁止 `targets`，直接表达 depth-only 或其他 no-color-output workload。存在
fragment stage 时必须显式提供 targets sequence；需要原生空 sequence 时也应显式
传入空数组。

`vertexBuffers` 与 `targets` 保留原生 slot index。显式 `null` 是真正的空 slot；
array hole 或 `undefined` 非法。Scratch 不压缩也不重新编号这些 sequence。Draw
必须绑定每个非空 vertex slot，也禁止向 null slot 绑定 buffer。

## Command

统一使用 `Command` 作为名称，因为它最接近 GPU command buffer 模型。

目标 command 家族:

- `DrawCommand`
- `DispatchCommand`
- `CopyCommand`
- `ClearBufferCommand`
- `UploadCommand`
- `ResolveQuerySetCommand`
- `ReadbackCommand` 作为显式 ordered-staging 逃生口，并产生 `ReadbackOperation`
- `BeginOcclusionQueryCommand` / `EndOcclusionQueryCommand` 作为 render-pass-only query bracket
- `BundleDrawCommand` / `ExecuteRenderBundlesCommand` 用于原生 render-bundle
  记录与执行
- `DebugCommand` 用于原生 encoder debug group 与 marker

`CopyCommand` 覆盖 WebGPU 原生 GPU-side copy 方向: buffer-to-buffer、texture-to-texture、buffer-to-texture 与 texture-to-buffer。CPU upload 与 CPU readback 仍然是显式 transfer/readback operation，不能替代这些 command encoder copy。

`ClearBufferCommand` 覆盖原生 `GPUCommandEncoder.clearBuffer()` operation。
Attachment resolve 是 render-pass color attachment 的组成部分，而不是独立的
resolve command。

### RenderBundle 与 DebugCommand

`RenderBundle` 是受限且使用原生编码的 render command sequence，不是缓存后的
普通 render pass:

```ts
const bundleDraw = runtime.createBundleDrawCommand({
    pipeline,
    bindSets: [ { set: staticSet } ],
    vertexBuffers: [ { slot: 0, region: vertices.region() } ],
    count: { vertexCount: 3 },
    resources: {
        read: [
            { resource: vertices, contentEpoch: vertices.contentEpoch },
        ],
        write: [],
    },
    whenMissing: 'throw',
})

const bundle = await runtime.createRenderBundle({
    realization: 'persistent',
    colorFormats: [ 'rgba8unorm' ],
    commands: [ bundleDraw ],
})
```

realization mode 必须显式提供。Persistent bundle 会确认唯一一个原生
`GPURenderBundle`，并快照 allocation version、BindSet preparation facts 与完整
immediate bytes。Allocation 改变或显式重新 prepare BindSet 后，它会变成 stale；
submission 必须失败，不能静默重建。依赖临时 Surface 或 external texture 时必须
使用 `realization: 'attempt-local'`。Submission 在该次选中 attempt 中至多为同一个
authored bundle 创建一个原生 bundle，且绝不把 temporal handle 变成 persistent
Resource。

Bundle layout 显式包含 color formats、可选 depth/stencil format、sample count
以及 depth/stencil read-only declaration，并且至少要有一个 color 或
depth/stencil attachment。Bundle 创建时校验 pipeline compatibility，包括考虑
cull mode 的原生 stencil-write 规则；submission effect 前校验 pass
compatibility。只有原生 layout equality 会忽略尾部 null color slots。

`BundleDrawCommand` 禁止 viewport、scissor、blend constant、stencil reference、
fallback readiness、query bracket 与 attachment operation；这些概念属于 pass。
原生 bundle encoding 不推进 content epoch。只有成功调用 `executeBundles()` 后，
每个嵌套 declared write 才会按实际执行 occurrence 推进一步，并记录进
`SubmittedWork`。即使 bundle list 为空，Scratch 也会调用 `executeBundles()`。
由于原生调用会清除 pipeline、bind-group、vertex-buffer 与 index-buffer state，
后续普通 Draw 必须重新发出自己的完整 state。

`DebugCommand` 只有 `push-group`、`pop-group` 与 `insert-marker` 三种 action。
同一个带私有品牌的 command 可降低到 command、render-pass、compute-pass 和
render-bundle encoder。Group 必须在准确的原生 encoder scope 内闭合；
command-encoder group 不能跨越 queue-side upload boundary。Debug command 不产生
Resource access、readiness dependency、content epoch 或持久 log stream。
不平衡 diagnostic 只保留有界 command ID 前缀以及 omitted count。

当前 RenderBundle 与 DebugCommand 使用
`09-diagnostics-validation` 共享 envelope 的 diagnostic codes:

- `SCRATCH_DEBUG_COMMAND_DESCRIPTOR_INVALID`
- `SCRATCH_DEBUG_COMMAND_NATIVE_FAILED`
- `SCRATCH_DEBUG_COMMAND_UNSUPPORTED`
- `SCRATCH_DEBUG_GROUP_UNBALANCED`
- `SCRATCH_RENDER_BUNDLE_ATTEMPT_REALIZATION_FAILED`
- `SCRATCH_RENDER_BUNDLE_COMMAND_INVALID`
- `SCRATCH_RENDER_BUNDLE_DESCRIPTOR_INVALID`
- `SCRATCH_RENDER_BUNDLE_DISPOSED`
- `SCRATCH_RENDER_BUNDLE_EXECUTION_DESCRIPTOR_INVALID`
- `SCRATCH_RENDER_BUNDLE_EXECUTION_FAILED`
- `SCRATCH_RENDER_BUNDLE_EXECUTION_UNSUPPORTED`
- `SCRATCH_RENDER_BUNDLE_NATIVE_CREATION_FAILED`
- `SCRATCH_RENDER_BUNDLE_NATIVE_INTERNAL_FAILED`
- `SCRATCH_RENDER_BUNDLE_NATIVE_OUT_OF_MEMORY`
- `SCRATCH_RENDER_BUNDLE_NATIVE_VALIDATION_FAILED`
- `SCRATCH_RENDER_BUNDLE_PASS_INCOMPATIBLE`
- `SCRATCH_RENDER_BUNDLE_PIPELINE_LAYOUT_MISMATCH`
- `SCRATCH_RENDER_BUNDLE_READ_ONLY_MISMATCH`
- `SCRATCH_RENDER_BUNDLE_STALE`
- `SCRATCH_RENDER_BUNDLE_TEMPORAL_REALIZATION_REQUIRED`
- `SCRATCH_RENDER_BUNDLE_WRONG_RUNTIME`

每个 executable command 都暴露单向 lifecycle。
所有 normalized command construction facts 与 payload/resource reference 都会被锁定：
其 public property 不可写，normalized nested layout/origin/extent shape 也会冻结。
缺省 optional fact 会在 command 变为不可扩展前具体化为 non-enumerable own
`undefined` property，因此 inherited prototype write 不能注入新的 normalized value。
Draw 与 Dispatch 的 `label` 无论存在或缺省，都参与同一锁定。每个 executable
command prototype 都会被冻结，因此 lifecycle、validation 与 encoding behavior 在
module 发布后不能被替换。Upload bytes 与 external-image source content 仍是由应用按
identity 持有的 mutable payload；锁定 command 不会冻结这些内容，也不会冻结被引用
Resource 自身的 lifecycle。
`isDisposed` 是由私有状态支持的只读 observation；`dispose()` 不可逆，赋值或
property shadowing 都不能让已 disposed command 再次可用。`ResolveQuerySetCommand`
只拥有一个深度冻结的 source snapshot；它的 `querySet`、`firstQuery` 与
`queryCount` observation 都从该 snapshot 派生，因此 submission readiness 与 native
encoding 不可能读取不同的 slot range。

### ClearBufferCommand

```ts
const clear = runtime.createClearBufferCommand({
    label: 'clear counters',
    target: counters.region({ offset: 0, size: 256 }),
})

const submitted = runtime.submission()
    .clear(clear)
    .submit()
```

target 是唯一且不可变的 `BufferRegion`，其 parent buffer 必须具有 `COPY_DST`。
offset 与 size 按四字节对齐，并在 encoder effect 前针对 current allocation
重新校验。非空 clear 是有序 parent-buffer write：它参与 dependency validation、
resource access、potential write、native observation，并推进一次 content epoch。
零长度 clear 同时是物理和逻辑 no-op。Scratch 不用 CPU bytes 或 compute pipeline
模拟 clear，也不发明 WebGPU 没有提供的通用 texture-clear command。

Command-kind authority 同样在 module 内闭合。每个成功构造的 executable command
都会在一个 module-private `WeakMap` 中登记其 exact command-family discriminator；
command guard 必须同时确认 exact built-in prototype 与该 private brand。Submission
和 fallback validation 使用这些 guard，而不是 public `instanceof`。Command
construction 也只通过 `isRenderPipeline()` / `isComputePipeline()` 接纳 render 或
compute pipeline，并只通过 `isBindSet()` 接纳 bind set；这些 guard 都由所属 module
的 private state map 支持。Resource 与 query operand 通过各自的 closed brand 进入。
替换 `Symbol.hasInstance`、提供具有 `assertRuntime()` 形状的 record、subclassing，
或执行 `Object.create(CommandClass.prototype)`，都不能向 construction、fallback
resolution、submission 或 native encoding 注入伪造 Pipeline、BindSet 或 Command
facts。

### Texture Allocation Replacement

`TextureResource.resize()` 是返回 Promise 的 resource-lifecycle operation，不是 `Command`、upload、copy 或 submission step。它不创建 encoder、queue action、resource-access entry、producer epoch 或 content write。原生 scope settle 期间旧 allocation 保持 current；被确认成功的 size-changing resize 会推进 `allocationVersion`，保留 `contentEpoch`，并把 replacement 标为 empty。

Pass spec 保留 `TextureViewSpec`，而不是 physical view。Render attachment 在每次 submission 内针对 current allocation 降低它。Texture upload、external-image upload 与全部 texture copy direction 保留逻辑 TextureResource，并解析其 current physical texture。Persistent texture binding 不同：BindSet preparation 拥有 allocation-scoped view，因此 replacement 会让 set stale；应用必须显式 prepare 后才能复用 resize 前的 command。

这种复用不绕过 validation。Upload 与 copy command 会在 encoder 或 queue effect 前，根据 current allocation 重新校验 mip、origin、extent、layer 与 sample constraint。BindSet preparation 会针对 BindLayout 与 current allocation 重新校验每个 TextureViewSpec；command preflight 要求 prepared snapshot 仍为 current。Render attachment 接受原生可渲染的 `2d`、`2d-array` 与 `3d` view，并要求单个 mip 与单个选定 array layer。Color slot 要求 color-renderable format。`2d-array` view 通过 `baseArrayLayer` 选择该 layer；`3d` view 覆盖 current logical mip depth，由 pass 通过 `depthSlice` 选择一个切片。Submission 会在 command encoder creation 前针对 current allocation 重新校验 view 与 `depthSlice`，并要求全部 color attachment region pairwise disjoint。不同 array layer 与不同 3D `depthSlice` 仍然合法。这些规则不应用只属于 texture binding 的 constraint。固定 required `contentEpoch` 仍要求精确匹配：replacement 前后数字 epoch 相同，并不表示 empty 的新 allocation 已可读。

### ExternalImageUploadCommand

`ExternalImageUploadCommand` 表达原生 immediate queue operation `GPUQueue.copyExternalImageToTexture()`。它是 upload，而不是第五种 `CopyCommand` direction:

```ts
commandKind: 'upload'
uploadKind: 'external-image'
```

另外两种 upload variant 也显式区分为 `uploadKind: 'buffer'` 与 `uploadKind: 'texture'`。external-image descriptor 按身份保留 canonical `GPUCopyExternalImageSource`，并暴露 `sourceOrigin`、`flipY`、目标 texture `origin`、`mipLevel`、`colorSpace`、`premultipliedAlpha` 和显式 width/height。destination aspect 固定为 `all`，`depthOrArrayLayers` 固定为 `1`。

当前完整 source union 都可接受: `ImageBitmap`、`ImageData`、`HTMLImageElement`、`HTMLVideoElement`、`VideoFrame`、`HTMLCanvasElement` 与 `OffscreenCanvas`。跨 realm 的 platform getter brand check 会拒绝任意 record，而不依赖 realm-local `instanceof`。构造会锁定 command fields，但不要求 source 已加载。执行会重新校验 image、video、frame 与 data source 的准确公开 dimension fields。Canvas dimensions 也可能来自当前 WebGL drawing buffer 或 `ImageBitmapRenderingContext` internal output bitmap；canvas 没有无副作用的 context-mode query，因此 Scratch 把这项 context-specific source-range check 留给原生 content timeline，并把同步 `OperationError` 分类为 invalid input。

降低使用 canonical `GPUCopyExternalImageSourceInfo` 与 `GPUCopyExternalImageDestInfo`，并要求 command runtime 自己的 queue。direct buffer 与 texture upload 也会在任何 native 或 logical effect 前执行同一 queue ownership 规则。pixels 在原生 queue method 调用时捕获。Scratch 不调用 `getContext()` 检查 canvas、不提取 CPU pixels、不使用 `writeTexture()`、不关闭或 dispose source，也不为 source 发明 resource epoch。

合格 target 必须是 single-sampled 2D plain color texture，同时具有 `COPY_DST` 与 `RENDER_ATTACHMENT` usage，并使用设备已启用的 renderable `unorm`、`unorm-srgb`、`float` 或 `ufloat` format。直接执行与 submission 共用同一套 validation、native-call、failure 与 target-epoch path。见 ADR-030。

Buffer `ReadbackCommand` 路径已通过 Promise-only `createReadbackCommand()` / `readbackCommand()` factory 实现。一个 command 只有在确认一个可复用 staging slot 后才变得可见；它使用显式 source `contentEpoch`，通过 `SubmissionBuilder.readback(...)` 进入 submission 顺序，在该位置只 staging 一次，并通过 `result({ after })` 返回关联的 `ReadbackOperation`。直接 texture readback 与 mapped lease 仍属于未来工作；有限 pending-operation 与 staging-byte budget 已是 runtime policy。

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

DrawCommand 与 DispatchCommand 使用一个封闭的 read-epoch contract:

```ts
type CommandResourceReadEpoch = number | 'current-at-step'

type CommandResourceReadDescriptor = {
    readonly resource: BufferResource | TextureResource
    readonly contentEpoch: CommandResourceReadEpoch
}
```

number 要求精确 simulated epoch，并保留 stale/read-before-write diagnostics。`'current-at-step'` 在显式 submission 位置解析最终选中 command 之前的内容：已包含前序 step effects，但不包含该 command 自身 writes。声明不可变且可复用，解析不会改写它。Bare resource、`latest` 等 alias、callback、closure、setter 与 compatibility overload 都会被拒绝。Vertex、index 与 indirect buffer 使用同一种声明模式。Copy、Readback 与 query-slot source 继续要求精确 numeric epoch。

写入资源内容的 command 推进 `contentEpoch`。替换物理 GPU 对象的 command 推进 `allocationVersion`。两者分离，这样 compute 写入不会被误解为 bind group invalidation。

### Native Observation Boundary

Command execution 进入其 enclosing submission observation。默认 summary
mode 用一个 submission-family scope bundle 包围全部 command encoding 与 queue
action；它不会声称某个唯一 command 失败。有限的
`nativeSubmissionDetail: 'step'` capture 可以改为在 standalone 或
pass-command location 外放置 balanced scope bundle，并把 `exact-operation`
attribution 指向该 location。

每个被引用的 BindSet 都必须已经处于 `prepared`。Command preflight 会在
encoder creation 前校验其不可变 slot table、prepared allocation snapshot、
Program requirement、named dynamic offset 与显式 resource access。Submission
可以把 pass-owned `TextureViewSpec` 针对 current allocation 降低成
submission-scoped attachment view；但绝不创建 persistent binding texture view
或 bind group，不调用 `prepare()`，也不等待、重试或修复 stale binding state。
BindSet preparation 是独立 acknowledged `bind-set-preparation` operation。

Draw 与 dispatch execution contract 会在构造时完成 normalization 并锁定。它们的 pipeline、bind/index/vertex state、count、dynamic offsets、resource declarations、readiness policy 与 fallback reference 不能在 validation 和 encoding 之间漂移。Draw render state 也属于同一不可变 snapshot；被引用的 bind set 暴露同一份不可变 normalized binding table。`dispose()` 仍是显式可变 lifecycle transition，并通过只读 `isDisposed` state 暴露，而不是可写 flag。

Pipeline 与 command validation findings 应使用 `09-diagnostics-validation` 中的共享 `ScratchDiagnostic` envelope。`Command` diagnostics 应以 command 自身作为 `subject`，并把相关 resources、pass specs、pipelines 或 bind sets 放进 `related`，而不是只写在 prose 里。

Query command 会写入 indexed `QuerySetResource` slots。resolve query set 会把字节写入 destination buffer，并推进该 buffer 的 `contentEpoch`; 它不会让数据自动 CPU-visible，CPU 访问仍需创建或消费 `ReadbackOperation`。

## DrawCommand

每个 Draw 都拥有完整的声明式 render state:

```ts
type DrawRenderState = Readonly<{
    viewport?: 'full-attachment' | Readonly<{
        x: number
        y: number
        width: number
        height: number
        minDepth?: number
        maxDepth?: number
    }>
    scissor?: 'full-attachment' | Readonly<{
        x: number
        y: number
        width: number
        height: number
    }>
    blendConstant?: Readonly<GPUColor>
    stencilReference?: number
}>
```

省略 viewport/scissor 会归一化为 `'full-attachment'`；省略 depth range、blend
constant 与 stencil reference 会分别归一化为 `0..1`、全零和零。
Full-attachment 在 submission 时根据 pass 当前已准备的 attachment extent 解析，
因此可复用 Draw 会跟随 texture 或 Surface resize。每个 Draw 都会在绘制前发出
`setViewport`、`setScissorRect`、`setBlendConstant` 与
`setStencilReference`，其结果不会依赖前一个 Draw 遗留的可变状态。Scratch
校验有限数值、WebGPU coordinate/size domain、depth 顺序与当前 scissor bounds，
不做静默 clamp，也不公开独立的 state-setting command。

当前实现的原生 count contract 支持静态 vertex 值、静态 indexed 值与 indirect buffer:

```ts
type DrawCount =
    | { vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number }
    | { indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number }
    | { indirect: BufferRegion }
```

静态 indexed count 必须带 `indexBuffer`; 静态 vertex count 禁止携带它。Descriptor 与 runtime 都要求 direct、indexed 和 indirect count fields 互斥。Indirect count 在没有 `indexBuffer` 时选择 `drawIndirect`，携带时选择 `drawIndexedIndirect`。Draw 构造要求 render pipeline，并要求 pipeline 声明的每个 vertex-buffer slot 都有对应 binding。每个 vertex `BufferRegion` 的 parent-buffer offset 都必须满足 `setVertexBuffer` 的 4-byte alignment；它与 attribute stride 和 shader layout 相互独立。Direct count 使用 WebGPU integer domain，并允许 zero-count no-op。已知的静态 no-op 不会推进 declared output epoch，也不会创建 producer fact; indirect command 因 Scratch 不读取 GPU argument bytes 而继续作为潜在 writer。Index-buffer offset 按所选 format 对齐; binding size 保留 WebGPU 原生的非负 byte-range 语义，包括 zero，以及末端不落在完整 index element 上的 range。静态 `firstIndex + indexCount` 必须落在 bound range 所含的完整 indices 内，strip pipeline 还要求 bound format 与 `stripIndexFormat` 一致; indirect argument 内容不会为同类 count-range 检查而被 CPU 读取。

静态值是默认路径:

```ts
const vertexRegion = vertexBuffer.region()
const drawTriangle = runtime.createDrawCommand({
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

CPU-dynamic resolver closure 仍是未来工作，当前 public API 不接受。Direct count
字段保持不可变。当 CPU 工作已经能够打包原生 indirect-argument record 时，可以用
稳定的 `UploadCommand` 更新 `COPY_DST | INDIRECT` buffer 中的记录，并让稳定 command
继续引用其 indirect region。动态值是显式 resource data，不是 count closure，也不是
对 command descriptor 的修改。

当 compute 产生 draw arguments 时，indirect count 是已实现且推荐的 GPU-driven 路径。Indirect buffer 与可选 index buffer 还必须以所需 content epoch 出现在 `resources.read` 中。Scratch 会校验 usage、alignment、range、ownership、disposal、readiness 与 epoch，但不会在 CPU 上检查 argument bytes。

Indirect record 不要求必须由 GPU 产生。CPU culling 可以在 draw 前通过有序 upload
更新同一条记录。Upload 推进 buffer epoch，draw 声明 `'current-at-step'` read，
SubmittedWork 保留 producer/read chain。这是 CPU-to-GPU 写入，不是 GPU-to-CPU
roundtrip，也不需要 mapping 或 readback。

## DispatchCommand

当前实现的 dispatch count 采用相同原生模型:

```ts
type DispatchCount =
    | { workgroups: [number, number?, number?] }
    | { indirect: BufferRegion }
```

静态 workgroup dimension 允许 zero，并按 `maxComputeWorkgroupsPerDimension` 校验。Indirect dispatch 校验 12-byte GPU argument range，并保持 GPU-side。

示例:

```ts
const simulate = runtime.createDispatchCommand({
    label: 'simulate particles',
    pipeline: simulationPipeline,
    bindSets: [ { set: simulationSet } ],
    count: { workgroups: [64, 64, 1] },
    resources: {
        read: [ { resource: flowTexture, contentEpoch: flowTexture.contentEpoch } ],
        write: [particleBuffer],
    },
    whenMissing: 'skip-command',
})
```

## Query Commands

Query command 暴露 WebGPU query 机制，但不发明平台并不提供的 profiling 抽象。

```ts
const resolveTiming = runtime.createResolveQuerySetCommand({
    label: 'resolve timing',
    source: {
        querySet: timingQueries,
        slots: [
            { index: 0, contentEpoch: 1 },
            { index: 1, contentEpoch: 1 },
        ],
    },
    destination: timingBuffer.region(),
    whenMissing: 'throw',
})
```

`ResolveQuerySetCommand` 是 copy/resolve command。它的 source 是显式连续 indexed query slots，并声明每个 slot 需要的 content epoch；destination 必须是带有 query-resolve usage，以及该 workflow 后续所需 copy/readback usage 的 buffer。后续 CPU 访问仍然使用 `ReadbackOperation`。

Occlusion query bracket 是 render-pass-only 的 command-like encoder action:

```ts
runtime.createBeginOcclusionQueryCommand({ querySet: visibilityQueries, index: tileIndex })
runtime.createEndOcclusionQueryCommand()
```

它们要求 active render pass 拥有同一个 `occlusionQuerySet`，不能嵌套，并写入一个 indexed query slot。

## 已确认的 Pipeline 创建

Scratch pipeline 构造对 render 与 compute 都是对称的异步过程:

```ts
const render = await runtime.createRenderPipeline(renderDescriptor)
const compute = await runtime.createComputePipeline(computeDescriptor)
```

只有 `createRenderPipelineAsync()` 与 `createComputePipelineAsync()` 是合法
原生 lowering path。只有一个原生 pipeline Promise、shader compilation
information、包围 supporting shader module 与 pipeline layout 的
validation/internal/OOM scopes，以及 lifecycle checks 全部 settle 后，才返回
pipeline wrapper。所有 scope pop 都必须在第一次 `await` 前发起；实现不假设
任何 Promise settlement order。

导出的 pipeline class 仍可用于 `instanceof`，但 direct 与 subclass
construction 由 internal token 关闭。成功 wrapper 拥有一个不可变、有界的
`compilationReport`。warning 与 information 是成功证据。Compilation error、
pipeline rejection、supporting-object error、structural Promise failure、
dispose 与 device loss 都让 factory 以一个结构化 `ScratchDiagnosticError`
reject；pending wrapper 不会进入 Draw 或 Dispatch command。

Pipeline 创建与 compilation 属于初始化工作。Command encoding、pass
lowering、queue submission 与 `SubmittedWork` 不增加隐藏 compilation、scope、
operation record 或 wait。

## Count 分流

draw 与 dispatch count 分三种情况; 按 count 实际依赖什么来选:

- 静态、record 时即可得 → 用字面量形式(`{ vertexCount: 3 }`、`{ workgroups: [64, 64, 1] }`)。不要把常量包进闭包。
- CPU 动态——只有在 CPU 侧工作(如剔除)之后才知道 → 当应用能够把原生 ABI 表达成显式 resource data 时，使用 uploaded indirect-argument record。对于不使用该记录的情形，resolver closure 或 tracked scalar handle 仍是未来工作(见 `02-resources` 动态值)。
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

## Per-Command Immediate Data

Render 与 compute pipeline 把可选 `immediateSize` 归一化为不可变、非负、
4-byte aligned、且不大于 `deviceLimits.maxImmediateSize` 的 `GPUSize32`。非零
range 还要求 Program contract 包含 `immediate_address_space`；该值直接降低到
原生 pipeline layout。

Draw 与 Dispatch descriptor 接受：

```ts
type CommandImmediateData =
    | ArrayBuffer
    | ArrayBufferView
    | LayoutUploadView
```

零尺寸 pipeline 禁止提供数据；非零 pipeline 要求 source 的可见 byte length
与声明尺寸精确相等。View 始终按 byte range 解释，不存在 typed-element offset
语义、截断、补零、callback 或 partial-update alias。Command identity、pipeline、
expected length 与 source identity 不可变；调用方可以在 submission 之间修改
source 内容。

每个实际 command 获得一份完整的 attempt-local snapshot。Render 降低顺序是
`setPipeline`、`setImmediates`、完整 render state、vertex/index buffer、
bind group、draw；compute 顺序是 `setPipeline`、`setImmediates`、bind group、
dispatch。零尺寸 command 不调用，非零 command 精确调用一次。Scratch 不公开
partial-state command，也不跨 command 去重。

## 非目标

- 不让 command count 默认就是闭包。
- 不把 indirect draw 或 dispatch 隐藏成特殊高层特性。
- 不公开 WebGL 式可变 viewport、scissor、blend-constant 或 stencil-reference command。
- 不模拟原生 buffer clear，也不发明非原生通用 texture-clear command。
- 当 WebGPU 缺少对应 core query type 时，不把 pipeline statistics 暴露成核心 command family。
- 不把 command membership 存在 pass spec 中。
- 不在 command 中编码 terrain、flow、tile 或 layer 概念。
- 不引入 `Material` 作为 `Program` + `BindSet` + render semantics 的快捷组合。
- 不把 pipeline 或 command validation 暴露成 prose-only errors。
- 不公开 partial `SetImmediatesCommand`，也不让 command 含义依赖前序 encoder
  state。
