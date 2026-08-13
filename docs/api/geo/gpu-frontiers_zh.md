---
docId: geo.gpu-frontiers.zh
canonical: false
translationOf: ./gpu-frontiers.md
canonicalDigest: c0e630babfe33b465d51ffbdebe14054bf8f01d94be1a2f771c2110e3a35156f
---
# GPU Frontier

[English](./gpu-frontiers.md) | [Geo 概览](./README_zh.md)

GPU frontier 在 GPU 上完成有界空间选择与 draw preparation。`GpuTileFrontier` 根据
view/policy buffer 评估 resident tile metadata，输出紧凑 demand/visibility feedback，
并准备 indirect argument。CPU 代码更新 map/view metadata 并消费延迟 feedback；它不在
每帧遍历无限 world quadtree。

Render-patch frontier 与 raster residency 分离。即使 source raster detail 已达到上限，
它仍按 projected grid spacing 与 distance 细化 terrain mesh patch。Normalized budget、
有界 balance pass、hysteresis 与 revision token 共同保持选择稳定。Balanced cut 在生成
mesh-stitching flag 前，保证 edge-adjacent level difference 不超过一级。

只有 resident 或可 seed 的 metadata 能参与 GPU pass，因此延迟 demand 可能在后续帧才
生效。这是有意的 eventual refinement，并不宣称所有 desired tile 已加载。Feedback
decoder 校验 counter 与 budget fact；stale 或 inconsistent result 会被拒绝，而不会破坏
active frontier。
