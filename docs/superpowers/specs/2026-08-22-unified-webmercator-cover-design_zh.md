# 统一自适应 WebMercatorQuad Cover 设计

## 状态

已批准在 `dev-feature` 上实现。ADR-086 是正式决策记录，英文设计稿是事实基准。

## 目标

用一条连续的 projected-cell 自适应路径取代按 pitch 划分的 `uniform`/`variable`
双模式 WebMercatorQuad cover，并把几何选择、栅格需求和 patch mesh 绘制准备彻底
分开。保留高精度坐标、GPU-driven、标准瓦片身份、被动 Virtual Raster、确定性、
prefix-free 和 2:1 邻接约束。

## 权限边界

`GpuWebMercatorQuadCover` 只拥有标准几何 cut、垂直包围体、所有 pitch 下统一的
投影误差细分、完整身份 lookup、2:1 closure 以及 GPU patch/state 反馈。它不拥有
source ceiling、栅格请求、Worker 优先级、atlas 驻留、mesh 顶点数或 draw-indirect
参数。

独立的 WebMercatorQuad demand projection 消费 cover frame 和一个来源表示的不可变
matrix limits，将期望几何 patch 降低为可执行 source tile，并保持期望层级、来源
上限、请求身份、优先级和代际事实互相独立。Virtual Raster 只消费由此得到的
`ViewTileDemandSet`。

独立的 patch draw preparation 消费 cover frame 和调用方拥有的顶点数，在 GPU
路径内形成 draw-indirect 参数。Cover 不知道 terrain grid。

未来 feature conformance compute stage 会消费 feature geometry、surface geometry
product 或一致的 field sampler，产出带 feature ID 和 indirect 参数的贴合后 GPU
几何。它可以依赖当前 surface product，但不会采用 terrain tile 身份，也不会把
矢量要素投射成 terrain tile 纹理。本任务只固定边界，不发布臆造的 feature API。

## 公共 API Clean Cut

删除 cover policy 中的 `sourceMaximumMatrixLevel` 和
`variableLodPitchThresholdRadians`，删除 descriptor 的 `vertexCount`，删除 feedback
的 `selectionMode`、cover 内栅格 demand、cover 内 draw arguments 以及 Underwater
Terrain 的 pitch 环境变量。

Cover 边界中的 `elevation*` 改为 `vertical*`，`visibleInstances` 改为 `patches`。
Terrain renderer 的输入仍保留 `elevation*`，因为 DEM source metadata 的确是高程；
renderer 在构造通用 cover 时把它转换为垂直包围体。

## 统一选择路径

CPU oracle 与 GPU kernel 始终使用同一条自适应 parent-window 路径：从标准最小几何
窗口开始，围绕精确 fixed-point 相机位置探查有限 parent window，只细分投影 cell
跨度超过 reference-pixel 阈值的可见 parent，建立嵌套标准 child window，输出
prefix-free cut，执行 2:1 closure，并生成 lookup 与质量事实。

不存在 pitch 分支、上一帧 cut 权限、root-forward traversal、atlas-driven 选择或
移动 clipmap。

内建 128-cell patch 和 512-reference-pixel tile 的首个质量基准是每 cell 四个
reference pixels，最终以真实浏览器测量而不是只凭算术决定。

## 垂直包围体

`WebMercatorTileVerticalBounds` 为标准瓦片保存不可变保守垂直范围。层级数据必须
完整匹配 spatial profile；部分元数据仍然无效。高于 bounds 最高层级的几何使用
对应祖先范围，缺少层级时使用全局 `verticalRangeMeters`。

Bounds 只影响可见性和投影质量。缓存、atlas、请求完成和异步 publication 都不能
改变几何拓扑。

## 验收

- 源码、公共 API、WGSL、example 和当前 API 文档不再包含旧 pitch 阈值或
  `selectionMode`。
- Cover identity 不含 demand buffer 和 draw-argument buffer。
- 不读取 CPU patch count 即可形成 draw-indirect 参数。
- source demand 保持期望层级、来源上限、请求瓦片、优先级和代际事实分离。
- 相同视图确定、DPR 不变、2:1、top-down 对称、zoom-in 不反向粗化。
- 穿过 60 度没有全局模式跳变。
- 生命周期、A-B-A、延迟反馈、wireframe、cache、failure、shaded、高 pitch、overflow
  和 WebGPU native observation 门禁全部通过。
- 英文当前 API 文档和中文翻译与源码一致。
