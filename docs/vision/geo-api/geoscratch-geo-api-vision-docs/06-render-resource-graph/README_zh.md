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
