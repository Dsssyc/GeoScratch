# WebMercatorQuad 俯仰分界投影单元 Cover

## 状态

本设计于 2026-08-19 获得确认。英文文档是事实基准；本文是经审阅的中文翻译，冲突时
以英文为准。

本设计修正 ADR-083 inverse standard cover 内部的质量模型，不恢复 root-forward
frontier，也不向 Virtual Raster 交付任何 LoD 权威。

## 已观察缺陷

当前 cover 在每个非 minimum level 都围绕 canonical camera position 使用固定两瓦片
半径。Parent alignment 最多把单轴扩张至六个瓦片，但该半径不响应 viewport、FOV、
device pixel ratio、terrain elevation 或 patch 的投影尺度。

在 `1512 x 864` viewport、`zoom=13.25`、`pitch=0`、`bearing=0` 的受控
Chrome/WebGPU 复现中，系统无 overflow、device error、cache miss 或未收敛 request，
却选择了横跨 z12 至 z14 的 23 个 patch。因此中央细、周边粗是 level policy 的确定性
输出，而不是异步 residency。

已有 browser proof 使用 `1280 x 800` viewport，只检查 min/max level 单调性、parity
对称、adjacency 和 density，没有要求正俯视可见足迹使用统一的 projected-cell 质量层级。

## 继承边界

- 所有 geometry patch 与 demand 保持 OGC `WebMercatorQuad` identity。
- `GpuWebMercatorQuadCover` 仍是唯一 geometry-LoD authority。
- Candidate 从 camera/view 反向直接枚举，不恢复 z0、source root、safety root、render
  root 或 previous topology traversal。
- Virtual Raster 仍只负责 demand、residency、fallback 与 publication；availability 不得
  选择 geometry。
- 输出保持 deterministic、prefix-free、覆盖配置内可见区域，且边相邻层差不超过一级。
- 保留 camera-relative wide-fixed addressing、mesh stitching、indirect draw、
  double-flight、lifecycle 与 diagnostics。
- Candidate 工作量可以随有界可见足迹和 patch 硬容量增长，不再宣称与 viewport 无关的
  常量上界。

## 工业依据

MapLibre Native 在 pitch 超过可配置阈值前保持单一 zoom，当前默认阈值为 60 度。
MapLibre GL JS 结合 camera height、tile AABB distance、FOV 与 off-nadir scale 计算逐瓦片
目标层级。Cesium 依据 maximum screen-space error 细分 terrain。deck.gl 的 planar tile
cover 在可见 bounds 上枚举一个 viewport zoom。

共同原则是由可见投影质量而非固定瓦片半径选择 level。GeoScratch 保留自己的 direct
inverse construction 与 GPU authority，不复制这些系统的 root traversal 或 availability
耦合。

## 公开 Policy

`GpuWebMercatorQuadCoverPolicy` 新增三个标准化且必填的事实：

```ts
type GpuWebMercatorQuadCoverPolicy = Readonly<{
    minimumMatrixLevel: number
    maximumMatrixLevel: number
    sourceMaximumMatrixLevel: number
    maximumPatches: number
    cellsPerPatchEdge: number
    maximumCellSpanPixels: number
    variableLodPitchThresholdRadians: number
}>
```

`cellsPerPatchEdge` 是一个标准瓦片所承载的 geometry grid 分辨率；
`maximumCellSpanPixels` 是单网格在屏幕上的最大面积等价投影跨度；
`variableLodPitchThresholdRadians` 位于 `[0, PI / 2]`。Pitch 严格小于阈值时使用统一
可见足迹 cut，等于或大于阈值时使用可变 projected-cell LoD，因此边界归属唯一且确定。

Terrain renderer 提供 64 cells、八像素阈值，并默认使用 `PI / 3`。其 descriptor 接受
可选的标准化阈值，使应用无需重建 cover 即可覆盖默认值。

Underwater Terrain 读取 `VITE_UNDERWATER_TERRAIN_VARIABLE_LOD_PITCH_DEGREES`。缺失或
空白表示 60；0 至 90 的有限值只转换一次并以 radians 传给 renderer；无效输入在 GPU
初始化前失败，并指出变量名及合法范围。Library 自身不读取 process 或 bundler env。

## Projected-Cell Metric

GPU 恢复 ADR-077 的局部 projective Jacobian。针对标准 patch 的两个配置 elevation
plane，将水平 polygon 裁剪到 WebGPU 六个 homogeneous clip plane；在每个存活顶点处，
分别求一个 Web Mercator grid cell 沿 x/y 位移经过 perspective division 后的像素向量
`Jx` 与 `Jy`：

```text
cellSpanPixels = sqrt(abs(Jx.x * Jy.y - Jx.y * Jy.x))
```

所有可见顶点和两个 elevation plane 的最大值控制 level。可能跨过 camera plane 的 cell
返回 viewport 最大值并保守细分。Determinant 对水平 basis rotation 不变，并包含 viewport
scale、perspective、foreshortening 与 elevation 影响。

## 阈值以下的 Uniform Mode

Uniform mode 首先基于 camera altitude、vertical FOV、viewport aspect、pitch 与四条
corner ray，在 minimum/maximum elevation plane 上推导完整 viewport footprint 的保守
camera-centered world envelope，并在 parent alignment 前增加一个标准瓦片 guard。该
envelope 在 world space 中使用 radial bound，因此 bearing 只旋转内部 visibility，不会
破坏覆盖保证。

Kernel 在经过 clamp 的 `ceil(zoomHint)` probe level 上只评估一次完整 footprint。标准
matrix level 每提升一级，projected cell span 精确减半，因此
`ceil(log2(maximumSpan / maximumCellSpanPixels))` 可以直接反解 uniform level，无需重复
扫描每一级。只输出反解后的 aligned window；maximum level 是终止 fallback。同一
settled top-down footprint 内不得出现更细孤岛或 coarse safety patch。

可观察不变量：

- 除 source coverage clipping 外，所有可见 patch 使用同一 geometry level；
- viewport 变宽或 pixel density 增长可以增加 patch count 或统一 level，但不能保留固定
  大小的中央细分岛；
- zoom-in 不能让仍可见位置变粗；
- bearing、camera tile parity 与 navigation history 不改变 settled cut。

## 阈值及以上的 Variable Mode

Variable mode 在每个可能 child level 上，围绕精确 camera coordinate 直接探查有界标准
parent candidate。Parent-tile 单位的保守 search radius 由 viewport focal length、
`cellsPerPatchEdge`、`maximumCellSpanPixels` 与 parent-group guard 推导，不再是固定常量。

GPU 对每个可见 parent 计算 projected-cell metric。最大 cell span 超过阈值的 parent 将四个
标准 children 贡献给该 level 的 refinement window。Bounding window 可以保守包含内部
空洞，但不得遗漏任何超阈值 candidate。Finer window 通过 parent projection 保持嵌套；
最终 visibility rejection、prefix-free emission 与 2:1 closure 保持原终止阶段。

这是 inverse level probing，不是 quadtree traversal：每个 level 都从 camera/view 推导的
标准瓦片 search window 独立开始，不消费 parent topology、world root、atlas slot 或上一帧
cut。

## 可观察性

Selection feedback 新增：

```ts
selectionMode: 'uniform' | 'variable'
minimumCellSpanPixels?: number
maximumCellSpanPixels?: number
```

数值描述已输出可见 patch，仅用于观察。Policy facts 暴露标准化阈值与 projected-cell
设置。Overflow 继续是硬 diagnostic，不允许 selector 为满足容量而静默降级。

## 验证

Reference/Node gate 必须证明默认与显式 threshold validation、60 度边界归属、宽屏与
Retina 俯视统一层级、viewport 增长会扩张工作量而非固定细分岛、variable mode 的 near/far
顺序、Jacobian rotation invariance、camera-plane protection、zoom monotonicity、标准
identity、prefix freedom、可见覆盖、deterministic order、2:1 adjacency，以及 source
ceiling 只改变 demand。

Chrome/WebGPU gate 必须覆盖 `1280 x 800` 与 `1512 x 864`、可行时的 DPR 1/2、fractional
zoom 13.25、pitch 0/59.9/60/70、bearing round trip、A-B-A、resize、streaming、
cancellation、cache、lifecycle，以及 shaded/wireframe 90-frame performance。默认 graph
contract 必须报告 60 度；Vite env override 必须能从 normalized cover policy 中观察。

## 非目标

- 不恢复 root-forward selector、trial cut、compatibility mode 或 CPU selected tile list。
- 不重做 Virtual Raster、atlas、Worker、cache、source protocol 或 terrain shader。
- 不加入 temporal geometry hysteresis 或 availability-driven topology。
- 不声称覆盖 globe；该契约仍限定 planar `WebMercatorQuad`。

## 参考

- https://github.com/maplibre/maplibre-native/blob/main/src/mbgl/util/tile_cover.cpp
- https://github.com/maplibre/maplibre-native/blob/main/src/mbgl/map/map_impl.hpp
- https://github.com/maplibre/maplibre-gl-js/blob/main/src/geo/projection/covering_tiles.ts
- https://github.com/maplibre/maplibre-gl-js/blob/main/developer-guides/covering-tiles.md
- https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/QuadtreePrimitive.js
- https://github.com/visgl/deck.gl/blob/master/modules/geo-layers/src/tileset-2d/utils.ts
