---
docId: scratch.gpu-programs-bindings.zh
canonical: false
translationOf: ./gpu-programs-bindings.md
canonicalDigest: af48713f689311153b5d1380e75304c3b0a7fd09c10c45af77ad5bf3bb9ab842
---
# Program 与 Binding

[English](./gpu-programs-bindings.md) | [Scratch 概览](./README_zh.md)

Program、shader module、layout、bind set 与 pipeline 是彼此分离的组合单元。
`ShaderModule` 拥有 source part 和 compilation evidence。`Program` 标识 entry point、
stage 与声明的 buffer-layout requirement。Pipeline 将 program 与显式原生状态组合，
并可异步创建，不会假装 compilation 已同步完成。

`LayoutCodec` 与不可变 layout artifact 是 CPU/WGSL 共用 schema 模型。它们计算
alignment、size、runtime-array extent，pack/unpack value，生成 WGSL accessor，并区分
schema compatibility 与 ABI compatibility。Buffer 只是 storage；同一个 allocation
可以在不同时刻匹配不同的兼容 view。

`BindLayout` 描述 slot 与 visibility。`BindSet` 绑定 resource，并必须在执行前针对
当前 allocation version 完成 prepare。Prepare 是幂等 realization 步骤，不是全局状态机，
也不是永久绑定。Shader inspection 提供保守证据和诊断；它不能替代原生 WebGPU validation，
也不把 source text 当作 runtime 成功证明。
