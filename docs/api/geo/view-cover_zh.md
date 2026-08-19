---
docId: geo.view-cover.zh
canonical: false
translationOf: ./view-cover.md
canonicalDigest: 63b8af9641593adfcc2815a3f2c5403f811555990e6e33aaea00369836540a7a
---
# WebMercatorQuad 视图覆盖

[English](./view-cover.md) | [Geo 概览](./README_zh.md)

`GpuWebMercatorQuadCover` 是 Geo 中平面 `WebMercatorQuad` rendering 的唯一 geometry
LoD authority。它消费不可变 `GeoViewSnapshot`，输出有界标准瓦片 cover、完整 identity
neighbor lookup、期望栅格页面 feedback 与 indirect draw argument。CPU 每帧只上传 view
fact 并提交持久图，不生成已选择瓦片数组。

每个输出 patch 都是 OGC `(tileMatrix, tileRow, tileCol)` identity。Camera/view-derived level
window 只从固定全球矩阵中做选择，不创建游戏式移动格网。Kernel 使用 rotation-invariant
local projective Jacobian 计算一个 geometry cell 的面积等价投影跨度。该 metric 包含
viewport scale、perspective、foreshortening 与配置的 elevation range；可能跨 camera plane
的 cell 会保守细分。

`variableLodPitchThresholdRadians` 划分两个确定性 mode。Pitch 严格小于阈值时，从粗到细
直接测试完整 viewport-footprint window，并只输出一个 uniform geometry level；pitch 等于
或大于阈值时，在每个可能 level 上围绕精确 camera coordinate 直接探查有界标准 parent，
只在 projected cell span 超过阈值处生成嵌套 child window。两种 mode 都保守拒绝不可见
candidate，并使用同一套 prefix-free emission 与局部 2:1 closure。Candidate 工作量随有界
可见足迹与 patch 硬容量增长，不再宣称与 viewport 无关的常量 candidate 上界。Kernel 不从
世界 root 开始、不执行 root-to-leaf 四叉树遍历、不统计 trial cut，也不把上一帧 topology
当作选择权威。

`GpuWebMercatorQuadCoverPolicy` 声明有序 geometry/source level、一个 patch 硬容量、
`cellsPerPatchEdge`、`maximumCellSpanPixels`，以及位于 `[0, PI / 2]` 的
`variableLodPitchThresholdRadians`。无效质量或阈值 fact 会在资源创建前失败。由于每个
patch 最多输出一个 demand，完整 demand capacity 直接由同一上界推导。
`sourceMaximumMatrixLevel` 是 source fact，不是 geometry ceiling。Geometry patch 可以继续
到 z14，而 raster demand 下落到标准 z10 ancestor。Feedback 分别保留
`desiredSampleLevel`、`sourceLevelCeiling` 与实际可执行 request tile。
Demand priority 先比较 desired precision，再比较到相机锚点的、考虑横向 world wrap 的
标准瓦片距离，使紧张 residency budget 不会退化为 row/column key 顺序。

Selection feedback 报告 `selectionMode`、最终 min/max geometry level，以及由 Q8 解码的
min/max projected cell span。这些 fact 只用于观察，不反馈给下一帧。Descriptor、lookup、
demand 或 capacity overflow 都是硬 diagnostic，不会静默降低 requested cut。

`gpuWebMercatorQuadCoverReadWgslModule()` 提供有界完整 identity lookup、covering-neighbor
解析与 edge-coordinate snapping。Lookup entry 保存完整 level、row、column，而不是容易
碰撞的 z14 compact key，因此契约可覆盖 WebMercatorQuad level range。

Cover 为有界 double-flight 拥有两套 parity resource。`writeView()` 创建一次性 view
upload，`frame()` 根据 submission-sequence authority 选择 parity，`encode()` 追加 upload
与一次 cover compute dispatch，`capture()` 追加有界 state/demand readback。Feedback 会
拒绝 overflow、stale frame epoch 与大于一级的最终边相邻层差。常量 root/trial counter 不
作为兼容词汇保留；结构门禁直接证明这些路径不存在。

Virtual Raster 位于下游。Cover 决定 geometry 与 desired sample precision；Virtual Raster
只调度显式 page demand、管理 residency，并解析 exact/ancestor 数据。
