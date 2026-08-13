---
docId: scratch.gpu-runtime-surface.zh
canonical: false
translationOf: ./gpu-runtime-surface.md
canonicalDigest: 65898a04d06a9467a056d644f807d2f76efcb0e592682b893e1b3a4379f85e7d
---
# GPU Runtime 与 Surface

[English](./gpu-runtime-surface.md) | [Scratch 概览](./README_zh.md)

`GPURuntime.create()` 是显式异步 device 边界。一个 runtime 拥有 adapter、device、
queue、capability、diagnostics、resource registry 与 submission authority。创建过程
不需要 canvas。Device loss 和 dispose 会推进 lifecycle authority，使陈旧异步完成
无法修改更新后的状态。

`Surface` 是单独拥有的 canvas context presentation 状态。它可以 configure、resize
和 dispose，而不释放 runtime。当前 swap-chain texture 是临时的：
`SurfaceTextureLease`、`SurfaceTextureView` 和 external texture binding 都是
attempt-local handle，不是持久资源。它们不能逃逸 WebGPU 定义的获取/提交区间。

Runtime 不选择 render loop、camera、scene 或 map；surface 不拥有 device。应用可以让
一个 runtime 拥有多个 surface，但 runtime ownership validation 会阻止资源意外跨
device 使用。
