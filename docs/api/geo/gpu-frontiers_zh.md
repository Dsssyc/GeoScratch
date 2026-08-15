---
docId: geo.gpu-frontiers.zh
canonical: false
translationOf: ./gpu-frontiers.md
canonicalDigest: f5de99191b00505c337658f3721249dd00f3fe5087ce7d3bee5c54516a939754
---
# GPU Frontier

[English](./gpu-frontiers.md) | [Geo 概览](./README_zh.md)

GPU frontier 在 GPU 上完成有界空间选择与 draw preparation。`GpuTileFrontier` 根据
view/policy buffer 评估 resident tile metadata，输出紧凑 demand/visibility feedback，
并准备 indirect argument。CPU 代码更新 map/view metadata 并消费延迟 feedback；它不在
每帧遍历无限 world quadtree。

Render-patch frontier 与 raster residency 分离。它遍历不可变且 prefix-free 的 render
roots，而不是当前 source page，因此异步加载与 fallback 不会重定义 geometry topology。
即使 source raster detail 已达到上限，它仍按一个 grid cell 的局部 projected span 细化
terrain mesh patch。六平面 homogeneous clipping 提供可见求值位置；局部 projective
cell differential 同时避免离屏过度细化与 zoom-in 时的 viewport-edge 降级。Normalized
budget、有界 balance pass、hysteresis 与 revision token 共同保持选择稳定。Balanced cut
在生成 mesh-stitching flag 前，保证 edge-adjacent level difference 不超过一级。Trial
count 会在刚超过 render capacity 时立即饱和，因此不可采用的 fine cut 不会因 root 跨越
多个层级而产生无界遍历工作量。

只有 resident 或可 seed 的 metadata 能参与 GPU pass，因此延迟 demand 可能在后续帧才
生效。这是有意的 eventual refinement，并不宣称所有 desired tile 已加载。Feedback
decoder 校验 counter 与 budget fact；stale 或 inconsistent result 会被拒绝，而不会破坏
active frontier。
Render-patch feedback 报告 render-root 与 selected-cut fact，raster feedback 报告 data
demand 与 residency；两种 readback 都不会成为 CPU selection authority。
