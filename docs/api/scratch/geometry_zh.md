---
docId: scratch.geometry.zh
canonical: false
translationOf: ./geometry.md
canonicalDigest: d0e74017eaaae45d0288ea75c13fb7f46f4a88b44f7621146a263e36575d1f34
---
# 几何

[English](./geometry.md) | [Scratch 概览](./README_zh.md)

几何 helper 为规则平面和球体创建 CPU 侧 typed array。它们是确定性数据工厂：不会
分配 GPU 资源、选择 pipeline、拥有 runtime 或附加地理语义。应用可通过显式 Scratch
buffer operation 上传返回的 position、normal、texture coordinate 与 index。

这些 helper 是便利函数，不是 scene 或 mesh 对象模型。领域专用 topology、自适应
terrain patch 与 tile stitching 仍属于 Geo 或拥有相关策略的应用。
