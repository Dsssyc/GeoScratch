# Scratch API 重设计

状态: Vision draft
日期: 2026-06-30

本目录记录下一版 `scratch` API 的模块化目标设计。它把 `docs/vision/scratch-graphics-kernel.md` 中的 GPU 内核方向拆成更小的接口层级。

这里的文档是设计参考，不代表实现已完成。修改 `packages/geoscratch/src/gpu/`、`packages/geoscratch/src/scratch.js` 或公开 `scratch` API 形状前，应先阅读这些文档。

## 模块地图

- `00-overview/`: 设计原则、0.x 破坏性重构策略、API 边界
- `01-runtime-surface/`: 显式异步 runtime 与 canvas surface 分离
- `02-resources/`: 逻辑资源、allocation version、content epoch、readiness、资源替换
- `03-bindings/`: 显式 bind layout、bind set、bind group 缓存、shader 检查辅助
- `04-pipelines-commands/`: 稳定 pipeline 与可执行 GPU command
- `05-passes-submissions-scheduler/`: 持久 pass spec、submission builder、submitted work、scheduler 校验
- `06-design-review/`: 从 AI 辅助编写与通用 compute 对等性两个角度，对 `00`–`05` 的评审
- `07-transfers-epochs/`: submission-scoped transfer、allocation version、content epoch 与 readback operation 生命周期(解决缺口 2–4)

每个模块都包含英文 `README.md` 和中文 `README_zh.md`。

## 已确认的顶层决策

- `scratch` 是 GPU 执行内核(compute 与图形同级)。`geo` 负责场景、空间、图层、瓦片、加载和地理可视化策略。
- 在 `0.x.x` 阶段，允许并鼓励为了清理过时概念而进行破坏性 API 重设计。
- 现有 API 只是需求样本和反例材料，不是兼容性约束。
- 核心 API 使用显式异步 `ScratchRuntime`。内核契约中不保留隐式全局 device。
- `Surface` 与 `ScratchRuntime` 分离；runtime 必须支持 compute-only 和 offscreen 工作流。
- 资源是逻辑句柄，并持有 physical GPU allocation version 与 content epoch。
- 资源缺失或未 ready 时的策略必须由 command 或 pass 使用点显式声明。
- CPU/GPU transfer 必须显式表达: upload、readback、copy 是 command 或 operation，不是隐藏的 `Resource` 方法。
- `ReadbackOperation` 有显式生命周期、retention、cancellation、disposal、budget 与 diagnostic 语义。
- 核心 API 中 bind layout 必须显式声明。Shader reflection 只作为开发辅助或校验工具。
- `Command` 是 draw、dispatch、copy、upload 等可执行 GPU 动作的统一名称。
- `PassSpec` 表达持久 pass 形状。`SubmissionBuilder` 把 pass spec 与当前 command 列表绑定; `.submit()` 返回 `SubmittedWork`。
- 第一版 scheduler 采用显式 submission 顺序加依赖校验。自动排序属于可选上层编排能力。
- `Frame` 不是 scratch core submission type。Frame cadence 属于 `geo`、应用或 presentation loops。
