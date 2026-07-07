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
