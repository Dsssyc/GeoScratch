# WebMercatorQuad 连续距离 Band 对称性修复

## 状态

2026-08-19 已批准。英文文档为事实基准；本文是经审阅的中文翻译，冲突时以英文为准。

本文只修复 ADR-083 inverse cover 中的一处缺陷，不引入第二套 selector，也不替换已接受
架构。

## 已观察缺陷

当前最细 cover 只把固定 4×4 窗口的最小 row/column 向下取整到偶数 parent-group
边界。相机瓦片索引为奇数时，相机瓦片会落到窗口末端。Example 默认位置的 z14 相机
column 是 `13697.966`，最细窗口却是 `13694..13697`：一侧接近四个细瓦片，另一侧几乎
没有。

直接进入最终相机与先倾斜/旋转再回到最终相机，会产生完全相同的 cover facts 与 pixel
hash。因此根因是确定性空间量化，不是 stale feedback、previous topology、residency 或
浮点漂移。

## 继承的不可妥协边界

本次修复保留 ADR-083 的全部边界：

- 每个 patch 仍是 OGC `WebMercatorQuad` matrix/row/column identity；
- cover 仍是唯一 geometry LoD authority；
- 从 camera/view facts 直接生成，不遍历世界 roots；
- Virtual Raster 仍只是被动 demand、residency 与 fallback service；
- 输出继续 deterministic、prefix-free、覆盖可见 source，且边相邻最多差一级；
- mesh stitching、完整 identity lookup、indirect draw、double-flight、高精度相机编码、
  lifecycle 与 diagnostics 全部保持；
- previous-frame topology 与 atlas availability 不得决定 settled cut。

## 工业实现依据

MapLibre GL JS 根据相机到 tile bounding volume 的连续距离计算 desired zoom。MapLibre
Native 暴露最细层最小半径，并根据 view/camera point 到 tile AABB 的连续距离决定 split。
Cesium terrain 根据投影几何误差与 tile distance 选择层级。deck.gl 普通平面 TileLayer 则
用连续 viewport bounds 在单一 zoom 上枚举，因此不会产生 mixed-LoD 方向偏置。

我们只吸收“连续空间误差/距离”原则；不采用它们的 root-forward traversal、orientation
threshold、cache coupling 或 previous-frame availability 逻辑。

## 决策

以相机为中心的连续 AABB-distance bands 取代 parity 平移的固定窗口，同时保留 GPU 有界
直接枚举。

### Fixed-coordinate band

对每个 matrix level `L`，相机规范 wide-fixed 单轴坐标为 `C`，总位数为 `Q`。一个瓦片
宽度是 `2^(Q - L)` fixed units。每一级使用常量最细半径 `R = 2` 个该级瓦片。

```text
tile       = floor(C / tileWidth)
fractional = C mod tileWidth != 0
rawMin     = tile - R
rawMax     = tile + R - (fractional ? 0 : 1)
```

`rawMin..rawMax` 精确表示单轴 AABB 到连续相机点距离小于 `R` 的标准瓦片集合。`tile` 与
`fractional` 直接从两个 u32 fixed limbs 推导，不发生 f32 转换。

随后只向外扩张到完整 parent groups，不能平移或缩小：

```text
alignedMin = rawMin 向下对齐到偶数 child index
alignedMax = rawMax 向上对齐到奇数 child index
```

因此每个非 minimum level 单轴最多六个瓦片，每级最多枚举 36 个 candidate。精确落在
parent 中线时向两侧共同扩张，不做方向 tie-break。

### 嵌套直接 bands

每一级都由同一连续相机坐标独立生成。粗一级 band 会与细一级 band 的 parent 投影求并集
作为完整性防线，再 clamp 到 `TileMatrixCoverage`。Minimum matrix level 仍保留完整 safety
domain。

现有 finest-level 决策（`ceil(zoomHint)` 加已接受的 pitch boost）不变。Pitch 与 bearing
不能给 band 引入方向偏置；bearing 只影响最终 frustum visibility，不能旋转或平移世界空间
LoD field。

被 finer band 完整覆盖的 candidate 继续省略。现有最终 frustum test、2:1 closure、lookup、
demand、source-ceiling lowering 与 indirect argument 均不变。

## 可观察保证

- 任意连续相机位置下，镜像等距 tile AABB 得到相同 desired level，包括奇数 row/column；
- 量化每条边最多向外增加一个 tile，不能缩小保证半径或把完整 band 移向一侧；
- 返回同一相机时 cover 与导航路径无关；
- 固定相机位置与 zoom 时，bearing 0/180 只旋转 visibility，不改变世界空间 LoD 组织；
- 每个非 minimum level 最多 36 个 candidate，外加配置的 minimum safety domain；不存在
  root DFS 或重复 trial；
- physical patch/demand budget 继续硬失败，不隐藏降质。

## 验证

生产代码修改前，测试必须先在旧实现上按预期失败。

Reference 门禁：

- z14 奇数 column 的东西等距采样必须同级；
- z12 奇数 row 的南北等距采样必须同级；
- 精确奇数 parent 中线必须向两侧扩张，不得 tie bias；
- parent-group 完整性、嵌套、prefix-free、可见完整性、2:1、zoom 单调与远近顺序不回归；
- 每级 candidate 上界保持有限。

真实 Chrome/WebGPU 门禁：

- fresh-direct 与 pitched/rotated-to-final 的最终俯视保持 pixel-identical；
- 默认位置 bearing 0/180 不再出现单侧最细 coverage；
- 俯视、高 pitch、mobile、resize、failure、cancellation、cache 与 lifecycle proof 全通过；
- 现有 90-frame shaded/wireframe latency gate 继续作为硬门禁；
- patch count、request、source ceiling、device loss、overflow 与 diagnostics 不回归。

## 非目标

- 不重新设计 screen-space-error policy；
- 不改变 pitch boost、source precision、mesh density 或 terrain shader；
- 不加入 LoD hysteresis 或 previous-frame geometry authority；
- 不修改 Virtual Raster、Worker、Cache 或 atlas；
- 不创建 moving clipmap identity，也不保留缺陷窗口兼容路径。

## 参考

- https://github.com/maplibre/maplibre-gl-js/blob/main/src/geo/projection/covering_tiles.ts
- https://github.com/maplibre/maplibre-gl-js/blob/main/developer-guides/covering-tiles.md
- https://github.com/maplibre/maplibre-native/blob/main/src/mbgl/util/tile_cover.cpp
- https://github.com/maplibre/maplibre-native/pull/2958
- https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/QuadtreePrimitive.js
- https://github.com/visgl/deck.gl/blob/master/modules/geo-layers/src/tileset-2d/utils.ts
