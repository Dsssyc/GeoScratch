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
