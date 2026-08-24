---
docId: geo.view-cover.zh
canonical: false
translationOf: ./view-cover.md
canonicalDigest: 88e35103ebacd94d4f2dfbad30ccc9b844dd774dfc9048758e200b48ae00fd6a
---
# WebMercatorQuad 视图覆盖

[English](./view-cover.md) | [Geo 概览](./README_zh.md)

`GpuWebMercatorQuadCover` 是平面 `WebMercatorQuad` patch 渲染的 geometry LoD
权威。它消费一个不可变 `GeoViewSnapshot`，输出有限标准瓦片 cut、完整身份邻接
lookup、GPU patch count 和几何反馈。它不拥有 tiled source、栅格 demand、atlas
驻留、mesh 顶点数或 draw arguments。

每个 patch 都是 OGC `(tileMatrix, tileRow, tileCol)` 身份。相机派生的探查始终寻址
固定全局矩阵，不创建移动式游戏格网。所有 pitch 都执行同一条自适应 kernel：围绕
精确 fixed-point 相机位置探查有限标准 parent，仅在一个几何 cell 的投影最大奇异
拉伸超过 `maximumCellSpanReferencePixels` 加 `refinementTolerance` 时记录精确的
稀疏 parent 身份。Pitch 和 FOV 只自然参与投影，
不选择 uniform/variable 算法模式。

投影度量使用 `GeoViewSnapshot.referenceViewport`、旋转不变的局部 projective
Jacobian、透视、缩短效应和不可变垂直包围体。最大奇异值约束最长屏幕方向，不会用
较小投影面积掩盖细长 cell。物理 presentation size 与 DPR 不会改变 cover 身份；
可能跨过相机平面的 cell 会保守细分。

`GpuWebMercatorQuadCoverPolicy` 声明有序几何层级、硬 patch 容量、
`cellsPerPatchEdge`、`maximumCellSpanReferencePixels` 和数值容差。无效 fact 在
资源创建前失败。内建 terrain consumer 使用 128 cells 和校准后的五 reference-
pixel 阈值。公共 cover policy 不含 source ceiling 或 pitch 边界。

Kernel 从声明的最小几何窗口开始，探查有限 parent，保留每个精确祖先决策，并只用
命中 parent 自己的四个标准 child 替换它；独立 parent 不会合并成按层矩形。随后输出
prefix-free 可见 cut，并执行局部 2:1 closure。它不从世界根开始、
不做 root-to-leaf quadtree traversal、不统计 trial cut、不检查 atlas slot，也不把
上一帧拓扑作为选择权威。descriptor、lookup 或 patch 容量溢出是硬诊断，不会静默
粗化 cut。

`WebMercatorTileVerticalBounds` 是几何 fact，不是 terrain 身份。平面 consumer
可以使用 `[0, 0]`；terrain 可以转换 source elevation metadata；挤出要素可以提供
保守高度。层级数据必须完整匹配 spatial profile；更细几何使用最高层祖先；省略
层级时使用 `verticalRangeMeters`。缓存、请求和驻留状态不能改变这些 bounds。

`GpuWebMercatorQuadCoverTemplate` 为下游 GPU component 暴露借用的 parity
resource：map metadata、patches、lookup 和完整 state。`writeView()` 拥有临时
upload，`frame()` 选择 parity，`encode()` 提交一次自适应
compute，`capture()` 只读取几何 state。反馈包含 candidate/patch 数、level range、
邻接、projected-cell span 和 overflow fact，不包含 demand 或 selection mode。

`gpuWebMercatorQuadCoverReadWgslModule()` 提供完整身份 lookup、covering-neighbor
解析和 edge coordinate snapping，不使用碰撞风险更高的紧凑 z14 key。

`GpuWebMercatorQuadDemandProjection` 是独立 source lowering 阶段。它借用 cover
frame，拥有 source coverage 与 parity resource，对可执行 source tile 去重，并保持
`desiredSampleLevel`、`sourceLevelCeiling`、请求身份、相机环绕距离优先级、frame
epoch 和 residency epoch 分离。其有限反馈可转换为 `ViewTileDemandSet`；Virtual
Raster 仍然位于下游且保持被动。

`GpuWebMercatorQuadPatchDraw` 是独立 draw-count adapter。它借用 cover state，
拥有 consumer element count 和 parity draw-indirect buffer，通过一次持久 compute
写入 `[elementCount, patchCount, 0, 0, 0]`。该 20-byte record 可直接用于 indexed
draw，其前 16 bytes 也可用于 non-indexed draw。Cover 不拥有这些 buffer 或 consumer mesh。

相关决策：ADR-083 建立 inverse cover 与被动 Virtual Raster；ADR-084 建立
reference-pixel 质量；ADR-086 废弃其中的 pitch gate，并分开 cover、source demand
和 patch draw 权限；ADR-087 保留稀疏 parent 决策；ADR-088 定义投影最大拉伸；
ADR-089 定义 consumer-neutral indexed/non-indexed indirect ABI。
