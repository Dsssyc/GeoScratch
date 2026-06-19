# 总览

状态: Vision draft
日期: 2026-06-20

## 目的

新的 `scratch` API 应减少 WebGPU 样板工作，同时保留直接 GPU 控制能力。它应该是图形执行内核，而不是地理场景图，也不是为每种渲染技术准备的配置式 DSL。

`scratch` 应降低这些重复低层工作的负担:

- runtime 与 device 生命周期
- 资源身份、替换、readiness、dirty 更新
- bind layout 与 bind group 构建
- pipeline 缓存与兼容性
- command readiness 与资源依赖校验
- frame 提交与空工作跳过

`scratch` 不应拥有领域策略:

- 地图、地球、笛卡尔或混合空间语义
- 瓦片遍历、LoD、流式加载或淘汰策略
- 地形、流场、矢量、影像或点云行为
- 图层历史、重投影、相机到资源的策略

这些属于 `geo` 或更上层应用。

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
scratch = explicit GPU runtime + resources + bindings + pipelines + commands + frame scheduler
geo     = spatial models + layer policy + geospatial resource loading and orchestration
```

API 应足够显式，使特殊 WebGPU 工作负载仍能被表达。可以存在 helper，但 helper 不应遮蔽底层 resource、pipeline、pass、command 模型。

## 形状与时间

Descriptor 适合描述稳定形状:

- buffer 与 texture usage
- shader module 与 entry point
- bind layout entry
- pipeline 静态状态
- pass attachment 形状

Descriptor 不适合承担时间变化行为:

- 当前帧运行哪些 command
- 哪些资源 ready
- 读取或写入哪个资源版本
- 是否跳过 pass
- 是否 prepare dirty resource
- command count 是静态、动态还是 indirect

动态行为应由 resource state、command state 和 frame scheduling 表达。

## 必须清晰的心智模型

新 API 应让这些边界很难被误解:

- `ScratchRuntime` 拥有 GPU device 状态与缓存。
- `Surface` 拥有呈现目标配置，不拥有 GPU 执行上下文。
- `Resource` 是带有物理 GPU 对象版本的逻辑句柄。
- `BindLayout` 描述 shader binding 形状。
- `BindSet` 把具体资源绑定到 layout。
- `Pipeline` 描述稳定 GPU 程序状态。
- `Command` 描述一个可执行 GPU 动作。
- `PassSpec` 描述稳定 pass 形状。
- `Frame` 按显式顺序把 commands 记录进 pass specs 并提交。
