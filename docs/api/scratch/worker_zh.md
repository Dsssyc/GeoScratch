---
docId: scratch.worker.zh
canonical: false
translationOf: ./worker.md
canonicalDigest: c084f2ef5c01bb2a4b07ec828151610209afc2f4630538a1b40039fb7af4501c
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

`WorkerOperationProtocol`、`WorkerContextProtocol` 与 `WorkerModuleProtocol` 允许
contract 在 caller 或 Worker implementation 出现前声明 operation 的 input/output type。
同一份声明会检查 `contract.implement(...)`；当 pool 以该 operation map 参数化时，也会
检查 `WorkerContextPool.run(...)` 调用。Protocol 是编译期 contract；对于不可信数据
边界，runtime validation 仍由 module 负责。

`WorkerContextPool` 拥有一个固定 group 及其 retained context。Descriptor 必须声明
`WorkerSystem` 是 `borrowed` 还是 `owned`；pool dispose 始终释放 group 与 context，
且只在 owned 情况下释放 system。初始化在分配前校验完整 context set，并回滚部分资源。
空闲 pool 会给予每个 context 的远端 finalizer 一个有界 grace period。如果仍有 queued 或
active work，或远端 finalizer 超过该期限，dispose 会优先通过 group termination 保证收敛，
使 non-cooperative 应用代码无法无限占有 lifecycle。`inspect()` 公开 ownership、配置期限
以及可区分远端正常清理与强制收敛的 disposal mode，但不返回原始 context handle。

`TaskPhaseBudget` 独立限制 fetch、decode 等稀缺异步阶段，避免大量 Worker 倍增网络或
decoder 压力。Worker 诊断保留远端 name、message、stack、task/module 身份与取消类型。
`recommendedWorkerCount` 提供有界 host-capacity 默认值；`workerRemoteErrorFacts` 与
`workerRemoteErrorCode` 只从带 Scratch brand 的 Worker diagnostic 读取应用错误事实。
系统不知道 tile、DEM、cache、GPU upload 或业务 operation；这些都是注入的 module 与
应用编排。

## 相关决策

- `docs/decisions/ADR-056-generic-worker-webmercator-virtual-raster-cache.md`
- `docs/decisions/ADR-070-static-worker-module-artifacts.md`
- `docs/decisions/ADR-072-worker-context-pool-and-typed-protocols.md`
