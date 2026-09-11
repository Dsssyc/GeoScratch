---
docId: geo.terrain-rendering.zh
canonical: false
translationOf: ./terrain-rendering.md
canonicalDigest: 332b74e4a624d2705ea614640c767a4dfcadd5768ac7c18de059f19869a18a4f
---
# 地形渲染

[English](./terrain-rendering.md) | [Geo 概览](./README_zh.md)

通用 raster WGSL 和 sampler 元数据契约见 [Virtual Raster](./virtual-raster_zh.md)。
地形继续组合现有的常量生成高度采样器。

`createWebMercatorTerrainRenderer` 是 Geo 的 OGC `WebMercatorQuad` 地形编排器。
它组合一个 `MapFieldLayer`、已准备的 Virtual Raster runtime、
`WebMercatorQuadCover`、`WebMercatorQuadDemandProjection`、
`WebMercatorQuadCoverUpload`、生成的 terrain WGSL、随 capture 调整的 attachment
和显式释放。CPU selector 是唯一几何权威。GPU 实现保留为冻结的一致性参考及现有
显式 GPU consumer 的 API；生产地形没有 CPU／GPU 切换开关。

帧顺序是：

```text
CPU 完整 cover 选择 -> CPU 源需求投影
    -> 可选的 Virtual Raster publication 上传
    -> 相机／patch／邻接 lookup 上传
    -> indexed patch-draw 参数上传
    -> terrain drawIndexedIndirect
```

`contractFacts().stageOrder` 依次为 `cpu-cover-selection`、`cpu-source-demand`、
`cover-upload`、`patch-draw-upload`、`terrain`。前两项是同步 CPU 工作，只有
`terrain` 是 GPU pass。`selectionPath` 为 `cpu-camera-inverse-webmercatorquad-cover`，
`countPath` 为 `cpu-produced-indirect-arguments`。`passIds` 只含 terrain pass；
`commandIds` 只含持久 terrain draw command。`coverUpload` 报告上传所有权与 receipt；
`patchDraw` 报告 renderer 的两个 buffer、20 字节参数 ABI 和 element count。
Renderer 不分配 GPU selection／demand compute 对象或 cover-feedback 回读缓冲。

这些阶段职责分离。Cover 选择标准几何 patch 与邻接；需求投影映射源 coverage，保留
期望精度；terrain 拥有 mesh，上传 `[elementCount, patchCount, 0, 0, 0]` 到 indexed
indirect buffer。精确的几何上传 receipt 验证通过后，`ViewDemandProducer` 执行既有
显式需求预算，Virtual Raster 调度选中页。驻留不改变几何拓扑；选择或投影失败不向
下游交付部分几何或资源需求。

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

不可变 CPU 源产物保持期望几何精度、source ceiling 和可执行请求瓦片互相独立。
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

`render(capture)` 消费一个 `GeoViewSourceCapture<ViewInput>`，按
`presentationSize` 调整物理 attachment，返回
`GeoFrameResult<WebMercatorTerrainFrameValue>`。每帧同步选择完整不可变 cut、投影
源需求并提交上传，再绘制。`value.frame.uploadReceipt` 记录准确的已排队几何产物与
producer epoch；receipt 验证失败时该字段缺省。它不证明 native success 或 raster
ready。四条 provenance 链分别把 CPU metadata、patch、lookup 和 indexed 参数的真实
上传连接到 terrain draw。

`WebMercatorTerrainFrameSettlement.coverSelection` 与 `.projectedDemands` 替代原先
GPU feedback 字段。Settlement 通常立即提供当前选择、reconciliation、新建及保留的真实
active request 数与对应 `residencySettlement` promise（同时等待适用的 pending publication
acknowledgement），不再有旧几何 `superseded`
标志。Renderer state 使用同名新字段，移除 GPU 回读容量和 stale-feedback 计数。
`convergenceState: 'converged'` 只表示当前 CPU 选择与需求已接受，资源可能仍在加载，
并非 exact-resource-ready 证明。每次接纳的决策都有新产物身份及原始 view／frame／
residency provenance，即便空间 cut 与早先视角相同。Native 或资源完成不能安装旧 cut。

帧 `observation` 独立等待 native success 及适用的 raster publication acknowledgement。
`submit()` 返回后，receipt、reconciliation 或 provenance observer 错误通过此
observation 拒绝，同时保留返回的 `SubmittedWork`，让 controller 核算已发出的工作。
Receipt 失败不发起源请求。这些提交后错误与 native failure 对 renderer 是终止性错误。
排队前构造失败可以重试；可能部分发出队列工作的事务必须终止。失败视角的选择事实
不能证明该视角已 converged。

新返回的 Virtual Raster publication 在后续准备可能失败前即登记。提交前重试复用
同一个 pending update；后续帧复用已发出的 publication 与 acknowledgement promise，
不重复 publish 或 encode。仅成功 acknowledgement 清除 pending publication，并推进
renderer 的 `virtualSnapshotEpoch`。`initialize()` 共享并发尝试；借用的 raster 一次性初始化失败必须终止，
后续本地排队前失败才可复用同一 publication 重试。Native 失败保持独立可观测，并阻止后续渲染。

没有 cover 回读、capture waiter 或回读轮询。保留的 active request 将完成信号传递给
每个新 settlement，使最新帧在没有相机事件时也能唤醒资源 publication。前一 publication
仍 pending 时新 staged 的页，让 settlement 等待该 acknowledgement 后再请求有界 follow-up。通用 frame
controller 仍拥有最新帧 admission 和 follow-up 上限；Underwater Terrain 保留测量确定
的双 in-flight 限制。

Renderer 拥有 CPU selector／projector／uploader、两套几何上传 parity 资源、两个
20 字节 indirect buffer、不可变 mesh／index buffer、配置、depth attachment 及配套
Scratch 对象。构造失败按逆序释放已成功取得的对象；`dispose()` 幂等释放全部自有对象，
包括 command 与 pipeline。释放不销毁借用的 runtime、Surface 或 Virtual Raster。
Virtual Raster 的 owner 负责完成或放弃 pending publication，并取消请求。迟到回调
不能恢复 renderer 状态。`persistentFacts()` 仅报告仍活动的 renderer 自有 resource、
bind layout、bind set、pipeline 与逻辑 GPU 字节数，不含借用的 raster／Surface 对象、
CPU workspace 或临时上传字节。无关 runtime 分配不影响 renderer 的持久身份／数量
检查。纹理逻辑字节随当前 depth attachment 尺寸变化，不代表驱动的物理显存。

Renderer 不拥有 map host、frame controller、source manifest、URL policy、Worker
system、decoder 或 persistent-cache 选择；这些职责与既有资源就绪／ancestor fallback
合同不变。

未来 feature-to-surface conformance 不属于该 renderer。独立 Geo preprocess product
可以消费其 surface geometry 或一致 field sampler，但 feature 身份和 source tiling
不能变成 terrain tile render-to-texture 状态。

相关决策：ADR-074 分配 terrain WGSL 权限；ADR-083 定义 inverse cover 与被动
Virtual Raster；ADR-084 定义 reference pixel；ADR-086 统一 selector，并分开几何、
source demand 与 draw-count 权限；ADR-087 与 ADR-088 分别定义稀疏 parent 细分和
投影最大拉伸；ADR-089 定义 indexed terrain execution；ADR-128 保留为冻结 GPU 反馈模型；ADR-129 将生产地形选择／
源需求移到 CPU，同时保留资源进度与 native acknowledgement 的独立合同。
