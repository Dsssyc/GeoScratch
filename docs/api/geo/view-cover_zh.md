---
docId: geo.view-cover.zh
canonical: false
translationOf: ./view-cover.md
canonicalDigest: 553a7244fae25acbb0ee5e51713af5105dd3cc992997a7e30124ef18cc277383
---
# WebMercatorQuad 视图覆盖

[English](./view-cover.md) | [Geo 概览](./README_zh.md)

## CPU 几何与源需求

`new WebMercatorQuadCover(descriptor)` 拥有有界 CPU 工作空间、不可变 WebMercator
平面 profile、`WebMercatorQuadCoverPolicy` 和保守垂向界。
`webMercatorQuadCoverPolicy()` 无需 GPU runtime 即可验证并快照策略。
`select(view)` 同步返回完整、不可变的 `WebMercatorQuadCoverSelection`，包括标准
`patches`、经过验证的精确视图快照、selector 身份、单调 selection revision 和几何
`facts`。它不上传、不回读、不请求资源，也不查询驻留状态。

CPU selector 保留下述候选包围、独立父瓦片决定、确定顺序、prefix-free、2:1 闭包
和质量合同。它基于与地形顶点 ABI 相同的 f32 相机／误差输入及补偿的 40／52 位
整数地址差，使用 JS f64 运算。有限 GPU／CPU 一致性测试不承诺所有浮点阈值处
逐位相同。候选域准备和垂向层级验证复用冻结的纯函数；二者都不依赖历史拓扑或驻留。

输入通过 `createGeoViewSnapshot` 验证并复制。每个成功产物从可复用工作空间复制
私有的 metadata、patch 和 lookup 数组；公开 patches 与 facts 深度不可变。
后续视角不能改写此前产物，调用方负责其持有产物的内存。
`dispose()` 释放工作空间并禁止继续 `select()`；已经返回的快照仍可读取和消费。
`facts().workspaceBytes` 只统计持久 typed-array 工作空间（lookup、patch、闭包标记
与数值状态），不包括临时投影对象和调用方保留的不可变产物。

输入／descriptor 失败沿用下述几何诊断 code。CPU 构造失败抛出
`GEO_WEB_MERCATOR_COVER_SELECTION_INVALID`，`actual.reason` 可为
`descriptor-overflow`、`lookup-overflow`、`adjacency` 或 `unbounded-quality`；
绝不返回半成品几何。相同 code 还拒绝 disposed selector（`disposed`）和伪造／外部
产物（`foreign-selection`）。工作空间分配失败使用
`GEO_WEB_MERCATOR_COVER_WORKSPACE_ALLOCATION_FAILED` 并保留原始 cause。
合法空 cut 省略层级／span 范围；到达显式最高级后，超过目标的有限误差仍如实报告。

`new WebMercatorQuadDemandProjection({ cover, sourceCoverage, maximumDemands })`
借用 cover 的不可变合同并快照已验证的源 limits。源层级必须连续，最粗级不细于
最粗几何级，且适配地址精度；容量是正整数且不超过 cover patch 容量。
`project(selection)` 只接受该 cover 的真实产物，返回不可变
`WebMercatorQuadProjectedDemands`，保留 selection 身份／revision 和原始
view／frame／residency provenance。它确定性去重源身份，分别保留 desired level、
source ceiling、request level 和环绕相机距离优先级。容量不足以
`GEO_WEB_MERCATOR_DEMAND_PROJECTION_INVALID`、reason `demand-capacity` 失败，
不暴露部分需求。projector 不拥有 scheduler、Worker、payload 或 GPU 状态。
selector 释放后，仍可投影此前的真实产物；projector 自身释放后禁止继续投影。
下游 `ViewDemandProducer` 和 Virtual Raster 继续拥有既有预算选择及资源生命周期。

ADR-129 记录 CPU 生产迁移。CPU 产物现已可独立使用，地形集成属于后续独立验证阶段。
以下 GPU API 冻结于 `ebb3336`，作为一致性参考，并继续供显式 GPU 消费者使用；
当前地形 renderer 在其迁移阶段完成前仍使用该 GPU 路径。

## 上传 CPU 产物

`WebMercatorQuadCoverUpload.create(runtime, { cover })` 借用真实 selector 的不可变
descriptor，拥有六个 GPU 缓冲，即 metadata、patch、邻接 lookup 的两组 parity。
它不分配候选／状态反馈缓冲、shader module 或 compute pipeline。任意分配失败都会
释放此前取得的缓冲，不释放借用的 selector 或 runtime。

`prepare(selection)` 接受该 cover 的真实产物，包括 selector 释放前已返回的快照。
每个 attempt 复制私有 metadata／patch／lookup 字节，并拥有三个临时上传 command。
patch 只上传有效前缀；空 cut 上传无害的零记录，绘制 instance 数为零。
新准备成功后会取代并释放此前未提交的 attempt；创建新 command 失败时保留此前
attempt。公开 frame facts 包含产物身份／revision、原始 frame／residency epoch 和
parity，不包含可写的 packet 字节。

`encode(builder, frame)` 追加三个有序的 Scratch opaque upload step，要求当前
prepared-view 和 queue-sequence stamp，并且只消费一次 sequence。Opaque step
防止调用方通过公开 builder command 改写已认证 payload。过期、外部、已释放或重复
encoding 会在提交前被拒绝。独立 uploader 可组合到同一 builder 中。消费者从
`templates()` 借用缓冲，在全部三个上传之后读取，不修改或释放这些缓冲。
该组件不拥有 mesh 或 indirect arguments。

`builder.submit()` 返回后，`receipt(frame, submitted)` 认证真实 `SubmittedWork`，
再使用其不可变 facts 核对精确的三个 command ID、resource ID、allocation version、
produced content epoch 和 step 顺序。同一 submission 内对这些几何缓冲的额外写入
非法；每个记录的 consumer read 必须位于全部上传之后，并读取对应 epoch。
提交后修改已关闭的 builder 不会改写真实 receipt。成功 receipt 释放 attempt 的
command，对相同 submitted work 幂等，释放后仍是不可变证据。它只证明 CPU 上传
已排入队列，不证明 native 完成、栅格驻留或当前视角 ready。仍须观察
`SubmittedWork.nativeOutcome`／`done` 中的原生错误。

生命周期／provenance 失败以 `GEO_WEB_MERCATOR_COVER_UPLOAD_INVALID` 报告，
`actual.reason` 包括 `foreign-cover`、`foreign-frame`、`stale-or-encoded-frame`、
`unsubmitted-frame`、`pending-receipt`、`receipt-mismatch`、`poisoned`、`runtime`
或 `disposed`。已发出的 attempt 必须取得 receipt 后才能继续准备。队列已执行后
receipt 失败，或未取得 receipt 就释放已发出的 attempt，都会使 uploader 进入
poisoned 状态，禁止静默复用部分写入。尚未产生 queue effect 的失败允许释放后用
新的 preparation／builder 重试。Renderer 只有在 receipt 被接受后才能协调源需求。

`dispose()` 幂等释放未完成 attempt 的 command、自有缓冲和 revision authority；
借用的 CPU 产物／runtime 及已返回 receipt 保留。`facts()` 报告 poison／disposal、
活动准备数、已接受 receipt 数和活跃逻辑缓冲字节数；字节数不包括临时 CPU packet，
也不声称等于物理 GPU 驻留。Parity 表示存储与队列顺序，不限制在途帧数，帧准入仍
归 renderer／controller 所有。

## 冻结的 GPU 参考

`GpuWebMercatorQuadCover` 是平面 `WebMercatorQuad` patch 渲染的 geometry LoD
权威。它消费一个不可变 `GeoViewSnapshot`，输出有限标准瓦片 cut、完整身份邻接
lookup、GPU patch count 和几何反馈。它不拥有 tiled source、栅格 demand、atlas
驻留、mesh 顶点数或 draw arguments。

每个 patch 都是 OGC `(tileMatrix, tileRow, tileCol)` 身份。相机派生的探查始终寻址
固定全局矩阵，不创建移动式游戏格网。所有 pitch 都由 `writeView()` 使用实际投影
矩阵和精确 fixed-point 相机准备保守标准 parent 窗口；GPU 在该 patch 的投影 cell
最大奇异拉伸保守上界超过 `maximumCellSpanReferencePixels * (1 + refinementTolerance)` 时记录精确的
稀疏 parent 身份。Pitch 和 FOV 只自然参与投影，
不选择 uniform/variable 算法模式。

候选成员由投影深度上界决定，不依赖径向距离或 pitch/FOV hint 的算法切换。令 cell
宽度为 `h`、参考像素比例为 `s`、实际投影为 `M`，则
`B_ij = s_i * (abs(M_ij) + abs(M_wj))` 给出裁剪后 Jacobian 的界：
`maximumStretch <= h * ||B||F / w`。逆投影将此深度上界映射为保守标准行列窗口。
非平面体的最小深度可能在裁剪区域之外，因此必须用整个包围体的投影半径扩大逆投影域
再舍入到瓦片；不能沿用原来仅针对裁剪点的候选域。
f32 坐标、clipping、metric 的独立误差预算及逆矩阵 residual 区间会向外扩大窗口。
Clipping 在相机相对世界坐标中进行：先组合矩阵行得到原始平面方程，再求点距离，
平面 bounds 最终才投影裁剪顶点。非平面高度区间使用整个高度棱柱的投影包络，
不再只检查两个端点平面。这避免大尺度粗 patch 的 clip 坐标相减／混合丢失 near/far
常量并把可见区域误判为空；插值始终保持 affine homogeneous `w=1`。
Shader 将裁剪 NDC 和插值比例约束在其数学定义域，避免对 subnormal clipping
分母做除法。这些约束处理舍入误差，不改变精确的投影 cell 定义。

无法认证的数值运算回退到声明的完整 geometry 域。独立的粗级 seed 域从不受
refinement 深度上界裁剪。Cover descriptor 的 `maximumCandidates` 限制 seed 与
refinement 输入候选之和，默认 `max(16384, 64 * maximumPatches)`。无效预算在构造时
失败；超预算 view 在 `writeView()` 创建 upload/token 前同步产生
`GEO_WEB_MERCATOR_COVER_CANDIDATE_CAPACITY_EXCEEDED`。选择器不会为适配预算而缩小候选域。
此输入预算不计入物化 children 或后续邻接工作；`facts().candidateCapacity` 单独报告
该预算，不与输出 patch、lookup 容量混淆。

投影度量使用 `GeoViewSnapshot.referenceViewport`、旋转不变的局部 projective
Jacobian、透视、缩短效应和不可变垂直包围体。最大奇异值约束最长屏幕方向，不会用
较小投影面积掩盖细长 cell。物理 presentation size 与 DPR 不会改变 cover 身份；
无法认证 footprint 正深度的 cell 会保守细分。

令 `J = N(q) / w`，仿射分子 `N(q)` 的谱范数是凸函数。平面 bounds 用裁剪多边形
顶点的最大分子除以最小深度，约束整个多边形；非平面 bounds 用保守投影 XY 矩形约束
所有允许高度的分子。整个包围体为正深度时投影其角点，跨相机平面时使用视锥矩形。
深度取包围体和逆投影坐标 slab 下界中的最大值，每个逆矩阵行都有向外舍入的 residual
证书。即使视锥位于高度区间内部，也不会因为两端平面都不可见而漏掉它。

度量使用缩放后的奇异值计算和分子／坐标的绝对舍入误差 allowance。反馈 span 报告
保守上界，不再是端点采样值。在显式 `maximumMatrixLevel` 处，有限上界可能超过质量
目标，反馈会如实报告。最终 footprint 无法认证时使用保留的
`maximumCellSpanQ8 = 0xffffffff`，撤销全部 patch 和 lookup，解码产生
`actual.reason: 'unbounded-quality'`。Demand 和 draw 在 CPU 反馈返回前就拒绝该状态。
普通 44-byte cover state ABI 和有限 Q8 span 编码保持不变（ADR-127）。

`GpuWebMercatorQuadCoverPolicy` 声明有序几何层级、硬 patch 容量、
`cellsPerPatchEdge`、`maximumCellSpanReferencePixels` 和数值容差。无效 fact 在
资源创建前失败。内建 terrain consumer 使用 128 cells 和校准后的五 reference-
pixel 阈值。公共 cover policy 不含 source ceiling 或 pitch 边界。

Kernel 从声明的最小几何窗口开始，探查有限 parent，保留每个精确祖先决策，并只用
命中 parent 自己的四个标准 child 替换它；独立 parent 不会合并成按层矩形。随后输出
prefix-free 可见 cut，并执行局部 2:1 closure。它不从世界根开始、
不做 root-to-leaf quadtree traversal、不统计 trial cut、不检查 atlas slot，也不把
上一帧拓扑作为选择权威。descriptor、lookup 或 patch 容量溢出是硬诊断，不会静默
粗化 cut。合法空可见 cut 返回 `patchCount: 0`，省略 level/span 范围；范围哨兵值
不是公共结果。即使没有剩余 patch，溢出或未完成的 2:1 closure 仍是失败。

`WebMercatorTileVerticalBounds` 是几何 fact，不是 terrain 身份。平面 consumer
可以使用 `[0, 0]`；terrain 可以转换 source elevation metadata；挤出要素可以提供
保守高度。层级数据必须按 level/row/column 顺序完整匹配 spatial profile 声明的每个
瓦片；后代高度范围必须包含于最近声明祖先以及全局高度范围，所有声明瓦片必须属于
最小几何域的后代。几何位于细级 metadata limit 之外或超过最高 metadata level 时，
使用最近的有效祖先 bounds。声明范围内缺记录、顺序错误或祖先不包含后代，会在
GPU 分配前产生 `GEO_WEB_MERCATOR_COVER_VERTICAL_BOUNDS_INVALID`；较小的细级空间
覆盖本身不属于缺失 metadata。记录数不符时直接失败，不枚举可能覆盖全球的缺失层级。
省略层级时使用 `verticalRangeMeters`。缓存、请求和驻留状态不能改变这些 bounds。

`GpuWebMercatorQuadCoverTemplate` 为下游 GPU component 暴露借用的 parity
resource：map metadata、patches、lookup 和完整 state。`writeView()` 拥有临时
upload，其中同时包含相机事实、保守窗口与逆矩阵行的深度证书；`frame()` 选择 parity。`encode()` 在一个
compute pass 中按序追加两个 dispatch，`capture()` 只读取最终几何 state。
`commandsFor()` 暴露当前自有 frame 的持久 `evaluate`、`generate`、`stateFeedback`
命令；消费者通过 `encode()` 保持完整依赖顺序，不能只执行 `generate`。

第一个 dispatch 每个 workgroup 使用 64 个 invocation，并行计算所有配置层级的
独立候选可见性和投影 metric。Indirect count 与相机事实在同一次 view upload 中
打包，只覆盖实际候选域；没有中间 GPU 回读或按层 CPU 调度。第二个 dispatch 使用
一个 64-invocation workgroup：单个 lane 保留精确父链、确定性物化与索引邻接闭包；
完成 workgroup storage 同步后，所有 lane 并行度量最终 patch，通过 workgroup
atomic 归约 Q8 span 范围。Barrier 仅在组内使用，跨组可见性来自前一个有序 dispatch。

拓扑协调明确保留串行，避免为有界 cut 引入全局排序／scan 和大量小 dispatch；昂贵
的候选与最终质量计算并行。每轮闭包从各细边查询不可变的完整身份 leaf index，先
标记粗邻居，再只替换标记 parent 并压缩可见性；本轮临时不可见 child 不会影响后续
标记。成功达到固定点后直接发布本次构建中已验证的可见 lookup 和邻接 delta，不重复压缩可见性、
重建 lookup 或扫描全部边；失败路径保留完整最终验证。这移除了全体 patch 两两邻接扫描以及处理顺序传播。轮次预算
`maximumPatches * levelCount` 必须可用 u32 表示；预算耗尽后若仍违反邻接约束，cut 失败。

Cover 为每个 parity 拥有一份 u32 candidate workspace。物化结束后，其前
`maximumPatches` 个 word 可复用为闭包标记。两份持久 workspace 共
`8 * max(maximumCandidates, maximumPatches)` bytes，由
`facts().candidateWorkspaceBytes` 报告；不包含普通 cover buffer、upload snapshot
和编译器私有 shader 存储。分配不依赖历史 view。并行构造失败时，先等待两个分支
停止生产再统一清理，包括迟到 sibling 返回的 resource/BindSet；单个底层失败保留原
对象，多个失败聚合。
两个公共反馈 decoder 对无效 bytes、失败或过期结果统一抛出 `GeoDiagnosticError`，
code 分别为 `GEO_WEB_MERCATOR_COVER_FEEDBACK_INVALID` 和
`GEO_WEB_MERCATOR_DEMAND_FEEDBACK_INVALID`。`diagnostic.actual.reason` 区分
`byte-length`、`frame-epoch`，cover 的 `patch-capacity`／`descriptor-overflow`／
`lookup-overflow`／`adjacency`／`range`／`unbounded-quality`，或 demand 的 `demand-capacity`／`overflow`／
`source-ceiling`／`record`，同时携带 state/record 事实。消费者检查结构化诊断，不解析
异常文字或依赖 RangeError/TypeError 类型。反馈包含 candidate/patch 数、level range、
邻接、projected-cell span 和 overflow fact，不包含 demand 或 selection mode。

`gpuWebMercatorQuadCoverReadWgslModule()` 提供完整身份 lookup、covering-neighbor
解析和 edge coordinate snapping，不使用碰撞风险更高的紧凑 z14 key。

`GpuWebMercatorQuadDemandProjection` 是独立 source lowering 阶段。它借用 cover
frame，拥有 source coverage 与 parity resource，对可执行 source tile 去重，并保持
`desiredSampleLevel`、`sourceLevelCeiling`、请求身份、相机环绕距离优先级、frame
epoch 和 residency epoch 分离。其有限反馈可转换为 `ViewTileDemandSet`；Virtual
Raster 仍然位于下游且保持被动。Projection 在读取 patch 前拒绝失败 cover 或不匹配
的 frame，输出零 demand 并设置既有 `overflowCount` 失败标记。因此非零 overflow
也可能表示上游 cover 无效；反馈解码会拒绝它，不会把它视为合法空 demand。

`GpuWebMercatorQuadPatchDraw` 是独立 draw-count adapter。它借用 cover state，
拥有 consumer element count 和 parity draw-indirect buffer，通过一次持久 compute
写入 `[elementCount, patchCount, 0, 0, 0]`。该 20-byte record 可直接用于 indexed
draw，其前 16 bytes 也可用于 non-indexed draw。失败 cover 输出零 instance，避免在
CPU 反馈尚未返回时绘制部分几何。Cover 不拥有这些 buffer 或 consumer mesh。

相关决策：ADR-083 建立 inverse cover 与被动 Virtual Raster；ADR-084 建立
reference-pixel 质量；ADR-086 废弃其中的 pitch gate，并分开 cover、source demand
和 patch draw 权限；ADR-087 保留稀疏 parent 决策；ADR-088 定义投影最大拉伸；
ADR-089 定义 consumer-neutral indexed/non-indexed indirect ABI；ADR-125 记录候选完整性、
失败 cut 撤销与有界执行设计。

ADR-126 明确完整垂直元数据与最近祖先包含关系。

Map metadata 布局从 560 bytes 增为 656 bytes：两个 vec4 深度支持向量和四行 residual
vec4，每个 parity 及每次 view upload 增加 96 bytes。候选 workspace 容量、dispatch 数
与反馈频率保持不变。ADR-127 记录高度体与候选域证明，以及有限原生对照。
