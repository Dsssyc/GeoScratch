---
docId: scratch.worker.zh
canonical: false
translationOf: ./worker.md
canonicalDigest: 54c61994ca7d9b957ed422ba1b6cef8a220a59881bee8df018fcc0d1028737c0
---
# Worker 执行

[English](./worker.md) | [Scratch 概览](./README_zh.md)

`WorkerSystem` 是领域无关的 CPU 并发边界。应用创建有界 group，并显式配置 module
allowlist、isolation、queue/active limit、priority、idle reclamation、cancellation 与
history。Task 和保留 context 都有可观测状态的 handle；dispose 是显式操作，且不与
`GPURuntime` 共享 lifecycle authority。

Worker module 从源码到部署使用同一个 typed contract。`defineWorkerModuleContract`
提供稳定身份，`defineWorkerModule` 提供 operation 与可选 stateful context，
`defineWorkerModuleBuild` 注册独立 artifact。`WorkerModuleCatalog` 解析生成的 manifest，
不依赖 Vite 专用 URL 约定。Transfer result 显式表达 ownership movement。

`TaskPhaseBudget` 独立限制 fetch、decode 等稀缺异步阶段，避免大量 Worker 倍增网络或
decoder 压力。Worker 诊断保留远端 name、message、stack、task/module 身份与取消类型。
系统不知道 tile、DEM、cache、GPU upload 或业务 operation；这些都是注入的 module 和
应用编排。
