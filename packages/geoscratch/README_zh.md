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
| `npm run dev` | 从 `examples/` 启动 Vite 示例浏览器。 |
| `npm test` | 运行 `tests/` 中的 Mocha 测试。 |
| `npm run build` | 将示例浏览器和独立示例页面构建到 `dist/examples/`。 |
| `npm run serve` | 本地预览构建后的示例。 |

## 项目结构

| 路径 | 作用 |
| --- | --- |
| `src/index.js` | 包的主要公开入口。 |
| `src/scratch.js` | 为旧导入方式保留的兼容入口。 |
| `src/core/` | 共享数据引用、数学、对象和包围盒基础类型。 |
| `src/geo/` | 地理坐标辅助工具和地理瓦片结构。 |
| `src/geometry/` | sphere、plane 等可复用几何生成器。 |
| `src/gpu/` | WebGPU device、buffer、binding、pass、pipeline、shader、texture、sampler 和 director。 |
| `src/loaders/` | 图片和 shader 加载工具。 |
| `src/effects/` | 可复用的后处理效果。 |
| `src/applications/` | 更高层的地理应用模块，包括地形。 |
| `examples/` | 示例浏览器和各示例的独立页面。 |
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

## 最小示例

下面的代码在 canvas 上渲染一个硬编码三角形。

```js
import * as scr from 'geoscratch'

scr.StartDash().then(() => main(document.getElementById('GPUFrame')))

function main(canvas) {
    const screen = scr.screen({ canvas })

    const shaderCode = `
    const pos = array<vec2f, 3>(
        vec2f(-0.5, -0.5),
        vec2f(0.0, 0.5),
        vec2f(0.5, -0.5),
    );

    @vertex
    fn vMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
        return vec4f(pos[vertexIndex], 0.0, 1.0);
    }

    @fragment
    fn fMain() -> @location(0) vec4f {
        return vec4f(128.0, 218.0, 197.0, 255.0) / 255.0;
    }
    `

    const triangleBinding = scr.binding({
        range: () => [ 3 ],
    })

    const trianglePipeline = scr.renderPipeline({
        shader: {
            module: scr.shader({ codeFunc: () => shaderCode }),
        },
    })

    const trianglePass = scr.renderPass({
        colorAttachments: [ { colorResource: screen } ],
    }).add(trianglePipeline, triangleBinding)

    scr.director.addStage({
        name: 'HelloTriangle',
        items: [ trianglePass ],
    })

    function animate() {
        scr.director.tick()
        requestAnimationFrame(animate)
    }

    animate()
}
```

## 示例

运行 `npm run dev` 后打开示例浏览器。每个示例也都有独立页面：

| 示例 | 路径 |
| --- | --- |
| Hello Triangle | `examples/1_helloTriangle/` |
| Hello Vertex Buffer | `examples/2_helloVertexBuffer/` |
| Hello Map | `examples/m_helloMap/` |
| DEM Layer | `examples/m_demLayer/` |
| Flow Layer | `examples/m_flowLayer/` |
| Hello GAW | `examples/x_helloGAW/` |

## 开发说明

- 公开 API 统一从 `src/index.js` 导出。
- 浏览器或 WebGPU 示例放在 `examples/<name>/index.html` 和 `examples/<name>/main.js`。
- 普通示例图片和 shader 放在所属 example 目录旁边，通过相对资源 URL 或 raw shader import 使用。
- 库自带运行资源放在拥有它的 `src/` 模块旁边。
- `examples/public/` 只用于需要 `/json/...` 这类稳定绝对 URL 加载的大型本地数据。
- Node 兼容的检查使用 `npm test`；涉及渲染的改动还需要在支持 WebGPU 的浏览器中验证。

[npm]: https://img.shields.io/npm/v/geoscratch
[npm-url]: https://www.npmjs.com/package/geoscratch
