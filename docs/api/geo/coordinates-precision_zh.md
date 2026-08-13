---
docId: geo.coordinates-precision.zh
canonical: false
translationOf: ./coordinates-precision.md
canonicalDigest: ea96a783b724a41b6e36af3e839bedd7b255ab4de0b4d085e3411c9cc296010c
---
# 坐标与精度

[English](./coordinates-precision.md) | [Geo 概览](./README_zh.md)

Coordinate domain 在选择 storage 或 rendering 之前描述 dimension axis、surface
semantics、auxiliary axis、wrapping 与 canonical unit。`localVector` 将平移不变的值与
绝对 position 分开。Web Mercator 提供 projection constant、geographic/projected
conversion、tile bounds 与稳定 address codec；它只是一个 model，不是 Geo 的定义。

Position codec 保持大世界稳定性，而不要求每个动态 vertex 都携带 JavaScript
double-double value。`WideFixedCodec` 将 canonical position 存为宽整数 cell 与局部
component。`CellLocalF32Codec` 把工作转到 camera-relative cell-local frame，使 shader
中的 f32 保持较小。WGSL helper 从紧凑 integer/f32 input 重建相对位置与 tile address。

Canonical position 与 origin 保持独立权威。Camera 移动更新 origin transform，而非
重建所有静态 vertex buffer。粒子积分或 stitched terrain vertex 等动态 shader 工作
保持局部，并周期性 rebase cell，避免 f32 drift 无界增长。Codec 暴露 precision 与
overflow fact；它不会暗中 clamp 或选择 CRS。
