---
docId: geo.terrain-rendering.zh
canonical: false
translationOf: ./terrain-rendering.md
canonicalDigest: c8fc44a55db3d936c35e3ae643f8d9ffdf35991a1c6a1ae84389697bcb9b151f
---
# 地形渲染

[English](./terrain-rendering.md) | [Geo 概览](./README_zh.md)

`createWebMercatorTerrainRenderer` 是 Geo 完整的 OGC `WebMercatorQuad` 地形编排器。
它把 `MapFieldLayer`、Web Mercator Virtual Raster runtime、GPU data frontier、GPU
render-patch frontier、生成式 terrain WGSL、indirect draw、feedback、capture-sized resize 与 dispose
组合为一个显式 renderer。这个名称有意限定投影。不存在通用
`TerrainFieldRenderer` 别名：globe 或其他 tiling topology 需要具备不同空间与选择语义
的 renderer。

`webMercatorTerrainWgslModule` 拥有完整 terrain vertex 路径。它从 render patch
重建 wide-fixed logical position，在转成 f32 前计算 camera-relative difference，解析
相邻 render patch，对混合 LoD 的共享边做 snapping，通过 logical Virtual Raster
accessor 采样高程，并投影最终结果。它也提供由
`WEB_MERCATOR_TERRAIN_TILE_WIREFRAME_FRAGMENT_ENTRY_POINT` 命名的内置 fragment
entry point。Renderer 的 `presentationShader` 是应用 fragment entry point 的扩展源码；
它消费 `WebMercatorTerrainVertexOutput`，不得重复 position、stitching、tile lookup 或
height sampling 逻辑。

Raster LoD 与 geometry LoD 是两个独立权威。Data frontier 负责不超过数据源 matrix
上限的 demand、residency、publication 与 fallback。render-patch frontier 从不可变且
prefix-free 的 geographic safety cover 开始遍历，并可在数据源上限之后继续细化地形网格。
render patch 只携带 geometry identity。Terrain 请求 Virtual Raster 的最细逻辑层，page
table 再把每个坐标解析到可用 physical page。Virtual Raster 消除 CPU padding 与
physical atlas 耦合；mesh stitching 消除 T-junction crack。

对于当前 camera、viewport、render roots 与 policy，render-patch 细分结果是规范且唯一
的。每个水平地形 footprint 会先经过 WebGPU 全部六个齐次裁剪面，以获得可见求值位置。
GPU 在这些位置沿两个水平轴对称投影一个 cell 的位移，并以其局部 Jacobian 的面积等效
像素跨度作为 refinement metric。该 metric 是局部量，不会因为 zoom-in 时 viewport
裁剪留下更小的可见窄片而缩小。

每个 `(render root, bias trial)` 会由独立 GPU invocation 计数，不再由单个 invocation
串行执行全部 17 次树遍历。Renderer 创建时，persistent render-patch capacity 根据 viewport patch budget 与
显式 2:1-balance headroom 推导，向上取二次幂，并受 data-frontier 理论上限约束；它不再从
resident data-tile capacity 盲目倍增。Balance kernel 保留最多 14 pass 的正确性上限，但当
一个完整 scratch/primary 偶数轮对没有产生新 split 时会提前结束；它使用
`workgroupUniformLoad`，确保所有 lane 在 uniform control flow 中退出。

GPU 会计算 17 个完整的统一 bias cut，并以无历史状态的方式选择预算内 base cut。随后
它反复找出超过阈值且 Q8 量化局部 span 最大的一组 patch。所有具有完全相同 error 的
terminal patch 构成一个不可分割 cohort：只有该 cohort 的全部可见 children 都能放入
剩余 frame budget 时，GPU 才会整体细分。它不会按 logical tile identity、遍历顺序或
屏幕方向选择同误差子集。当下一个完整 quality cohort 无法容纳时，保留未使用 slot 是
合法结果。Primary lookup 会从 error-cohort-filled cut 重建，然后才执行有界 2:1
balance。局部选择不会读取 data-frontier topology、上一 parity topology 或上一帧 bias。
延迟 render-patch feedback 会暴露 base、fill、budget-limited、unbalanced 与 balance
fact，但不会控制后续 render cut。

`render(capture)` 消费一个 `GeoViewSourceCapture<ViewInput>`。只有 `capture.size` 变化时，
它才执行 Surface 与 depth-target resize；随后从 `capture.view` 提交，并返回一个
`GeoFrameResult<WebMercatorTerrainFrameValue>`。Result value 包含即时 submitted frame
identity/provenance 与精确 view。`WebMercatorTerrainFrameSettlement` 直接满足
`GeoFrameSettlement`；`residencyWorkCount` 是唯一 page-work count。不存在公开 renderer
`renderFrame()` 或 `resize()` compatibility path。

`render()` 在当前 work 提交后立即返回。Native observation、延迟 GPU feedback、
feedback 驱动的 residency 与 convergence 继续由独立 promise 表达；它们都不会持有
frame submission authority。旧 camera 的 feedback 会被标记为 superseded，不能协调
residency 或覆盖当前 facts。只有 frontier 已 converged 且没有请求额外 page 时，一个
decision 才会被标记为 settled。当 camera 或 residency decision key 变化时，renderer
会立即撤销上一 decision 的 frontier 与 render-patch facts，并在当前 decision 的 feedback
完成前报告 `transitioning`。即使返回之前访问过的 camera，也不会复用旧 settled 状态，
因为中间的 decision 已经改写 GPU-resident frontier。

更底层的消费者可以直接组合 `gpuRenderPatchReadWgslModule`。它通过显式 storage
binding 与 layout dependency 提供有界 visible-instance lookup、covering-patch lookup、
neighbor resolution 和 edge-coordinate snapping。生成模块不会读取 CPU 选择的 tile
列表，也不会让 draw count 往返 CPU。

Renderer 不拥有 map host、camera controller、view source、source manifest、network transport、
decoder、Worker system 或应用 cache policy；这些都是显式组合输入。因此 Underwater
Terrain example 只拥有 source-specific loading/decoding、map/UI 装配、cache 总预算选择
和自己的 fragment presentation。它的 `main.ts` 只拥有 page bootstrap 与 proof loading；
`application.ts` 则让显式 map/runtime/raster/renderer/source/driver/controller 装配可以独立阅读。
