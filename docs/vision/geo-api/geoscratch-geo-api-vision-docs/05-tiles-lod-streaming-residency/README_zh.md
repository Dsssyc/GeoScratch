# Tiles、LoD、Streaming 与 Residency

状态: Vision draft，当前基础契约由 ADR-055 和 ADR-056 冻结
日期: 2026-08-05

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
    -> explicit cache tier and coherence
    -> unique owned decoded payload
    -> bounded staging publication
    -> Scratch upload and SubmittedWork acknowledgement
    -> immutable page-table snapshot
    -> shader-stage logical sampling and parent fallback
```

## 冻结的所有权边界

- `geoscratch/scratch` 只拥有通用 Dedicated Worker、module、group、task、priority、
  cancellation、stateful context、Transferable、remote error 和有界诊断。它不认识
  Geo、Scratch、tile、camera 或 DEM。
- `geoscratch/geo` 拥有 TileMatrixSet、canonical address translation、virtual raster、
  demand、source/cache policy、request adapter、residency、snapshot、fallback 与 GPU
  lowering。
- Scratch 只拥有 WebGPU resource、command、submission、epoch 与 GPU diagnostics。
- example 或上层 source adapter 拥有数据 URL、业务展示范围、camera selection、
  source revision、cache policy 选择和最终 presentation。

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
| Cache | tier、hit/miss、bytes、eviction、invalidation、quota、persistence grant |
| Payload ownership | worker-owned、transferred、adopted、staged、released |
| Residency | missing/staged/resident、slot generation、pin、fallback、eviction |
| Publication | pending/settling/acknowledged/abandoned、snapshot epoch、staging bytes |
| GPU | atlas/page-table allocation、uploaded slot generation、SubmittedWork outcome |

这些维度可以并发变化，但每个维度都必须有唯一 authority、有限容量和幂等终止。

## Cache 与 coherence

当前 cache policy 是显式选择:

```ts
type VirtualRasterCachePolicy =
    | { tier: 'none' }
    | { tier: 'memory', maxBytes: number }
    | {
        tier: 'persistent'
        memoryMaxBytes: number
        persistentMaxBytes: number
        backend: 'indexeddb'
        namespace: string
      }
```

`none` 不保留 completed result；`memory` 是 deterministic byte-bounded LRU；
`persistent` 使用 IndexedDB 作为有界 L2，并如实报告 quota、usage 和
`navigator.storage.persist()` 结果。所有 tier 都可以保留短生命周期的 in-flight
dedupe 与 upload staging，但这不能计作 cache hit。

coherence 独立表达 `immutable(contentVersion)`、`revisioned(revision, validator)`
和 `editable(baseRevision)`。cache key 必须包含 source、matrix set、matrix、row、
column、plane/band、revision、encoded representation、decoder、sample type 与 schema。
dirty edit 由 working-state authority 持有；clear cache 不得丢弃未提交编辑，旧 base
也不得覆盖新 content epoch。

当前 DEM `memory` tier 仍保留 encoded PNG，并在 GPU eviction 后重新 decode；这只能
算 source cache hit，不能冒充 decoded cache hit。目标模型需要进一步区分
source-neutral encoded L2 与 ownership-moving decoded L1。decoded L1 必须把唯一 payload
以 lease 方式移交给 Residency，并在对应 Scratch upload 的 `SubmittedWork` settled 后
收回；禁止为了同时保留 cache 和 transfer 而复制第二份 decoded backing buffer。

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

## 非目标

- 不把 tile 设计成 material、scene node 或 render object。
- 不让 layer 持有隐藏 cache 或 Worker singleton。
- 不把 dirty editable state 当作可逐出的 cache entry。
- 不要求 OPFS、SharedArrayBuffer、Service Worker CacheStorage 或 WebGPU native sparse texture。
- 不声称当前基础已经迁移可见 Flow layer；动态 Flow proof 只证明通用契约可表达。
- 不让 AI 通过 console 或网络全集猜测调度、fallback、ownership 或终止状态。
