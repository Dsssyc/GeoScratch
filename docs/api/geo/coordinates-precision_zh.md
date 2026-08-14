---
docId: geo.coordinates-precision.zh
canonical: false
translationOf: ./coordinates-precision.md
canonicalDigest: 41fde642f5a0ac4697f27cb333e741a4321fb96fc85c1c3ecbf745e30fca1e32
---
# 坐标与精度

[English](./coordinates-precision.md) | [Geo 概览](./README_zh.md)

Coordinate domain 在选择 storage 或 rendering 之前描述 dimension axis、surface
semantics、auxiliary axis、wrapping 与 canonical unit。`localVector` 将平移不变的值与
绝对 position 分开。Web Mercator 提供 projection constant、geographic/projected
conversion、tile bounds 与稳定 address codec；它只是一个 model，不是 Geo 的定义。

Position codec 保持大世界稳定性，而不要求每个动态 vertex 都携带 JavaScript
double-double value。`WideFixedCodec` 将每个有符号 canonical axis 存为两个 u32 limb。
它生成的 WGSL 包含精确 shifted-u32 construction、signed wide-axis conversion、signed
difference、fractional normalization 与 expansion subtraction helper。其中
`<namespace>_signed_difference_f32` 先执行整数减法再转换为 f32；
`<namespace>_fraction_f32` 则无需先生成巨大的 global f32 position 就能得到归一化
logical coordinate。

`CellLocalF32Codec` 把动态工作转到 camera-relative cell-local frame，使 shader 中的
f32 保持较小。WGSL helper 从紧凑 integer/f32 input 重建相对位置与临时 LoD address；
per-vertex buffer 不携带重复的七字段 physical tile address。

Canonical position 与 origin 保持独立权威。Camera 移动更新 origin transform，而非
重建所有静态 vertex buffer。粒子积分或 stitched terrain vertex 等动态 shader 工作
保持局部，并周期性 rebase cell，避免 f32 drift 无界增长。静态 terrain 从 logical
patch identity 与 local grid coordinate 推导 canonical wide-fixed position，因此 camera
变化不会重建 vertex buffer。Codec 暴露 precision 与 overflow fact；它不会暗中
clamp、有符号溢出后 wrap，也不会选择 CRS。
