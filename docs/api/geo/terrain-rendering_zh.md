---
docId: geo.terrain-rendering.zh
canonical: false
translationOf: ./terrain-rendering.md
canonicalDigest: bc43cf8caefee70b574083c1b978374e1014369d1ec60435b42408201721ea9a
---
# 地形渲染

[English](./terrain-rendering.md) | [Geo 概览](./README_zh.md)

`createTerrainFieldRenderer` 是从 DEM example 提取出的可复用 Geo 编排。它把 Geo view、
field/runtime、GPU render-patch frontier、atlas sampling module、mesh-stitching topology、
pipeline、indirect draw、resize、feedback 与 lifecycle 组合为一个显式 renderer contract。
应用提供 source、presentation、shader/color policy 与 ownership choice。

Web Mercator Virtual Raster WGSL 根据 logical world position 采样高程，包括 parent
fallback 与跨 tile filtering。Terrain vertex generation 保持 camera-relative，并能独立于
raster z 细化 mesh density。消除 T-junction crack 的是 mesh stitching，不是 Virtual
Raster；Virtual Raster 消除的是 tile boundary 处 CPU padding 与 neighbor-aware shader
plumbing。

Renderer 不是通用 scene、map 或 DEM loader。它不拥有外部 map，也不暗中启动无关
Worker。其他 renderer 可以复用相同 field 与 frontier primitive 来实现 imagery、flow、
compute 或 editing。DEM example 最终应只保留 source-specific loading/decoding、
presentation shader、control 和无法由这些公开 contract 表达的装配。
