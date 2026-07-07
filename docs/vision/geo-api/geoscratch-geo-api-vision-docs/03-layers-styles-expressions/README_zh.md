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
