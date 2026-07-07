# GeoScratch Geo API Vision 文档合集

状态: Vision draft  
日期: 2026-07-06



---

<!-- Source: README_zh.md -->

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


---

<!-- Source: 00-overview/README_zh.md -->

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


---

<!-- Source: 01-geoviz-document-ir/README_zh.md -->

# GeoVizDocument 与 Canonical IR

状态: Vision draft  
日期: 2026-07-06

## 决策

`GeoVizDocument` 是 `geo` 层项目状态的唯一 canonical representation。命令式 API 可以存在，但它们必须降低为对 `GeoVizDocument` 的 patch。运行时对象、事件回调、闭包和内部缓存不能成为项目真相源。

AI 友好的前提是: agent 能读取当前状态、提出局部修改、预估影响、验证结果、回滚失败修改。没有 canonical IR，AI 只能在对象图和副作用中猜测系统状态。

## 目标形状

```ts
type GeoVizDocument = {
    version: string
    metadata?: DocumentMetadata
    sources: Record<string, SourceSpec>
    schemas?: Record<string, SourceSchema>
    layers: LayerSpec[]
    styles?: Record<string, StyleSpec>
    portrayal?: PortrayalCatalogueSpec | PortrayalRuleSetSpec
    constraints?: ConstraintSpec
    render?: RenderPolicySpec
    budgets?: BudgetSpec
    security?: SecurityPolicySpec
    diagnostics?: DiagnosticPolicySpec
    extensions?: ExtensionSpec[]
}
```

## 设计原则

### 1. Document 是语义状态，不是 runtime dump

Document 不应保存 volatile GPU 对象、当前 command buffer、具体 `GPUBuffer`、worker task、Promise 或 callback。它描述“应当是什么”，而 runtime 描述“现在执行到哪里”。

```text
GeoVizDocument: source/layer/style/policy 的目标状态
GeoRuntimeState: tile cache、resource residency、render products、diagnostics、metrics
ScratchRuntime: GPU device/resource/submission 状态
```

### 2. 所有变更都是 patch

推荐 patch envelope:

```ts
type GeoVizPatch = {
    id?: string
    author?: 'human' | 'agent' | 'system'
    reason?: string
    baseRevision?: string
    operations: GeoVizPatchOperation[]
}

type GeoVizPatchOperation =
    | { op: 'add-source', id: string, value: SourceSpec }
    | { op: 'remove-source', id: string }
    | { op: 'add-layer', value: LayerSpec, before?: string, after?: string }
    | { op: 'remove-layer', id: string }
    | { op: 'set-layer-property', layer: string, path: string, value: unknown }
    | { op: 'set-style-property', style: string, path: string, value: unknown }
    | { op: 'set-budget', path: string, value: unknown }
    | { op: 'set-security-policy', path: string, value: unknown }
    | { op: 'reorder-layer', id: string, before?: string, after?: string }
```

JSON Patch 可作为底层表达，但 geospatial patch 应保留语义型操作。语义操作比裸路径操作更容易验证和解释，例如 `remove-source` 能检查是否仍有 layer 引用该 source。

### 3. Plan before apply

所有 patch 都应支持:

```ts
const plan = geo.planPatch(patch)
```

返回:

```ts
type GeoPatchPlan = {
    valid: boolean
    patchId?: string
    baseRevision: string
    diagnostics: GeoDiagnostic[]
    semanticDiff: SemanticDiff[]
    estimatedEffects: PatchEffects
    securityDiff?: SecurityDiff
    rollback?: RollbackToken
}

type PatchEffects = {
    sourcesAdded?: string[]
    sourcesRemoved?: string[]
    layersAdded?: string[]
    layersRemoved?: string[]
    stylePlansRecompiled?: string[]
    layoutDomainsInvalidated?: string[]
    tileRequestsChanged?: boolean
    tilesReloadedEstimate?: number
    gpuPipelinesAffected?: string[]
    scratchCommandsAffectedEstimate?: number
    gpuMemoryDeltaMB?: number
    networkRequestsEstimate?: number
    frameCostDeltaMsEstimate?: number
}
```

AI 不应直接 `applyPatch`，除非 plan 已经通过 validation policy。

### 4. Runtime state 以 snapshot 暴露

Document 之外需要 runtime snapshot:

```ts
type GeoRuntimeSnapshot = {
    documentRevision: string
    view: ViewState
    sources: Record<string, SourceRuntimeState>
    layers: Record<string, LayerRuntimeState>
    renderGraph?: RenderGraphSnapshot
    resourceGraph?: ResourceGraphSnapshot
    layoutProducts?: Record<string, LayoutProductSummary>
    diagnostics: GeoDiagnosticReport
    metrics: RuntimeMetrics
}
```

Snapshot 是只读事实，不应由外部直接 mutation。

## Versioning

Document 必须 versioned:

```ts
type DocumentMetadata = {
    createdWith?: string
    updatedWith?: string
    revision?: string
    createdAt?: string
    updatedAt?: string
    title?: string
    description?: string
}
```

推荐策略:

- `version` 是 document schema version，不是 npm package version。
- Runtime 应能读取旧 version 并产生 migration plan。
- 进入稳定期后，破坏性 document schema 变化必须提供 migration。

## Determinism

Document 序列化应稳定:

- layer order 是数组顺序。
- object key 如果参与 hash，应排序或显式 canonicalize。
- derived defaults 应在 plan 中可见，不能只在 renderer 内部隐式展开。
- patch plan 的 semantic diff 应 deterministic，便于 agent/test 断言。

## Checkpoint 与 rollback

```ts
type DocumentCheckpoint = {
    id: string
    revision: string
    documentHash: string
    label?: string
    createdBy?: 'human' | 'agent' | 'system'
}
```

API:

```ts
const cp = geo.checkpoint('before agent edit')
const plan = geo.planPatch(patch)
if (plan.valid) geo.applyPatch(patch)
else geo.rollback(cp)
```

Rollback 只回滚 document state；runtime cache 可以选择增量失效或重建。

## 与命令式 API 的关系

允许:

```ts
map.addLayer(new FillLayer({ ... }))
```

但它应等价于:

```ts
map.applyPatch({
    operations: [
        { op: 'add-layer', value: fillLayerSpec }
    ]
})
```

命令式 API 不能绕过 schema validation、plan、diagnostics 和 security policy。

## 非目标

- 不把 Document 做成 WebGPU resource dump。
- 不在 Document 中存储 Promise、closure、class instance 或 GPU handle。
- 不让 command-style mutation 成为唯一状态来源。
- 不把 runtime caches 序列化为 project truth。
- 不允许 agent 通过内部对象引用绕过 patch pipeline。


---

<!-- Source: 02-source-schema-fields/README_zh.md -->

# Source Schema、字段语义与数据发现

状态: Vision draft  
日期: 2026-07-06

## 决策

`geo` 层必须把 source schema 与 field semantics 作为一等公开契约。字段不只是名字和 JavaScript 类型；它还包含单位、坐标系、值域、nullable、分类/连续属性、统计摘要、GPU encoding、layout dependency 与安全标签。

AI 生成地理可视化代码时，最常见错误不是语法错误，而是语义错误: 把经纬度当米、把类别当连续变量、把字符串字段用于数值聚合、忽略 depth/height 单位、把 nullable 字段直接作为 extrusion height。Source schema 的目的就是把这些错误提前暴露给 validator 和 planner。

## SourceSpec

```ts
type SourceSpec = {
    id: string
    type:
        | 'vector-tile'
        | 'raster-tile'
        | 'terrain-dem'
        | 'point-cloud'
        | 'mesh-tiles'
        | 'geojson'
        | 'table'
        | 'custom'
    url?: string
    urls?: string[]
    data?: unknown
    schema?: SourceSchemaRef | SourceSchema
    crs?: CrsSpec
    tileScheme?: TileSchemeSpec
    loading?: SourceLoadingPolicy
    security?: SourceSecurityPolicy
    metadata?: Record<string, unknown>
}
```

## SourceSchema

```ts
type SourceSchema = {
    id?: string
    version?: string
    geometry?: GeometrySchema
    featureId?: FeatureIdSpec
    fields: Record<string, FieldSchema>
    relations?: RelationSchema[]
    indexes?: SpatialIndexSpec[]
    statistics?: SourceStatistics
    gpu?: SourceGpuLoweringSpec
}
```

## FieldSchema

```ts
type FieldSchema = {
    name: string
    type:
        | 'float32'
        | 'float64'
        | 'int32'
        | 'uint32'
        | 'int64'
        | 'uint64'
        | 'boolean'
        | 'string'
        | 'category'
        | 'datetime'
        | 'json'
    semantic?:
        | 'longitude'
        | 'latitude'
        | 'height'
        | 'depth'
        | 'elevation'
        | 'population'
        | 'density'
        | 'speed'
        | 'time'
        | 'class'
        | 'name'
        | 'identifier'
        | 'weight'
        | 'uncertainty'
    unit?:
        | 'm'
        | 'ft'
        | 'degree'
        | 'radian'
        | 'px'
        | 's'
        | 'ms'
        | 'kg'
        | 'count'
        | 'ratio'
        | 'unknown'
    nullable: boolean
    domain?: NumericDomain | CategoricalDomain | TemporalDomain
    stats?: FieldStatistics
    role?: FieldRole[]
    gpuEncoding?: GpuFieldEncoding
    security?: FieldSecurityPolicy
    description?: string
}
```

## FieldRole

字段角色帮助 style compiler 和 agent 判断字段能否用于某类任务:

```ts
type FieldRole =
    | 'paint-input'
    | 'layout-input'
    | 'filter-input'
    | 'aggregation-weight'
    | 'classification-input'
    | 'label-text'
    | 'feature-id'
    | 'join-key'
    | 'time-key'
    | 'geometry-component'
```

示例:

```ts
height: {
    name: 'height',
    type: 'float32',
    semantic: 'height',
    unit: 'm',
    nullable: true,
    domain: { kind: 'numeric', min: 0, max: 312 },
    stats: { nullRate: 0.082, quantiles: [0, 8, 14, 25, 60, 312] },
    role: ['paint-input', 'layout-input', 'classification-input'],
    gpuEncoding: { kind: 'float32' }
}
```

## CRS 与几何语义

```ts
type CrsSpec = {
    id: string             // e.g. 'EPSG:4326', 'EPSG:3857', 'ECEF', 'tile-local'
    axisOrder?: string[]
    units?: string
    epoch?: string         // dynamic datum support if needed
}

type GeometrySchema = {
    type:
        | 'point'
        | 'multi-point'
        | 'line'
        | 'multi-line'
        | 'polygon'
        | 'multi-polygon'
        | 'mesh'
        | 'point-cloud'
        | 'raster'
        | 'volume'
    crs: CrsSpec
    dimensions?: 2 | 3 | 4
    positionEncoding?: 'float64' | 'float32' | 'quantized' | 'tile-local' | 'high-low-split'
    bbox?: [number, number, number, number]
    zSemantic?: 'height' | 'depth' | 'elevation' | 'ellipsoidal-height' | 'unknown'
    quantization?: QuantizationSpec
}
```

`geo` validator 应能识别这些错误:

- 用 EPSG:4326 degree 坐标直接进行 meter buffer。
- 把 `depth` 和 `height` 混为同一正方向。
- 把全局 float64 坐标直接降低到 shader f32，而没有 tile-local origin 或 high-low split。
- 对没有 stable feature id 的 source 启用 feature-state 或 persistent picking。

## Source profiling

Source 应提供数据发现 API:

```ts
const profile = await source.profile({
    sample: 10000,
    fields: ['height', 'landuse', 'name']
})
```

返回:

```ts
type SourceProfile = {
    rowCountEstimate?: number
    featureCountEstimate?: number
    fields: Record<string, FieldProfile>
    geometry?: GeometryProfile
    suggestedEncodings?: SuggestedEncoding[]
    diagnostics: GeoDiagnostic[]
}
```

`FieldProfile`:

```ts
type FieldProfile = {
    type: FieldSchema['type']
    nullable: boolean
    nullRate?: number
    min?: number
    max?: number
    mean?: number
    quantiles?: number[]
    categories?: { value: string, count: number }[]
    examples?: unknown[]
    warnings?: GeoDiagnostic[]
}
```

## GPU lowering

Source schema 应能连接到 `scratch` 的 layout codec，但不要等同于 layout codec。

```text
SourceSchema: 地理/表格/属性语义
LayoutSpec: GPU buffer 字节形状
LayoutArtifact: offset/stride/padding/hash
LayoutCodec: CPU writer + WGSL accessor + readback view
```

Lowering 计划:

```ts
type SourceGpuLoweringPlan = {
    requiredColumns: string[]
    layoutSpecs: Record<string, unknown>
    columnEncodings: Record<string, GpuFieldEncoding>
    generatedCodecs: string[]
    diagnostics: GeoDiagnostic[]
}
```

## 安全标签

字段可能带敏感性:

```ts
type FieldSecurityPolicy = {
    sensitive?: boolean
    pii?: boolean
    redactInLogs?: boolean
    allowExport?: boolean
    allowAgentInspect?: boolean
}
```

`explainFeature` 和 `createReproCase` 必须遵守这些标签。

## 非目标

- 不把 source schema 降级成 TypeScript interface 注释。
- 不要求所有外部数据源都预先拥有完整 schema；可以先 profile，再生成 tentative schema。
- 不让 style expression 随意访问未知字段。
- 不在 schema 中存储 GPUBuffer 或 runtime resource handle。
- 不用 schema 自动修复数据；schema 只提供 validation、lowering 和 agent reasoning 的依据。


---

<!-- Source: 03-layers-styles-expressions/README_zh.md -->

# Layers、Styles 与 Expressions

状态: Vision draft  
日期: 2026-07-06

## 决策

`Layer` 是地理可视化的语义组织单元。`Style` 是从 feature/source/view/context 到视觉变量的函数集合。`Expression` 必须是可分析的 IR，而不是不可见 JavaScript 闭包。Style compiler 必须输出 dependency graph、required columns、layout/paint 分类、GPU technique key 与 invalidation plan。

这层替代传统 material 在地图可视化中的地位。

## LayerSpec

```ts
type LayerSpec = {
    id: string
    type:
        | 'fill'
        | 'line'
        | 'symbol'
        | 'raster'
        | 'terrain'
        | 'point-cloud'
        | 'mesh'
        | 'heatmap'
        | 'volume'
        | 'custom'
    source: string
    sourceLayer?: string
    minZoom?: number
    maxZoom?: number
    filter?: Expression<boolean>
    style?: StyleSpecRef | StyleSpec
    layout?: LayerLayoutSpec
    order?: number
    visibility?: VisibilitySpec
    constraints?: LayerConstraintSpec
    picking?: PickingPolicy
    metadata?: Record<string, unknown>
}
```

## StyleSpec

```ts
type StyleSpec = {
    id?: string
    variables?: Record<string, StyleVariable>
    paint?: Record<string, ExpressionLike>
    layout?: Record<string, ExpressionLike>
    ramps?: Record<string, ColorRampSpec>
    transferFunctions?: Record<string, TransferFunctionSpec>
    defaults?: Record<string, unknown>
    metadata?: Record<string, unknown>
}
```

`paint` 与 `layout` 必须分开，因为它们的失效代价不同:

```text
paint change:
    常见为 uniform / LUT / bind set / style buffer 更新
    不应触发 tile reload 或 label placement，除非表达式依赖改变

layout change:
    可能影响 tessellation、symbol candidate、label placement、collision domain、tile-local layout result
    通常需要重建 layout product
```

## Expression IR

Expression 应是可序列化、可静态分析的结构:

```ts
type Expression<T = unknown> =
    | ['literal', T]
    | ['get', string]
    | ['feature-state', string]
    | ['zoom']
    | ['time']
    | ['camera', string]
    | ['context', string]
    | ['case', Expression<boolean>, Expression, Expression]
    | ['coalesce', ...Expression[]]
    | ['interpolate', InterpolationSpec, Expression<number>, ...unknown[]]
    | ['match', Expression, ...unknown[]]
    | ['==', Expression, Expression]
    | ['!=', Expression, Expression]
    | ['>', Expression, Expression]
    | ['<', Expression, Expression]
    | ['all', ...Expression<boolean>[]]
    | ['any', ...Expression<boolean>[]]
    | ['+', Expression<number>, Expression<number>]
    | ['-', Expression<number>, Expression<number>]
    | ['*', Expression<number>, Expression<number>]
    | ['/', Expression<number>, Expression<number>]
```

允许自定义 expression，但必须注册 schema 和 dependency behavior:

```ts
type ExpressionFunctionManifest = {
    name: string
    args: ExpressionArgSpec[]
    returnType: ExpressionType
    dependencies: ExpressionDependencySpec
    gpuLowering?: 'wgsl-inline' | 'lookup-table' | 'cpu-eval' | 'unsupported'
}
```

## StylePlan

Style compiler 输出:

```ts
type StylePlan = {
    layerId: string
    styleHash: string
    requiredColumns: string[]
    requiredFeatureState?: string[]
    viewDependencies: ('zoom' | 'pitch' | 'bearing' | 'camera-position' | 'time')[]
    contextDependencies: string[]
    paintDependencies: StyleDependency[]
    layoutDependencies: StyleDependency[]
    sourceDependencies: StyleDependency[]
    techniqueKey: string
    gpuLowering: StyleGpuLowering
    invalidation: StyleInvalidationClass
    diagnostics: GeoDiagnostic[]
}

type StyleInvalidationClass =
    | 'paint-only'
    | 'style-buffer-update'
    | 'layout-recompute'
    | 'tile-reload'
    | 'pipeline-recompile'
    | 'unsupported'
```

示例:

```json
{
  "requiredColumns": ["height", "landuse", "name"],
  "paintDependencies": ["height", "landuse"],
  "layoutDependencies": ["name"],
  "viewDependencies": ["zoom"],
  "techniqueKey": "fill-extrusion:attribute-height:categorical-color",
  "invalidation": "layout-recompute"
}
```

## Dependency classes

```text
Constant expression
    不依赖 feature/source/view，可编译为 uniform 或 specialization constant。

Feature property expression
    依赖 source field。需要 requiredColumns，并可能触发 column loading。

View expression
    依赖 zoom/camera/time。可能每帧更新 uniform，但不一定重建 tile。

Layout expression
    影响候选生成、geometry layout、label placement 或 collision。需要 layout epoch。

Source expression
    影响 filter、tile request、band selection 或 source-layer selection。可能触发 source scheduler。
```

## GPU lowering

StylePlan 可以降低为:

```ts
type StyleGpuLowering = {
    uniforms?: UniformBlockSpec
    lookupTextures?: LookupTextureSpec[]
    propertyColumns?: string[]
    generatedWgslModules?: string[]
    bindLayouts?: string[]
    scratchResources?: string[]
    cpuEvalFallback?: string[]
}
```

规则:

- 简单 numeric/color expression 可降为 WGSL 或 uniform/LUT。
- Categorical match 可降为 dictionary + LUT。
- 大型 string expression 或 locale-sensitive text shaping 应留在 CPU/worker。
- 不支持的 expression 不能静默退化，应产生 diagnostic。

## Diagnostics

常见 diagnostic codes:

```ts
type GeoStyleDiagnosticCode =
    | 'GEO_STYLE_FIELD_MISSING'
    | 'GEO_STYLE_FIELD_TYPE_MISMATCH'
    | 'GEO_STYLE_FIELD_NULLABLE_WITHOUT_DEFAULT'
    | 'GEO_STYLE_UNIT_MISMATCH'
    | 'GEO_STYLE_EXPRESSION_UNSUPPORTED_ON_GPU'
    | 'GEO_STYLE_LAYOUT_DEPENDENCY_UNDECLARED'
    | 'GEO_STYLE_PIPELINE_VARIANT_EXPLOSION'
    | 'GEO_STYLE_RAMP_DOMAIN_MISSING'
```

Diagnostic subject 应定位到 layer/style/expression path，例如:

```ts
subject: { kind: 'StyleExpression', layerId: 'buildings', path: '/style/paint/color' }
```

## 非目标

- 不把 style 表达成任意 JavaScript 函数作为默认路径。
- 不让 style 拥有具体 tile GPU resource。
- 不把 style/material/pipeline/cache 合成一个长期闭包。
- 不在 style compiler 中执行网络加载或 tile residency 决策；它只声明需求。
- 不把所有 style 变化都粗暴标记为 layer dirty。


---

<!-- Source: 04-portrayal-layout-constraints/README_zh.md -->

# Portrayal、Layout 与 Constraints

状态: Vision draft  
日期: 2026-07-06

## 决策

地理对象之间的相互影响不应通过对象间消息、ECS 事件或 material mutation 实现。海图符号、注记避让、优先级遮挡、基于渲染结果的后续布局，应该进入显式的 **Portrayal / Candidate / Constraint / Layout Product** 管线。

核心观点:

```text
对象间相互影响不是对象行为，而是可视化结果的全局或局部约束。
```

## Pipeline

```text
FeatureBatch
    ↓
StylePlan + PortrayalRules
    ↓
PortrayalInstructionBatch
    ↓
CandidateBuilder
    ↓
CandidateBatch
    ↓
ConstraintSolver
    ↓
LayoutProduct / PlacementResult
    ↓
DrawPacketBuilder / RenderGraph
```

## PortrayalInstruction

`PortrayalInstruction` 是 feature 被规则系统处理后的中间表达，不是 draw call。

```ts
type PortrayalInstruction = {
    id: string
    featureId: FeatureId
    sourceId: string
    layerId: string
    sourceLayer?: string
    geometryRef: GeometryRef
    symbolType:
        | 'area-fill'
        | 'line-symbol'
        | 'point-symbol'
        | 'text'
        | 'soundings'
        | 'mesh-surface'
        | 'raster-sample'
        | 'custom'
    displayCategory?: string
    viewingGroup?: string
    priority: number
    sortKey: string | bigint
    styleParams: Record<string, unknown>
    visibilityPolicy: VisibilityPolicy
    collisionPolicy?: CollisionPolicy
    placementPolicy?: PlacementPolicy
    dependencies?: PortrayalDependency[]
    diagnostics?: GeoDiagnostic[]
}
```

## PortrayalDependency

跨对象依赖必须声明式表达，而不是任意 callback。

```ts
type PortrayalDependency =
    | { type: 'nearby-features', source?: string, classes: string[], radiusMeters: number, maxResults?: number }
    | { type: 'same-feature-relation', relation: string }
    | { type: 'screen-collision', domain: string }
    | { type: 'depth-occlusion', product: 'depth' | 'depth-pyramid' }
    | { type: 'render-product', product: 'occupancy-mask' | 'visibility-buffer' | 'aggregation-grid' }
    | { type: 'navigation-context', keys: string[] }
```

这些 dependency 会被编译成批量 query plan 或 render product dependency。

## Candidate

```ts
type VisualCandidate = {
    id: string
    instructionId: string
    featureId: FeatureId
    kind: 'symbol' | 'text' | 'line-label' | 'area-label' | 'marker' | 'custom'
    anchor: AnchorCandidate
    alternatives?: AnchorCandidate[]
    screenBoxes: ScreenBox[]
    priority: number
    sortKey: string | bigint
    collisionDomain?: string
    allowOverlap?: boolean
    blocksOthers?: boolean
    canDisplace?: boolean
    payload: Record<string, unknown>
}
```

候选生成可以在 worker 中分 tile 执行，最终由 viewport-level solver 合并。

## CollisionDomain

```ts
type CollisionDomain = {
    id: string
    coordinateSpace: 'screen' | 'tile-local' | 'world'
    scope: 'viewport' | 'source' | 'layer' | 'tile' | 'route-corridor'
    priorityPolicy: 'stable-sort' | 'source-order' | 'safety-first' | 'custom'
    grid?: CollisionGridSpec
    crossSource?: boolean
}
```

示例:

```ts
constraints: {
    collisionDomains: {
        'chart-text': {
            coordinateSpace: 'screen',
            scope: 'viewport',
            priorityPolicy: 'safety-first',
            crossSource: true
        },
        'poi-labels': {
            coordinateSpace: 'screen',
            scope: 'viewport',
            priorityPolicy: 'stable-sort'
        }
    }
}
```

## PlacementResult

```ts
type PlacementResult = {
    candidateId: string
    featureId: FeatureId
    accepted: boolean
    selectedAnchorIndex?: number
    displacement?: [number, number]
    opacity?: number
    reason?: PlacementRejectReason
    blockedBy?: string[]
    collisionDomain?: string
}

type PlacementRejectReason =
    | 'collision'
    | 'out-of-view'
    | 'priority-lost'
    | 'tile-boundary'
    | 'missing-glyph'
    | 'missing-resource'
    | 'budget-exceeded'
    | 'constraint-cycle'
```

`PlacementResult` 不应写回 feature 或 style。它是当前 view/layout epoch 下的派生产物。

## LayoutEpoch

```ts
type LayoutEpoch = {
    styleEpoch: number
    sourceEpoch: number
    tileSetEpoch: number
    viewEpoch: number
    layoutZoom: number
    navigationContextEpoch?: number
    collisionDomainEpoch: number
}
```

layout result 必须说明它依赖哪些 epoch。小幅 pan/zoom 可尝试复用旧 placement；跨 layout zoom 或 style layout dependency 改变时应失效。

## Solver 策略

第一版不要追求完美全局优化。推荐:

```text
1. 只对 active viewport + padding 生成候选。
2. 按 collision domain 分组。
3. 按 priority bucket + stable sortKey 排序。
4. 每个 candidate 尝试有限 anchor。
5. accepted 后写入 occupancy grid。
6. rejected 记录 reason 和 blockedBy。
7. 小幅 pan/zoom 时复用上一帧结果，再增量处理新候选。
```

## 海图/专业制图支持

海图表达通常不是 style-only，而是 portrayal catalogue + conditional symbology + display priority + viewing group + navigation context。

```ts
type NavigationContext = {
    displayMode?: 'base' | 'standard' | 'all'
    safetyDepth?: number
    safetyContour?: number
    shipDraft?: number
    routeCorridor?: GeometryRef
    timeRange?: [number, number]
    radarOverlayEnabled?: boolean
}
```

Portrayal rule 可以读取 `NavigationContext`，但必须声明依赖，进入 plan/validation。

## 渲染结果反馈

基于其他渲染结果的动态更新不应通过对象消息实现，而应通过 render product:

```text
Pass A: terrain depth
Pass B: symbol occupancy mask
Pass C: label placement compute reads depth + occupancy
Pass D: label render reads placement result
```

对应类型:

```ts
type LayoutDependencyOnRenderProduct = {
    product: 'depth-pyramid' | 'occupancy-mask' | 'visibility-buffer'
    producerPass: string
    requiredEpoch?: number
}
```

## Diagnostics

```ts
type GeoLayoutDiagnosticCode =
    | 'GEO_LAYOUT_CANDIDATE_BUDGET_EXCEEDED'
    | 'GEO_LAYOUT_COLLISION_DOMAIN_MISSING'
    | 'GEO_LAYOUT_PRIORITY_TYPE_MISMATCH'
    | 'GEO_LAYOUT_CONSTRAINT_CYCLE'
    | 'GEO_LAYOUT_RENDER_PRODUCT_UNAVAILABLE'
    | 'GEO_LAYOUT_GLYPH_MISSING'
    | 'GEO_LAYOUT_PLACEMENT_UNSTABLE'
```

Diagnostics 应定位到 candidate、feature、domain、layout product 或 render product。

## 非目标

- 不让 feature、label、symbol 互相发消息。
- 不把 placement result 写回 source data。
- 不把注记避让藏在 symbol renderer 内部。
- 不允许任意 rule 查询任意 feature；必须编译成受限 query plan。
- 不强制一个全局最优 solver；确定性、可解释、可增量优先。


---

<!-- Source: 05-tiles-lod-streaming-residency/README_zh.md -->

# Tiles、LoD、Streaming 与 Residency

状态: Vision draft  
日期: 2026-07-06

## 决策

`geo` 必须把瓦片遍历、LoD、数据流式加载、GPU 驻留和缓存预算作为显式系统。它们不能藏在 layer 或 material 内部，也不能表现为每个 tile 一个渲染对象的任意生命周期。

核心原则:

```text
Source owns data truth and scheduling policy.
TileChunk owns decoded/GPU-resident data handles.
Layer/Style declares needs.
Render planning consumes resident data and fallback policy.
```

## Tile identity

```ts
type TileId = {
    scheme: 'xyz' | 'tms' | 'quadkey' | 'implicit-quadtree' | 'implicit-octree' | 'custom'
    z: number
    x: number
    y: number
    level?: number
    subtree?: string
    contentId?: string
}
```

Tile identity 不等于 GPU resource identity。一个 tile 可以产生多个 `TileChunk`，对应 geometry、property columns、raster pages、metadata、label candidates 等。

## SourceScheduler

```ts
type SourceScheduler = {
    requestTiles(view: ViewState, needs: SourceNeeds, budget: StreamingBudget): TileRequestPlan
    updateResidency(plan: TileRequestPlan): ResidencyPlan
    explainTile(tileId: TileId): TileExplanation
}
```

`SourceNeeds` 来自 style/layout/portrayal 编译结果:

```ts
type SourceNeeds = {
    sourceId: string
    requiredColumns: string[]
    requiredGeometry?: string[]
    requiredRasterBands?: string[]
    requiredMetadata?: string[]
    minZoom?: number
    maxZoom?: number
    layoutDependencies?: string[]
    priority?: number
}
```

## Tile states

```ts
type TileState =
    | 'unseen'
    | 'queued'
    | 'requesting'
    | 'received'
    | 'decoding'
    | 'decoded'
    | 'uploading'
    | 'gpu-resident'
    | 'fallback-resident'
    | 'evicting'
    | 'evicted'
    | 'failed'
```

Tile state 应可 inspect。AI 和 tests 不应通过日志猜测 tile 是否已加载。

## TileChunk

```ts
type TileChunk = {
    id: string
    tileId: TileId
    sourceId: string
    lod: number
    schemaVersion: string
    state: TileState
    cpu?: {
        decodedBytes?: number
        featureCount?: number
        candidateCount?: number
    }
    gpu?: {
        geometry?: ScratchResourceRef
        indices?: ScratchResourceRef
        columns?: Record<string, ScratchResourceRef>
        textures?: Record<string, ScratchResourceRef>
        metadata?: ScratchResourceRef
        bindSets?: string[]
    }
    epochs: {
        dataEpoch: number
        layoutEpoch?: number
        gpuUploadEpoch?: number
    }
    bbox?: BoundingVolume
    priority?: number
    lastUsedFrame?: number
    diagnostics?: GeoDiagnostic[]
}
```

## Residency policy

```ts
type ResidencyPolicy = {
    gpuMemoryBudgetMB?: number
    cpuMemoryBudgetMB?: number
    maxResidentTiles?: number
    maxInflightRequests?: number
    maxUploadsPerFrame?: number
    evictionPolicy?: 'lru' | 'priority-lru' | 'screen-error' | 'custom'
    preload?: {
        viewportPaddingTiles?: number
        zoomAhead?: number
        zoomBehind?: number
    }
}
```

Eviction 必须遵守 `scratch` submitted work 生命周期：GPU 仍可能引用的 resource 不可立即释放。需要 fence/submission completion 或 generation-based reclamation。

## LoD policy

```ts
type LodPolicy = {
    mode: 'screen-space-error' | 'zoom-level' | 'geometric-error' | 'custom'
    targetErrorPx?: number
    minZoom?: number
    maxZoom?: number
    hysteresis?: number
    refinement?: 'replace' | 'additive' | 'blend'
    fallback?: 'parent' | 'child' | 'none' | 'placeholder'
}
```

LoD 决策应输出 plan:

```ts
type LodSelectionPlan = {
    selected: TileId[]
    loading: TileId[]
    fallback: { requested: TileId, using: TileId, reason: string }[]
    hidden: { tile: TileId, reason: string }[]
    diagnostics: GeoDiagnostic[]
}
```

## Streaming budget

```ts
type StreamingBudget = {
    networkRequestsPerSecond?: number
    maxInflightNetwork?: number
    decodeMsPerFrame?: number
    uploadBytesPerFrame?: number
    gpuMemoryMB?: number
    tilePriority?: 'view-center' | 'screen-error' | 'layer-priority' | 'custom'
}
```

Budget 不是建议，而是 plan 和 scheduler 的输入。超预算必须进入 diagnostics 或 degradation plan。

## Degradation policy

```ts
type DegradationPolicy = {
    onGpuMemoryPressure?:
        | 'evict-low-priority'
        | 'reduce-point-budget'
        | 'drop-label-candidates'
        | 'lower-raster-lod'
        | 'disable-noncritical-layers'
        | 'throw'
    onNetworkPressure?:
        | 'use-parent-tiles'
        | 'delay-low-priority-sources'
        | 'drop-prefetch'
        | 'throw'
    onLayoutPressure?:
        | 'cap-candidates'
        | 'priority-filter'
        | 'reuse-previous-layout'
        | 'throw'
}
```

Degradation 应可解释:

```ts
geo.explainBudget()
geo.explainDegradation(frameId)
```

## Tile diagnostics

```ts
type GeoTileDiagnosticCode =
    | 'GEO_TILE_REQUEST_FAILED'
    | 'GEO_TILE_DECODE_FAILED'
    | 'GEO_TILE_SCHEMA_MISMATCH'
    | 'GEO_TILE_REQUIRED_COLUMN_MISSING'
    | 'GEO_TILE_UPLOAD_BUDGET_EXCEEDED'
    | 'GEO_TILE_GPU_RESIDENCY_EVICTED'
    | 'GEO_TILE_LOD_FALLBACK_USED'
    | 'GEO_TILE_STALE_LAYOUT_PRODUCT'
```

Subject 应能定位 source/tile/chunk/column/band。

## 与 scratch 的衔接

TileChunk 的 GPU 资源最终降低为 `scratch` resources。内容变化推进 `contentEpoch`，物理替换推进 `allocationVersion`。Geo 层不要直接模拟 WebGPU bind group invalidation，而应复用 scratch 的 resource/bind set/version 模型。

```text
Tile decoded data
    -> LayoutCodec CPU writer
    -> scratch UploadCommand
    -> BufferResource contentEpoch++
    -> Draw/Dispatch Command reads declared resource epochs
```

## 非目标

- 不把 tile 设计成 material 或 render object。
- 不让 layer 持有 tile cache。
- 不把 tile loading 结果通过隐式事件直接改 renderer 内部状态。
- 不隐藏 fallback/parent tile 的使用。
- 不让 AI 只能通过网络日志判断 tile scheduler 行为。


---

<!-- Source: 06-render-resource-graph/README_zh.md -->

# RenderGraph 与 ResourceGraph

状态: Vision draft  
日期: 2026-07-06

## 决策

`geo` 可以在 `scratch` 的显式 submission model 之上提供 render/resource graph，但第一目标不是自动魔法排序，而是可解释、可验证、可计划的可视化执行图。RenderGraph 描述可视化 pass 和 render product 的依赖；ResourceGraph 描述 source/tile/layout/render 资源之间的生产和消费关系。

`scratch` core 可以保持显式 submission 顺序；`geo` graph 是上层 orchestration 和 introspection。

## RenderProduct

```ts
type RenderProduct = {
    id: string
    kind:
        | 'color'
        | 'depth'
        | 'depth-pyramid'
        | 'normal'
        | 'picking'
        | 'visibility-buffer'
        | 'occupancy-mask'
        | 'aggregation-grid'
        | 'heatmap-density'
        | 'label-placement'
        | 'tile-indirect-args'
        | 'custom'
    resource?: ScratchResourceRef
    format?: string
    size?: ProductSizeSpec
    producerPass?: string
    contentEpoch?: number
    lifetime?: 'frame' | 'view-epoch' | 'persistent' | 'external'
}
```

## RenderPassNode

```ts
type RenderPassNode = {
    id: string
    kind: 'render' | 'compute' | 'copy' | 'upload' | 'readback' | 'custom'
    label?: string
    reads: RenderProductRef[]
    writes: RenderProductRef[]
    usesSources?: string[]
    usesLayers?: string[]
    scratchPassSpec?: string
    scratchCommands?: string[]
    requiredFeatures?: string[]
    requiredLimits?: Record<string, number>
    budget?: PassBudget
    diagnostics?: GeoDiagnostic[]
}
```

## 示例图

```text
terrain-depth
    writes depth

vector-fill
    reads depth? / tile geometry
    writes scene-color

symbol-occupancy
    reads symbol candidates
    writes occupancy-mask

label-placement
    reads occupancy-mask + depth-pyramid + label candidates
    writes label-placement

label-render
    reads label-placement + glyph-atlas
    writes scene-color

picking
    reads visible draw packets
    writes picking-buffer

composite
    reads scene-color
    writes surface
```

## ResourceGraph

ResourceGraph 解释数据从 source 到 GPU 执行的流向:

```ts
type ResourceGraphNode =
    | { kind: 'Source', id: string }
    | { kind: 'TileChunk', id: string, tileId: TileId }
    | { kind: 'LayoutProduct', id: string }
    | { kind: 'ScratchResource', id: string, resourceKind: string }
    | { kind: 'RenderProduct', id: string }
    | { kind: 'Pass', id: string }
    | { kind: 'Command', id: string }

type ResourceGraphEdge = {
    from: string
    to: string
    relation:
        | 'requests'
        | 'decodes-to'
        | 'uploads-to'
        | 'binds-as'
        | 'reads'
        | 'writes'
        | 'produces'
        | 'consumes'
        | 'fallback-for'
    epoch?: number
    diagnostics?: GeoDiagnostic[]
}
```

## Graph planning

RenderGraph planner 应返回:

```ts
type RenderGraphPlan = {
    nodes: RenderPassNode[]
    products: RenderProduct[]
    executionOrder: string[]
    scratchSubmissions: ScratchSubmissionPlan[]
    invalidatedProducts: string[]
    reusableProducts: string[]
    diagnostics: GeoDiagnostic[]
    estimatedCost: RenderGraphCostEstimate
}
```

`ScratchSubmissionPlan`:

```ts
type ScratchSubmissionPlan = {
    id: string
    presentation?: boolean
    passNodes: string[]
    scratchPassSpecs: string[]
    scratchCommands: string[]
    reads: ScratchResourceRef[]
    writes: ScratchResourceRef[]
}
```

## Introspection API

```ts
geo.inspectRenderGraph()
geo.inspectRenderPass(passId)
geo.inspectRenderProduct(productId)
geo.inspectResourceGraph()
geo.traceResource(resourceId)
```

返回值必须可 JSON 序列化。可视化 UI 可以建立在这些 API 之上，但 API 本身不应只输出图形界面。

## GPU feedback 与 compute

地理可视化中常见 GPU feedback:

- GPU culling -> indirect draw args
- terrain depth -> label occlusion
- symbol occupancy -> label placement
- heatmap binning -> blur -> color ramp
- picking buffer -> feature query
- visibility query -> tile residency priority

这些应表达为 RenderProduct 依赖，而不是对象回调。

## Validation

Graph validation 检查:

- product read before producer。
- product lifetime 被错误跨 frame 使用。
- pass kind 与 scratch command kind 不匹配。
- resource usage 与 scratch resource usage 不匹配。
- layout product epoch 与 current view/style/tile epoch 不一致。
- cycle 未被明确允许。
- required feature/limit 不满足。

## Diagnostics

```ts
type GeoGraphDiagnosticCode =
    | 'GEO_GRAPH_PRODUCT_READ_BEFORE_WRITE'
    | 'GEO_GRAPH_RESOURCE_LIFETIME_EXCEEDED'
    | 'GEO_GRAPH_PASS_KIND_MISMATCH'
    | 'GEO_GRAPH_REQUIRED_FEATURE_UNAVAILABLE'
    | 'GEO_GRAPH_REQUIRED_LIMIT_UNSATISFIED'
    | 'GEO_GRAPH_CYCLE_UNDECLARED'
    | 'GEO_GRAPH_STALE_LAYOUT_PRODUCT'
    | 'GEO_GRAPH_SCRATCH_LOWERING_FAILED'
```

## 非目标

- 不把自动 render graph sorting 放进 `scratch` core。
- 不要求所有用户必须使用 graph helper；低层 escape hatch 保留。
- 不隐藏最终生成的 scratch pass/command/submission。
- 不把 graph 做成只供 renderer 内部使用的黑箱。


---

<!-- Source: 07-explain-trace-profile/README_zh.md -->

# Explain、Trace 与 Profile

状态: Vision draft  
日期: 2026-07-06

## 决策

`geo` 必须提供解释运行时行为的结构化 API。Diagnostics 解释错误；Explain/Trace/Profile 解释系统为什么以某种方式工作。AI 调试地图时，不能只看到 FPS、console log 或一张错图。

## Explain API

```ts
geo.explainLayer(layerId: string): LayerExplanation
geo.explainSource(sourceId: string): SourceExplanation
geo.explainTile(tileId: TileId): TileExplanation
geo.explainFeature(featureId: FeatureId): FeatureExplanation
geo.explainPixel(x: number, y: number): PixelExplanation
geo.explainFrame(frameId?: string): FrameExplanation
geo.explainPlacement(domainId: string): PlacementExplanation
geo.explainWhyNotVisible(featureId: FeatureId): VisibilityExplanation
geo.explainBudget(): BudgetExplanation
```

所有返回值必须是 JSON-compatible structured data。

## LayerExplanation

```ts
type LayerExplanation = {
    layerId: string
    type: string
    sourceId: string
    visible: boolean
    visibilityReason?: string
    stylePlan?: {
        requiredColumns: string[]
        paintDependencies: string[]
        layoutDependencies: string[]
        techniqueKey: string
        invalidationClass: string
    }
    tileUse?: {
        activeTiles: number
        residentTiles: number
        loadingTiles: number
        fallbackTiles: number
    }
    render?: {
        passes: string[]
        scratchPipelines: string[]
        drawCommandEstimate?: number
    }
    diagnostics: GeoDiagnostic[]
}
```

## FeatureExplanation

```ts
type FeatureExplanation = {
    featureId: FeatureId
    sourceId: string
    tileId?: TileId
    presentInSource: boolean
    loaded?: boolean
    filteredOut?: boolean
    filterReason?: string
    fields?: Record<string, unknown>
    redactedFields?: string[]
    portrayal?: {
        instructions: PortrayalInstructionSummary[]
    }
    placement?: {
        accepted: PlacementResult[]
        rejected: PlacementResult[]
    }
    render?: {
        visibleDraws: string[]
        occluded?: boolean
        depthTest?: 'passed' | 'failed' | 'not-applicable'
        pickingId?: string
    }
    diagnostics: GeoDiagnostic[]
}
```

## PixelExplanation

```ts
type PixelExplanation = {
    x: number
    y: number
    color?: [number, number, number, number]
    contributors: PixelContributor[]
    topFeature?: FeatureId
    topLayer?: string
    depth?: number
    picking?: PickingResult
    overdrawEstimate?: number
    renderPassTrace?: string[]
    diagnostics: GeoDiagnostic[]
}

type PixelContributor = {
    layerId: string
    featureId?: FeatureId
    tileId?: TileId
    passId: string
    productId?: string
    styleValues?: Record<string, unknown>
}
```

Pixel trace 可以依赖 picking buffer、feature id buffer、debug render products 或 CPU-side spatial query。并不要求所有生产配置都开启完整 trace，但 debug mode 应支持。

## PlacementExplanation

```ts
type PlacementExplanation = {
    domainId: string
    layoutEpoch: LayoutEpoch
    candidateCount: number
    acceptedCount: number
    rejectedCount: number
    rejectionBreakdown: Record<PlacementRejectReason, number>
    priorityBuckets?: Record<string, number>
    gridOccupancy?: {
        cells: number
        occupiedCells: number
        maxCellLoad?: number
    }
    reusedFromPreviousLayout?: number
    diagnostics: GeoDiagnostic[]
}
```

## Frame profile

```ts
type FrameProfile = {
    frameId: string
    view: ViewState
    totalMs: number
    breakdown: {
        sourceSchedulingMs?: number
        networkMs?: number
        decodeMs?: number
        uploadMs?: number
        styleEvalMs?: number
        portrayalMs?: number
        layoutMs?: number
        renderPlanningMs?: number
        scratchSubmitMs?: number
        gpuMs?: number
        readbackMs?: number
        gcMs?: number
    }
    gpu?: {
        passTimings?: Record<string, number>
        queryAvailability?: string
    }
    memory?: {
        gpuEstimatedMB?: number
        cpuEstimatedMB?: number
        stagingMB?: number
    }
    bottlenecks: BottleneckFinding[]
    diagnostics: GeoDiagnostic[]
}
```

## Bottleneck findings

```ts
type BottleneckFinding = {
    code:
        | 'GEO_PROFILE_TILE_DECODE_BOUND'
        | 'GEO_PROFILE_UPLOAD_BOUND'
        | 'GEO_PROFILE_LABEL_CANDIDATE_EXPLOSION'
        | 'GEO_PROFILE_GPU_RENDER_BOUND'
        | 'GEO_PROFILE_NETWORK_BOUND'
        | 'GEO_PROFILE_SHADER_VARIANT_EXPLOSION'
        | 'GEO_PROFILE_READBACK_STALL'
    subject: GeoDiagnosticSubject
    evidence: Record<string, unknown>
    suggestions?: GeoDiagnosticSuggestion[]
}
```

AI 应基于 bottleneck finding 修复，而不是只看 FPS。

## Trace API

```ts
geo.traceFeature(featureId)
geo.traceTile(tileId)
geo.traceResource(resourceId)
geo.tracePatch(patchId)
geo.traceStyleExpression(layerId, expressionPath)
```

`traceStyleExpression` 示例输出:

```json
{
  "path": "/layers/buildings/style/paint/color",
  "expression": ["interpolate", ["linear"], ["get", "height"], 0, "#ddd", 200, "#884"],
  "requiredColumns": ["height"],
  "fieldStats": { "min": 0, "max": 312, "nullRate": 0.082 },
  "gpuLowering": "lut+wgsl",
  "diagnostics": []
}
```

## Privacy

Explain/Trace 必须遵守 source/field security policy。敏感字段默认 redacted，并在结果中标记:

```ts
redactedFields: ['owner', 'vessel_id']
```

AI 工具不应通过 explain API 绕过数据权限。

## 非目标

- 不把 explain 做成只给人看的字符串。
- 不要求 production mode 永远记录全量 pixel provenance；可以按 debug/profile mode 开启。
- 不把 profiling 只简化成 FPS。
- 不通过 explain API 允许 mutation。
- 不泄露 security policy 标记为敏感的字段。


---

<!-- Source: 08-plan-patch-migration/README_zh.md -->

# Plan、Patch、Diff 与 Migration

状态: Vision draft  
日期: 2026-07-06

## 决策

AI 友好的 `geo` API 必须把修改分成四步:

```text
propose patch -> plan patch -> validate/diff/cost/security -> apply or reject
```

直接 mutation 是 convenience，不是核心 contract。

## planPatch

```ts
const plan = await geo.planPatch(patch, {
    validation: 'throw',
    estimate: 'standard',
    includeSecurityDiff: true,
})
```

返回:

```ts
type GeoPatchPlan = {
    version: 1
    patchId: string
    baseRevision: string
    targetRevision?: string
    valid: boolean
    diagnostics: GeoDiagnosticReport
    semanticDiff: SemanticDiff[]
    estimatedEffects: PatchEffects
    cost?: CostEstimate
    securityDiff?: SecurityDiff
    suggestedPatches?: GeoVizPatch[]
    rollbackToken?: string
}
```

## SemanticDiff

```ts
type SemanticDiff =
    | { kind: 'source-added', sourceId: string }
    | { kind: 'source-removed', sourceId: string }
    | { kind: 'layer-added', layerId: string }
    | { kind: 'layer-removed', layerId: string }
    | { kind: 'layer-order-changed', layerId: string, from: number, to: number }
    | { kind: 'style-paint-changed', layerId: string, path: string }
    | { kind: 'style-layout-changed', layerId: string, path: string }
    | { kind: 'source-needs-changed', sourceId: string, requiredColumns: string[] }
    | { kind: 'constraint-domain-changed', domainId: string }
    | { kind: 'render-policy-changed', path: string }
    | { kind: 'budget-changed', path: string }
    | { kind: 'security-policy-changed', path: string }
```

Semantic diff 比文本 diff 更适合 agent 和 tests。

## CostEstimate

```ts
type CostEstimate = {
    confidence: 'low' | 'medium' | 'high'
    cpuMsDelta?: number
    gpuMsDelta?: number
    gpuMemoryMBDelta?: number
    cpuMemoryMBDelta?: number
    networkRequestsDelta?: number
    tilesReloadedEstimate?: number
    layoutCandidatesDelta?: number
    pipelinesRecompiled?: number
    scratchResourcesCreated?: number
    scratchCommandsAffected?: number
}
```

Estimate 不需要完美，但必须解释依据:

```ts
type CostEvidence = {
    reason: string
    source?: string
    metric?: string
    value?: unknown
}
```

## Apply

```ts
const applied = await geo.applyPatch(patch, {
    requirePlan: true,
    planId: plan.patchId,
})
```

返回:

```ts
type ApplyResult = {
    applied: boolean
    previousRevision: string
    revision: string
    diagnostics: GeoDiagnosticReport
    invalidated: RuntimeInvalidationSummary
}
```

## Runtime invalidation summary

```ts
type RuntimeInvalidationSummary = {
    stylePlans: string[]
    sourcePlans: string[]
    tileSelections: string[]
    layoutProducts: string[]
    renderProducts: string[]
    renderGraph?: boolean
    scratchPipelines?: string[]
    scratchBindSets?: string[]
    scratchResources?: string[]
}
```

AI 可以根据 invalidation 判断下一步是否需要 profile 或 repro。

## Migration

```ts
const migration = geo.planMigration(document, {
    from: '0.4',
    to: '0.5'
})

const migrated = geo.applyMigration(document, migration)
```

Migration plan:

```ts
type MigrationPlan = {
    from: string
    to: string
    patches: GeoVizPatch[]
    diagnostics: GeoDiagnosticReport
    breakingChanges: BreakingChange[]
    manualSteps?: ManualMigrationStep[]
}
```

## Deprecation metadata

Schema 中每个废弃项应能携带机器可读替代方案:

```ts
type DeprecationMetadata = {
    deprecated: true
    since: string
    removedIn?: string
    replacement?: string
    codemod?: string
    note?: string
}
```

示例:

```json
{
  "deprecated": true,
  "since": "0.5",
  "removedIn": "0.7",
  "replacement": "/layers/*/style/paint/color",
  "codemod": "renamePaintColorToStylePaintColor"
}
```

## Codemod

对于命令式 API，用 source-level codemod 辅助迁移:

```ts
type CodemodManifest = {
    id: string
    fromVersion: string
    toVersion: string
    description: string
    input: 'typescript' | 'javascript' | 'geoviz-document'
    output: 'patch' | 'source-edit'
    diagnostics: GeoDiagnostic[]
}
```

## Diagnostics

```ts
type GeoPlanDiagnosticCode =
    | 'GEO_PLAN_PATCH_BASE_REVISION_STALE'
    | 'GEO_PLAN_LAYER_ID_CONFLICT'
    | 'GEO_PLAN_SOURCE_IN_USE'
    | 'GEO_PLAN_STYLE_CHANGE_LAYOUT_AFFECTING'
    | 'GEO_PLAN_FIELD_REQUIRED_BUT_MISSING'
    | 'GEO_PLAN_PATCH_COST_HIGH'
    | 'GEO_PLAN_SECURITY_CONFIRMATION_REQUIRED'
    | 'GEO_PLAN_MIGRATION_MANUAL_STEP_REQUIRED'
```

## 非目标

- 不让 `applyPatch` 静默修复错误。
- 不把 migration 只写在 prose changelog。
- 不要求 cost estimate 完美，但必须有 confidence 和 evidence。
- 不让 command-style API 绕过 plan/validation/security。
- 不把 raw text diff 当成 agent 的主要判断依据。


---

<!-- Source: 09-agent-tools-mcp-llms/README_zh.md -->

# Agent Tools、MCP 与 LLM 文档入口

状态: Vision draft  
日期: 2026-07-06

## 决策

`geo` 应把 agent 操作接口作为正式开发目标。AI 不应仅靠阅读人类文档和生成任意 JS 操作框架；它应通过受限、可验证、可回滚的 tools/resources/prompts 操作 `GeoVizDocument` 和 runtime snapshot。

## Agent-facing layers

```text
Machine-readable docs
    llms.txt / schema / examples / diagnostics catalog

Agent tool protocol
    validate / plan / apply / explain / profile / repro / test

Runtime resources
    document / schema / render graph / tile cache / diagnostics / metrics

Mutation safety
    patch / transaction / checkpoint / rollback / security diff
```

## MCP resources

建议暴露:

```text
geoscratch://project/document
geoscratch://project/document-schema
geoscratch://project/source-schemas
geoscratch://project/style-schema
geoscratch://runtime/snapshot
geoscratch://runtime/render-graph
geoscratch://runtime/resource-graph
geoscratch://runtime/tile-cache
geoscratch://runtime/layout-products
geoscratch://runtime/diagnostics
geoscratch://runtime/profile/latest
geoscratch://docs/geo-api
geoscratch://docs/scratch-api
geoscratch://examples/index
```

Resources 是只读上下文。Mutation 必须走 tools。

## MCP tools

```ts
type AgentTool =
    | 'validate_document'
    | 'plan_patch'
    | 'apply_patch'
    | 'rollback'
    | 'explain_layer'
    | 'explain_source'
    | 'explain_tile'
    | 'explain_feature'
    | 'explain_pixel'
    | 'inspect_render_graph'
    | 'inspect_resource_graph'
    | 'inspect_tile_cache'
    | 'profile_frame'
    | 'create_repro_case'
    | 'run_geo_assertions'
    | 'plan_migration'
    | 'apply_migration'
    | 'suggest_visual_encoding'
```

每个 tool 的输出都应包括:

```ts
type AgentToolResult<T> = {
    ok: boolean
    result?: T
    diagnostics?: GeoDiagnosticReport
    revision?: string
    artifacts?: ArtifactRef[]
}
```

## Tool safety

Mutation tool 必须支持:

- `dryRun`。
- `baseRevision`。
- `requirePlan`。
- `securityConfirmation`。
- `rollbackToken`。
- `maxCost` 或 budget guard。

示例:

```ts
plan_patch({
    baseRevision: 'rev_123',
    patch,
    maxCost: { gpuMemoryMBDelta: 128, networkRequestsDelta: 0 },
    includeSecurityDiff: true
})
```

## Prompts

可以提供可复用 prompt templates，但 prompt 不是核心契约。示例:

```text
create_choropleth_layer
create_height_extrusion_layer
debug_missing_features
optimize_label_placement
profile_slow_view
migrate_document_version
create_repro_for_render_bug
add_s101_standard_display
```

Prompt 应引导 agent 调用 tools，而不是直接输出不可验证代码。

## llms.txt

仓库根或文档站建议提供:

```text
/llms.txt
/llms-full.txt
/docs/schema/geoviz-document.schema.json
/docs/schema/geo-diagnostics.schema.json
/docs/schema/geo-patch.schema.json
/docs/schema/source-schema.schema.json
/docs/examples/index.json
/docs/errors/index.json
```

`llms.txt` 内容应简短，指向最重要的机器可读资源:

```text
# GeoScratch

GeoScratch is a WebGPU-based geospatial visualization framework.

Core docs:
- Scratch GPU kernel vision: /docs/vision/scratch-api/
- Geo API vision: /docs/vision/geo-api/
- GeoVizDocument schema: /docs/schema/geoviz-document.schema.json
- Diagnostics catalog: /docs/errors/index.json
- Agent tools: /docs/agent-tools.json
```

## Machine-readable examples

每个示例应包含:

```text
example.geoviz.json
example.intent.json
example.assertions.json
example.expected.png
example.profile.json
example.explanation.md
example.failure-modes.md
```

AI 可以从 intent 生成 patch，从 assertions 验证结果，从 failure-modes 学会避免常见错误。

## Documentation split

```text
Human docs:
    tutorial, concept explanation, screenshots, migration narrative

Agent docs:
    schema, API contracts, diagnostic codes, examples, counterexamples, tool specs

Runtime docs:
    explain outputs, profile outputs, render graph/resource graph schemas
```

不要只提供 human tutorial。AI 最需要的是 schema、counterexample、diagnostic catalog 和 structured examples。

## Agent diagnostics

Agent tool 失败不应返回普通字符串:

```json
{
  "ok": false,
  "diagnostics": {
    "version": 1,
    "diagnostics": [
      {
        "code": "GEO_STYLE_FIELD_MISSING",
        "severity": "error",
        "phase": "style",
        "subject": { "kind": "StyleExpression", "layerId": "buildings", "path": "/style/paint/color" },
        "expected": { "field": "height" },
        "actual": { "availableFields": ["name", "class"] },
        "suggestions": []
      }
    ]
  }
}
```

## 非目标

- 不把自然语言 prompt 作为唯一 agent interface。
- 不允许 agent 直接调用内部 renderer mutation。
- 不让 tools 返回 prose-only errors。
- 不把 MCP 作为必选 runtime dependency；可以是官方 adapter。
- 不把 machine-readable docs 当成 README 的替代；两者面向不同读者。


---

<!-- Source: 10-repro-tests-security/README_zh.md -->

# Repro、Tests 与 Security

状态: Vision draft  
日期: 2026-07-06

## 决策

Web 地理可视化的 bug 往往来自异步瓦片、LoD 边界、缓存淘汰、GPU device limits、shader/layout mismatch、label placement 和网络数据状态。AI 调试这些问题需要稳定复现包、语义断言和安全边界。`geo` 应把 repro/test/security 作为一等能力。

## Repro capsule

```ts
const repro = await geo.createReproCase({
    include: [
        'document',
        'viewport',
        'device-limits',
        'runtime-snapshot',
        'tile-manifest',
        'sample-tiles',
        'render-graph',
        'resource-graph',
        'layout-products',
        'diagnostics',
        'profile',
        'expected-image'
    ],
    cropToViewport: true,
    maxSizeMB: 32,
    redactSensitiveFields: true
})
```

输出 artifact 例如:

```text
case.geoscratch-repro.zip
```

建议内容:

```text
manifest.json
document.geoviz.json
viewport.json
device.json
runtime-snapshot.json
render-graph.json
resource-graph.json
tile-manifest.json
tiles/
layout-products/
diagnostics.json
profile.json
expected.png
assertions.json
README.md
```

## Repro manifest

```ts
type ReproManifest = {
    version: 1
    createdAt: string
    createdWith: string
    documentRevision: string
    browser?: BrowserInfo
    adapter?: GpuAdapterInfo
    deviceLimits?: Record<string, number>
    deviceFeatures?: string[]
    randomSeeds?: Record<string, number>
    included: string[]
    redactions: RedactionSummary[]
    entrypoint: string
}
```

## Semantic assertions

框架应提供地图语义断言，而不是只依赖 screenshot。

```ts
await expectGeo(document)
    .atView({ center: [139.7, 35.6], zoom: 14 })
    .toHaveNoGeoDiagnostics()
    .toHaveNoScratchDiagnostics()
    .toHaveVisibleLayer('buildings')
    .toRenderFeature('building_123')
    .toPlaceAtLeastLabels('station-labels', 50)
    .toStayUnderGpuMemory(512)
    .toUseNoFallbackTiles()
    .toMatchImageSnapshot('tokyo-z14')
```

断言输出必须结构化:

```ts
type GeoAssertionResult = {
    pass: boolean
    assertion: string
    subject?: GeoDiagnosticSubject
    expected?: unknown
    actual?: unknown
    diagnostics?: GeoDiagnostic[]
    artifacts?: ArtifactRef[]
}
```

## Assertion catalog

建议内置:

```text
Document assertions:
    valid schema
    no deprecated fields
    no unresolved source/layer refs

Source/tile assertions:
    required fields present
    tile request count under budget
    no failed tiles
    fallback tiles below threshold

Style assertions:
    no missing field
    no unit mismatch
    no nullable field without default
    no unexpected pipeline variant explosion

Layout assertions:
    labels accepted count
    rejected safety-critical labels == 0
    collision domain occupancy below threshold
    placement stable across small pan

Render assertions:
    visible layer exists
    feature visible / not visible reason
    pixel contributor matches expected layer
    image snapshot within tolerance

Performance assertions:
    frame cost under threshold
    GPU memory under threshold
    upload bytes under threshold
    label candidates under threshold

Security assertions:
    no literal credential
    no external URL outside allowlist
    no sensitive field exported
```

## Security policy

```ts
type SecurityPolicySpec = {
    network?: NetworkPolicy
    credentials?: CredentialPolicy
    export?: ExportPolicy
    logging?: LoggingPolicy
    agent?: AgentSecurityPolicy
}

type NetworkPolicy = {
    allowedDomains?: string[]
    blockedDomains?: string[]
    requireHttps?: boolean
    allowLocalhost?: boolean
}

type CredentialPolicy = {
    allowLiteralTokens?: boolean
    credentialRefs?: string[]
    redactInDiagnostics?: boolean
}

type ExportPolicy = {
    allowDocumentExport?: boolean
    allowTileExport?: boolean
    allowReproExport?: boolean
    sensitiveFields?: string[]
}
```

## Source security

```ts
type SourceSecurityPolicy = {
    credentialRef?: string
    allowedDomains?: string[]
    allowExport?: boolean
    allowCachePersistence?: boolean
    redactFields?: string[]
    sensitiveFields?: string[]
    license?: string
}
```

## Security diff

`planPatch` 应返回 security diff:

```ts
type SecurityDiff = {
    requiresConfirmation: boolean
    changes: SecurityChange[]
}

type SecurityChange =
    | { kind: 'external-url-added', url: string, domain: string, allowed: boolean }
    | { kind: 'credential-added', credentialRef?: string, literalDetected?: boolean }
    | { kind: 'sensitive-field-export-risk', field: string, sourceId: string }
    | { kind: 'cache-policy-changed', sourceId: string, from: string, to: string }
```

## Redaction

Repro、explain、trace、profile 和 diagnostics 都必须支持 redaction。

```ts
type RedactionSummary = {
    subject: string
    fieldsRedacted: string[]
    reason: 'sensitive-field' | 'credential' | 'network-policy' | 'user-policy'
}
```

## Diagnostics

```ts
type GeoSecurityDiagnosticCode =
    | 'GEO_SECURITY_LITERAL_CREDENTIAL_DETECTED'
    | 'GEO_SECURITY_DOMAIN_NOT_ALLOWED'
    | 'GEO_SECURITY_SENSITIVE_FIELD_EXPORT_BLOCKED'
    | 'GEO_SECURITY_REPRO_REDACTION_APPLIED'
    | 'GEO_SECURITY_AGENT_PERMISSION_REQUIRED'
```

```ts
type GeoReproDiagnosticCode =
    | 'GEO_REPRO_SIZE_BUDGET_EXCEEDED'
    | 'GEO_REPRO_TILE_SAMPLE_MISSING'
    | 'GEO_REPRO_DEVICE_INFO_UNAVAILABLE'
    | 'GEO_REPRO_EXPECTED_IMAGE_MISSING'
    | 'GEO_REPRO_REDACTION_INCOMPLETE'
```

## 非目标

- 不把 screenshot regression 当成唯一测试方式。
- 不把私有 source data 默认写进 repro。
- 不允许 agent 通过 explain/repro 绕过 field redaction。
- 不把 credential 作为 document literal 的推荐路径。
- 不依赖人手复制浏览器日志作为主要复现方式。
