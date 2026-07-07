# Geo API 总览

状态: Vision draft  
日期: 2026-07-06

## 目的

`geo` 是 `GeoScratch` 中面向地理可视化的上层编译与运行时。它不应成为传统意义上的 scene graph，也不应把游戏引擎的 `Material` / `MeshRenderer` / `GameObject` 心智模型套到地理数据上。它的职责是把地理数据、比例尺、样式、注记、符号、流式瓦片和动态可视化约束，编译成 `scratch` 能执行的 GPU resource、program、bind set、pipeline、command 和 submission。

`geo` 的目标是:

```text
source/layer/style/portrayal/constraint/render policy
        ↓
可验证、可解释、可回放的执行计划
        ↓
scratch GPU execution primitives
```

## 与 scratch 的边界

`scratch` 负责 GPU 执行内核:

```text
runtime
resource
layout codec
transfer/readback/query
bind layout / bind set
program / pipeline
command
pass spec / submission
machine-readable diagnostics
```

`geo` 负责地理可视化策略:

```text
CRS / projection / camera
source / schema / tile set
LoD / streaming / residency
layer / style / expression
portrayal / symbolizer
label placement / collision / layout constraint
render graph / resource graph at visualization level
explain / trace / profile / repro / semantic tests
```

一个判断规则:

```text
如果概念没有地图、地球、瓦片、属性字段、比例尺或地理语义也能成立，优先属于 scratch。
如果概念依赖地理数据语义、视图尺度、source/layer/style 或空间调度，属于 geo。
```

## AI 友好的核心含义

`geo` 面向 AI 时代，不是因为它支持自然语言，而是因为它提供这些机器可操作的契约:

1. **Canonical document**: 当前地图/场景状态可以被完整序列化。
2. **Patchable state**: 修改是结构化 patch，而不是任意 JS 副作用。
3. **Plan before apply**: 任何 patch 应先产生 plan、cost estimate、diagnostics 和 rollback point。
4. **Semantic schema**: 字段类型、单位、CRS、nullable、domain、统计分布、用途都可机器读取。
5. **Dependency graph**: style、layout、tile request、GPU technique、render graph 的依赖关系显式暴露。
6. **Explainability**: feature、pixel、layer、tile、frame、layout domain 都能解释。
7. **Reproducibility**: 异步瓦片、GPU device limit、runtime state 能被打包成最小复现案例。
8. **Structured diagnostics**: 错误不能只靠 prose message；应有 code、subject、expected/actual、suggested patch。
9. **Security and privacy**: source credential、network access、sensitive fields、export policy 是计划和验证的一部分。

## 非目标

`geo` 不应:

- 把 `Material` 作为通用地理对象渲染抽象。
- 要求每个 feature、tile 或 label 是独立运行时对象。
- 使用 ECS/mailbox 式对象间通信解决大规模布局约束。
- 把瓦片流式加载藏成不可观察的内部缓存。
- 把 style expression 当成无法分析的任意 JavaScript 函数。
- 把 render graph、tile cache、layout result、placement rejection reason 隐藏在 renderer 内部。
- 允许 AI 绕过 patch/plan/validate 直接修改 runtime 内部对象。

## 推荐层次

```text
GeoVizDocument
    project-level canonical IR

SourceSystem
    data source, schema, tile index, loader, residency, cache

StyleSystem
    expression, dependency analysis, style plan, GPU lowering

PortrayalSystem
    feature -> portrayal instruction / visual candidates

LayoutSystem
    collision, placement, priority, decluttering, constraint solving

RenderPlanningSystem
    render products, pass graph, resource graph, scratch lowering

RuntimeObservation
    explain, trace, profile, diagnostics, repro, assertions

AgentInterface
    plan/apply tools, MCP resources, llms docs, migration and codemod
```

## 设计轴

`geo` 抽象的评判轴应是:

```text
是否让地理可视化状态更可验证、更可解释、更可回放？
```

不是:

```text
API 是否最短？
是否最像现有地图框架？
是否最像游戏引擎？
是否隐藏了最多复杂性？
```

隐藏复杂性不是目标。目标是把复杂性拆成可计划、可验证、可观察的中间层。
