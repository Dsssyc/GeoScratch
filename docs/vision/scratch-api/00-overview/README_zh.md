# 总览

状态: Vision draft
日期: 2026-07-16

## 目的

新的 `scratch` API 应在保留直接 GPU 控制能力的同时，最大化"可局部验证的正确性"。它应补上裸 WebGPU 缺失的约束与检查，而不引入隐藏行为。它是 GPU 执行内核——compute 与图形是同级用途——而不是地理场景图，也不是为每种渲染技术准备的配置式 DSL。

`scratch` 应降低这些重复低层工作的负担:

- runtime 与 device 生命周期
- 真实 resource identity、经确认的 allocation、逻辑 BufferRegion/TextureViewSpec selection、replacement、readiness、content epoch 与显式 transfer
- layout artifact、layout codec 与 shader accessor 生成
- acknowledged bind-layout construction 与显式 BindSet preparation
- shader program 组合与 pipeline cache 兼容性
- command readiness 与资源依赖校验
- machine-readable diagnostics 与 validation reports
- submission 记录、完成等待与空工作跳过

`scratch` 不应拥有领域策略:

- 地图、地球、笛卡尔或混合空间语义
- 瓦片遍历、LoD、流式加载或淘汰策略
- 地形、流场、矢量、影像或点云行为
- 图层历史、重投影、相机到资源的策略

这些属于 `geo` 或更上层应用。

## 设计轴

上面的目标隐含一条评判任何抽象的轴: 它应该 **加约束和检查**，而不是 **加隐藏行为**。一个抽象可以比裸 WebGPU 更抽象，同时更可验证——只要行为保持显式且局部。裸 WebGPU 是"最少抽象"的极限，却是最不可验证的接口面: 它的有效性规则是隐式的，许多逻辑错误会静默地给出错误结果而不是报错。

两条推论:

- 保留显式、"啰嗦"的接口面——声明式 resource access、显式 transfer operation、显式 `BindLayout`、显式 submission 顺序。不要仅仅为了简洁就自动推断它们。由作者写出、再由 validator 校验的样板是可接受的; 歧义和隐藏状态则不可接受。
- 每个有状态的"聪明"特性(allocation version、content epoch、readiness、device-loss rehydration)都必须暴露可 inspect、可 assert 的状态。一个藏起"为什么发生了重建"的特性是净负值。

## 0.x 破坏性重构策略

GeoScratch 仍处于 `0.x.x`。新的 `scratch` API 可以在清理过时概念、避免旧模型约束内核时破坏旧 API。

现有 API 应被视为:

- 真实用例的证据
- 仍然有效时值得保留的人体工学样本
- 迁移测试的参考
- 职责混杂处的警示材料

在项目明确稳定 `1.x.x` 契约前，现有 API 不应被视为兼容性要求。

## 核心边界

目标模型是:

```text
scratch = explicit GPU runtime + resources + layout codecs + transfers + bindings + programs + pipelines + commands + diagnostics + submission scheduler
geo     = spatial models + layer policy + geospatial resource loading and orchestration
```

API 应足够显式，使特殊 WebGPU 工作负载仍能被表达。可以存在 helper，但 helper 不应遮蔽底层 resource、pipeline、pass、command 模型。

`scratch` 不能加入 `Material` 层。material-like 抽象会耦合 shader program、数据值、视觉表面语义与对象赋值关系。它属于 `geo`、应用或可选 scene helper。scratch core 保持拆分: `Program` 声明 shader 代码契约，`BindSet` 提供具体资源，`Pipeline` 描述稳定 WebGPU 可执行状态，`Command` 执行一个显式 GPU 动作。

## 形状与时间

Descriptor 适合描述稳定形状:

- buffer 与 texture usage
- shader module 与 entry point
- bind layout entry
- pipeline 静态状态
- pass attachment 形状

Descriptor 不适合承担时间变化行为:

- 当前 submission 运行哪些 command
- 哪些资源 ready
- 绑定哪个 allocation version
- 读取或写入哪个 content epoch
- 是否跳过 pass
- 是否 prepare dirty resource
- command count 是静态、动态还是 indirect

动态行为应由 resource state、command state 和 submission scheduling 表达。

## 必须清晰的心智模型

新 API 应让这些边界很难被误解:

- `ScratchRuntime` 拥有 GPU device 状态与缓存。
- 被覆盖的原生 allocation 是返回 Promise 的 GPU operation。只有 validation、internal、out-of-memory scope 与 lifecycle recheck 都成功 settle 后，逻辑资源才会安装。
- `Surface` 拥有呈现目标配置，不拥有 GPU 执行上下文。
- `Resource` 拥有 logical identity、allocation lifecycle 与 disposal。只有 BufferResource 与 TextureResource 拥有 scalar content/readiness fact；SamplerResource 没有这些事实，QuerySetResource 则拥有 indexed slot facts。
- `BufferRegion` 与 `TextureViewSpec` 是同步、不可变的 selection/interpretation value，不是 resource 或 native allocation。
- `QuerySetResource` 是 indexed query-slot resource，不是无序集合，也不是 shader binding。
- Transfer operation 显式移动 CPU/GPU 或 GPU/GPU 边界上的数据，并推进 content epoch。
- `LayoutCodec` 是连接 CPU packing、WGSL accessor、readback view 与 layout diagnostics 的准备期 artifact。
- `BindLayout` 是 Promise-only acknowledged native binding ABI。
- `BindSet` 冻结显式 BufferRegion/TextureViewSpec/SamplerResource binding，并只在 initial native snapshot prepared 后返回。Allocation replacement 要求显式 `prepare()`；submission 绝不修复它。
- `Program` 描述 shader source、生成模块、entry points 与所需 layouts，但不拥有具体资源。
- `Pipeline` 描述某个 `Program` entry point 的稳定 WebGPU 可执行状态。公开 render 与 compute factory 只返回 Promise；只有原生异步创建、compilation evidence、supporting-object scopes 与 lifecycle checks 全部成功 settle 后才暴露 wrapper。
- `Command` 描述一个可执行 GPU 动作。
- Draw/Dispatch resource read 必须声明一个精确 numeric content epoch 或 `'current-at-step'`。后者只在最终选中 command 的位置，基于显式前序 submission steps、且在该 command 自身 write 前解析一次；它不重排工作，也不改写 command。
- `ScratchDiagnostic` 是统一 machine-readable validation contract; prose message 不是稳定 API。
- `runtime.diagnostics` 将始终当前的事实、有界近期 operation、不可变 incident 与显式临时 deep capture 分开。
- GPU operation evidence 使用 schema v5 discriminated Resource、Pipeline、BindLayout、BindSet、Command、Readback 与 Submission target。任何 fact 都不借用不属于其 object kind 的字段。
- `PassSpec` 描述稳定 pass 形状。
- `SubmissionBuilder` 按显式顺序把 commands 记录进 pass specs。
- `SubmittedWork` 是 `.submit()` 返回的可 inspect 句柄。它的 native outcome 与 `done` boundary 报告 observed submission、queue-completion 与 lifecycle facts，但不等待 readback mapping 或 host copy。
- `Frame` 不是 scratch core type; frame cadence 属于 `geo`、应用或 presentation loops。
