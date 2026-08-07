# GeoScratch

[English](./README.md) | [简体中文](./README_zh.md)

[![NPM Package][npm]][npm-url]

GeoScratch 是一个基于 WebGPU 的 ES module 图形库，面向地理可视化场景。它提供较底层的 GPU 构件，包括 buffer、binding、pipeline、render pass、compute pass、texture、shader 和帧调度，并在此之上组织地理坐标、地形等应用层能力。

这个库适合需要直接控制 WebGPU 资源的开发者，用于构建场景、地图、地球、地形图层或 GPU 驱动的实验性可视化。

![GeoScratch preview](https://raw.githubusercontent.com/YcSoku/GeoScratch/main/DayDream.png)

## 快速开始

```bash
npm install
npm run dev
```

打开 Vite 输出的本地地址即可浏览示例。渲染示例需要支持 WebGPU 的浏览器。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm install` | 根据 `package-lock.json` 安装依赖。 |
| `npm run dev` | 先构建库包，再从 `examples/` 启动 Vite 示例浏览器。 |
| `npm test` | 先构建库包，再运行 `tests/` 中的 Mocha 测试。 |
| `npm run build` | 构建库包，并将示例浏览器和独立示例页面构建到 `dist/examples/`。 |
| `npm run serve` | 本地预览构建后的示例。 |

## 项目结构

| 路径 | 作用 |
| --- | --- |
| `packages/geoscratch/` | 可发布的库包。 |
| `packages/geoscratch/src/index.ts` | 只公开 `scratch` 与 `geo` namespace 的包根入口。 |
| `packages/geoscratch/src/scratch.ts` | 正式的 `geoscratch/scratch` 门面。 |
| `packages/geoscratch/src/scratch/` | TypeScript source-first 的 GPU、Worker、诊断和几何基础能力。 |
| `packages/geoscratch/src/geo/` | TypeScript source-first 的坐标、瓦片和虚拟栅格适配层。 |
| `packages/geoscratch/dist/` | 生成的包 JavaScript 和声明文件输出。 |
| `examples/` | 示例 workspace、示例浏览器和各示例的独立页面。 |
| `docs/assets/` | 文档和项目品牌资源。 |
| `examples/public/` | 需要稳定绝对 URL fetch 的大型本地示例数据。 |
| `tests/` | 可在 Node 环境中运行的 Mocha 测试。 |

## 包入口

包根入口只公开两个架构 namespace：

```js
import { scratch, geo } from 'geoscratch'
```

直接使用能力时通过正式子入口导入：

```js
import { GPURuntime, WorkerSystem, sphere } from 'geoscratch/scratch'
import { MercatorCoordinate, WebMercatorQuad } from 'geoscratch/geo'
```

Scratch 是领域无关的 TypeScript source-first 基础能力层，Geo 在其上适配地理
语义；单向依赖可以概括为 **Geo from the Scratch**。

## Geo Streaming 与 Worker

`geoscratch/geo` 公开 OGC `WebMercatorQuad`、有限 `TileMatrixLimits`、高精度
canonical coordinate、虚拟栅格 demand/residency、纯 cache address/coherence adapter、
owned page transfer 与 Scratch GPU publication。全局瓦片身份通过数据源的 compact
coverage 映射，不会创建覆盖整个世界的 dense page table。

从 `geoscratch/scratch` 导入的 `WorkerSystem` 是独立且需要显式构造的线程抽象。
它支持 URL module、自定义 operation、有界优先级 group、cooperative/hard
cancellation、stale-result rejection、stateful context、Transferable 所有权和结构化
远端诊断。它与 `GPURuntime` 不共享可变状态或 lifecycle authority，也不依赖 Geo、
tile、DEM 或 GPU。

DEM Layer 是这条路径的可执行参考：terrain demand 在 Worker 中获取和解码标准
WebMercatorQuad tile，可通过 Scratch Cache 持久化可直接使用的 raw height page，将
page 转移到有限 atlas，并在 vertex shader 中进行跨页逻辑过滤和 parent fallback。
源 PNG 只用于离线构建 COG；浏览器没有完整图片或旧瓦片路径回退。

## Scratch Persistent Cache

`PersistentCache` 与 Worker、GPU、Geo 相互独立。IndexedDB 保存结构化 metadata 并
作为权威 commit point；可选 raw `ArrayBuffer` 以 immutable `(id, revision)` key
存入 OPFS：

```js
import { PersistentCache, persistentCacheKey } from 'geoscratch/scratch'

const cache = await PersistentCache.open({
    namespace: 'my-dataset-v1',
    maxPayloadBytes: 128 * 1024 * 1024,
    maxEntries: 2048,
    lifecycle: { kind: 'durable', open: 'reuse' },
})
const key = persistentCacheKey({ id: 'tiles/10/843/418', revision: 'source-v3' })
await cache.put(key, {
    metadata: { format: 'raw/uint8', width: 256, height: 256 },
    payload: decodedBytes.buffer,
})
const result = await cache.get(key)
await cache.dispose()
```

Cache 会 snapshot 调用方输入，hit 时返回新的 caller-owned buffer，因此可以安全
transfer。它没有隐藏 memory tier，也不提供 Buffer/Texture 转换 API；这些策略和
转换由 application 持有。不创建 cache 就是显式 no-cache mode。存储 commit 与
garbage collection 保证跨 context 一致性；同步 `inspect()` 只报告有界的
`observationScope: 'instance'` 事实，不虚构全局同步 diagnostic snapshot。
生命周期必须显式声明：durable cache 可选择复用或在 open 前清空；session cache
会在 open 前重置，并在显式等待的 dispose 中清理。session 仍然写入磁盘；如果可视化
不应写 IndexedDB/OPFS，就应直接不创建 cache。

## Scratch 异步资源分配

持久 Scratch buffer 与 texture allocation 需要异步确认。只有原生 validation 与 out-of-memory scope 都成功 settle 后才返回资源；texture replacement 使用同一 transaction boundary。

```js
const runtime = await GPURuntime.create()
const vertices = await runtime.createBuffer({
    label: 'vertices',
    size: 4096,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
})
const color = await runtime.createTexture({
    label: 'color',
    size: { width: 1024, height: 768 },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
})

await color.resize({ width: 1920, height: 1080 })
const evidence = runtime.diagnostics.exportEvidence()
```

`runtime.diagnostics` 暴露当前 resource facts、有界 operation/incident history 与显式临时 deep capture。logical footprint evidence 不是 physical VRAM。

## Scratch Resource View 与 Binding

Buffer 是裸容器。每个 buffer range consumer 都接收不可变 `BufferRegion`；
persistent texture consumer 接收不可变逻辑 `TextureViewSpec`。Supporting native
object 是 Promise-only，BindSet 只有在首次 preparation 获得 acknowledgement 后
才会返回:

```js
const uniforms = await runtime.createBuffer({
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
})
const uniformRegion = uniforms.region()
const colorView = color.view({ dimension: '2d' })
const sampler = await runtime.createSampler()
const layout = await runtime.createBindLayout({
    group: 0,
    entries: [
        { binding: 0, name: 'uniforms', type: 'uniform', visibility: [ 'vertex' ] },
        { binding: 1, name: 'color', type: 'texture', sampleType: 'float', viewDimension: '2d', visibility: [ 'fragment' ] },
        { binding: 2, name: 'sampler', type: 'sampler', samplerType: 'filtering', visibility: [ 'fragment' ] },
    ],
})
const set = await runtime.createBindSet(layout, {
    uniforms: uniformRegion,
    color: colorView,
    sampler,
})

await color.resize({ width: 1920, height: 1080 })
await set.prepare()
```

Content write 不要求 preparation。Allocation replacement 会让受影响 BindSet
变为 `stale`；在应用显式 await `prepare()` 前，submission 会在 encoder
creation 前失败。Submission 绝不重建 binding。

## Scratch Submission Outcomes

`SubmissionBuilder.submit()` 保持同步。异步 native validation 通过显式结果暴露:

```js
const runtime = await GPURuntime.create({
    diagnostics: {
        submissionScopes: 'summary',
        maxPendingNativeObservations: 64,
    },
})
const submitted = runtime.createSubmission()
    .compute(pass, [ dispatch ])
    .submit()

const nativeOutcome = await submitted.nativeOutcome
await submitted.done
```

`summary` 是默认值，每个 effectful submission 只使用一个常数规模的 native
error-scope bundle。`off` 不打开 submission scope，并报告 `unobserved`；queue
completion 不会被改写成 validation success。`maxPendingNativeObservations`
限制尚未 settle 的 submission 与 direct-readback observation，耗尽时会在 native
effect 前失败。

`SubmittedWork.nativeOutcome` 始终 resolve 为不可变且可序列化的 result。
`SubmittedWork.done` 联合 native observation、queue completion，以及该 completion
边界结算前的 runtime/device lifecycle；任一适用边界失败时以结构化 diagnostic
reject，但不等待 readback mapping 或 host copy。迟到的 failure 只把仍为 current
的 potential write 标为 `indeterminate`，不回滚 epoch，也不能污染已被后续
producer 推进的内容。

Per-command/pass attribution 只在临时有限 capture 中启用:

```js
const capture = runtime.diagnostics.capture({
    maxOperations: 128,
    maxDurationMs: 5_000,
    maxEvidenceBytes: 256 * 1024,
    nativeSubmissionDetail: 'step',
})
// 在有限窗口复现后停止 capture。
const report = capture.stop()
```

默认 summary failure 只能标识 enclosing submission family。Detailed capture
定位 scoped location，不一定定位唯一 native call；OOM 也不证明某一个 command
或 resource 独自耗尽 physical memory。


## Scratch Readback

Direct readback 在请求 bytes 前保持同步。第一次 materialization 会先确认一个
ephemeral staging allocation，之后才允许 copy 或 queue 使用:

```js
const resultRegion = resultBuffer.region()
const direct = runtime.createReadback({ source: resultRegion })
const directBytes = await direct.toBytes()
```

同一个 operation 也接受 texture subresource。`toBytes()` 会移除 native row
padding；`map()` 则在不增加 host copy 的情况下暴露 padded staging:

```js
const pixels = runtime.createReadback({
    source: {
        resource: colorTexture,
        mipLevel: 0,
        size: { width: 64, height: 64 },
        aspect: 'all',
    },
})
const lease = await pixels.map()
try {
    const mapped = new Uint8Array(lease.view)
    const { stagingBytesPerRow } = lease.rowLayout
    // 只在 lease active 期间读取 mapped rows。
} finally {
    lease.dispose()
}
```

Ordered readback command 持有一个已确认的可复用 staging slot，因此 factory
只能返回 Promise，而 `submit()` 保持同步:

```js
const ordered = await runtime.createReadbackCommand({
    source: {
        region: resultRegion,
        contentEpoch: resultBuffer.contentEpoch,
    },
    whenMissing: 'throw',
})
const submitted = runtime.createSubmission().readback(ordered).submit()
const orderedBytes = await ordered.result({ after: submitted }).toBytes()
await submitted.done
```

`SubmittedWork.done` 联合 submission native observation、已 replay 的 queue-work
completion，以及该 completion 结算前的 lifecycle；它不覆盖 mapping 或 host
copy。Direct readback 会在 staging allocation 前拒绝当前为 `indeterminate` 的
source content。Runtime options
`maxPendingOperations` 与 `maxStagingBytes` 限制当前
readback ownership，包括 padded texture staging 与 active mapped lease。
Mapping validation 使用结构化 code
`SCRATCH_READBACK_MAPPING_VALIDATION_FAILED`；native message prose 只是
evidence，不是 classifier。

## 最小示例

下面的代码在 canvas 上渲染一个硬编码三角形。

```js
import { GPURuntime } from 'geoscratch/scratch'

const canvas = document.getElementById('GPUFrame')

main().catch(console.error)

async function main() {
    const runtime = await GPURuntime.create({ label: 'triangle runtime' })
    const surface = runtime.createSurface(canvas, { format: 'preferred' })
    const shaderModule = await runtime.createShaderModule({
        sourceParts: [ { code: `
            @vertex
            fn vsMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
                let positions = array(
                    vec2f(0.0, 0.58),
                    vec2f(-0.58, -0.48),
                    vec2f(0.58, -0.48)
                );
                return vec4f(positions[index], 0.0, 1.0);
            }

            @fragment
            fn fsMain() -> @location(0) vec4f {
                return vec4f(0.12, 0.72, 0.58, 1.0);
            }
        ` } ],
    })
    const program = runtime.createProgram({
        vertex: { module: shaderModule, entryPoint: 'vsMain' },
        fragment: { module: shaderModule, entryPoint: 'fsMain' },
    })
    const pipeline = await runtime.createRenderPipeline({
        program,
        targets: [ { format: surface.format } ],
    })
    const pass = runtime.createRenderPass({
        color: [ {
            target: surface,
            load: 'clear',
            store: 'store',
            clear: [ 0.03, 0.05, 0.08, 1 ],
        } ],
    })
    const draw = runtime.createDrawCommand({
        pipeline,
        count: { vertexCount: 3 },
        resources: { read: [], write: [] },
        whenMissing: 'throw',
    })

    function render() {
        runtime.createSubmission({ validation: 'throw' })
            .render(pass, [ draw ])
            .submit()
        requestAnimationFrame(render)
    }

    render()
}
```

## 示例

运行 `npm run dev` 后打开示例浏览器。每个示例也都有独立页面：

| 示例 | 路径 |
| --- | --- |
| Hello Triangle | `examples/helloTriangle/` |
| Uniform Triangle | `examples/uniformTriangle/` |
| Compute Readback | `examples/computeReadback/` |
| Submission Order | `examples/submissionOrder/` |
| External Image Upload | `examples/externalImageUpload/` |
| Texture Resize | `examples/textureResize/` |
| Hello Vertex Buffer | `examples/helloVertexBuffer/` |
| Texture Sampling | `examples/textureSampling/` |
| Render To Texture | `examples/renderToTexture/` |
| Indirect Execution | `examples/indirectExecution/` |
| Readiness Policies | `examples/readinessPolicies/` |
| DEM Layer | `examples/demLayer/` |
| Flow Layer | `examples/flowLayer/` |
| Hello GAW | `examples/helloGAW/` |

## 开发说明

- 公开 API 统一从 `packages/geoscratch/src/index.ts` 导出，包入口指向 `packages/geoscratch/dist/`。
- 浏览器或 WebGPU 示例放在 `examples/<name>/index.html` 和 `examples/<name>/main.ts`。
- 示例必须通过 `geoscratch` 包入口导入库，不允许用相对路径进入库源码。
- 普通示例图片和 shader 放在所属 example 目录旁边，通过相对资源 URL 或 raw shader import 使用。
- 库自带运行资源放在拥有它的 `packages/geoscratch/src/` 模块旁边。
- `examples/public/` 只用于需要 `/json/...` 这类稳定绝对 URL 加载的大型本地数据。
- Node 兼容的检查使用 `npm test`；涉及渲染的改动还需要在支持 WebGPU 的浏览器中验证。

[npm]: https://img.shields.io/npm/v/geoscratch
[npm-url]: https://www.npmjs.com/package/geoscratch
