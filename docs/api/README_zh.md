---
docId: api.zh
canonical: false
translationOf: ./README.md
canonicalDigest: d40233ec07e56f20d594e26abaabb047d3bff8840306955c620b598941850191
---
# GeoScratch API

[English](./README.md)

本目录记录当前公开 API。TypeScript 源码与包入口是可执行事实；英文页面是规范性
语义说明，中文页面是其译文。Vision 文档描述方向，ADR 解释决策，review 记录特定
范围的证据。它们都不能替代这里使用现在时描述的 API 契约。

## 入口

- [Scratch](./scratch/README_zh.md) 是领域无关基础层，提供诊断、生命周期、缓存、
  几何、Worker 执行以及显式 WebGPU 资源与工作模型。
- [Geo](./geo/README_zh.md) 在 Scratch 之上适配坐标、视图、瓦片、场、Virtual Raster、
  CPU／GPU 视图覆盖与地形语义。Geo 可以依赖 Scratch；Scratch 永不依赖 Geo。

自动生成的参考完整列举真实入口导出：[Scratch reference](./reference/scratch.md)、
[Geo reference](./reference/geo.md) 与[机器可读事实](./reference/api-docs.json)。

## 维护

公开 TypeScript 变更后运行 `npm run docs:generate`，更新相关英文和中文页面，再运行
`npm run docs:translations` 确认译文已经同步。`npm run docs:check` 只读执行，并拒绝
陈旧参考、缺失源码摘要、不完整源码归属、损坏链接或陈旧译文。
