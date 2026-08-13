---
docId: geo.tiles-demand.zh
canonical: false
translationOf: ./tiles-demand.md
canonicalDigest: 1eefdfb83dd61e1bb16b4f81e867bfcc13af84fa2e4013b677aea1ee0eaa06eb
---
# 瓦片模型与需求

[English](./tiles-demand.md) | [Geo 概览](./README_zh.md)

Tile matrix set 与 finite coverage 描述 source addressability、bounds、origin、matrix
dimension 与逐级 limit。Topology 独立描述 parent、child 与 neighbor relationship。
Spatial profile 为特定 map 或 globe model 编码 tile bounds 与 camera-relative coordinate。

`ViewDemandProducer` 根据 frustum/viewport evidence、projected error、distance 与 source
limit，把 view snapshot 转成带优先级的 tile demand。它只是一个 demand producer，
不是 Virtual Raster owner。其他 producer 可以请求 simulation region、prefetch corridor、
edit neighborhood 或 analytic extent，再合并为带 generation 的 demand set。

Demand 是 intent，不是 residency。它携带 usage、priority、revision 与 generation，使
陈旧异步 load 可被拒绝。Source detail level 与 render mesh detail 相互独立：raster
source 可以停在 z10，而 terrain frontier 继续细化 geometry 以获得更平滑的投影。
