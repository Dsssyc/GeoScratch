---
docId: geo.tiles-demand.zh
canonical: false
translationOf: ./tiles-demand.md
canonicalDigest: edb654eb233762b05d2b61d5aa1dcf282013df1c569283c911d93cf9fcfa1470
---
# 瓦片模型与需求

[English](./tiles-demand.md) | [Geo 概览](./README_zh.md)

Tile matrix set 与 finite coverage 描述 source addressability、bounds、origin、matrix
dimension 与逐级 limit。Topology 独立描述 parent、child 与 neighbor relationship。
Spatial profile 为特定 map 或 globe model 编码 tile bounds 与 camera-relative coordinate。

`ViewDemandProducer` 根据同一份不可变 view provenance 校验、去重、排序并限制调用方
已经推导出的 tile candidate；它自身不检查 camera，也不选择 LoD。View cover、simulation、
editor、prefetch corridor 或 analytic extent 才是语义 demand producer。

Demand 是 intent，不是 residency。`ViewTileDemand` 携带可执行 page、
`desiredSampleLevel`、`sourceLevelCeiling`、priority、intent、reason、generation 与
精确 view/frame/residency provenance。下落到 Virtual Raster 时会有意移除语义 level
字段：residency 可以调度 page，但不能修改 producer 的 LoD 决策。Raster source 可以停在
z10，而标准 geometry 继续到 z14。
