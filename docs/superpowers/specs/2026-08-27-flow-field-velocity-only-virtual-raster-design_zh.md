# Flow Field 纯速度 Virtual Raster 设计

英文设计稿是事实基准；本文是其中文翻译。

## 状态

已于 2026-08-27 获准进入实现规划。

## 目标

围绕瓦片化时序速度采样建立一个独立的 `examples/flowField/` 页面，标题为
`Flow Field`，同时保持正常路径的传输数据面最小。现有 `examples/flowLayer/` 页面原样
冻结为行为参考。Flow Field 表达可输运的流动，而不是权威的有水范围。动态粒子支撑、
生成、生命周期和可见 Flow 支撑轮廓，都在 GPU 上从模拟本来就需要的速度场派生。

## 当前事实

冻结的 Flow Layer 案例加载一份 `station.bin` 和 27 份完整的 `uv_N.bin`。每个文件包含 117,148 个
`float32` 数对。页面构建一次全局 Delaunay 三角网，把 234,240 个三角形展开成
702,720 个非索引顶点，并在每帧把两个时刻的场光栅化为 viewport 大小的
`rg32float` 速度纹理和 `r8unorm` mask。mask 由最大三角形边长启发式规则与
`FLOW_DISPLAY_EXTENT` 组合而成；它既不是水动力 wet/dry 结果，也不是稳定矢量边界。

精确零速度无法区分干区与静水。本表现层无需解决这种二义性：两种情况都不含可输运
运动，因此都不应保留或生成 Flow 粒子。这是 Flow 支撑规则，不是对真实有水范围的
声明。

## 不变量

1. 正常时变载荷只包含 Flow 模拟必需的两个速度分量。
2. 正常 Flow 路径不请求边界纹理、矢量要素瓦片、水深平面、wet/dry 平面或 SDF。
3. 语义状态是派生视图，不是独立网络载荷或 atlas 平面。
4. 零速度样本可以是有效源数据，但仍然不可输运。
5. Flow 支撑只表示“适合粒子平流的运动”，永不表示权威真实有水范围。
6. 粒子在支撑边界上的死亡是吸收式的：旧粒子退休，替代粒子开始，二者之间不生成
   连线。不提供反射或边界滑移。
7. Scratch 保持领域无关，不获取 Flow、瓦片、边界或粒子策略。
8. 粒子位置保持 canonical 且与 LoD 无关。瓦片和页面身份只作为瞬时采样、demand
   与局部性事实。
9. 屏幕空间 history 纹理、reverse-gather 重投影、衰减、截止与呈现继续作为
   viewport 资源，而不是 Virtual Raster 页面。
10. `examples/flowLayer/` 的源码与行为保持冻结。Flow Field 既不修改它，也不导入其
    实现文件。
11. Flow Field 首先组合当前公开的 `geoscratch/geo` 与 `geoscratch/scratch` 能力。
    缺失组合先在 `examples/flowField/` 内实现；未经独立设计审阅和用户批准，不把
    example-local 概念移入 package。

## Example 与库边界

`examples/flowField/` 是独立的公共 package 消费者，拥有自己的页面、应用组装、source
adapter、时间协调器、粒子模拟、派生支撑预处理、shader、proof facts 与释放 authority。
它只从 `geoscratch/scratch` 导入基础契约，只从 `geoscratch/geo` 导入地理契约。

首个实现不修改 `packages/geoscratch/src/`。它把当前单 plane Virtual Raster runtime
组合成 example-local 的有界时序速度对，在 reconcile 公开 demand 前本地合并 view 与
prefetch 需求，并本地拥有 Flow 专用 spawn index 和 contour 产品。实现中发现的重复、
consumer-neutral primitive 记录为后续下沉讨论证据；构建 Flow Field 时不直接提升它。

路由、catalog label、runtime label、proof fact、测试和文档统一使用精确名称
`Flow Field`。`Flow Layer` 只继续标识冻结的参考页面。

## 最小数据产品

### Manifest

一个不可变 `FlowDatasetManifest` 记录：

- dataset id、source revision、载荷 checksum 和有序模型时刻；
- `WebMercatorQuad` coverage、地理范围、page size 和 source levels；
- 速度分量顺序、单位、矢量 basis、字节序与采样编码；
- 时间插值策略；
- 最大速度归一化事实；
- cold-start、spin-up、transient 或 production 等阶段标签；这些是每帧标量元数据，
  不是栅格通道。

Flow Field 应用设置而非 source manifest 拥有 `FLOW_DISPLAY_EXTENT`，以及显式有限并满足
`activitySpawn > activityKill >= 0` 的 `activitySpawn` 与 `activityKill` 阈值。
这些设置进入帧 provenance，但不创建数据 URL、cache identity 或栅格通道。

### 速度页面

首个正确实现使用当前公开 Virtual Raster 形态：双通道 `float32` 页面降低到
`rg32float` atlas，每个逻辑 texel 的载荷为八字节。source builder 确定性地把不受
支持的位置编码为零速度。缺失、失败、过期或不在 coverage 中的页面继续由 page table
状态表达，不得伪装成成功的零值页面。

正常路径不增加任何逐 texel 的时变通道。未来若要引入权威 activity bit 或 16 位速度
编码，必须有独立的实测证据、明确误差预算和经过审阅的 API 变更；二者均不属于本设计。

## 确定性离线构建

source builder 读取完整站点坐标与每个时刻的 U/V 切片，只构建一次接受的全局
Delaunay 场，并将其采样到一个全局 `WebMercatorQuad` 逻辑 texel 格点。不得按 tile
独立三角化。瓦片边缘因此采样同一个全局场，不会选择不同的局部三角网。

目标场构建在目标 texel 中心使用 Delaunay 重心插值，运行时使用 Geo Virtual Raster
逻辑双线性过滤。当前 shader 中未使用的 IDW helper 不是 parity authority。不受支持
的三角形降低为零速度，不创建第二份 mask 产品。应用 display exclusion 在运行时求值，
永不烘焙进 source page。

构建器输出确定性的多层页面、source metadata、checksum 和 seeded parity samples。
矢量降采样必须保留分量语义并报告实测速度误差；不得通过平均方向角派生方向。

## 时序虚拟采样

运行时保持一个当前时间平面、一个下一时间平面，以及最多一个有界预取平面。一次
submission step 只观察一个不可变时间对和一个 progress。两个时间样本必须在同一
canonical 位置和兼容的 resolved level 上求值后再插值。任一时间成员缺失或失败都会
使 Flow sample 不可用；不得把其他时间或 generation 的 atlas slot 当作 fallback 读取。

派生的 shader 级契约在概念上是：

```text
FlowSample {
    status
    velocity
    speed
    advectable
}
```

仅存储速度和 Virtual Raster 状态，其余数值现场计算：

```text
velocity = mix(velocity0, velocity1, progress)
speed = length(velocity)
advectable = status 可用
    && position 位于表现策略范围内
    && speed >= activityKill
```

首个实现把它表达成 current public Virtual Raster instance 之上的 example-local 有界
组合。它不构成 Flow 专用 page table、scheduler、Worker pool 或 Scratch primitive 的
理由。只有 Flow Field 实现提供可复用证据后，才可以单独提出通用 Geo 抽象。

## 粒子支撑与生命周期

### 生成支撑

一个有界 GPU 预处理对当前采样的逻辑 cell 执行 `speed >= activitySpawn` 分类，压缩
其 canonical cell identity，并发布不可变 `FlowSpawnIndex`。死亡粒子从该索引采样，
而不是在完整 display extent 内反复尝试随机位置。最终加入抖动的位置在采纳前，必须
再次通过同一时序 Flow snapshot 验证。

如果索引为空或其必需页面不可用，受影响的粒子 slot 显式进入 dormant，而不是进入
拒绝采样死循环。应用可以依据实测支撑面积调整活跃粒子数，但在独立的实测决策修改它
之前，最大池保持 262,144。

### 存活与死亡

每个积分子步都采样候选位置。当样本不可用、超出表现策略范围或低于
`activityKill` 时，粒子退休。如果所需子步预算会溢出，粒子也应退休，不能冒险生成
跨支撑线段。

退休并重生时写入：

```text
currentPosition = spawnPosition
previousPosition = spawnPosition
velocity = zero
age = zero
stagnantAge = zero
```

因此 particle draw 不会发出旧位置到新位置的线。独立的有限 lifetime 与
stagnant-age 上限保证精确或近零速度粒子得到回收。不得通过篡改场有效性来实现粒子
生命周期。

## 派生动态 Flow 轮廓

启用可见 Flow 支撑边界时，一个有界、瓦片化的 GPU marching-squares 预处理从同一个
不可变时序速度 snapshot 求值 `speed - activityKill`，并输出零等值线的瞬时线段。
不引入矢量边界载荷、稳定 feature id、geometry residency 或 picking contract。

逻辑 cell 采用半开 tile 所有权，角点值通过跨页 Virtual Raster accessor 解析。
marching-squares 歧义情形采用一种明确、确定的判定器。容量溢出是结构化硬诊断，不能
静默截断轮廓。

该轮廓表示可输运 Flow 支撑，绝不能在文档或样式中称为权威湿润岸线或淹没范围。

## Demand、所有权与生命周期

- Geo 拥有瓦片身份、Virtual Raster demand、residency、不可变 snapshot、fallback
  状态、生成 accessor 与通用时序组合。
- Scratch 拥有 Worker 执行、持久原始载荷 cache、GPU resource、command、submission、
  epoch 与 diagnostics，但不获取 Geo 或 Flow 语义。
- Flow Field source adapter 拥有 URL 构造、解码、checksum、单位、source revision 与离线构建
  schema。
- Flow Field example 拥有阈值、时间播放、生成策略、粒子生命周期、动态轮廓表现、history、
  相机集成和总预算。

首先请求 view 可见的速度页面。粒子位移可以增加一个有界预测 halo，下一时间平面可以
预取相同空间集合。demand feedback 保持 workgroup 归约且有界；不得引入 CPU 粒子镜像、
逐粒子 readback、持久虚拟地址或整域请求。

释放顺序为：停止 demand 与帧生产，取消或结算 loader，排空已经发出的 submission 与
readback，释放派生 spawn/contour 状态和 Virtual Raster resource，最后才释放 runtime
和 map authority。

## 性能契约

- 正常时变传输严格保持两个速度分量：在当前 `float32` API 中，每逻辑 texel 八字节。
- 正常请求 URL 与 cache identity 中不存在 depth、wet mask、boundary mask、SDF 或
  vector geometry。
- 活跃 residency 受限于当前/下一平面、一个显式预取窗口和 pinned safety coverage。
- 网络、decoded staging、atlas、page table、spawn index、contour、particle 与 history
  字节分别报告。
- 没有 before/after 载荷、GPU 内存、采样误差和帧时间测量时，不接受任何 16 位编码的
  优化声明。

## 失败语义

- 无效 manifest、载荷尺寸、非有限速度、checksum 不匹配、不支持的单位或 basis，以及
  不一致时间对都通过结构化诊断失败。
- 缺失或失败的速度样本不可输运，并使受影响粒子退休；不得把它们当作成功静水。
- 过期 generation 或时间响应不得发布到活动时间对。
- spawn index 与 contour overflow 属于有界诊断失败。
- source outage 保留有界 history 衰减，并收敛到 dormant 粒子，不保留无界重试或
  observation。

## 验证契约

### Source 与单元门禁

- 验证全部 27 个有序模型时刻、页面尺寸、checksum、单位、basis 与 content version；
- 将瓦片速度与源站点、seeded 三角形内部、不受支持的三角形和 page-edge 样本比较，
  再独立验证运行时 display exclusion；
- 证明相邻瓦片及 parent/fine 样本满足声明误差界；
- 证明构建过程从不按 tile 独立三角化。

### GPU 与浏览器门禁

- 两个完整的 27-slice 循环保持时间索引、progress、有界 residency 和确定性 prefetch；
- 非零速度从一个入口扩张的 cold-start fixture 不得在当前 Flow 支撑外生成粒子，并且
  只随支撑扩张激活 dormant slot；
- 精确零速与近零速场在有限生命周期上界内回收全部粒子；
- 候选位置与子步检查禁止一帧跨支撑线段；
- 时间缺失/fallback 过渡不得混合无关 LoD 或时间 generation；
- 瓦片化 marching-squares 输出确定且跨 page 边界无缝；
- 正常 network 与 cache trace 不含 boundary、depth、wet-mask、SDF 或 vector-feature
  载荷；
- 长时间 operation、residency、staging、particle、spawn、contour 与 history 数量保持
  有界，drain 后 pending work 为零；
- 冻结的 Flow Layer 参考继续通过现有相机重投影、resize、660 帧以上 cadence、结构化
  失败与清理门禁；
- Flow Field 拥有独立路由、页面 identity、proof facts、browser gate 与清理证据，源码
  门禁证明 `examples/flowLayer/` 保持不变且未被 Flow Field 导入。

## 非目标

- 权威有水范围、淹没范围、水面、水深或 wet/dry 显示。
- 边界 feature identity、属性、拓扑或 picking。
- 反射、投影、滑移、壁面法向响应或基于 SDF 的碰撞。
- Flow 专用 scheduler、page table、Worker pool、scene hierarchy 或 Scratch API。
- 修改、删除、重定向或导入冻结的 `examples/flowLayer/` 参考实现。
- 在 Flow Field 内复用当前 viewport Voronoi stage、整场 Worker 传输、全局粒子经纬度
  `f32` ABI 或 screen-UV 场采样。
- 在没有实测证据和独立审批契约时，引入 16 位载荷、第二 activity 通道或额外栅格
  平面。

## 相关材料

- [Geo Virtual Raster Flow readiness](../../review/geo-virtual-raster-flow-readiness.md)
- [ADR-044：Flow Layer Scratch clean cut](../../decisions/ADR-044-flow-layer-scratch-api-clean-cut.md)
- [当前 Virtual Raster API](../../api/geo/virtual-raster.md)
