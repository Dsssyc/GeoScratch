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
