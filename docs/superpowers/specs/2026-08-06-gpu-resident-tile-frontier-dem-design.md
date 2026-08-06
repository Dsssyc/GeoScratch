# GPU 驻留瓦片前沿与 DEM indirect pipeline 设计

## 状态

设计已批准，尚未实施。

## 日期

2026-08-06

## 背景

当前 DEM example 在 CPU 上根据物理相机经纬度和 map zoom 遍历地理四叉树，随后每帧生成并上传 node level、node box、canonical node 和两份 indirect draw instance count。这个模型没有使用完整视锥、瓦片三维包围体或屏幕空间误差，因此地图高俯仰时，物理相机落点会偏离视口中心，远近区域出现错误 LoD。CPU 选择结果还直接驱动虚拟栅格页面计划，使几何覆盖、页面需求、GPU 驻留和实际绘制被一份瞬时 CPU 数组串联。

GeoScratch 已经具备实现 GPU-driven 方案所需的 Scratch 原语：storage buffer、compute pipeline、direct/indirect dispatch、indirect draw、同一 submission 内的资源 epoch/provenance、readback operation，以及稳定的 virtual-raster atlas 和 page table。当前缺口不是新的 WebGPU 封装，而是 Geo 层对这些原语的组合模型。

本设计把每帧完整四叉树遍历替换为一个 GPU 驻留、预算有界、跨帧收敛的 active frontier。CPU 热路径只更新相机事实；GPU 根据当前驻留页和前沿状态计算可见覆盖、LoD 细分/合并、页面需求和 indirect 参数。异步 CPU/worker 流式路径消费 GPU demand、获取页面并发布新的 residency snapshot。

## 规范与参考基线

- [WebGPU Latest Published Version](https://www.w3.org/TR/webgpu/)：storage buffer、compute pass、`dispatchWorkgroupsIndirect()`、`drawIndirect()` 和同一 queue timeline 的顺序执行；
- [WGSL Candidate Recommendation Draft](https://www.w3.org/TR/WGSL/)：storage/workgroup atomics、host-shareable layout、compute execution 和 texture/buffer access；
- [MapLibre covering tiles](https://github.com/maplibre/maplibre-gl-js/blob/main/src/geo/projection/covering_tiles.ts)：视锥裁剪、瓦片包围体和高俯仰下逐瓦片 variable zoom 的工业实现；
- [MapLibre covering tiles calculation](https://github.com/maplibre/maplibre-gl-js/blob/main/developer-guides/covering-tiles.md)：距离、FOV、投影面积和瓦片层级关系；
- [Cesium Globe maximumScreenSpaceError](https://cesium.com/learn/cesiumjs/ref-doc/Globe.html?classFilter=globe)：屏幕空间误差驱动地形 LoD 的公开契约。

实现只参考公开算法和数学模型，不依赖 MapLibre 私有 transform/tile internals，也不复制专有许可证下的 Mapbox GL JS 代码。

## 目标

1. 使用三维保守包围体、视锥裁剪和屏幕空间误差修复高俯仰 DEM 覆盖。
2. 每帧只处理 GPU 中的有限 active frontier 或 resident slot，不遍历完整世界四叉树。
3. 让 GPU 持久维护前沿并跨帧收敛，允许页面请求、worker 解码和上传落后一至数帧。
4. 让动态 compute 工作量由 GPU 写入 indirect dispatch 参数。
5. 让 LoD-map 和 terrain render 的 instance count 均由 GPU 写入 indirect draw 参数。
6. 删除 DEM 热路径上的 CPU node selection、node arrays、canonical-node packing 和 draw-count materialization。
7. 保持 virtual raster 为通用栅格采样系统；DEM 的 page-to-patch 策略不得限制 Flow、编辑器或其他动态消费者。
8. 保持高精度相机相对坐标、mesh-stitching、parent fallback、generation/epoch 安全和结构化诊断。
9. 在资源预算不足、请求失败、相机 teleport 和 residency 变化下仍提供无洞、可解释、可恢复的覆盖。

## 非目标

- 不把 tile、LoD、camera、frustum、terrain 或 virtual-raster policy 放入 Scratch core；
- 不让 GPU 直接执行网络请求、worker 调度、持久缓存或资源解码；
- 不在本设计中实现 globe、octree、3D Tiles 或 Flow Layer LoD，但 Geo 抽象不得阻止这些后续消费者；
- 不把 atlas 物理槽位等同于通用 tile identity；
- 不用逐帧 GPU readback 把完整可见 tile list 重新交给 CPU；
- 不用无界日志记录每帧、每瓦片决策历史；
- 不保留旧 CPU selector 作为长期兼容路径。GeoScratch 处于 `0.x.x`，新路径通过验收后 clean cut 删除旧路径。

## 术语

本设计使用 `selection`、`coverage` 或 `frontier` 表示瓦片覆盖决策。`picking` 仅作为讨论中的俗称；公共命名不得与 screen-to-object picking 混淆。

### Resident Set

已经进入 virtual-raster atlas 且由当前 acknowledged residency snapshot 标识的物理页面集合。

### Active Frontier

GPU 持久维护的、互不重叠并能为 source root/safety domain 构成无洞 coverage 的有限叶节点集合。它在视锥及有界 guard band 内自适应细化，在不可见区域逐步合并回粗层，因此 camera teleport 后始终存在新的遍历入口。因 `invisibleGraceFrames` 暂留的细化条目仍可属于 Active Frontier，但不得进入本帧 draw list。Active Frontier 不是完整四叉树，也不等于全部 resident pages；每帧只遍历这些当前叶节点。

**Task 3B discovered-design correction:** canonical frontier order 是把每个 tile path 对齐到配置的 maximum level 后得到的 hierarchical Morton/path-prefix order，逐层 child ordinal 固定为 `rowBit * 2 + colBit`，即 `00, 01, 10, 11`。合法 frontier 必须 prefix-free，因此这些 path key 唯一；parent 原位替换为 ordered children，以及完整 sibling block 原位合并为 parent，都能通过稳定 prefix compaction 以 `O(active)` 保持顺序。`compactIndex` 仍是 address identity 和 residency lookup key，不再作为 frontier array order 或同优先级预算 tie order。初始 roots 可以在 seed 时一次性按该 path order 排序。此前把 numeric `compactIndex` sort 当作 canonical order 的文字会要求热路径做全局重排，和稳定 compaction 及 GPU-resident 性能目标冲突，现以本不变量为准。

### Demand Set

GPU 根据视锥、SSE、预算和当前 residency 产生的缺失页面请求。CPU/worker 异步消费该集合。

### Render Cover

本帧实际绘制的 visible frontier pages。细分子页尚未完全就绪时继续使用 resident parent；合并时先保证 parent 可用，再退役 children。视锥外或仅因 guard band/grace 保留的条目不得写入 `visibleInstanceBuffer`。

### Desired Cover

在当前 camera、policy 和 budget 下应当达到的目标覆盖。Desired cover 可以领先 render cover 数帧。

## 所有权边界

### Scratch

Scratch 只提供通用执行和资源原语：

- `BufferResource`、`TextureResource`、regions 和 layout codecs；
- `Program`、compute/render `Pipeline`；
- `DispatchCommand`、`DrawCommand`、`PassSpec`、`SubmissionBuilder`；
- direct/indirect dispatch 和 direct/indirect draw；
- upload、copy、readback、resource epochs、SubmittedWork 和 diagnostics。

Scratch 不理解 tile address、SSE、parent/child、frontier、residency policy 或 DEM。

### Geo

Geo 拥有通用的 GPU tile-frontier 语义：

- tile-matrix address 和 parent/child 推导；
- resident-slot metadata；
- active-frontier buffers；
- view/policy codecs；
- visibility、SSE、hysteresis、budget 和 convergence；
- bounded demand feedback；
- render-cover、fallback、retire 和 diagnostic facts。

Geo 的实现降低为 Scratch primitives，不建立第二套 GPU runtime 或隐藏 submission scheduler。

### DEM example

DEM example 负责：

- 把一个 resident DEM page 解释为候选 terrain patch；
- DEM height range、geometric error 和 terrain exaggeration policy；
- 64-sector mesh、LoD map 和 mesh-stitching；
- terrain shader、颜色和 MapLibre camera adapter；
- 用真实 WebMercatorQuad/COG 页面验证通用 Geo frontier。

`DEM render tile = exact resident page or resident ancestor fallback` 是 DEM policy，不是 `VirtualRasterResource` 的普遍约束。

## GPU 数据模型

所有结构都使用显式 WGSL/TypeScript layout codec。以下是语义字段，不是允许手写偏移的替代品。

### MapMetaBuffer

CPU 每帧更新的唯一选择热路径输入：

```ts
type MapMeta = {
    relativeViewProjection: Float32Array
    cameraHigh: readonly [number, number, number]
    cameraLow: readonly [number, number, number]
    cameraFixedLow: readonly [number, number]
    cameraFixedHigh: readonly [number, number]
    viewport: readonly [number, number]
    verticalFov: number
    centerZoom: number
    frameEpoch: number
}
```

`relativeViewProjection` 必须在 CPU 的 `f64` 计算域中移除 camera/world origin translation 后再转换为 `f32`；shader 以 tile integer address、page-local coordinate 和 wide-fixed camera origin 构造相机相对位置，不能把 WebMercator 全局大坐标直接塞入 `f32` matrix。CPU 按 `WebMercatorQuadAddressCodec.coordinateBits` 把 camera XY 量化到 `cameraFixedLow/cameraFixedHigh` 两个 u32 limb；shader 独立构造 west/east/north/south boundary quanta，以 borrow 和二补码 magnitude 计算四条相机相对边，最后才把相对 magnitude 转为 `f32` 米。不得从一条边以大 `f32` extent 推导另一条边，也不得把 normalized high/low float 当跨设备 correctness contract；这是依据 ADR-055 对早期 split-float 表述的设计纠正。`cameraHigh/cameraLow` 继续承载 meter-space camera facts，尤其是 elevation 相对量。`centerZoom` 只用于兼容、初始化提示和诊断；最终 LoD authority 是投影后的屏幕空间误差。

### SelectionPolicyBuffer

只在 policy 改变时更新，不属于逐帧相机 upload：

```ts
type GpuTileSelectionPolicy = {
    refineErrorPx: number
    coarsenErrorPx: number
    minimumLevel: number
    maximumLevel: number
    maximumActiveTiles: number
    maximumDemands: number
    transitionReservePages: number
    invisibleGraceFrames: number
}
```

必须满足 `coarsenErrorPx < refineErrorPx`，形成迟滞区间。无效 policy 产生 Geo diagnostic，不进入 GPU execution。

### ResidentSlotMetadataBuffer

该 buffer 是 atlas 的 reverse mapping：一个元素对应一个物理 slot。page table 继续提供 virtual-to-physical resolution；slot metadata 提供 physical-to-virtual frontier facts。

现有 Virtual Raster page table 的 `resident/fallback/missing/failed`、resolved level、physical slot、generation 和 content epoch 继续作为 virtual-page resolution authority。`missing` 可以包含 CPU scheduler 中的 pending request；pending、cancel 和 retry timer 不复制进通用 page-table ABI。terminal failure 通过新的 residency snapshot 发布为 `failed`，GPU 据此停止无意义的逐帧 demand，同时保持 parent fallback。

每个有效 slot 至少包含：

```text
valid flags
tile-matrix level / row / column
physical slot
slot generation
content epoch
residency snapshot epoch
minimum elevation
maximum elevation
geometric error
last publication epoch
```

XY bounds 不以大数值全局 `f32 AABB` 作为事实来源。WebMercatorQuad 使用整数 tile address 在 shader 中重建 canonical bounds，再转换成 camera-relative coordinates。非规则 tile matrix set 以后通过 Geo bounds codec 提供量化或 high/low 表达。

高度范围必须覆盖 vertical exaggeration 后的真实 terrain extent。页面加载前对子页的判断使用 parent height range 和 geometric error 的保守继承；页面就绪后以该页面 metadata 收紧。

### Frontier Buffers

前沿使用 ping-pong buffers：

```text
currentFrontierBuffer
nextFrontierBuffer
frontierLookupBuffer
currentDispatchArguments
nextDispatchArguments
```

每个 frontier entry 至少保存 physical slot、expected generation、expected content epoch、entry snapshot epoch、tile address、previous LoD state、transition state、last-demand epoch 和 child demand mask。读取 slot 前必须验证 page/address、physical slot、generation 和 content epoch 与当前 slot 完全一致，当前 slot snapshot epoch 必须等于本帧 acknowledged MapMeta snapshot epoch，且 entry snapshot epoch 不得来自未来。较新的 acknowledged snapshot 若只更新了无关 page，不要求重建或 reseed 未变化 entry；验证通过的旧 entry 在下一 frontier 中传播当前 snapshot epoch。不匹配的 entry 是 stale，不得绘制或产生 child demand。

`frontierLookupBuffer` 是只覆盖当前有限前沿的 GPU membership index，用于按 canonical tile key 查询相邻 cover entry。它可以使用有界 open-addressed hash；并发插入允许改变内部槽位，但 lookup 的 membership 结果、后续 prefix-scan offset 和最终 canonical 输出顺序必须确定。该索引不扩展成完整世界四叉树，也不进入 Virtual Raster 的通用 page-table ABI。

ping-pong 的 A/B buffer 和 indirect-argument offsets 在创建时固定。实现预构建 `A -> B` 与 `B -> A` 两份等价 submission template，并按已跨过 frontier ordered issue boundary 的单调 sequence 选择模板；caller `frameEpoch` 只作为 decision metadata，不能控制资源角色。取消、未提交或 boundary 前失败不推进 sequence，boundary 后的组合工作失败也不能回滚已经 issue 的 A/B 转换。CPU 不读取 count，也不重写 indirect bytes。

### GPU 输出

```text
visibilityFlagsBuffer
decisionFlagsBuffer
prefixScanScratchBuffer
visibleInstanceBuffer
demandBuffer
retireBuffer
lodDrawArguments
terrainDrawArguments
boundedDiagnosticBuffer
```

`visibleInstanceBuffer` 是 LoD-map 和 terrain vertex shader 的共同 instance source。它替换当前 CPU 生成的 node levels、geographic boxes 和 canonical nodes；shader 从 tile address、slot metadata 和 address codec 重建所需事实。

`demandBuffer` 每项包含 virtual page identity、parent identity/generation、priority、decision frame/residency epoch 和 child mask。它不包含 payload、完整日志或 JavaScript callback。未满足的 active transition 以有界 lease/retry cadence 重发 demand；CPU scheduler 以最新 decision epoch 刷新请求优先级，并取消或降级超过 grace window 未获续租的旧请求。

GPU 写、GPU indirect 读的 argument buffers 必须以 `GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT` 创建；若还需要初始化或清零，再显式并入 `COPY_DST`。实现不得通过 CPU map 或 shadow array 在两种 usage 之间搬运 count。

## 固定 GPU 命令图

每帧使用相同的逻辑命令图；动态数量来自 GPU buffer：

```text
MapMeta upload
    -> Reset/PrepareCamera direct compute
    -> BuildFrontierLookup direct-clear + indirect-insert compute
    -> EvaluateFrontier indirect compute
    -> SelectBudgets compute
    -> ResolveTransitions indirect compute
    -> BalanceNeighbors indirect compute
    -> MarkAndPrefixScan compute
    -> CompactOutputs compute
    -> FinalizeArguments direct compute
    -> LoD-map drawIndirect
    -> terrain drawIndirect
    -> bounded demand readback copy
```

`BuildFrontierLookup` 的 clear phase 按固定 hash capacity direct dispatch，insert phase 与 `EvaluateFrontier`、`ResolveTransitions`、`BalanceNeighbors` 一样读取 `currentDispatchArguments`。prefix scan 可以按固定 capacity 使用 direct dispatch，也可以读取由前序 compute 生成的 block arguments，但 CPU 不提供元素数量。`FinalizeArguments` 为下一帧 frontier 和本帧两次 draw 写出新的 arguments。

### Reset/PrepareCamera

固定一个或少量 workgroups：

- 清零本帧有界 counters 和 overflow flags；
- 从 view-projection matrix 提取 camera-relative frustum planes；
- 发布本帧 frame/residency epochs；
- 不清除 persistent current frontier。

### EvaluateFrontier

通过 `currentDispatchArguments` 执行 `dispatchWorkgroupsIndirect()`。每个 invocation 处理一个 active frontier entry：

1. 验证 slot、generation 和 snapshot epoch；
2. 重建 conservative camera-relative bounding volume；
3. 执行 frustum test；
4. 计算 camera 到包围体最近距离；
5. 计算 SSE 和 projected-area priority；
6. 标记 retain、refine、coarsen、hidden、stale 或 failed transition。

### SelectBudgets

refine、demand 和 transition candidate 必须先通过 GPU 预算仲裁，不能在 compaction 后按数组尾部截断。实现使用固定数量的量化 priority buckets：先对 `SSE excess`、projected area、request age 和 incremental slot cost 生成整数 priority，再以 histogram/prefix 找到容量阈值；阈值同分项按 canonical frontier order 取舍。这样无需全排序，也能在相同输入下选择相同的高收益候选。

本帧 refine acceptance 以 `currentFrontierCount + 3 * acceptedRefines <= maximumActiveTiles` 的保守上界为准，不依赖同帧 coarsen 释放容量；coarsen 释放的预算在下一帧生效。demand 数量、transition reserve 和 atlas incremental slot cost 分别受自己的硬上限约束。任何上限不足都保留 parent cover，并记录 budget-limited facts。

### ResolveTransitions

- refine：从 `(level, row, column)` 直接推导可见 children，不查询完整四叉树；
- 所需 children 全部 resident 且 generation 合法时，下一前沿使用 children；
- 任一所需 child 缺失时，下一前沿保留 parent，并产生 bounded demand；
- coarsen：parent resident 后，下一前沿使用 parent，children 进入 retire candidates；
- request failure 不移除 parent fallback；
- camera 变化导致旧 demand 失去价值时，新的 decision epoch 和 demand lease 使 CPU scheduler 可以取消或降级旧请求。

转换只产生 candidate，不得直接破坏当前 cover。refine 的 candidate 必须等四个 required children 全部 acknowledged 后才有资格替换 parent；coarsen 的 candidate 必须把同一 parent 的四个当前 siblings 作为一个事务处理，并只由 canonical first child 写出 parent candidate。部分 child、部分 sibling、重复 parent 输出或单独 retire 都不能成为 next frontier。

### BalanceNeighbors

Active Frontier 的入口不变量是相邻 cover level 差最多 1。GPU 通过 `frontierLookupBuffer` 检查 candidate，并只接受保持该不变量的转换：

1. 先确定 refine acceptance。level `L` parent 只有在所有相邻当前 cover level 至少为 `L` 时才能替换为 level `L + 1` children；被更粗邻居阻塞时保留 parent，并提升该邻居的 refine demand priority。
2. 再确定 coarsen acceptance。level `L` siblings 只有在相邻当前 cover 不细于 `L`，且相邻区域没有本帧已接受 refine 时，才能合并为 level `L - 1` parent。
3. 最后的 balance kernel 验证 proposed next levels；任何仍会造成层差大于 1 的转换都回退为 current cover，并记录 bounded diagnostic，而不是在同一帧递归传播细分。

因为 current frontier 已平衡，且每个被接受的转换都保持平衡，所以这里不依赖数据相关、轮数不定的 GPU fixpoint。被拒绝的转换在后续帧重试，符合跨帧收敛模型。预算不足时优先拒绝 refine 或合并过细 patch，而不是强迫补出超预算 children。

### Deterministic Compaction

全局 atomic append 的顺序不稳定，不能作为最终输出算法。实现使用：

1. 固定 frontier 顺序下的 decision flags；
2. prefix sum 计算稳定 output offset；
3. 以 canonical child order 写入 next frontier、visible instances 和 demand；
4. atomics 只用于有界 counters/overflow facts，不决定语义顺序。

这样相同输入、epochs 和预算产生相同 tile order，便于 agent、tests 和 provenance 审核。

### FinalizeArguments

固定 compute 写出并夹紧：

```text
nextDispatchArguments = ceil(nextFrontierCount / workgroupSize)
lodDrawArguments      = [4, visibleInstanceCount, 0, 0]
terrainDrawArguments  = [terrainVertexCount, visibleInstanceCount, 0, 0]
```

所有 count 必须受 buffer capacity 和 WebGPU device limits 约束。overflow 不得依赖 native no-op；它必须产生结构化 diagnostic，并保留一个无洞的 budget-limited cover。

### Render

LoD-map 和 terrain pass 都读取同一 `visibleInstanceBuffer`，分别使用 GPU 生成的 indirect arguments。LoD-map 继续为 terrain vertex shader 提供邻接层级信息，mesh-stitching 行为不因 selection owner 从 CPU 移到 GPU 而丢失。

## 屏幕空间误差

默认 perspective evaluator 使用：

```text
SSE = geometricErrorWorld * viewportHeight
    / (2 * tan(verticalFov / 2) * distanceToBoundingVolume)
```

约束：

- `distanceToBoundingVolume` 是 camera 到 conservative 3D bounds 的最近距离，不是 tile center distance；
- bounds 包含经 exaggeration 处理的 minimum/maximum elevation；
- `SSE > refineErrorPx` 才允许 refine；
- `SSE < coarsenErrorPx` 才允许 coarsen；
- 迟滞区间内保留 previous state；
- orthographic、globe 或 custom projection 以后替换 evaluator，不修改 residency/frontier 协议。

DEM 初始 geometric error 可以由 tile matrix cell size、64-sector mesh spacing 和 source height resolution 的保守上界生成。后续可用 source metadata 或 GPU 比较 parent/child height residual 收紧，但 min/max height 不能被误称为 geometric error。

## 有界资源与细分事务

一次完整一分四在稳态将一个 parent 替换为四个 children，净增加三个 resident pages。无洞过渡期间 parent 与 children 同时存在，因此需要 transition reserve。

必须满足：

1. root 或低层 safety pyramid 常驻；
2. active parent 在 required children 全部 acknowledged 前不可退役；
3. atlas 满时先驱逐非 active、非 transition、低收益页面；
4. 若仍无空间，则拒绝该次 refine 并保留 parent；
5. refine priority 至少考虑 `SSE excess`、projected area、request age 和 incremental slot cost；
6. 预算选择不得通过遍历后 `slice()` 丢弃 cover；
7. GPU 仍可能引用的 slot 必须等待 SubmittedWork completion 或 generation-safe reclamation。

预算不足时，系统收敛到 best-feasible frontier，并报告 budget-limited facts，而不是声称达到 target SSE。

## 跨帧收敛

在以下前提下：

- camera 和 policy 最终稳定；
- source 请求最终成功或返回明确 terminal failure；
- maximum level 有限；
- atlas budget 足以容纳一个合法 cover 和 transition reserve；
- active parent 在 child handoff 前保持 resident；

每次成功 refine 都降低对应区域的最大 geometric error，系统在有限层级内收敛到满足 target SSE 的稳定 frontier。若 budget 不足，则收敛到由收益排序确定的稳定 budget-limited frontier。

相机 teleport 不要求保留旧区域的完整树。常驻 root/safety pyramid 提供新区域入口；GPU 从 coarse parent 逐帧产生 descendants。允许有限的决策延迟，但当前 render cover 始终使用已有 parent，不能出现未定义区域。

## CPU 热路径与异步事件路径

### 每帧热路径

CPU 只做：

1. 从 MapLibre adapter 读取 camera facts；
2. 更新 `MapMetaBuffer`；
3. 提交固定 Scratch submission graph。

热路径不执行 tile tree traversal，不生成 visible arrays，不 pack canonical nodes，不读取 indirect arguments，也不等待 demand readback。

### 流式事件路径

CPU/worker 仍负责：

```text
bounded GPU demand readback
    -> validate decision/residency epochs
    -> worker/network fetch and decode
    -> optional PersistentCache read/write
    -> atlas texture upload
    -> page table + resident slot metadata publication
    -> SubmittedWork acknowledgement
```

readback 使用固定三槽 staging ring。每个槽是持久 `ReadbackCommand`，结果采用 `consume-on-read`；ring 只在同一 open submission 持有该 frame 的 package-private `GpuTileFrontier.encode()` 凭证且只包含一份精确 frontier upload/compute graph 后追加一个 readback。三个已提交槽都忙时产生结构化 backpressure，调用方仍可不带 feedback 地提交本帧 frontier/render graph，GPU 不因 host readback 延迟阻塞当前 render。尚未提交的多个 builder 是同一 revision 的互斥候选，不提前 reservation 槽位；只有一个能跨越同步 issue authority，失败候选不产生 queue effect，也不需要额外 cancel 状态机。

CPU 只消费按实际成功 issue sequence 计算的 N-1 或更早结果，而不把业务 `frameEpoch` 当作执行序号。消费要求精确 `SubmittedWork` provenance，并同时校验 packed decision epoch、当前 acknowledged residency snapshot、demand parent slot/generation，以及 retirement 的 slot/generation/content epoch。Demand parent 和 retirement page 必须是 snapshot 中同页 exact `resident`，ancestor fallback 不能成为可执行 authority。Demand 以 canonical page path 排序并按最高 priority 去重；stale retirement 被丢弃并计入 bounded diagnostic；所有 frontier/candidate/transition counters 受 fixed active capacity 约束，任何越界或 overflow 都 fail closed。公开 batch 只包含 immutable demands、retirements、counters、facts 和有限 diagnostics，不暴露 mapped/raw bytes，也不保留逐帧历史。Frontier 拥有 ring 生命周期并在 dispose 时级联清理三个槽。

CPU 不直接编辑 active frontier。新 children 通过 page table/slot metadata publication 被 GPU parent transition 自动发现。

## 初始化与生命周期

1. runtime、virtual raster、atlas/page table 和 GPU frontier 显式异步创建；
2. 初始化至少发布一个 root/safety page；
3. 一次性 seed current frontier 和 current indirect dispatch args；
4. 每个 frame submission 显式声明 map upload、compute writes、indirect reads 和 render reads；
5. residency publication 必须 acknowledgement 后才可成为 frontier authority；
6. resize 只更新 surface/depth 和 MapMeta viewport，不重建 tile hierarchy；
7. dispose 停止新 demand、取消 readback ring、等待本实例已提交工作，并按 generation-safe 顺序释放 frontier、metadata、page table 和 atlas。

不存在隐式全局 frontier、自动创建 runtime 或由 `prepare()` 驱动的外部强制状态机。状态存在于显式 GPU resources 和 epochs 中，执行顺序存在于 SubmissionBuilder graph 中。

## 诊断与可解释性

默认每帧只维护固定大小 counters 和当前 facts：

```text
frameEpoch
residencySnapshotEpoch
activeFrontierCount
visibleInstanceCount
refineCandidateCount
coarsenCandidateCount
demandCount
fallbackCount
staleGenerationCount
budgetLimitedCount
maximumObservedSse
minimum/maximum selected level
frontier/demand/visible overflow flags
convergence state
```

不默认保存逐帧、逐瓦片历史。详细调查由显式 bounded capture 开启，按选定 frame/tile/filter 读回有限记录。这延续 Scratch ledger 的有界设计，避免长时应用耗尽 CPU 内存或 agent 上下文。

至少定义以下 Geo diagnostic codes：

```text
GEO_GPU_TILE_FRONTIER_INVALID
GEO_GPU_TILE_FRONTIER_STALE_SLOT
GEO_GPU_TILE_FRONTIER_CAPACITY_EXCEEDED
GEO_GPU_TILE_DEMAND_CAPACITY_EXCEEDED
GEO_GPU_TILE_TRANSITION_RESERVE_EXHAUSTED
GEO_GPU_TILE_BUDGET_LIMITED
GEO_GPU_TILE_REQUEST_TERMINAL_FAILURE
GEO_GPU_TILE_CONVERGENCE_TIMEOUT
```

正常 parent fallback 和一至数帧 demand 延迟不是 error。只有违反不变量、超过明确容量或进入 terminal failure 才产生 warning/error。

## DEM clean-cut 迁移结果

完成后 DEM 热路径不再调用旧 `selectTerrainNodes()`，并删除以下 CPU 每帧职责：

- `nodeLevels` array fill/upload；
- `nodeBoxes` array fill/upload；
- `writeDemCanonicalNodes()`；
- CPU `visibleNodeCount` 写入 indirect arguments；
- 由 CPU selection 展开 virtual-raster page plan；
- 基于物理相机 tile distance 的页面优先级。

替代关系：

```text
CPU node levels/boxes     -> GPU visibleInstanceBuffer
CPU canonical nodes       -> tile address + GPU address codec reconstruction
CPU page plan             -> GPU demandBuffer
CPU draw instance counts  -> GPU indirect argument buffers
CPU selector diagnostics  -> bounded GPU frontier facts/readback
```

旧 selector 可以保留为 test-only reference oracle，用于小型输入与 GPU 输出一对一比较，但不得进入生产 example bundle 或 runtime path。

## 验收与测试

### 纯逻辑与类型门禁

- CPU reference model 验证 frustum、SSE、hysteresis、parent/child handoff、coarsen 和 budget；
- layout/type tests 锁定 MapMeta、policy、slot metadata、frontier、demand 和 indirect argument ABI；
- invalid policy、capacity、epoch 和 generation 产生结构化 Geo diagnostics；
- public topology 仍只有 `scratch` 与 `geo`。

### Scratch lowering/provenance

- compute-produced indirect dispatch 在同一 submission 中被后续 compute pass读取；
- compute-produced LoD/terrain indirect arguments 在同一 submission 中被 render pass读取；
- producer epoch 等于 consumer `current-at-step` read；
- indirect argument bytes不 map、不由 CPU 解码；
- zero、overflow、stale 和 skipped readiness 不伪造 producer epoch。

### 真实浏览器 GPU proof

至少覆盖：

- pitch `0 / 45 / 70 / 85`；
- 多个 bearing、pan、zoom、resize 和 camera teleport；
- 近处细、远处按 SSE 降级，视锥外无 active draw；
- 相机稳定后 frontier 和 demand 收敛；
- child 加载前 parent fallback 无洞，children acknowledged 后完成替换；
- coarsen 时先恢复 parent，再退役 children；
- atlas 紧预算和 transition reserve 耗尽时得到稳定 budget-limited cover；
- request failure、cancel、stale generation 和 slot reuse 不绘制错误页面；
- mesh-stitching 边界无裂缝；
- DEM 上下方向、WebMercatorQuad address 和跨页采样保持正确；
- WebGPU validation errors、console errors 和 unhandled rejections 为零。

### 热路径证明

- camera-only frame 中 CPU 只更新 MapMeta upload；
- source 中不存在生产路径 `selectTerrainNodes()` 调用；
- node arrays 和 indirect instance count 不由 CPU 每帧 materialize；
- demand readback 至少延迟一帧且不阻塞 render submission；
- residency 没变化时不重复上传 atlas/page-table/slot metadata。

### 回归门禁

- `npm test`；
- package typecheck/build；
- DEM browser proof；
- Hello GAW、Flow Layer、virtual-raster dynamic flow 和 indirect execution browser regression；
- `git diff --check`；
- 最终 bounded diff review。

## 成功判据

本设计只有在以下事实同时成立时完成：

1. 高俯仰截图中的远区错误 LoD 不再出现；
2. DEM selection 不依赖物理相机二维邻域；
3. GPU active frontier 在有限 atlas budget 内无洞并可收敛；
4. 每帧 CPU selection/node upload/draw-count materialization 已被删除；
5. dynamic compute 和两次 render 都由 GPU indirect arguments 驱动；
6. 页面 demand 由 GPU 产生并通过异步 bounded readback 进入现有 worker/residency 流程；
7. page/patch 的 DEM 一一对应 policy 没有污染通用 Virtual Raster API；
8. generation、snapshot epoch、transition reserve、overflow 和 failure 都可机器解释；
9. 完整测试、构建和浏览器门禁通过。

## 实施边界

后续 implementation plan 应按可回滚阶段推进：Geo GPU metadata/frontier contract、Scratch command graph proof、DEM shader/data-flow replacement、GPU demand streaming integration、browser convergence/visual gates、clean-cut cleanup 和最终审计。每一阶段验证并提交后才进入下一阶段。

本文档不授权在实现过程中追加 globe、Flow LoD、通用 scene graph、material、GPU 网络访问、无界 telemetry 或与本目标无关的 Scratch API。
