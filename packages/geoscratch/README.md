# GeoScratch

[English](./README.md) | [简体中文](./README_zh.md)

[![NPM Package][npm]][npm-url]

GeoScratch is an ES module graphics library for WebGPU-based geovisualization. It exposes lower-level GPU building blocks such as buffers, bindings, pipelines, render passes, compute passes, textures, shaders, and frame orchestration, then layers geospatial helpers and terrain-oriented application modules on top.

The library is designed for developers who want direct control over WebGPU resources while building scenes, maps, globes, terrain layers, or GPU-driven experiments.

![GeoScratch preview](https://raw.githubusercontent.com/YcSoku/GeoScratch/main/DayDream.png)

## Quick Start

```bash
npm install
npm run dev
```

Open the Vite URL to browse examples. A WebGPU-capable browser is required for rendering examples.

## Commands

| Command | Description |
| --- | --- |
| `npm install` | Install dependencies from `package-lock.json`. |
| `npm run dev` | Start the Vite examples browser from `examples/`. |
| `npm test` | Run Mocha tests in `tests/`. |
| `npm run build` | Build the examples browser and standalone example pages into `dist/examples/`. |
| `npm run serve` | Preview the built examples locally. |

## Project Structure

| Path | Purpose |
| --- | --- |
| `src/index.js` | Main public package entrypoint. |
| `src/scratch.js` | Compatibility re-export for older imports. |
| `src/core/` | Shared data references, math, object, and bounding box primitives. |
| `src/geo/` | Geospatial helpers and geographic tiling structures. |
| `src/geometry/` | Reusable geometry generators such as sphere and plane meshes. |
| `src/gpu/` | WebGPU device, buffers, bindings, passes, pipelines, shaders, textures, samplers, and director. |
| `src/loaders/` | Image and shader loading helpers. |
| `src/effects/` | Reusable postprocessing effects. |
| `src/applications/` | Higher-level geospatial application modules, including terrain. |
| `examples/` | Examples browser plus standalone demo pages. |
| `docs/assets/` | Documentation and project branding assets. |
| `examples/public/` | Large local demo data that must be fetched by stable absolute URL. |
| `tests/` | Node-compatible Mocha tests. |

## Package Entrypoints

```js
import * as scr from 'geoscratch'
```

The package also keeps a compatibility entrypoint:

```js
import * as scr from 'geoscratch/scratch'
```

Focused subpaths are available for geospatial and geometry helpers:

```js
import { MercatorCoordinate } from 'geoscratch/geo'
import { sphere } from 'geoscratch/geometry'
```

## Minimal Usage

The example below renders a hard-coded triangle onto a canvas.

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

## Examples

Run `npm run dev` and open the examples browser. Each demo also has a standalone page:

| Example | Path |
| --- | --- |
| Hello Triangle | `examples/1_helloTriangle/` |
| Hello Vertex Buffer | `examples/2_helloVertexBuffer/` |
| Hello Map | `examples/m_helloMap/` |
| DEM Flow Layer | `examples/m_demLayer/` |
| Hello GAW | `examples/x_helloGAW/` |

## Development Notes

- Keep public exports routed through `src/index.js`.
- Add browser/WebGPU demos under `examples/<name>/index.html` and `examples/<name>/main.js`.
- Keep ordinary example images and shaders beside their owning example, using relative asset URLs or raw shader imports.
- Keep library-owned runtime assets beside the source module that owns them, under `src/`.
- Use `examples/public/` only for large local data that must be loaded by stable absolute URLs such as `/json/...`.
- Use `npm test` for Node-compatible checks, and verify rendering changes in a WebGPU-capable browser.

[npm]: https://img.shields.io/npm/v/geoscratch
[npm-url]: https://www.npmjs.com/package/geoscratch
