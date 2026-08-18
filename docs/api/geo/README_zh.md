---
docId: geo.zh
canonical: false
translationOf: ./README.md
canonicalDigest: 19a54a2d282d5670064f6c9c40e88dd465251d7d35d6a89db254bc1d12b1d1ff
---
# Geo

[English](./README.md) | [API 根目录](../README_zh.md) | [自动生成参考](../reference/geo.md)

Geo 是 `geoscratch/geo` 中的地理适配层。它把 Scratch 原语组合成 coordinate domain、
precision encoding、view snapshot、field model、tile demand、Virtual Raster residency、
GPU-driven view cover 与 terrain rendering。Geo 拥有地理语义并可依赖 Scratch；它不会
隐藏 Scratch runtime，也不会创建全局 GPU 状态。

Geo 诊断遵循与 Scratch 相同的机器可读规范，但保留独立 domain、code、phase 与
subject 词汇。`GeoDiagnosticError` 让结构化证据跨异常边界传播。

## 子系统

- [坐标与精度](./coordinates-precision_zh.md)
- [视图与帧控制](./views-frames_zh.md)
- [场与图层组合](./fields_zh.md)
- [瓦片模型与需求](./tiles-demand_zh.md)
- [Virtual Raster](./virtual-raster_zh.md)
- [WebMercatorQuad 视图覆盖](./view-cover_zh.md)
- [地形渲染](./terrain-rendering_zh.md)

当前可执行 topology 支持平面与 Web Mercator，但核心 field 与 coordinate contract
并未宣称一棵四叉树可以表示所有 globe 或 CRS。未来 globe profile 可以提供不同的
topology 与 spatial encoding，而无需修改 Scratch。
