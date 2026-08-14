---
docId: geo.terrain-rendering.zh
canonical: false
translationOf: ./terrain-rendering.md
canonicalDigest: cfa41d7272d9593e9b0f7ae44fdae1191b153d7ec8bcdbafe3acf3b9d738f450
---
# 地形渲染

[English](./terrain-rendering.md) | [Geo 概览](./README_zh.md)

`createWebMercatorTerrainRenderer` 是 Geo 完整的 OGC `WebMercatorQuad` 地形编排器。
它把 `MapFieldLayer`、Web Mercator Virtual Raster runtime、GPU data frontier、GPU
render-patch frontier、生成式 terrain WGSL、indirect draw、feedback、resize 与 dispose
组合为一个显式 renderer。这个名称有意限定投影。不存在通用
`TerrainFieldRenderer` 别名：globe 或其他 tiling topology 需要具备不同空间与选择语义
的 renderer。

`webMercatorTerrainWgslModule` 拥有完整 terrain vertex 路径。它从 render patch
重建 wide-fixed logical position，在转成 f32 前计算 camera-relative difference，解析
相邻 render patch，对混合 LoD 的共享边做 snapping，通过 logical Virtual Raster
accessor 采样高程，并投影最终结果。它也提供由
`WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT` 命名的内置 fragment
entry point。Renderer 的 `presentationShader` 是应用 fragment entry point 的扩展源码；
它消费 `WebMercatorTerrainVertexOutput`，不得重复 position、stitching、tile lookup 或
height sampling 逻辑。

Raster LoD 与 geometry LoD 保持为不同权威。Data frontier 在数据源 matrix 上限内选择
resident source page；render-patch frontier 可以继续细化地形网格，并保留显式
`samplingLevel`。Neighbor stitching 使用 geometry level，共享边高程查询则协调实际可用
的 sampling level。Virtual Raster 消除 CPU padding 与 physical atlas 耦合；mesh
stitching 消除 T-junction crack。

更底层的消费者可以直接组合 `gpuRenderPatchReadWgslModule`。它通过显式 storage
binding 与 layout dependency 提供有界 visible-instance lookup、covering-patch lookup、
neighbor resolution 和 edge-coordinate snapping。生成模块不会读取 CPU 选择的 tile
列表，也不会让 draw count 往返 CPU。

Renderer 不拥有 map host、camera controller、source manifest、network transport、
decoder、Worker system 或应用 cache policy；这些都是显式组合输入。因此 Underwater
Terrain example 只拥有 source-specific loading/decoding、map/UI 装配、cache 总预算选择
和自己的 fragment presentation。
