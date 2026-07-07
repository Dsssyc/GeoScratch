# Geo API Vision 文档集

状态: Vision draft  
日期: 2026-07-06

本目录是对 `GeoScratch` 上层 `geo` API 的智能友好设计补充。它假设 `scratch` 已经保持为显式 WebGPU/GPGPU 执行内核：runtime、resource、layout codec、transfer、bind layout、program、pipeline、command、submission、diagnostics 与 scheduler。`geo` 层不应反向污染 `scratch`，但必须把地理可视化中真正困难的部分——数据语义、瓦片流式加载、比例尺、样式、注记、约束求解、可解释性、可回放性与 agent 操作协议——纳入公开契约。

## 设计目标

`geo` 层的目标不是提供一个更漂亮的地图 API，而是提供一个 **地理可视化编译器与可观测运行时**：

```text
Human / AI Intent
        ↓
GeoVizDocument / Patch / Plan
        ↓
Semantic Validation
        ↓
SourcePlan / StylePlan / PortrayalPlan / LayoutPlan
        ↓
Tile Scheduler / Resource Residency / RenderGraph
        ↓
Scratch Program / BindSet / Pipeline / Command / Submission
        ↓
Explain / Trace / Profile / Repro / Tests
```

核心原则:

1. **项目状态必须可序列化。** AI 不应通过不可见对象图、闭包和事件副作用理解地图状态。
2. **修改必须可计划。** 在 `apply` 前必须能 `plan`、`diff`、`validate` 和 `rollback`。
3. **地理语义必须可机器读取。** 字段单位、坐标系、nullable、domain、classification、geometry role 等不是注释，而是 schema。
4. **样式不是 material。** 地理可视化核心是 source/layer/style/portrayal/constraint，而不是 surface material。
5. **运行时必须可解释。** 不仅要解释错误，还要解释为什么某个 feature 显示、隐藏、变色、被遮挡、被 label collision 拒绝。
6. **流式和 LoD 是一等问题。** Tile request、residency、epoch、fallback、degradation、budget 不能藏在内部缓存里。
7. **agent 工具接口是公开能力。** AI 应通过受限工具调用修改项目，而不是任意生成命令式 JS。

## 模块地图

- `00-overview/`: `geo` 层定位、与 `scratch` 的边界、智能友好目标。
- `01-geoviz-document-ir/`: Canonical `GeoVizDocument`、patch、diff、checkpoint、transaction。
- `02-source-schema-fields/`: Source schema、字段语义、CRS、单位、统计摘要、GPU lowering。
- `03-layers-styles-expressions/`: Layer、style、expression、style dependency graph、style plan。
- `04-portrayal-layout-constraints/`: Portrayal instruction、候选生成、注记/符号布局、collision domain、约束求解。
- `05-tiles-lod-streaming-residency/`: 瓦片、LoD、流式加载、资源驻留、cache、预算和降级。
- `06-render-resource-graph/`: RenderGraph、ResourceGraph、RenderProduct、与 `scratch` submission 的衔接。
- `07-explain-trace-profile/`: explain/trace/profile API、像素/feature provenance、布局和性能解释。
- `08-plan-patch-migration/`: planPatch、cost estimate、semantic diff、migration、deprecation/codemod。
- `09-agent-tools-mcp-llms/`: MCP/tooling、`llms.txt`、machine-readable docs、agent 操作协议。
- `10-repro-tests-security/`: Repro capsule、semantic assertions、安全、credential、network policy。

## 顶层决策

- `geo` 是 `scratch` 之上的地理可视化策略层。它可以有 source、layer、style、symbolizer、portrayal、tile、LoD、camera、projection、layout 和 render graph，但这些概念必须降低到 `scratch` primitives，而不能进入 `scratch` core。
- `GeoVizDocument` 是项目状态的 canonical representation。命令式 API 是对 document patch 的便利封装，不应成为唯一真相源。
- `Style` 描述数据到视觉变量的函数。`Portrayal` 描述地理对象如何转成候选视觉表达。`Layout/Constraint` 描述候选表达在当前视图中如何被接受、拒绝、移动或降级。
- `Material` 只允许作为可选 surface-rendering helper 存在，例如 glTF-like mesh 或 terrain surface appearance。通用地图、海图、点云、热力图、label、符号、aggregation 不使用 material 作为核心抽象。
- AI 友好不是自然语言接口。AI 友好意味着状态、错误、计划、性能、依赖、测试和安全边界都可机器读取。
