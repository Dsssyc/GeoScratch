# Geo View、Field 与可配置瓦片空间 Profile 设计

## 状态

已实施并通过全量、类型、构建和真实 WebGPU 浏览器验证。

## 日期

2026-08-08

## 背景

DEM example 已经证明 GeoScratch 可以用 GPU resident frontier、virtual raster、
screen-space error、indirect compute/draw 和高精度 camera-relative 坐标完成平面
WebMercator 地形渲染。但是当前通用能力仍被 example 和 WebMercator 实现细节切开：

- `GpuTileFrontierDescriptor` 直接接收 `WebMercatorQuadAddressCodec`；
- CPU reference evaluator 和 WGSL 生成器直接调用 WebMercator bounds/address 逻辑；
- `roots` 虽然是数组，但每个 root 的空间边界仍按单根 `1 x 1` 世界解释；
- DEM 自己定义 MapLibre/Mapbox duck types 和 camera snapshot；
- GPU feedback 直接降为 Virtual Raster demand，缺少可解释的 view-demand 边界；
- field 的地理语义、tiled representation 和 map presentation 尚未形成独立组合对象。

这会把 `WebMercatorQuad + planar map + virtual raster + DEM` 误写成一个不可拆的
抽象。Cesium GeographicTilingScheme 的 `2 x 1` level-zero roots、MapLibre 在 globe
上重投影同一 Mercator tile set，以及 S2/cube-sphere 的多根层次结构都说明：根森林、
空间嵌入、选择算法和内容 residency 必须分开。

## 规范与工业参考

- [OGC Two Dimensional Tile Matrix Set 2.0](https://docs.ogc.org/is/17-083r4/17-083r4.html)：tile matrix、row/column、top-left origin、WorldCRS84Quad 与 WebMercatorQuad；
- [Cesium GeographicTilingScheme](https://cesium.com/learn/cesiumjs/ref-doc/GeographicTilingScheme.html)：默认 level zero 为 `2 x 1`；
- [Cesium WebMercatorTilingScheme](https://cesium.com/learn/cesiumjs/ref-doc/WebMercatorTilingScheme.html)：WebMercator 的 `1 x 1` root；
- [Cesium QuadtreePrimitive](https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/QuadtreePrimitive.js)：quadtree traversal 与 tile provider/空间实现分离；
- [MapLibre Globe view](https://maplibre.org/roadmap/maplibre-gl-js/globe-view/) 与 [globe custom tile layer](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-custom-layer-with-tiles-to-a-globe/)：同一 Mercator tile identity 可以经不同空间嵌入参与 globe rendering；
- [S2 cell hierarchy](https://s2geometry.io/devguide/s2cell_hierarchy)：多 face root forest 仍可共享层次遍历语义；
- [3D Tiles](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc)：空间 bounding volume、geometric error 与内容资源是正交事实。

实现只采用公开的标准、数学事实和架构思想，不复制第三方源码。

## 目标

1. 将 frontier 的 root forest、parent/children 关系与空间 bounds/WGSL lowering 从
   WebMercator 专用代码中抽离。
2. 保持 DEM 当前 WebMercator 平面行为、GPU command graph、预算、滞回、fallback、
   高精度 camera-relative 计算和 indirect draw 不变。
3. 用一个真实 `2 x 1` root forest 测试证明根数量与空间边界不再被写死为 `1 x 1`。
4. 提供平台无关、不可变、可验证的 `GeoViewSnapshot`，由 example adapter 从
   MapLibre/Mapbox 相机事实生成。
5. 将相机产生的 coverage/refinement/prefetch 意图表达为结构化 view demand，再显式
   降为现有 Virtual Raster scheduler demand。
6. 分离 `GeoField` 语义、`TiledFieldRepresentation` 物理表示和 `MapFieldLayer`
   presentation 组合；layer 不拥有 cache、worker、runtime 或 scheduler。
7. 让 DEM 使用这些公开边界，避免创建只存在于测试中的空壳 API。

## 非目标

- 本轮不实现 globe renderer、ellipsoid horizon culling、cube-sphere、S2、octree 或
  3D Tiles traversal；
- 本轮不实现 simulation/editor demand producer，也不提前冻结其交互和一致性模型；
- 不把 camera 设为全部业务需求的唯一 authority；本轮只实现 screen-based
  visualization 的 `ViewDemandProducer`；
- 不改变 DEM source、COG/Python backend、mesh-stitching、cache UI 或 worker pipeline；
- 不把 cache、worker、network request、GPU upload 或 editable working state 隐藏到
  `MapFieldLayer`；
- 不向 Scratch core 注入 tile、CRS、camera、field 或 layer 语义；
- 不保留新的 legacy/compatibility 双路径。GeoScratch 仍处于 `0.x.x`，迁移采用
  clean cut。

## 核心分解

```text
GeoViewSnapshot
    -> TileTopology + TileSpatialProfile
    -> GpuTileFrontier
    -> ViewDemandProducer
    -> TiledFieldRepresentation
    -> MapFieldLayer
```

这不是强制状态机。每个对象是可替换的事实或策略，调用方可以独立创建、缓存和组合；
frame execution 仍由现有 Scratch submission authority 驱动。

## TileTopology

`TileTopology` 只表达有限根森林和层次关系，不表达 CRS、相机、bounds、residency 或
内容格式：

```ts
interface TileTopology {
    readonly id: string
    readonly tileMatrixSet: TileMatrixSet
    readonly roots: readonly TileCoordinate[]
    parent(tile: TileCoordinate): TileCoordinate | undefined
    children(tile: TileCoordinate): readonly TileCoordinate[]
    childOrdinal(tile: TileCoordinate): 0 | 1 | 2 | 3
    path(tile: TileCoordinate): readonly number[]
    comparePath(left: TileCoordinate, right: TileCoordinate): number
    isPathPrefix(prefix: TileCoordinate, candidate: TileCoordinate): boolean
}
```

当前内建实现是 regular quadtree root grid。`1 x 1` 和 `2 x 1` 共享 child ordinal、
prefix order 和 stable compaction；root ordinal 是 canonical path 的首段，防止不同
root 的相同 local row/column 冲突。

`TileCoordinate` 始终保持标准 TileMatrixSet identity。topology 直接解释 matrix
coordinate，不创建另一套需要长期同步的私有 tile address；frontier 不自行猜测 matrix
layout。

## TileSpatialProfile

`TileSpatialProfile` 把 topology address 嵌入可计算空间，并同时提供 CPU oracle 与
WGSL lowering：

```ts
interface TileSpatialProfile {
    readonly id: string
    readonly topology: TileTopology
    readonly coordinateFrame: 'planar'
    readonly coverage: TileMatrixCoverage
    readonly frontierEncoding: TileSpatialFrontierEncoding
    tileBounds(tile: TileCoordinate): PlanarTileBounds
    encodeCamera(position: ProjectedPosition2D): TileSpatialCameraEncoding
}
```

本轮生产 profile 是 `webMercatorPlanarTileSpatialProfile()`，并提供通用
`planarTileSpatialProfile()`。前者组合现有
`WebMercatorQuadAddressCodec`，生成与当前整数量化、高低 limb、camera-relative AABB
完全一致的 WGSL 参数。planar frontier WGSL 消费稳定 encoding，不再导入
WebMercator。frontier descriptor 接收 profile，不再接收裸 WebMercator codec。

通用 planar profile 还必须在构造时证明每一级 TileMatrix 的 top-left origin、
`matrixWidth * tileWidth * cellSize` 和 `matrixHeight * tileHeight * cellSize` 与同一个
TileMatrixSet bounding box 一致。CPU `tileBounds()` 和 GPU fixed-coordinate lowering
共同以这个已验证的 world 为准；不允许两条路径各自相信一套互相矛盾的空间元数据。

用于 `2 x 1` 证明的 regular planar profile 是公开 topology/profile 契约的测试实现，
验证两个 root 拥有不同 bounds、parent/children 和 canonical key。它不冒充完整
WorldCRS84Quad 或 globe profile。

未来非 planar spatial-profile family 可以实现：

- `GeographicEllipsoidTileProfile`：双根经纬度 tile + ellipsoid bounds/horizon；
- `MercatorOnGlobeTileProfile`：Mercator identity + curved patch embedding；
- `CubeSphereTileProfile`：六根 face topology + cube/sphere embedding。

它们可以复用 frontier 的预算、滞回、compaction、feedback 和 submission authority，
但必须先扩展并审核非 planar spatial evaluator 契约。空间测试 WGSL 必须由该 evaluator
专门生成；不能用一个堆满 projection flag 的 shader 分支冒充统一模型。

## GeoViewSnapshot

`GeoViewSnapshot` 是选择阶段的不可变输入事实，不是 MapLibre transform 的镜像：

```ts
type GeoViewSnapshot = {
    kind: 'geo-view-snapshot'
    id: string
    frameEpoch: number
    residencySnapshotEpoch: number
    clipFromRelativeWorld: readonly number[]
    cameraHigh: readonly [number, number, number]
    cameraLow: readonly [number, number, number]
    viewport: readonly [number, number]
    verticalFovRadians: number
    cameraLatitudeRadians: number
    cameraPitchRadians: number
    zoomHint: number
}
```

工厂执行 finite/range/matrix/epoch 验证并复制 mutable typed arrays。平台 adapter 负责
从 MapLibre、Mapbox 或独立 controller 生成 snapshot；frontier 只消费 snapshot。
`zoomHint` 仍不是 LoD authority，SSE 与 profile bounds 才是。

## ViewDemandProducer

GPU feedback 表达的是 view 对覆盖和细化的需求，不等于网络请求。公开 demand 保留
可解释的 provenance：

```ts
type ViewTileDemand = {
    page: VirtualRasterPageIdentity
    generation: number
    priority: WorkerTaskPriority
    intent: 'coverage' | 'refinement' | 'prefetch'
    source: {
        kind: 'view'
        viewId: string
        frameEpoch: number
        residencySnapshotEpoch: number
    }
    reason: string
    deadlineMs?: number
}
```

`ViewDemandProducer` 对结构化候选需求做有界、幂等转换；单独的 adapter 再把 intent 映射到
`VirtualRasterPageDemand.usage`。priority 属于策略结果，不属于 camera 本身。

## GeoField 与 TiledFieldRepresentation

`GeoField` 描述可在地理域采样的语义数据：identity、domain、value type、components、
unit、no-data 和 interpolation。它不包含 tile URL、atlas slot 或 shader resource。

`TiledFieldRepresentation` 描述该 field 的一种物理表示：tile spatial profile、
Virtual Raster plane、coverage 和 source revision。一个 field 可以有多个 representation；
一个 representation 也不能反向成为 field 的语义真相。

本轮 DEM height 使用 scalar continuous field、meter unit、linear interpolation 和
WebMercator tiled representation。

## MapFieldLayer

`MapFieldLayer` 是平面地图 presentation 的显式组合边界：

```ts
type MapFieldLayer = {
    field: GeoField
    representation: TiledFieldRepresentation
    spatialProfile: TileSpatialProfile
    viewAdapter: GeoViewAdapter
    demandProducer: ViewDemandProducer
}
```

它只验证组合兼容性并暴露这些依赖，不创建 runtime、cache、worker、scheduler、atlas
或 submission。DEM example 继续拥有渲染管线和资源生命周期。未来
`GlobeFieldLayer` 可以组合同一 field 与另一 spatial profile，而不污染 Map API。

## 诊断与 Agent 可理解性

所有公共工厂的无效组合使用稳定 Geo diagnostic code，至少覆盖：

- topology address/root 越界；
- profile 与 TileMatrixSet/coverage 不兼容；
- 非有限 view facts 或无效 epoch；
- field/representation identity 不匹配；
- Map layer 接收非 planar-map profile；
- feedback snapshot 与 view provenance 不一致。

诊断必须包含 subject、expected 和 actual；不得只抛出 prose-only `Error`。

## 验收

1. DEM 的 WebMercator 正常路径只通过 profile 访问空间评估。
2. frontier CPU oracle 与 WGSL 不再直接导入 `WebMercatorQuad`。
3. `2 x 1` root forest 的两个根拥有不重叠 bounds，均能稳定 split/compact。
4. DEM camera adapter 输出 `GeoViewSnapshot`，frontier 不再依赖 example camera type。
5. GPU feedback 经 `ViewDemandProducer` 和显式 adapter 进入 Virtual Raster scheduler。
6. DEM 构造并使用 `GeoField`、`TiledFieldRepresentation` 和 `MapFieldLayer`。
7. layer/profile 不拥有隐藏 cache、worker、runtime 或 scheduler。
8. focused tests、`npm test`、`npm run typecheck`、`npm run build` 和真实 WebGPU DEM
   browser smoke 全部通过。
