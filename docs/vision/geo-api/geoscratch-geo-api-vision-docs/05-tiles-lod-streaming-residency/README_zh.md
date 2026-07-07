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
