---
docId: scratch.zh
canonical: false
translationOf: ./README.md
canonicalDigest: 00557ebda5c5022910aa17f384e72d99e9c287211dfe966018f094a41548bf4f
---
# Scratch

[English](./README.md) | [API 根目录](../README_zh.md) | [自动生成参考](../reference/scratch.md)

Scratch 是 `geoscratch/scratch` 中的领域无关基础层。它公开显式对象而非隐藏的全局
状态：调用方拥有 runtime、resource、submission、cache、Worker system 及其释放责任。
Scratch 完整表达原生 WebGPU 能力，同时增加稳定身份、所有权、生命周期权威、校验、
诊断和可检查历史。

## 子系统

- [诊断](./diagnostics_zh.md)
- [生命周期](./lifetime_zh.md)
- [持久缓存](./cache_zh.md)
- [几何](./geometry_zh.md)
- [GPU runtime 与 surface](./gpu-runtime-surface_zh.md)
- [GPU 资源与数据](./gpu-resources-data_zh.md)
- [Program 与 binding](./gpu-programs-bindings_zh.md)
- [Command 与 submission](./gpu-commands-submissions_zh.md)
- [Readback 与观测](./gpu-readback-observation_zh.md)
- [Worker 执行](./worker_zh.md)

Scratch 不定义地图、坐标参考系、瓦片选择、栅格驻留策略、地形、scene 或 layer。
这些属于 Geo 或应用。示例中的特定工作流可以证明缺少某个原语，但不能凭此直接成为
核心 API 形状。
