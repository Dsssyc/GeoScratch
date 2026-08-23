---
docId: geo.terrain-rendering.zh
canonical: false
translationOf: ./terrain-rendering.md
canonicalDigest: 1f5b19c7a4e95e183bedf0d3c89c48e7112f5728addaba9f93735b7e2100564d
---
# 地形渲染

[English](./terrain-rendering.md) | [Geo 概览](./README_zh.md)

`createWebMercatorTerrainRenderer` 是 Geo 的 OGC `WebMercatorQuad` terrain 编排器。
它组合 `MapFieldLayer`、已准备的 Virtual Raster runtime、
`GpuWebMercatorQuadCover`、`GpuWebMercatorQuadDemandProjection`、
`GpuWebMercatorQuadPatchDraw`、生成的 terrain WGSL、随 capture 调整的 attachment、
延迟反馈和显式释放。不存在假装 planar 与 globe 选择等价的通用 terrain alias。

帧顺序是：

```text
view upload
    -> adaptive inverse-cover compute
    -> source-demand projection compute
    -> patch-draw indirect preparation compute
    -> terrain drawIndirect
```

这些阶段权限分离。Cover 只选择标准几何 patch 和邻接；demand projection 将 patch
映射到 Virtual Raster source ceiling；patch draw 把 consumer vertex count 与 GPU
patch count 组合；Virtual Raster 随后只调度显式 `ViewTileDemandSet` page，并解析
exact 或 ancestor 数据，驻留状态不改变几何拓扑。

内建 terrain consumer 使用 128-cell 标准 patch、四 reference-pixel 最大 area-
equivalent projected cell span 和 0.005 数值容差。所有 pitch 使用同一自适应 selector。
不存在 60 度边界、mode feedback、renderer override 或 example 环境变量。物理
presentation size 与 DPR 不参与质量度量。

`elevationRangeMeters` 和可选 `WebMercatorTerrainElevationBounds` 仍然是 terrain
source fact。Renderer 应用 exaggeration，再把它们转换为通用
`WebMercatorTileVerticalBounds` 后构造 cover。Hierarchy 必须完整匹配 source
coverage；省略时使用全局范围。cache hit、atlas page 和请求完成不能提供或改变 bounds。

Demand feedback 保持期望几何精度、source ceiling 和可执行请求瓦片互相独立。
`VirtualRasterRuntime.reconcileViewDemands()` 只调度这些显式请求。exact-resident
page 不消耗 request budget；缺少 exact page 时通过 page-table ancestor fallback
继续渲染，同时保持同一几何 cut。

`webMercatorTerrainWgslModule` 拥有完整 vertex 路径：重建 wide-fixed 标准瓦片
位置、在 f32 转换前减去相机、解析 cover neighbor、吸附混合 LoD 边缘、按全局 field
坐标采样高度并投影。内建 wireframe entry point 用稳定瓦片颜色显示 stitching 后
mesh；应用只提供 fragment presentation WGSL。

`render(capture)` 消费一个 `GeoViewSourceCapture<ViewInput>`，根据
`presentationSize` 调整物理 attachment，并返回
`GeoFrameResult<WebMercatorTerrainFrameValue>`。submission/native observation、cover
feedback、demand feedback、raster settlement 和后续 publication 保持不同 promise
与 fact。被 supersede 的反馈不能 reconcile demand 或覆盖当前状态。最新相机决策
完成两个有限 readback 前，同决策帧保持 `needsFollowUp`，避免 latest-only admission
遗失收敛。

Renderer 在三个组合 GPU component 中分别拥有两套 parity resource。Underwater
Terrain 使用测量得到的双 in-flight bound。Renderer 不拥有 map host、controller、
source manifest、URL policy、Worker system、decoder 或 persistent-cache 选择。

未来 feature-to-surface conformance 不属于该 renderer。独立 Geo preprocess product
可以消费其 surface geometry 或一致 field sampler，但 feature 身份和 source tiling
不能变成 terrain tile render-to-texture 状态。

相关决策：ADR-074 分配 terrain WGSL 权限；ADR-083 定义 inverse cover 与被动
Virtual Raster；ADR-084 定义 reference pixel；ADR-086 统一 selector，并分开几何、
source demand 与 draw-count 权限。
