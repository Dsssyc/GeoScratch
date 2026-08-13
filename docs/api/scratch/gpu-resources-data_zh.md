---
docId: scratch.gpu-resources-data.zh
canonical: false
translationOf: ./gpu-resources-data.md
canonicalDigest: f937ed0d6bf8fa6cdb5cd3821ade23d5b604e5f7bb5ea3c11453eb4029249f1c
---
# GPU 资源与数据

[English](./gpu-resources-data.md) | [Scratch 概览](./README_zh.md)

`Resource` 为 GPU allocation 提供稳定逻辑身份、runtime owner、dispose 状态、
`allocationVersion` 与 `contentEpoch`。Allocation replacement 与 content mutation 是
不同事实：替换原生 storage 会改变 allocation 身份；成功写入推进内容历史。因此
command 能在提交前拒绝 stale view、cross-runtime use 或未满足的 read epoch。

`BufferResource`、`BufferRegion`、`TextureResource`、`TextureViewSpec` 与
`SamplerResource` 保留原生 WebGPU descriptor，同时显式表达所有权与兼容性。Buffer
mapping 使用 `MappedBufferLease`；host mapping 打开期间，该 lease 是排他的权威，
并阻止冲突的 GPU 使用。

Resource 不会从任意 JavaScript 属性变化中推断 upload、readback、schema 或同步。
Layout interpretation、command 与 submission 相互分离。调用方必须释放 owned resource，
也不能让 native/view handle 超出创建它的逻辑权威生命周期。
