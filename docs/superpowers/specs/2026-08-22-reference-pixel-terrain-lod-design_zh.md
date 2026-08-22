# Reference-Pixel 地形 LoD 设计

## 状态

本设计已于 2026-08-22 实现并验证。英文文档是事实基准；本文是经审阅的中文翻译，
冲突时以英文为准。本设计细化
`2026-08-19-webmercator-projected-cell-pitch-gated-cover-design.md` 已接受的
projected-cell cover；它不恢复 root-forward traversal，也不向 Virtual Raster 交付
LoD 权威。

## 问题

MapLibre planar adapter 曾把同一个 device-pixel canvas size 同时作为 presentation extent
与 `GeoViewSnapshot` viewport。Cover 因而把 device pixel 解释为 geometry-quality pixel。
在相同的 1512 x 864 CSS viewport 与正俯视 camera 下，DPR 1 选择 28 个 z11 patch，
DPR 2 则选择 104 个 z12 patch；MapLibre 4.7.1 在两种 DPR 下保持相同 cover。

内建 terrain mesh 曾为每个标准 patch 使用 64 x 64 cells。八像素 projected-cell
阈值在 DPR 1 下因此近似一套 256-screen-pixel tile policy。MapLibre 的
512-screen-pixel terrain cover 使用可复用 128 x 128 mesh，以更少 tile identity
维持相近 cell density。

Cover 还曾把同一个 global elevation range 应用于所有 patch。Underwater Terrain example
将 source exaggerate 五十倍，因此 global deep-water minimum 会扩张本来较浅的 patch
bounds，并可能放大正俯视 coverage。

## 外部依据

Mapbox GL JS 3.29 保存[不含 pixel ratio 的 transform width 与 height](https://github.com/mapbox/mapbox-gl-js/blob/v3.29.0/src/geo/transform.ts#L97-L99)，
以 screen pixel 定义 cover `tileSize`，只对
[painter extent](https://github.com/mapbox/mapbox-gl-js/blob/v3.29.0/src/render/painter.ts#L518-L525)
与 canvas 乘 device pixel ratio。MapLibre 使用相同分离方式，并通过
[测试](https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/ui/map_tests/map_pixel_ratio.test.ts#L21-L37)
证明 512 x 512 container 在 pixel ratio 为二时产生 1024 x 1024 painter 与 canvas。
两者都使 canonical tile identity 与 DPR 无关。Raster `@2x` 是同一 `(z, x, y)` tile
的 representation variant；Mapbox 的
[Raster DEM 路径会显式禁用 2x URL variant](https://github.com/mapbox/mapbox-gl-js/blob/v3.29.0/src/source/raster_dem_tile_source.ts#L67-L71)。

Mapbox 还使用[较小数值 tolerance](https://github.com/mapbox/mapbox-gl-js/blob/v3.29.0/src/geo/transform.ts#L1315-L1320)
保护 terrain split boundary，并在可用时使用
[per-tile elevation bounds](https://github.com/mapbox/mapbox-gl-js/blob/v3.29.0/src/geo/transform.ts#L1392-L1408)。
MapLibre 4.7.1 把逻辑 tile convention 固定为
[512 pixels](https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/geo/transform.ts#L77-L79)，
并把 terrain mesh 设为
[128 cells](https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/render/terrain.ts#L138-L145)。
另行审查的 MapLibre commit
[`49491068aff0f1801c942de1bdc9da5ada0297b0`](https://github.com/maplibre/maplibre-gl-js/blob/49491068aff0f1801c942de1bdc9da5ada0297b0/src/render/terrain.ts#L153-L160)
仍保留 128-cell terrain mesh；本设计不依赖会漂移的 `main` 表述。

## Pixel domain

Geo 暴露两个相互独立的尺寸：

```ts
type GeoViewSnapshot = Readonly<{
    referenceViewport: readonly [number, number]
    // camera、matrix、zoom、orientation 与 revision facts
}>

type GeoViewSourceCapture<View> = Readonly<{
    view: View
    presentationSize: Readonly<SurfaceSize>
}>
```

`referenceViewport` 是 camera math、projected quality、tile cover 与 picking 使用的稳定
逻辑像素空间。MapLibre host 提供 `map.transform.width` 与
`map.transform.height`，即 CSS-pixel dimensions。Standalone camera 必须自行选择并记录
其逻辑 reference-pixel 空间。

`presentationSize` 是物理 color/depth attachment extent。它可以随 DPR、browser zoom、
output scaling 或 GPU limit 改变，而不会改变已经收敛的 cover。两个尺寸的比例是
presentation scale，不是 geographic LoD。

本次 clean cut 移除旧的 `GeoViewSourceCapture.size`、`GeoViewSnapshot.viewport` 与
`MapLibrePlanarViewSourceDescriptor.viewport` 名称。0.x 阶段不保留 compatibility alias。

## MapLibre source composition

`mapLibrePlanarViewSource()` 接受一个 `presentationSize()` reader。每次 capture：

1. 读取并冻结物理 presentation size；
2. 从构建 projection matrix 的同一个 MapLibre transform 读取 reference viewport；
3. 使用该 reference viewport 创建 camera；
4. 把 camera 与 presentation size 作为独立 fact 返回。

Source 会拒绝非正或非有限的 transform dimension。它不读取
`window.devicePixelRatio`；应用仍负责设置自己的 WebGPU canvas 与 Surface 尺寸。

## Terrain geometry policy

内建 WebMercator terrain policy 使用：

```ts
referenceTileSizePixels: 512
cellsPerPatchEdge: 128
maximumCellSpanReferencePixels: 8
refinementTolerance: 0.005
variableLodPitchThresholdRadians: Math.PI / 3
```

`zoomHint` 定义在常规 512-reference-pixel WebMercator zoom 空间内。Pitch 低于分界时，
uniform mode 从经过 clamp 的
`floor(zoomHint + log2(512 / referenceTileSizePixels))` level 开始。它在该层级评估完整
可见 footprint，只有 measured cell span 超过
`maximumCellSpanReferencePixels * (1 + refinementTolerance)` 时才允许整体细分；
它不会粗化到 zoom anchor 以下。

Pitch 等于或高于分界时，variable mode 保留 direct inverse level probing、
projected-cell evidence、prefix-free output 与 2:1 closure，并使用相同的
reference-pixel threshold 与 tolerance。DPR 不进入任一 mode。

公开 policy 与 feedback 名称使用 `ReferencePixels`。旧的歧义
`maximumCellSpanPixels` policy/feedback field 与 `minimumCellSpanPixels` feedback field
被直接移除，而不是 deprecated。

## 不可变高程 bounds

Tile source manifest 为其 WebMercatorQuad limits 内声明的每个 tile 携带完整且不可变的
elevation-bound record：

```ts
type WebMercatorTileElevationBounds = Readonly<{
    matrixLevel: number
    tileRow: number
    tileCol: number
    minimumElevationMeters: number
    maximumElevationMeters: number
}>
```

COG build 在编码前从有效 source pixel 计算 bounds。Manifest validation 要求 record
唯一、完整、有序，并与声明 limits 完全匹配。Source snapshot 这些 record，并传给
terrain renderer。

GPU cover 使用 dense immutable bounds buffer。高于 source ceiling 的 geometry 解析到
source-ceiling ancestor。缺少 hierarchy 时使用声明的 global elevation range；partial
hierarchy 非法，不能逐 tile fallback。Residency、cache state、request completion 与 atlas
contents 都不能改变 hierarchy 或 geometry selection。

Renderer 在 cover 创建前，按 terrain exaggeration 同时缩放 global bounds 与 tile bounds。
Cover facts 报告 `elevationBoundsMode` 与 record count。

## Representation density

DPR 不会请求更细的 WebMercatorQuad matrix level。未来 raster source 可以把更密集 payload
作为同一 page identity 的显式 representation variant。Underwater Terrain 只有一种
256 x 256 DEM payload representation，因此所有 DPR 下的 page demand 完全一致。

## 清理

实现移除了：

- camera 与 cover metadata 中的 physical-pixel viewport；
- 内建 64-cell terrain geometry 及其陈旧 capacity assumption；
- 旧 pixel field 名称与 compatibility shim；
- shared exact/global resolver 建立后的 global-only patch-bound code；
- 声称 pixel density 可以改变 geometry level 的文档；
- 固化旧 physical-pixel 或 64-cell 行为的测试。

没有新增 Worker、cache、Virtual Raster、root-frontier、clipmap、skirt 或应用本地 LoD
抽象。

## 验收门禁

- 相同逻辑 view 在 DPR 1、1.25、1.5、2 与 3 下产生完全相同的 cover identity、level、
  count、adjacency fact 与 DEM demand。
- Presentation size 随 DPR 改变，renderer resize 仍跟随物理 extent。
- 正俯视 zoom 8 至 14 保持单调、uniform、与历史无关，并与 512-pixel MapLibre cover
  处于相同 tile-count 量级。
- 精确 60 度边界归 variable mode 所有，不出现单帧细化尖峰或粗化坍缩。
- Pitched cover 保持 prefix-free、2:1 balanced、无 overflow 且有界。
- 静态 per-tile bounds 能减少 global-range 的保守 coverage，但 topology 不依赖 residency。
- Picking 与 camera projection 使用 reference coordinate；physical readback 只在
  presentation boundary 转换。
- Typecheck、documentation generation/check、全部 unit test、package/example build、
  wide browser proof、streaming proof、lifecycle proof，以及 90-frame shaded/wireframe
  benchmark 全部通过。
