# Tiles、LoD、Streaming 与 Residency

状态: Vision draft，当前基础契约由 ADR-055、ADR-056、ADR-058、ADR-059、ADR-061 和 ADR-067 冻结
日期: 2026-08-08

## 决策

`geo` 必须把标准瓦片身份、LoD 需求、异步请求、缓存、CPU staging、GPU
residency 和不可变 publication 表达为彼此正交的系统。它们不能藏在 layer、
material 或每瓦片渲染对象中，也不能压缩成一个只能按固定顺序推进的全局
`TileState` 状态机。

当前宏观数据流是:

```text
canonical high-precision position
    -> transient TileMatrixSet sample address
    -> idempotent demand generation
    -> generic WorkerSystem request execution
    -> Geo cache address/coherence adapter
    -> optional Scratch PersistentCache raw lookup
    -> unique owned decoded payload
    -> bounded staging publication
    -> Scratch upload and SubmittedWork acknowledgement
    -> immutable page-table snapshot
    -> shader-stage logical sampling and parent fallback
```

DEM 已通过 ADR-061 接受一条 GPU resident frontier 路径。在需要可见性与 LoD 的
消费者中，前半段进一步具体化为:

```text
camera/map metadata upload
    -> persistent GPU A/B active frontier
    -> frustum + SSE + hysteresis + balance + bounded budget
    -> GPU visible instances + indirect arguments
    -> bounded demand/retirement feedback
    -> CPU Worker/cache/request reconciliation
    -> acknowledged immutable residency publication
    -> next GPU frontier decision
```

这里不是把整个网络瓦片树移入 GPU。GPU 只遍历有限 active frontier 和已确认的
residency metadata；CPU 不再逐帧生成 visible node 数组或 indirect count。

## 已实现的 topology、spatial profile 与 view demand 边界

ADR-067 将标准瓦片身份之上的层次关系、空间求值和业务需求进一步拆开：

```text
GeoViewSnapshot
    -> TileTopology + TileSpatialProfile(planar)
    -> GpuTileFrontier
    -> ViewDemandProducer
    -> VirtualRasterRequestScheduler
```

- `TileTopology` 表达 finite root forest、parent/children、root-aware canonical path
  和 matrix-normalized bounds。regular quadtree 已通过真实 `2 x 1` level-zero root
  forest 验证，不再假定整个世界只有一颗根瓦片。
- `TileSpatialProfile` 当前明确只接受 `coordinateFrame: 'planar'`，负责 tile bounds、
  camera fixed encoding 与 frontier WGSL 所需的两轴量化事实。WebMercator 是其中一个
  profile，不再是 frontier descriptor 的硬编码输入。
- `GeoViewSnapshot` 是带 frame/residency epoch 的不可变相机事实。平台 adapter
  可以来自 MapLibre、Mapbox 或独立 controller；frontier 不读取平台私有 transform。
- GPU feedback 先成为带 view provenance 的 bounded `ViewTileDemandSet`，再显式降低为
  Virtual Raster demand。view producer 不拥有 Worker、cache、scheduler 或 residency。
- `GeoField`、`TiledFieldRepresentation` 与 `MapFieldLayer` 分别表达数据语义、物理瓦片
  表示和平面地图组合；layer 不创建 runtime、atlas、cache、Worker 或 pipeline。

当前 2×1 proof 只证明多根平面层次结构。globe 仍必须另行实现和审核 curved bounds、
ellipsoid-relative precision、horizon/occlusion、SSE 与专用 WGSL spatial evaluator；
不得把“支持多 root”误报为“已支持 globe”。

## 冻结的所有权边界

- `geoscratch/scratch` 分别拥有通用 Dedicated Worker 与 Persistent Cache 能力。
  Worker 管理 module、group、task、priority、cancellation、stateful context、
  Transferable、remote error 和有界诊断；Cache 管理 IndexedDB metadata、OPFS raw
  payload、预算、回收与存储诊断。两者不共享状态，也不认识 Geo、tile、camera 或 DEM。
- `geoscratch/geo` 拥有 TileMatrixSet、canonical address translation、virtual raster、
  demand、cache address/coherence adapter、request adapter、residency、snapshot、
  fallback 与 GPU lowering。
- Scratch GPU 域只拥有 WebGPU resource、command、submission、epoch 与 GPU diagnostics。
- example 或上层 source adapter 拥有数据 URL、业务展示范围、camera selection、
  source revision、是否创建 PersistentCache、缓存预算和最终 presentation。
- `geoscratch/geo` 的 `GpuTileFrontier` 拥有 persistent frontier、视锥/SSE、滞回、
  相邻层级平衡、预算仲裁、canonical compaction、visible instances、demand、retirement
  和结构化 diagnostics。具体 DEM 仍拥有 level metrics、page-to-patch、shader 与
  mesh-stitching。

缓存不是数据真相，GPU residency 不是缓存，in-flight 去重不是 completed cache，
editable working state 也不是缓存。

## TileMatrixSet 身份

标准二维瓦片身份使用 Tile Matrix Set 2.0 的 row/column 语义:

```ts
type TileCoordinate = {
    tileMatrixSetId: string
    matrixId: string
    tileRow: number
    tileCol: number
}
```

`WebMercatorQuad` 使用 EPSG:3857、top-left origin、向南增长的 row 和向东增长的
column。经度在反经线换行，纬度限制在 Web Mercator 有效范围。`xyz`、`tms`、
`z/x/y` 之类的名称不能代替完整的 matrix-set 身份和 origin 语义。

有限数据集通过每层 `TileMatrixLimits` 声明 coverage。compact page-table index
只为 coverage 内的页面分配:

```text
matrix offset
    + (tileRow - minTileRow) * coveredColumnCount
    + (tileCol - minTileCol)
```

世界矩阵仍是标准全局矩阵，但库不得因此创建覆盖全世界的 dense page table。

## Canonical 坐标与临时采样地址

canonical position 必须与 camera、tile 拆分、cache、residency、physical slot 和
atlas relocation 解耦。shader 在寄存器中按请求 LoD 临时展开:

```text
(canonical position, matrixId)
    -> global tile/texel/sub-texel footprint
    -> compact coverage entry
    -> immutable physical slot
```

不得把 `(level, pageX, pageY, texelX, texelY, subTexelX, subTexelY)` 作为每个动态
对象持久化 ABI。动态 vertex/fragment/compute 代码共享同一逻辑 accessor；只有经
测量能复用的中间结果才允许进入显式有界缓存。mesh stitching 必须先得到最终
canonical position，再采样虚拟高程。

## Demand 与调度

view、terrain、simulation 或编辑工具产生完整且幂等的 demand generation:

```ts
type VirtualRasterPageDemand = {
    page: VirtualRasterPageIdentity
    generation: number
    priority: WorkerTaskPriority
    reason: string
    usage: 'required' | 'prefetch'
    deadlineMs?: number
}
```

`VirtualRasterRequestScheduler` 对新旧 generation 做 reconciliation，而不是要求
调用方逐项驱动 `prepare()` 状态机。它必须:

- 去重同一 page；
- 保留并 reprioritize 仍需要的请求；
- 立即移除 obsolete queued work；
- cooperative abort active fetch/decode；
- 拒绝无法及时停止的 stale result；
- 保证 pinned root/required work 不被 prefetch 饥饿；
- 对 queue、active request、network、decode 和 history 使用硬预算；
- 独立配置 network 与 CPU decode 并发预算，并分别报告 active、queued 与峰值；
- 将超预算事实报告为 degradation 或结构化 diagnostic。

GPU 产生的一个已接受父级缺页事务，在相同父级仍需要 refine 且 residency snapshot
尚未补齐时必须保持 sticky；普通公平优先级不能每帧轮换该事务并造成 cancel/retry
振荡。相机或策略使父级不再需要 refine 时，generation reconciliation 仍正常取消
旧任务。terminal child failure 在 page table 中保持独立 `failed` 状态，阻断该父级
refine、保留 parent cover，并防止重复请求。

## 通用 WorkerSystem

Geo 的 request executor 可以使用公开 `geoscratch/scratch`，但 Worker API 不能
变成 tile 专用接口。`WorkerSystem` 必须显式构造且非单例；`WorkerGroup` 是 module
trust、isolation、capacity、state affinity 和 reclamation 边界。用户可以加载自定义
module，运行 stateless operation，或打开保留上下文的 stateful context。

当前 host 在其完整生命周期内只属于一个 group 及其冻结的 `(id, version, URL)`
module set；idle/capacity reclaim 和 group dispose 都直接 terminate。当前不实现跨 group
warm reuse，也不虚构内容 fingerprint。未来若引入 warm reuse，必须先具备可信内容
fingerprint 与成功 reset 契约。

取消语义必须区分 queued removal、cooperative cancellation、stale-result rejection
和 exclusive-host hard termination。module 通过 URL 加载，禁止 `eval`、
`new Function` 和任意 closure 序列化。Transferable 的 sender detachment 是所有权
移动事实，不是“零成本共享内存”的虚构承诺。

## 正交生命周期

不再使用一个枚举同时描述网络、decode、cache、staging 和 GPU 状态。至少独立
观察以下事实:

| 维度 | 当前事实 |
| --- | --- |
| Demand | generation、required/prefetch、priority、retained/cancelled/dropped |
| Worker task | queued/active/completed/cancelled/stale/failed、phase、context affinity |
| Cache | mode、entry/payload bytes、hit/miss、eviction、invalidation、quota、persistence grant |
| Payload ownership | worker-owned、transferred、adopted、staged、released |
| Residency | missing/staged/resident、slot generation、pin、fallback、eviction |
| Publication | pending/settling/acknowledged/abandoned、snapshot epoch、staging bytes |
| GPU | atlas/page-table allocation、uploaded slot generation、SubmittedWork outcome |

这些维度可以并发变化，但每个维度都必须有唯一 authority、有限容量和幂等终止。

## Cache 与 coherence

Cache 是否存在由 application 显式决定。`none` 表示不创建 cache；`persistent`
表示 application 以 namespace、payload byte budget、entry budget 和 persistence
request 打开独立的 Scratch `PersistentCache`。Scratch 不提供默认或隐藏的 JS memory
cache，快速内存缓存仍是业务策略。

Scratch cache 只理解 `(id, revision)`、structured-clone metadata 与可选 raw
`ArrayBuffer`。IndexedDB 是 metadata 和 commit point，OPFS 保存 immutable raw block；
不存在跨二者的虚构事务。pending journal、随机 payload ID、read repair 与显式 GC
使中断状态可判定、可回收。cache hit 返回新的 caller-owned buffer，因而可以安全
transfer。

Geo 的 `virtualRasterCacheAddress()` 只把 source、matrix set、matrix、row、column、
plane/band、source/payload representation、decoder、sample type、schema 和 coherence
映射为 Scratch key、metadata 与 invalidation prefixes。coherence 独立表达
`immutable(contentVersion)`、`revisioned(revision, validator)` 和
`editable(baseRevision)`。dirty edit 由 working-state authority 持有；clear cache
不得丢弃未提交编辑，旧 base 也不得覆盖新 content epoch。

当前 DEM 持久化的是 decode-ready `raw/uint8` height page。首次 network miss 在 Worker
中 decode 一次；scheduler 接受当前结果后提交受限 raw snapshot。后续 camera return
以及新 Worker lifecycle 的 hit 都直接 transfer raw payload，不再请求网络或执行图片
decode。这里的一次 miss-path snapshot 是 transfer detachment 与 stale-result acceptance
之间的必要 ownership 边界，不是常驻 memory tier。

## Transfer、Staging 与 Snapshot

fetch、persistent cache read 和 image decode 可以在 Worker 中完成。decoded typed
array 的整个 backing `ArrayBuffer` 通过 transfer list 移动到主线程；Residency 只
adopt 一次，不得 clone、slice 或再次 structured-clone payload。

`VirtualRasterSnapshot` 只保留 page identity、compact entry、physical slot、
generation/content epoch 与 fallback。decoded bytes 属于 upload publication，而非
snapshot。Scratch upload 形成实际 `SubmittedWork` 后，acknowledgement 才释放 staging；
abandon/dispose 也必须收敛到零 bytes。GPU 在上传后不得依赖 JS decoded payload。

## Residency、LoD 与 fallback

Residency policy 至少具有:

```ts
type ResidencyPolicy = {
    maxPhysicalPages: number
    maxStagingBytes: number
    maxRequests: number
    maxHistory: number
}
```

上层仍可以根据 screen-space error、zoom、geometric error 或 simulation policy 选择
LoD，但必须区分 geometry LoD、requested sampling LoD 与 resolved residency LoD。
fallback 是 page-table 中可解释的 parent resolution，不是 CPU padding、裙边或
隐藏的 full-image texture。跨页 bilinear footprint 必须逐 texel 解析，因此同样适用
于 vertex、fragment 和 compute stage。

## Budget 与 degradation

network、Worker queue、active decode、cache bytes、staging bytes、physical pages、
upload bytes 和 diagnostic history 都是独立硬预算。超过预算时允许降低 LoD、丢弃
prefetch、使用 parent 或返回 structured failure；不允许无界积累后只写 console log。

长期应用默认保留 current facts、bounded counters 和 bounded recent history。临时深度
诊断必须有 duration/entry/byte 上限，不能把每帧 page/task 全历史永久保留给开发者
或 agent。

## 与 Scratch 的衔接

Geo 只通过公开 Scratch resource/command/submission 契约降低 GPU 状态:

```text
owned publication pages
    -> TextureUploadCommand / page-table UploadCommand
    -> ordered SubmissionBuilder step
    -> SubmittedWork native outcome
    -> publication acknowledgement
    -> staging release
```

内容变化推进 Scratch `contentEpoch`，物理替换推进 `allocationVersion`。Geo 不模拟
bind-group invalidation，不把 Worker/tile/cache 概念注入 Scratch，也不绕过 Scratch
直接写 raw queue。

GPU frontier 证明现有 Scratch 能力已经足够：Geo 使用 storage/compute、indirect
dispatch/draw、submission authority、三槽 bounded readback、current-at-step provenance
和 diagnostics 组合固定图，没有向 Scratch 新增 tile API。具体所有权和 clean cut
见 [ADR-061](../../../../decisions/ADR-061-gpu-resident-tile-frontier-dem.md)、
[设计文档](../../../../superpowers/specs/2026-08-06-gpu-resident-tile-frontier-dem-design.md)
和
[实现计划](../../../../superpowers/plans/2026-08-06-gpu-resident-tile-frontier-dem.md)。
Topology/profile/view/field 的 clean cut 见
[ADR-067](../../../../decisions/ADR-067-geo-view-field-tile-spatial-profile.md)。

## 非目标

- 不把 tile 设计成 material、scene node 或 render object。
- 不让 layer 持有隐藏 cache 或 Worker singleton。
- 不把 dirty editable state 当作可逐出的 cache entry。
- 不要求 SharedArrayBuffer、Service Worker CacheStorage 或 WebGPU native sparse texture。
- 不声称当前基础已经迁移可见 Flow layer；动态 Flow proof 只证明通用契约可表达。
- 不让 AI 通过 console 或网络全集猜测调度、fallback、ownership 或终止状态。
