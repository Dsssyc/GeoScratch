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
