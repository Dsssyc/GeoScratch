---
docId: scratch.diagnostics.zh
canonical: false
translationOf: ./diagnostics.md
canonicalDigest: 95507d868bf0a4381ff728ec8d100d805f1cab4e0df4fbb7e12fe55ccd51fc15
---
# 诊断

[English](./diagnostics.md) | [Scratch 概览](./README_zh.md)

诊断是机器可读证据，而不是 console 文本。诊断包含稳定的 domain、code、severity、
phase、subject、evidence、expected/actual 事实、suggestion 和关联记录。
`ScratchDiagnosticError` 让一个诊断通过异常控制流传播，同时保留其结构。

GPU 诊断还包含有界 operation record、pending-operation fact、原生错误结果、资源
epoch、压力证据与事件归因。`GPURuntimeDiagnostics` 拥有一个 runtime 的有界 ledger；
capture 对象定义显式观测窗口。Ledger 是诊断历史，不是无限帧日志，也不能替代
WebGPU error scope 或 `device.lost`。

调用方拥有报告保留和导出责任。Runtime/resource 标识建立 provenance，但诊断不拥有
GPU 资源，也不会延长其寿命。异步原生错误只能依据最强可用 scope 与时间线证据归因；
API 不会为异步 WebGPU validation 或 OOM 虚构同步成功保证。

领域无关记录使用 `createScratchDiagnostic`，关联 GPU operation 时使用 GPU 专用报告
类型。程序应根据 code 和 fact 分支，而非匹配 message 文本。
