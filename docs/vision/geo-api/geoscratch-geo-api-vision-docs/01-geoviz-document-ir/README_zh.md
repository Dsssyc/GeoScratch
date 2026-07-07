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
