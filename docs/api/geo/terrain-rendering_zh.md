---
docId: geo.terrain-rendering.zh
canonical: false
translationOf: ./terrain-rendering.md
canonicalDigest: 012b3be513fa146376fed159f90e3b3cafee9322b4377072e2030ebf5b02a61f
---
# 地形渲染

[English](./terrain-rendering.md) | [Geo 概览](./README_zh.md)

`createWebMercatorTerrainRenderer` 是 Geo 的 OGC `WebMercatorQuad` 地形编排器。
它组合一个 `MapFieldLayer`、一个已准备的 Virtual Raster runtime、一个
`GpuWebMercatorQuadCover`、生成式 terrain WGSL、indirect draw、按 capture resize、
延迟 demand settlement 与 dispose。名称有意限定投影；不存在假定 planar 与 globe
selection 等价的通用 terrain alias。

每帧顺序为：

```text
view upload -> inverse-cover compute -> terrain drawIndirect
```

Cover 是唯一 geometry LoD authority。它从当前 camera fact 反向生成 prefix-free 标准
瓦片 cover，不遍历 root，也不依赖 atlas residency。输出包含完整
`tileMatrix/tileRow/tileCol` identity、neighbor lookup、desired-page feedback 与 indirect
instance count。最终 cover 在 terrain render 前满足边相邻 2:1。

Raster demand 明确位于下游。Cover feedback 分别保留 desired precision 与 source ceiling，
renderer 再创建 `ViewTileDemandSet`。`VirtualRasterRuntime.reconcileViewDemands()` 只调度
可执行 source page；已经 exact-resident 的页面不占并发请求预算。Exact page 缺失时通过
page-table ancestor fallback 继续渲染；residency 时序不会改变 geometry topology。

`webMercatorTerrainWgslModule` 拥有完整 vertex 路径：它重建 wide-fixed 标准瓦片位置，
在转成 f32 前减去 camera，解析 cover neighbor，snap 混合 LoD 边，根据全局 field
coordinate 采样高程并完成投影。内置
`WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT` 用稳定瓦片颜色展示
post-stitch mesh。应用 presentation WGSL 只提供 fragment shading。

`render(capture)` 消费一个 `GeoViewSourceCapture<ViewInput>`，提交匹配 view，并返回
`GeoFrameResult<WebMercatorTerrainFrameValue>`。Submission/native observation、延迟 cover
readback、raster request settlement 与后续 publication 保持为独立 promise。被 supersede
的 cover feedback 不能协调 demand 或覆盖当前 fact。Renderer 拥有两套 map-meta/cover
parity；Underwater Terrain 应用使用经过测量的两帧 in-flight 上限。

Renderer 不拥有 map host、controller、source manifest、URL policy、Worker system、
decoder 或 persistent cache 选择；这些继续由应用显式组合。
