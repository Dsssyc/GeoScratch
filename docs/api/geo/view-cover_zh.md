---
docId: geo.view-cover.zh
canonical: false
translationOf: ./view-cover.md
canonicalDigest: 97b878e6e059b117780c6fc02a06b931a48ae4164dee4a83fdf9d7b23cd6d869
---
# WebMercatorQuad 视图覆盖

[English](./view-cover.md) | [Geo 概览](./README_zh.md)

`GpuWebMercatorQuadCover` 是平面 `WebMercatorQuad` patch 渲染的 geometry LoD
权威。它消费一个不可变 `GeoViewSnapshot`，输出有限标准瓦片 cut、完整身份邻接
lookup、GPU patch count 和几何反馈。它不拥有 tiled source、栅格 demand、atlas
驻留、mesh 顶点数或 draw arguments。

每个 patch 都是 OGC `(tileMatrix, tileRow, tileCol)` 身份。相机派生的探查始终寻址
固定全局矩阵，不创建移动式游戏格网。所有 pitch 都由 `writeView()` 使用实际投影
矩阵和精确 fixed-point 相机准备保守标准 parent 窗口；GPU 仅在一个几何 cell 的投影最大奇异
拉伸超过 `maximumCellSpanReferencePixels` 加 `refinementTolerance` 时记录精确的
稀疏 parent 身份。Pitch 和 FOV 只自然参与投影，
不选择 uniform/variable 算法模式。

候选成员由投影深度上界决定，不依赖径向距离或 pitch/FOV hint 的算法切换。令 cell
宽度为 `h`、参考像素比例为 `s`、实际投影为 `M`，则
`B_ij = s_i * (abs(M_ij) + abs(M_wj))` 给出裁剪后 Jacobian 的界：
`maximumStretch <= h * ||B||F / w`。逆投影将此深度上界映射为保守标准行列窗口。
f32 坐标、clipping、metric 的独立误差预算及逆矩阵 residual 区间会向外扩大窗口。
Clipping 在相机相对世界坐标中进行：先组合矩阵行得到原始平面方程，再求点距离，
最终才投影裁剪顶点。这避免大尺度粗 patch 的 clip 坐标相减／混合丢失 near/far
常量并把可见区域误判为空；插值始终保持 affine homogeneous `w=1`。
Shader 将裁剪 NDC 和插值比例约束在其数学定义域，避免对 subnormal clipping
分母做除法。这些约束处理舍入误差，不改变精确的投影 cell 定义。

无法认证的数值运算回退到声明的完整 geometry 域。独立的粗级 seed 域从不受
refinement 深度上界裁剪。Cover descriptor 的 `maximumCandidates` 限制 seed 与
refinement 输入候选之和，默认 `max(16384, 64 * maximumPatches)`。无效预算在构造时
失败；超预算 view 在 `writeView()` 创建 upload/token 前同步产生
`GEO_WEB_MERCATOR_COVER_CANDIDATE_CAPACITY_EXCEEDED`。选择器不会为适配预算而缩小候选域。
此输入预算不计入物化 children 或后续邻接工作；`facts().candidateCapacity` 单独报告
该预算，不与输出 patch、lookup 容量混淆。

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
粗化 cut。合法空可见 cut 返回 `patchCount: 0`，省略 level/span 范围；范围哨兵值
不是公共结果。即使没有剩余 patch，溢出或未完成的 2:1 closure 仍是失败。

`WebMercatorTileVerticalBounds` 是几何 fact，不是 terrain 身份。平面 consumer
可以使用 `[0, 0]`；terrain 可以转换 source elevation metadata；挤出要素可以提供
保守高度。层级数据必须完整匹配 spatial profile；更细几何使用最高层祖先；省略
层级时使用 `verticalRangeMeters`。缓存、请求和驻留状态不能改变这些 bounds。

`GpuWebMercatorQuadCoverTemplate` 为下游 GPU component 暴露借用的 parity
resource：map metadata、patches、lookup 和完整 state。`writeView()` 拥有临时
upload，其中同时包含相机事实和保守窗口；`frame()` 选择 parity，`encode()` 提交一次自适应
compute，`capture()` 只读取几何 state。反馈包含 candidate/patch 数、level range、
邻接、projected-cell span 和 overflow fact，不包含 demand 或 selection mode。

`gpuWebMercatorQuadCoverReadWgslModule()` 提供完整身份 lookup、covering-neighbor
解析和 edge coordinate snapping，不使用碰撞风险更高的紧凑 z14 key。

`GpuWebMercatorQuadDemandProjection` 是独立 source lowering 阶段。它借用 cover
frame，拥有 source coverage 与 parity resource，对可执行 source tile 去重，并保持
`desiredSampleLevel`、`sourceLevelCeiling`、请求身份、相机环绕距离优先级、frame
epoch 和 residency epoch 分离。其有限反馈可转换为 `ViewTileDemandSet`；Virtual
Raster 仍然位于下游且保持被动。Projection 在读取 patch 前拒绝失败 cover 或不匹配
的 frame，输出零 demand 并设置既有 `overflowCount` 失败标记。因此非零 overflow
也可能表示上游 cover 无效；反馈解码会拒绝它，不会把它视为合法空 demand。

`GpuWebMercatorQuadPatchDraw` 是独立 draw-count adapter。它借用 cover state，
拥有 consumer element count 和 parity draw-indirect buffer，通过一次持久 compute
写入 `[elementCount, patchCount, 0, 0, 0]`。该 20-byte record 可直接用于 indexed
draw，其前 16 bytes 也可用于 non-indexed draw。失败 cover 输出零 instance，避免在
CPU 反馈尚未返回时绘制部分几何。Cover 不拥有这些 buffer 或 consumer mesh。

相关决策：ADR-083 建立 inverse cover 与被动 Virtual Raster；ADR-084 建立
reference-pixel 质量；ADR-086 废弃其中的 pitch gate，并分开 cover、source demand
和 patch draw 权限；ADR-087 保留稀疏 parent 决策；ADR-088 定义投影最大拉伸；
ADR-089 定义 consumer-neutral indexed/non-indexed indirect ABI；ADR-125 记录候选完整性、
失败 cut 撤销与有界执行设计。
