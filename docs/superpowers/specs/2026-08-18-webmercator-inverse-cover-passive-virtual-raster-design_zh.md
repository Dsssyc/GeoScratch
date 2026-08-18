# WebMercatorQuad 反向覆盖与被动虚拟纹理设计

## 状态

设计于 2026-08-18 获得批准。英文配对文档是事实基准；中英文冲突时以英文为准。

## 问题

当前地形路径有两个独立 LoD authority：`GpuTileFrontier` 按 residency 感知的数据
frontier 做细分/合并，`GpuRenderPatchFrontier` 则从不可变 safety-cover roots 遍历并选择
几何。这既重复了选择状态，也让 root-forward 四叉树遍历继续留在热路径中。

新模型必须分清三项事实：

1. WebMercator 地图瓦片拥有不可变的 OGC `WebMercatorQuad` identity；
2. 几何密度由视图决定，可以高于栅格数据源精度；
3. Virtual Raster residency 表示异步可用性，不是 LoD 决策。

## 不可回退不变量

### 标准瓦片 identity

每个几何覆盖项、栅格 demand、cache address 与 source request 都必须使用：

```text
(tileMatrixSet = WebMercatorQuad, tileMatrix, tileRow, tileCol)
```

以相机为中心的 LoD 区域只能选择哪些标准瓦片参与，不能平移、旋转、缩放或发明相机
局部格网。横向世界重复只是 render instance metadata；数据 canonical key 始终是
`z/x/y`，`wrap` 不产生第二份缓存页面。

### 唯一视图覆盖 authority

相机反向生成的 cover 是唯一几何 LoD authority。它从请求最细层级中包含相机规范位置
的标准瓦片出发，而不是从世界 roots 或 atlas resident pages 开始。它在标准矩阵上直接
枚举嵌套 level bands，保守剔除不可见 candidate，经相邻最大一级闭包后输出唯一的
prefix-free cover。

上一帧 topology、atlas 状态、request 状态与 render-root trial 都不能决定 settled geometry
cut。

### 被动 Virtual Raster

Virtual Raster 只接收显式页面 demand。它可以去重、按调用者策略调度、取消过期请求、
重试、缓存、淘汰、发布、解析 fallback 与报告事实，但不能检查 camera zoom、计算 SSE、
细分/合并瓦片、执行几何相邻规则或改写请求的语义层级。

### 四种层级事实

```text
geometryLevel       视图选择的 mesh patch 层级
desiredSampleLevel  producer 选择的理想栅格精度
resolvedSampleLevel 当前实际驻留的 exact/ancestor 页面层级
sourceLevelCeiling  source 声明可以提供的最高层级
```

z14 几何可以请求 z14 数据但当前解析到 z10。如果 source 明确只到 z10，demand producer
直接请求对应 z10 祖先，同时保留 z14 geometry 与理想 sampling footprint 的诊断事实。

## 架构

```text
GeoViewSnapshot + WebMercatorQuad profile + cover policy
    -> GpuWebMercatorQuadCover
        -> canonical RenderTileSet
        -> render-patch lookup
        -> indirect draw arguments
        -> bounded desired-raster feedback

desired-raster feedback
    -> ViewDemandProducer
    -> VirtualRasterDemandSet
    -> VirtualRasterRequestScheduler
    -> VirtualRasterResidency
    -> page table + atlas + slot table

RenderTileSet + global field coordinate
    -> Virtual Raster shader accessor
    -> exact resident page 或最近的 resident ancestor
```

`GpuWebMercatorQuadCover` 属于 Geo，理解标准矩阵、相机相对坐标、可见 footprint、level
bands、覆盖完整性、相邻关系与 indirect rendering；它不理解 terrain payload、worker、
cache policy、URL 或 atlas ownership。

## 标准反向覆盖

GPU 根据相机的规范 WebMercator fixed position 与请求 zoom 推导最细标准瓦片。这个
瓦片只是层级选择锚点，不是相机局部几何格网，也不声称在倾斜视图中锚点本身必须可见。
按 parent 对齐的窗口从该标准瓦片向外扩展，再由 relative view-projection facts 与配置的
高程区间保守剔除视图外 candidate。

嵌套 bands 只作为层级选择场。每一级都把按 parent 对齐的窗口与标准 top-left-origin
tile row/column limits 求交并直接枚举；细区域必须先对齐到完整 parent groups，再形成下一
粗级 band。因此最终仍是固定 WebMercatorQuad 格网，而不是游戏式移动格网。

实现必须证明：

- 工作量受层级数与 candidate/output cover 约束，而不是被剔除的祖先数；
- 不存在 root-to-leaf DFS 或重复 trial cut；
- 输出 identity 在配置 coverage 中合法；
- settled cover 确定、prefix-free、覆盖可见 source footprint，且边相邻最大差一级；
- 俯视对称输入没有方向 tie bias；
- 其他输入固定时 zoom-in 不会让仍可见位置变粗；
- 等价条件下更远瓦片不会比更近瓦片更细。

允许对直接生成的有限 candidates 做最终保守 footprint test；这不能成为恢复世界 root
遍历的借口。

可用性变化永远不能改变 geometry topology。现有 logical cross-page filtering 继续混合空间
LoD 边界，sample 继续显式保留 requested/resolved level。本次 selector clean cut 不声称已
实现 temporal parent-to-child residency morph；该能力需要显式的 previous-snapshot 与
physical-assignment lifetime authority，必须独立设计，不能隐藏在 cover selection 内。

## Demand 与可用性

view/sample producer 决定 desired pages，Virtual Raster 不决定。source ceiling 已知时，
细几何/sample footprint 应在请求执行前下落到可提供祖先，避免必然失败的请求；source
声明存在 exact page 但暂时 pending/retryable 时，继续保持 exact demand，并用 resident
ancestor 绘制；terminal unavailable 页面保留明确状态并 fallback，不得每帧重复请求。
requested 与 resolved identity 永远不能合并成一个字段。

Cover feedback capacity 与 physical residency capacity 相互独立。Runtime composition
先为 pinned minimum-matrix safety cover 预留 slot，再把动态 view demand 限制在剩余的
request 与 physical-page capacity 内。在该上界内先按 desired sample precision 排序，
同精度 page 再按到相机锚点的、考虑横向
world wrap 的标准瓦片距离排序。选中的 exact-resident page 必须继续参与 reconcile，
使 scheduler 可以 mark-used；若在 scheduling 前过滤它们，紧张 atlas 会在同样仍属当前的
page 之间永久振荡。

## Clean Cut

完成 parity 与浏览器证明后：

- 删除 `GpuTileFrontier` 的 view/LoD authority；
- 删除 `GpuRenderPatchFrontier`、immutable render roots、17 trial cuts、global bias 及其
  feedback 词汇；
- 保留高精度 addressing、tile topology/profile、view capture、demand types、Virtual
  Raster residency/page table/atlas、terrain grid、mesh stitching、indirect draw 与结构化
  diagnostics；
- 不保留 legacy selector、兼容 flag 或隐藏 CPU fallback。

## 验证

Node/reference 门禁覆盖标准 identity、source limits、prefix-free、可见覆盖完整性、确定
顺序、2:1、俯视对称、zoom 单调、远近次序、wrap canonicalization、requested/resolved
分离、source ceiling 下落、retryable fallback 与 passive scheduler ownership。

真实 Chrome/WebGPU 门禁覆盖 shaded/wireframe 的俯视、倾斜、旋转、zoom、pan、pitch
往返与 A-B-A；不得出现洞、stale decision、overflow、uncaptured WebGPU error、device
loss 或请求风暴。90-frame 高 pitch benchmark 继续作为硬门禁，但必须报告 inverse-cover
事实，而不是优化后的 root traversal 事实。
