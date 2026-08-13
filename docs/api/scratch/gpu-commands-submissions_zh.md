---
docId: scratch.gpu-commands-submissions.zh
canonical: false
translationOf: ./gpu-commands-submissions.md
canonicalDigest: 9cc6858f0cf4c16eaf3f5297c73cf4b3a055c4d7c46160f077a386cdbe4fd1c5
---
# Command 与 Submission

[English](./gpu-commands-submissions.md) | [Scratch 概览](./README_zh.md)

Command 是不可变的原生工作描述。Scratch 直接表达 draw、indexed/indirect draw、
dispatch/indirect dispatch、WebGPU 支持的所有 buffer/texture copy 方向、upload、clear、
query、readback、external image upload、debug marker 与 render-bundle execution。
Render/compute pass spec 描述 encoder 边界，而不创建 scene graph。

`SubmissionBuilder` 在一个 runtime timeline 上排列 pass step 与 queue action。它校验
ownership、mapping authority、content epoch、readiness policy、temporal handle、resource
conflict 与 query state，再生成可检查凭据 `SubmittedWork`。`SubmissionAuthority` 为
异步 revision 加戳，使陈旧 prepare 或 feedback 结果无法覆盖更新后的 intent。

Scratch 不会自动重排 dependency，也不隐藏 queue submission。调用方显式选择 strict、
fallback 或 skip readiness 行为。Validation failure 是结构化诊断；原生 completion 与
error-scope evidence 仍是附着在 submitted work 上的异步事实。
