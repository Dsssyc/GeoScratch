---
docId: geo.virtual-raster.zh
canonical: false
translationOf: ./virtual-raster.md
canonicalDigest: b72844f14a68d4a65d5608141da76a8b7a7b5ffb9c24362e921a7c41d257626f
---
# Virtual Raster

[English](./virtual-raster.md) | [Geo 概览](./README_zh.md)

Virtual Raster 提供大于有限 GPU storage 的逻辑 field。Address space、plane、request
executor、sampling profile、accessor 与 snapshot 将 logical identity 和 physical atlas placement
分离。紧凑 source coverage 避免为整个世界创建 dense page table。库级 WGSL 根据
vertex、fragment 或 compute stage 中的位置解析精确 page、parent fallback、跨页过滤与
outer-boundary policy。

Demand scheduling、CPU page transfer、residency、publication、GPU table 与 feedback 是
不同权威。Request scheduler 协调带 generation 的 demand 与 cancellation。
`VirtualRasterRequestExecutor` 是 scheduling 与 runtime composition 实际消费的唯一异步
page-source 边界，不再并存一套失联的 `loadPage()` source object。Decoded ownership 只由
`OwnedVirtualRasterPagePayload` 及其 transfer operation 表达，不再通过第二个 identity
alias 表达。Worker
`createVirtualRasterWorkerExecutor` 在 `WorkerContextPool` 之上适配固定的七步 context
protocol（`lookup`、`fetch`、`decode`、`transfer`、`accept`、`discard` 与 `facts`），并独立
限制 network/decode phase。`VirtualRasterWorkerModuleProtocol` 让源码 implementation
使用同一份类型协议。Descriptor 可接收保留 candidate/init/Worker-facts 推断的 typed
contract，或一个 deployment `WorkerModuleReference`。Descriptor 显式声明 `borrowed`
或 `owned` WorkerSystem 权威；Geo
不会推断 ownership、接受 operation-name alias，也不会虚构 initial/disposed Worker facts。
Facts 来自 live context 查询，pool 的 terminal state 会记录远端 Worker finalizer 正常完成，
还是 lifecycle authority 执行了有界强制终止。Executor facts 会把 Worker 业务快照标记为
`live` 或 `last-observed-before-disposal`；dispose 后由 context-pool facts 充当生命周期权威，
而不是虚构已销毁的业务快照。

`createVirtualRasterRuntime` 同样要求显式的 `VirtualRasterExecutorBinding`。`borrowed`
executor 完全由调用方拥有；`owned` executor 必须提供异步 `dispose()`。Runtime 创建开始时
ownership 即发生转移；创建失败会释放 owned executor，runtime dispose 会先停止并结算
scheduler work，再严格释放 executor 一次。相互独立的 shutdown failure 会共同保留，不会
因为一个 authority 失败而跳过另一个。Runtime facts 只报告声明的 executor ownership，
不会虚构 executor 业务状态。Transfer helper 显式表达 `ArrayBuffer`
ownership。Residency stage page 并发布 coherent snapshot；需要跨异步工作保持 physical
assignment 的 consumer 仍可显式使用 lease。Runtime 自身通过
`reconcileViewDemands()` 消费显式 `ViewTileDemandSet`；它不检查 camera、zoom、
projected error、相邻关系或 geometry topology。

Demand producer 保留 `desiredSampleLevel` 与 `sourceLevelCeiling`；下落为
`VirtualRasterDemandSet` 时只传递可执行 page、priority、usage、generation 与 reason。
因此已知 source ceiling 会阻止不可能的请求，却不会改写 desired precision。Runtime 创建
时会为每个 pinned safety-cover page 预留 request 与 physical-page capacity；
`ViewDemandProducer.maxDemands` 是剩余的
`min(maxPhysicalPages, maxRequests) - safetyCoverPageCount`，所以可以为 0。Reconcile 会把
由该 runtime-owned producer 生成的 exact-resident 与 missing page 一起交给 scheduler；
foreign 或超容量 set 会失败，而不会被静默重排或截断。Scheduler 对 resident page 执行
mark-used，只请求 missing page。因此紧张 atlas 不会让两个当前 detail page 在一个空闲
slot 中相互驱逐。完整几何 cover 不受这项 residency budget 截断。

`VirtualRasterResidencyFacts.staleResponseCount` 同时包含被拒绝的过时代 staging／failure
操作，以及原本有效、但被新需求移除的 staged page。撤销 staged page 会在 GPU publication
前释放其独占 bytes；仅凭该计数不能判断发生了旧数据采纳。相同页面仍被新需求保留时，
会更新 staged generation 而不丢弃。这类撤销属于取消开销，审计时应与无效源数据采纳区分。

`VirtualRasterGpuState.encode()` 会记录精确 update ownership，并在同一个 open
submission 中把 staged publication 排在依赖它的 command 之前。该 submission 进入同一
WebGPU queue 后，后续 frame 可以在 native acknowledgement 尚未完成时引用这个 staged
snapshot，因为 queue order 会保留依赖关系。未编码的 staged snapshot、不同 runtime 或
不同 update 仍然非法。Acknowledgement 仍是 commit authority：只有全部 update command
均存在且 native execution 成功后，它才推进公开 snapshot epoch。

Runtime 组合这些权威，但不虚构 camera demand、cache policy、network format 或
rendering geometry。Cache address 只是映射到 Scratch Cache 的纯函数，cache 始终可选。
`virtualRasterCacheMetadataMatches()` 会将不可信 stored metadata 与 canonical address 的
全部 identity field 比较，同时允许 source-specific payload fact 扩展基础 metadata。
Source Worker 仍负责验证自己的 payload shape；identity 不匹配时必须视作 cache miss，
而不是接纳陈旧 bytes。
应用可以将 Virtual Raster 用于 DEM、imagery、flow field、classification、simulation
grid 或 editable raster，而无需让 shader 与 tile neighbor 或 atlas coordinate 耦合。

## 相关决策

- `docs/decisions/ADR-055-high-precision-virtual-raster-dem.md`
- `docs/decisions/ADR-056-generic-worker-webmercator-virtual-raster-cache.md`
- `docs/decisions/ADR-072-worker-context-pool-and-typed-protocols.md`
- `docs/decisions/ADR-073-virtual-raster-executor-authority.md`
- `docs/decisions/ADR-085-maplibre-readiness-and-raster-source-boundaries.md`


`prepareWebMercatorVirtualRasterSampler(model)` 将数据源解释准备为 CPU 元数据，
使用固定 1,808 字节的 uniform 布局。它借用一个不可变且内部一致的 WebMercator
场模型，并拥有私有的打包副本。`pack()` 返回调用方拥有的新字节副本，修改该副本
不会改变准备产物。准备过程不分配 GPU 资源、不上传、不发布驻留状态，也不执行采样。
布局描述源范围、解码参数、局部采样层级、像素中心偏移，以及内置 WebMercatorQuad
0–24 级的矩阵到局部层级直接映射。缺失矩阵 id 使用显式哨兵；局部层级索引不能
与矩阵 id 混用。页表偏移保留数据源紧凑覆盖的行优先身份。模型所有权不一致会在
`sampling` 阶段报告 `GEO_RASTER_SAMPLER_METADATA_INVALID`。
