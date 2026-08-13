---
docId: scratch.gpu-readback-observation.zh
canonical: false
translationOf: ./gpu-readback-observation.md
canonicalDigest: 22fb5e22008e1cb41ec7318698eb7da0d282f565008600d8038a9829131eedd7
---
# Readback 与观测

[English](./gpu-readback-observation.md) | [Scratch 概览](./README_zh.md)

Readback 是显式 GPU 工作，之后再显式 host mapping。`ReadbackOperation` 记录 source、
byte layout、retention policy、mapping provenance 与 lifecycle。`ReadbackCommand` 将
staging copy 放入 submission 顺序，因此观测不会暗中与前面的 write 竞争。Texture
readback 显式暴露 origin、extent、row pitch 与 padding，不会假装 image row 总是紧密排列。

`MappedReadbackLease` 拥有打开的 mapped range。只有 lease 有效时才能访问 byte 或
typed value，除非调用方显式复制。Retention policy 控制是否保留 staging allocation
以便复用；它不会延长逻辑 source resource 的寿命。

Readback 不会在 getter 中隐式发生，也不会令 GPU execution 变成同步。Epoch provenance
允许调用方验证观测的是哪一版内容，而原生 completion 与 mapping failure 仍保持异步并
可通过诊断查看。
