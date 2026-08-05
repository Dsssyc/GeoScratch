# Scratch 基础能力层与公共拓扑设计

## 状态

已实施。Implemented by ADR-057。

## 日期

2026-08-05

## 目的

GeoScratch 的公共架构收敛为两个概念入口：`scratch` 与 `geo`。

`scratch` 不再只指 GPU execution kernel，而是 GeoScratch 的领域无关基础能力层。GPU、Worker 和后续 Persistent Cache 都是 Scratch 中彼此独立的能力域。`geo` 是建立在 Scratch 之上的地理语义适配层，负责地图、地球、坐标、投影、瓦片和虚拟栅格等模型。

这一依赖方向可以概括为：**Geo from the Scratch**。

这句概括只是架构语义的简写。实际边界仍由领域依赖、所有权、生命周期和可验证性决定，不能把 `scratch` 变成所有非 Geo 代码的容器。

## 目标模型

```text
scratch = domain-neutral capability foundation
geo     = geospatial semantic adaptation built on scratch
```

Scratch 中的公共能力必须同时满足：

- 不包含地理领域语义；
- 可以脱离 Geo 独立使用；
- 封装浏览器或计算平台的基础能力；
- 显式表达所有权、生命周期、异步状态和错误；
- 提供机器可读诊断与可检查事实；
- 不隐藏执行、缓存、调度或修复策略；
- 不能仅因为多个业务可能使用就进入 Scratch。

Geo 可以依赖 Scratch 的公开契约，Scratch 不得依赖 Geo。

## 交付拆分

完整目标分成三个连续、各自可收敛的 goal：

1. Scratch/Geo 公共拓扑重构；
2. Scratch Persistent Cache；
3. Geo Virtual Raster 与 DEM example 验证。

本文只规定 Goal 1。Goal 1 不实现 Persistent Cache，不迁移 DEM 缓存，也不推进 Flow Layer 的虚拟栅格化。

这种拆分只限制交付范围，不引入临时兼容 API、重复实现或替代性的目标架构。

## 公共入口

包的公开子路径最终只保留：

```text
geoscratch
geoscratch/scratch
geoscratch/geo
geoscratch/package.json
```

推荐的能力导入方式是：

```ts
import {
    GPURuntime,
    WorkerSystem,
} from 'geoscratch/scratch'

import {
    WebMercatorQuad,
    VirtualRasterAccessor,
} from 'geoscratch/geo'
```

包根入口只提供两个 namespace：

```ts
import { scratch, geo } from 'geoscratch'
```

根入口不得继续扁平导出 GPU、Worker、Geo、geometry、effects、loaders 或旧 API 符号。

以下独立入口删除且不提供兼容别名：

```text
geoscratch/worker
geoscratch/geometry
```

`geoscratch/scratch` 是 Scratch 基础层的正式公共门面，不再是根入口的兼容重导出。

## 内部组织

目标源码布局是：

```text
packages/geoscratch/src/
├── index.ts
├── scratch.ts
├── scratch/
│   ├── index.ts
│   ├── diagnostics/
│   ├── gpu/
│   ├── worker/
│   └── geometry/
└── geo/
    ├── index.ts
    ├── coordinates/
    ├── projections/
    ├── tiling/
    └── virtual-raster/
```

Goal 2 将在 `scratch/` 下增加独立的 `cache/` 能力域。

统一公共门面不意味着共享 runtime：

- `GPURuntime` 只拥有 WebGPU adapter/device、GPU resource、pipeline、command、submission 和 GPU diagnostics；
- `WorkerSystem` 只拥有 Worker、任务、优先级、取消、上下文与 CPU 并发状态；
- 后续 `PersistentCache` 只拥有 IndexedDB、OPFS、缓存条目和存储生命周期；
- 不创建统管这些能力的 `ScratchPlatformRuntime`；
- GPU、Worker 和 Cache 不能调用彼此的内部实现；
- Geo 或应用按需组合公开能力，不需要某项能力的消费者不得被迫创建它。

Scratch 能力域可以共享无状态公共契约，例如诊断 envelope。它们不能因此共享可变状态、lifecycle authority、任务队列或历史记录。

## Runtime 与类型命名

当 `scratch` 成为基础能力总层后，`ScratchRuntime` 会错误暗示它统管全部 Scratch 能力。Goal 1 必须执行以下 clean cut：

```text
ScratchRuntime             -> GPURuntime
ScratchRuntimeDiagnostics  -> GPURuntimeDiagnostics
ScratchDiagnosticCapture   -> GPUDiagnosticCapture
ScratchGpuIncidentReport   -> GPUIncidentReport
ScratchGpuOperationRecord  -> GPUOperationRecord
```

完整公共类型清单按以下规则机械审计：

```text
Scratch*  跨整个 Scratch 基础层的公共契约
GPU*      GPU 能力域
Worker*   Worker 能力域
Cache*    Cache 能力域
Geo*      Geo 语义层
```

GPU 专属类型应改为 `GPU*`，或者在不存在歧义时去掉多余前缀。旧 GPU API 删除后：

```text
ScratchRenderPipeline   -> RenderPipeline
ScratchComputePipeline  -> ComputePipeline
```

Goal 1 不保留旧类名、旧类型名或旧 export alias。GeoScratch 仍处于 `0.x.x`，这一轮以单一明确契约代替兼容层。

## 现有导出归属

### 迁入 Scratch

- 当前 TypeScript Scratch GPU 实现迁入 `scratch/gpu/`；
- WorkerSystem 及其协议迁入 `scratch/worker/`；
- `plane` 与 `sphere` 作为无地理语义的通用 mesh generator，迁移为 TypeScript 并进入 `scratch/geometry/`；
- UUID 等仅供实现使用的工具迁入 TypeScript 内部模块，不再公开。

### 保留在 Geo

- `MercatorCoordinate`；
- coordinate domain 与高精度 position codec；
- tile matrix 与 WebMercatorQuad；
- virtual-raster addressing、sampling、demand、residency 和 GPU lowering；
- GeoDiagnostic。

现有 Geo virtual-raster cache 在 Goal 1 中不改写。Goal 2/3 将用 Scratch Persistent Cache 和 Geo address adapter 完整替换它。Goal 1 不得为它新增兼容入口或扩展其公共模型。

### 删除

- 旧 `src/gpu/` JavaScript API，包括全局 device、`StartDash`、旧 Buffer/Texture/Binding/Pipeline/Pass、Director 与 Monitor；
- 旧 effects 与 loaders；
- 旧 ArrayRef、BlockRef 和 numeric wrapper；
- ScratchObject 旧继承体系；
- 没有当前消费者且已被新 tile-matrix/virtual-raster 模型取代的 GeoQuadNode2D、Node2D、旧 quadtree 与其 BoundingBox2D；
- 重复的旧 Mercator 源文件；
- 旧 geometry 独立入口；
- 同源 JavaScript 与手写 declaration 文件。

删除依据是当前实现与 examples 的事实审计，不是只看文件年龄。`plane`、`sphere` 和 `MercatorCoordinate` 因仍有当前消费者而迁移，不得随旧目录一并丢弃。

## 统一诊断契约

Scratch 提供一个公共、可判别的诊断 envelope：

```ts
type ScratchDiagnostic =
    | GPUDiagnostic
    | WorkerDiagnostic

type ScratchDiagnosticBase<Domain, Code, Phase, Subject> = Readonly<{
    version: 1
    domain: Domain
    code: Code
    severity: 'info' | 'warn' | 'error'
    phase: Phase
    subject: Subject
    message: string
    expected?: unknown
    actual?: unknown
    hints?: readonly string[]
    related?: readonly ScratchDiagnosticSubject[]
    suggestions?: readonly ScratchDiagnosticSuggestion[]
    evidence?: readonly ScratchDiagnosticEvidence[]
}>

type ScratchDiagnosticErrorContext =
    | Readonly<{
        domain: 'gpu'
        incident?: GPUIncidentReport
    }>
    | Readonly<{
        domain: 'worker'
        remote?: WorkerRemoteErrorFacts
    }>
```

公共统一能力是：

- `ScratchDiagnostic`；
- `ScratchDiagnosticError`；
- `ScratchDiagnosticReport`；
- `createScratchDiagnostic()`；
- `isScratchDiagnosticError()`。

GPU 与 Worker 保留各自的 code、phase、subject、facts 和附加证据。`WorkerDiagnostic` 是统一 union 中 `domain: 'worker'` 的窄化成员，不再拥有平行的 envelope。

`ScratchDiagnosticError` 只统一错误入口。需要随错误携带的领域事实通过与 `diagnostic.domain` 一致的 `ScratchDiagnosticErrorContext` 表达。GPU incident 与 Worker remote facts 不会因此进入对方的生命周期或事实图。

Goal 1 删除 `WorkerDiagnosticError` 与 `createWorkerDiagnostic()`。Worker 操作统一抛出 `ScratchDiagnosticError`。

当前 `ScratchDiagnosticCapture` 实际由 GPU runtime 私有拥有，因此改名为 `GPUDiagnosticCapture`。GPU 的 bounded ledger、native evidence 和 incident attribution 继续只属于 GPU，不向 Worker 扩散。

GeoDiagnostic 继续属于 Geo。它可以保持结构一致，但不能进入 Scratch union，也不能形成 Scratch 对 Geo 的反向依赖。

## 迁移规则

Goal 1 是行为保持型的公共拓扑与命名 clean cut：

- 先建立精确的迁移前公共符号与行为清单；
- 移动实现时保持每项 GPU 和 Worker 能力的一对一事实对应；
- 所有 examples 从 `geoscratch/scratch` 或 `geoscratch/geo` 导入；
- 根入口只用于 namespace 导入验证；
- 不通过双导出、deprecated alias 或隐藏 shim 让旧入口继续工作；
- 不在本轮改变 GPU command、resource、submission、readiness 或 native error 语义；
- 不在本轮改变 Worker 调度、优先级、取消、context retention 或 transfer 语义；
- 不在本轮实现 Persistent Cache；
- 不在本轮把 DEM、Flow、TerrainLayer 或其他 example 业务提升为 Geo API。

历史 ADR 不重写。Goal 1 应新增 ADR 记录新公共架构并标记被取代的旧决策。README、vision、living review、examples 和测试必须使用新名称。历史审计中的旧名称只能通过明确 allowlist 作为历史证据保留。

## 验收门禁

### 结构门禁

- `package.json#exports` 精确等于 `.`, `./scratch`, `./geo`, `./package.json`；
- 根入口只导出 `scratch` 与 `geo`；
- examples 只从两个正式子路径导入能力；
- 已删除入口无法导入；
- 已删除旧源码目录和同源 JS/手写 declaration 不存在；
- `ScratchRuntime` 不出现在活跃源码、测试、README 和迁移说明之外的 vision 中；
- 本文的迁移映射和历史文档中的旧名称具有精确 allowlist。

### 契约门禁

- GPURuntime 与迁移前 ScratchRuntime 的能力逐项对应；
- RenderPipeline 与 ComputePipeline 不再需要 Scratch 消歧义别名；
- WorkerSystem 的调度、取消、上下文和 transfer 行为保持；
- Worker 错误统一为 ScratchDiagnosticError；
- ScratchDiagnostic.domain 可以可靠窄化 GPU 与 Worker；
- Scratch 与 Geo 公共导出分别由精确 allowlist 保护；
- TypeScript plane/sphere 输出与迁移前逐项相等。

### 固定执行门禁

实施计划必须固定并执行以下门禁：

```text
TypeScript public-contract typecheck
npm test
npm run build
Scratch/WebGPU current-spec coverage audit
Worker real-browser test
Hello GAW browser test
DEM Layer browser test
Flow Layer browser test
```

浏览器验证必须确认：

- 无 uncaptured WebGPU error；
- 无 device loss；
- 无 Worker 泄漏；
- Hello GAW、DEM Layer 与 Flow Layer 保持当前已接受的可见结果。

## 收敛与终止

Goal 1 不使用开放式、不断扩张的审查循环。

1. 实现完成后执行一次完整门禁；
2. 确定性失败只修复 Goal 1 范围内的原因，并重跑受影响门禁；
3. 随后只进行一次限定于 Goal 1 diff 的最终审查；
4. 不追加 Cache 实现、DEM 缓存、Flow 虚拟栅格或新的功能审计；
5. 最终停止本 goal，并报告 `confirmed-clean` 或 `completed-with-findings`。

`completed-with-findings` 必须列出失败命令、问题原因、影响范围和后续处理建议。它不能触发无限修复、重复子代理恢复或未约定的范围扩张。

## 后续 Goal 边界

Goal 2 在完成本拓扑后实现独立的 Scratch Persistent Cache：IndexedDB 元数据、OPFS raw blocks、不可变 revision、预算、回收和 cache-domain ScratchDiagnostic。

Goal 3 让 Geo 保持在通用 virtual-raster/virtual-texture 方案边界，并由 DEM example 作为第一个完整消费者验证 raw height 缓存。DEM source、decode、Worker task、mesh-stitching、terrain shader 和 layer lifecycle 始终留在 example。
