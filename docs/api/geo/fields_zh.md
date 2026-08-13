---
docId: geo.fields.zh
canonical: false
translationOf: ./fields.md
canonicalDigest: 1455d43a1975239f10b03806144df6ac25308d8e0d4b973192d761efb4e502c4
---
# 场与图层组合

[English](./fields.md) | [Geo 概览](./README_zh.md)

`GeoField` 模型表示定义在 coordinate domain 上的值，包含 value shape、interpolation、
missing-data semantics 与一种或多种 representation。Tiled representation 说明 storage
如何分区；它不会强迫 rendering code 手工寻址邻近 tile。

`webMercatorVirtualRasterField` 将 field 与 Web Mercator addressing、Virtual Raster
sampling 组合。Shader consumer 提供 geographic/projected position，并使用生成的库级
函数解析正确 logical page、parent fallback、boundary behavior 与 physical atlas sample。
Field abstraction 对 terrain、flow、compute 与 editing shader 隐藏 storage partition，
同时为 missing/fallback sample 保留显式 status。

`mapFieldLayer` 将 field-oriented renderer 接入 view/frame lifecycle。它是小型组合契约，
不是 scene hierarchy，也不承诺所有 field 都使用一棵平面四叉树。Globe 或非四叉树
representation 可以用不同 topology 与 demand producer 实现相同 field semantics。
