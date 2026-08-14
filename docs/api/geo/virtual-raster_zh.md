---
docId: geo.virtual-raster.zh
canonical: false
translationOf: ./virtual-raster.md
canonicalDigest: 24331795c0b13c33c905023454e594eef1f4635b013b4a5f672e1b6522bd238e
---
# Virtual Raster

[English](./virtual-raster.md) | [Geo 概览](./README_zh.md)

Virtual Raster 提供大于有限 GPU storage 的逻辑 field。Address space、plane、source、
sampling profile、accessor 与 snapshot 将 logical identity 和 physical atlas placement
分离。紧凑 source coverage 避免为整个世界创建 dense page table。库级 WGSL 根据
vertex、fragment 或 compute stage 中的位置解析精确 page、parent fallback、跨页过滤与
outer-boundary policy。

Demand scheduling、CPU page transfer、residency、publication、GPU table 与 feedback 是
不同权威。Request scheduler 协调带 generation 的 demand 与 cancellation。Worker
`createVirtualRasterWorkerExecutor` 在 `WorkerContextPool` 之上适配固定的七步 context
protocol（`lookup`、`fetch`、`decode`、`transfer`、`accept`、`discard` 与 `facts`），并独立
限制 network/decode phase。`VirtualRasterWorkerModuleProtocol` 让源码 implementation
使用同一份类型协议。Descriptor 显式声明 `borrowed` 或 `owned` WorkerSystem 权威；Geo
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
ownership。Residency stage page 并发布 coherent snapshot；lease 防止
submission 仍可能采样时 physical slot 被回收。GPU feedback ring 限制异步 readback，
并拒绝 stale slot。Feedback lowering 会把缺席的 in-flight page 严格延续一个后续 feedback
generation，以吸收交替 GPU frontier transaction，而不会把单批缺席误判为取消；连续两批
缺席仍会取消过期工作。Demand-controller facts 会报告固定 grace 和当前 deferred count。
Deferred work 会降级为 background prefetch，因此在有界 request budget 下，当前 refinement
和 safety cover 始终优先。
报告的 deferred count 只包含真正进入该有界调度集的 page，不包括因预算被丢弃的 grace
candidate。

Runtime 组合这些权威，但不虚构 camera demand、cache policy、network format 或
rendering geometry。Cache address 只是映射到 Scratch Cache 的纯函数，cache 始终可选。
应用可以将 Virtual Raster 用于 DEM、imagery、flow field、classification、simulation
grid 或 editable raster，而无需让 shader 与 tile neighbor 或 atlas coordinate 耦合。

## 相关决策

- `docs/decisions/ADR-055-high-precision-virtual-raster-dem.md`
- `docs/decisions/ADR-056-generic-worker-webmercator-virtual-raster-cache.md`
- `docs/decisions/ADR-072-worker-context-pool-and-typed-protocols.md`
- `docs/decisions/ADR-073-virtual-raster-executor-authority.md`
