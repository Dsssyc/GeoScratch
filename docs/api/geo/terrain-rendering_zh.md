---
docId: geo.terrain-rendering.zh
canonical: false
translationOf: ./terrain-rendering.md
canonicalDigest: b90b01a3c73cce89ffeb8cf1771811c8927f242c17ae8352f353761729bd0c3c
---
# 地形渲染

[English](./terrain-rendering.md) | [Geo 概览](./README_zh.md)

`createWebMercatorTerrainRenderer` 是 Geo 的 OGC `WebMercatorQuad` terrain 编排器。
它组合 `MapFieldLayer`、已准备的 Virtual Raster runtime、
`GpuWebMercatorQuadCover`、`GpuWebMercatorQuadDemandProjection`、
`GpuWebMercatorQuadPatchDraw`、生成的 terrain WGSL、随 capture 调整的 attachment、
延迟反馈和显式释放。不存在假装 planar 与 globe 选择等价的通用 terrain alias。

帧顺序是：

```text
view upload
    -> adaptive inverse-cover compute
    -> source-demand projection compute
    -> patch-draw indirect preparation compute
    -> terrain drawIndirect
```

这些阶段权限分离。Cover 只选择标准几何 patch 和邻接；demand projection 将 patch
映射到 Virtual Raster source ceiling；patch draw 把 consumer vertex count 与 GPU
patch count 组合；Virtual Raster 随后只调度显式 `ViewTileDemandSet` page，并解析
exact 或 ancestor 数据，驻留状态不改变几何拓扑。

内建 terrain consumer 使用 128-cell 标准 patch、五 reference-pixel 最大奇异投影
cell 拉伸和 0.005 数值容差。所有 pitch 使用同一自适应 selector。
不存在 60 度边界、mode feedback、renderer override 或 example 环境变量。物理
presentation size 与 DPR 不参与质量度量。

`elevationRangeMeters` 和可选 `WebMercatorTerrainElevationBounds` 仍然是 terrain
source fact。Renderer 应用 exaggeration，再把它们转换为通用
`WebMercatorTileVerticalBounds` 后构造 cover。源范围描述各自栅格层级，renderer
因此将后代范围并入每个有效祖先，再验证几何层级的包含关系；派生 bounds 使用独立
snapshot，不改变源 metadata 或后端数据，并在 renderer GPU 分配前完成验证。
此转换不依赖驻留和请求状态（ADR-126）。Hierarchy 必须完整匹配 source
coverage；省略时使用全局范围。cache hit、atlas page 和请求完成不能提供或改变 bounds。

Demand feedback 保持期望几何精度、source ceiling 和可执行请求瓦片互相独立。
`VirtualRasterRuntime.reconcileViewDemands()` 只调度这些显式请求。exact-resident
page 不消耗 request budget；缺少 exact page 时通过 page-table ancestor fallback
继续渲染，同时保持同一几何 cut。

`webMercatorTerrainWgslModule` 拥有完整 vertex 路径：重建 wide-fixed 标准瓦片
位置、在 f32 转换前减去相机、解析 cover neighbor、吸附混合 LoD 边缘、按全局 field
坐标采样高度并投影。Terrain 使用 indexed indirect draw，让每个逻辑网格顶点在每个
patch 中只执行一次 vertex shading，而不是按每个三角形角重复执行。Renderer 拥有
等长的 triangle-list 与 line-list index buffer；后者直接包含每个 cell 的 bottom、left
和真实 diagonal edge。内建 wireframe fragment 以稳定瓦片颜色绘制这些 native、
post-stitch 线段，不在 fragment 中猜测拓扑；应用只提供 fragment presentation WGSL。

`render(capture)` 消费一个 `GeoViewSourceCapture<ViewInput>`，根据
`presentationSize` 调整物理 attachment，并返回
`GeoFrameResult<WebMercatorTerrainFrameValue>`。submission/native observation、cover
feedback、demand feedback、raster settlement 和后续 publication 保持不同 promise
与 fact。反馈在自身 submission 发出后即开始异步消费，不要求额外渲染一帧。
只有匹配当前相机决策的反馈才能更新当前几何与选择事实。资源侧独立接受帧号单调
更新的完整 source-demand 观察：它基于 renderer 生命周期内不可变的 source/coverage，
保留原始 frame 与 residency provenance，并包含选中的已驻留页。旧观察不能证明
当前视角就绪、倒退更新过的资源目标，或改变几何 cut。

`WebMercatorTerrainFrameSettlement.superseded` 表示几何观察已经过时；这类 settlement
仍可报告资源 reconciliation 与工作。除新请求外，仍在执行的保留请求也计入
`residencyWorkCount`，以便实际完成时唤醒后续 publication。几何和源选择已知时，
资源加载仍可能在进行，不能将其当成 exact-resource-ready 证明。

帧通过显式 settlement 等待，避免额外渲染来轮询 readback。同决策帧共享已捕获反馈的
settlement；若捕获容量占满，renderer 只保留最新帧的一个等待者，并释放被替换的等待者。
反馈槽释放时，等待者获得重新捕获当前视角的 follow-up 与适用的资源工作，但不附加旧
几何事实。当前反馈请求一次确认／publication 帧；未变化且已确定的决策不再捕获反馈。
释放 renderer 会结束等待，反馈失败会拒绝该等待。frame controller 的 latest-only
admission 以及既有 in-flight／follow-up 上限保持不变。

Renderer 在三个组合 GPU component 中分别拥有两套 parity resource。Underwater
Terrain 使用测量得到的双 in-flight bound。Renderer 不拥有 map host、controller、
source manifest、URL policy、Worker system、decoder 或 persistent-cache 选择。

未来 feature-to-surface conformance 不属于该 renderer。独立 Geo preprocess product
可以消费其 surface geometry 或一致 field sampler，但 feature 身份和 source tiling
不能变成 terrain tile render-to-texture 状态。

相关决策：ADR-074 分配 terrain WGSL 权限；ADR-083 定义 inverse cover 与被动
Virtual Raster；ADR-084 定义 reference pixel；ADR-086 统一 selector，并分开几何、
source demand 与 draw-count 权限；ADR-087 与 ADR-088 分别定义稀疏 parent 细分和
投影最大拉伸；ADR-089 定义 indexed terrain execution；ADR-128 定义异步反馈消费与
独立的资源观察进度。
