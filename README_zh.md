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
| `packages/geoscratch/src/index.ts` | 包主要公开入口的 TypeScript 源文件。 |
| `packages/geoscratch/src/scratch.ts` | `geoscratch/scratch` 兼容入口的 TypeScript 源文件。 |
| `packages/geoscratch/src/scratch/` | TypeScript source-first 的 Scratch API 核心。 |
| `packages/geoscratch/dist/` | 生成的包 JavaScript 和声明文件输出。 |
| `packages/geoscratch/src/core/` | 共享数据引用、数学、对象和包围盒基础类型。 |
| `packages/geoscratch/src/geo/` | 地理坐标辅助工具和地理瓦片结构。 |
| `packages/geoscratch/src/geometry/` | sphere、plane 等可复用几何生成器。 |
| `packages/geoscratch/src/gpu/` | WebGPU device、buffer、binding、pass、pipeline、shader、texture、sampler 和 director。 |
| `packages/geoscratch/src/loaders/` | 图片和 shader 加载工具。 |
| `packages/geoscratch/src/effects/` | 可复用的后处理效果。 |
| `packages/geoscratch/src/applications/` | 更高层的地理应用模块，包括地形。 |
| `examples/` | 示例 workspace、示例浏览器和各示例的独立页面。 |
| `docs/assets/` | 文档和项目品牌资源。 |
| `examples/public/` | 需要稳定绝对 URL fetch 的大型本地示例数据。 |
| `tests/` | 可在 Node 环境中运行的 Mocha 测试。 |

## 包入口

```js
import * as scr from 'geoscratch'
```

兼容入口仍然可用：

```js
import * as scr from 'geoscratch/scratch'
```

地理和几何辅助模块也提供独立子入口：

```js
import { MercatorCoordinate } from 'geoscratch/geo'
import { sphere } from 'geoscratch/geometry'
```

## Scratch 异步资源分配

持久 Scratch buffer 与 texture allocation 需要异步确认。只有原生 validation 与 out-of-memory scope 都成功 settle 后才返回资源；texture replacement 使用同一 transaction boundary。

```js
const runtime = await scr.ScratchRuntime.create()
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

+## Scratch Submission Outcomes

`SubmissionBuilder.submit()` 保持同步。异步 native validation 通过显式结果暴露:

```js
const runtime = await scr.ScratchRuntime.create({
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
`SubmittedWork.done` 联合 native observation 与 queue completion；任一边界失败
时以结构化 diagnostic reject，但不等待 readback mapping 或 host copy。迟到的
failure 只把仍为 current 的 potential write 标为 `indeterminate`，不回滚 epoch，
也不能污染已被后续 producer 推进的内容。

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
const direct = runtime.createReadback({ source: resultBuffer })
const directBytes = await direct.toBytes()
```

Ordered readback command 持有一个已确认的可复用 staging slot，因此 factory
只能返回 Promise，而 `submit()` 保持同步:

```js
const ordered = await runtime.createReadbackCommand({
    source: {
        resource: resultBuffer,
        contentEpoch: resultBuffer.contentEpoch,
    },
    whenMissing: 'throw',
})
const submitted = runtime.createSubmission().readback(ordered).submit()
const orderedBytes = await ordered.result({ after: submitted }).toBytes()
await submitted.done
```

`SubmittedWork.done` 联合 submission native observation 与已 replay 的 queue-work
completion；它不覆盖 mapping 或 host copy。Runtime options
`maxPendingOperations` 与 `maxStagingBytes` 限制当前
readback ownership。Mapping validation 使用结构化 code
`SCRATCH_READBACK_MAPPING_VALIDATION_FAILED`；native message prose 只是
evidence，不是 classifier。

## 最小示例

下面的代码在 canvas 上渲染一个硬编码三角形。

```js
import { ScratchRuntime } from 'geoscratch'

const canvas = document.getElementById('GPUFrame')

main().catch(console.error)

async function main() {
    const runtime = await ScratchRuntime.create({ label: 'triangle runtime' })
    const surface = runtime.createSurface(canvas, { format: 'preferred' })
    const program = runtime.createProgram({
        modules: [ `
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
        ` ],
        entryPoints: { vertex: 'vsMain', fragment: 'fsMain' },
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
| Hello Triangle | `examples/scratch_helloTriangle/` |
| Uniform Triangle | `examples/scratch_uniformTriangle/` |
| Compute Readback | `examples/scratch_computeReadback/` |
| Submission Order | `examples/submissionOrder/` |
| External Image Upload | `examples/externalImageUpload/` |
| Texture Resize | `examples/textureResize/` |
| Hello Vertex Buffer | `examples/scratch_helloVertexBuffer/` |
| Texture Sampling | `examples/scratch_textureSampling/` |
| Render To Texture | `examples/scratch_renderToTexture/` |
| DEM Layer (legacy) | `examples/m_demLayer/` |
| Flow Layer (legacy) | `examples/m_flowLayer/` |
| Hello GAW (legacy) | `examples/x_helloGAW/` |

## 开发说明

- 公开 API 统一从 `packages/geoscratch/src/index.ts` 导出，包入口指向 `packages/geoscratch/dist/`。
- 浏览器或 WebGPU 示例放在 `examples/<name>/index.html` 和 `examples/<name>/main.js`。
- 示例必须通过 `geoscratch` 包入口导入库，不允许用相对路径进入库源码。
- 普通示例图片和 shader 放在所属 example 目录旁边，通过相对资源 URL 或 raw shader import 使用。
- 库自带运行资源放在拥有它的 `packages/geoscratch/src/` 模块旁边。
- `examples/public/` 只用于需要 `/json/...` 这类稳定绝对 URL 加载的大型本地数据。
- Node 兼容的检查使用 `npm test`；涉及渲染的改动还需要在支持 WebGPU 的浏览器中验证。

[npm]: https://img.shields.io/npm/v/geoscratch
[npm-url]: https://www.npmjs.com/package/geoscratch
