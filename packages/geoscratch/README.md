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
| `npm run dev` | Build the library package, then start the Vite examples browser from `examples/`. |
| `npm test` | Build the library package, then run Mocha tests in `tests/`. |
| `npm run build` | Build the library package and standalone example pages into `dist/examples/`. |
| `npm run serve` | Preview the built examples locally. |

## Project Structure

| Path | Purpose |
| --- | --- |
| `src/index.ts` | TypeScript source for the main public package entrypoint. |
| `src/scratch.ts` | TypeScript source for the `geoscratch/scratch` compatibility entrypoint. |
| `src/scratch/` | TypeScript source-first Scratch API core. |
| `dist/` | Generated package JavaScript and declaration output. |
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

## Scratch Async Resource Allocation

Persistent Scratch buffer and texture allocation is acknowledged asynchronously. A resource is returned only after its native validation and out-of-memory scopes settle successfully; texture replacement follows the same transaction boundary.

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

`runtime.diagnostics` exposes current resource facts, bounded operation and incident history, and explicit temporary deep capture. Logical footprint evidence is not physical VRAM.

## Scratch Readback

Direct readback stays synchronous until bytes are requested. Its first
materialization acknowledges an ephemeral staging allocation before copy or
queue use:

```js
const direct = runtime.createReadback({ source: resultBuffer })
const directBytes = await direct.toBytes()
```

An ordered readback command owns one acknowledged reusable staging slot, so its
factory is Promise-only while `submit()` remains synchronous:

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

`SubmittedWork.done` covers replayed queue work, not mapping or host copying.
Runtime options `maxPendingOperations` and `maxStagingBytes` bound current
readback ownership. Mapping validation is reported structurally as
`SCRATCH_READBACK_MAPPING_VALIDATION_FAILED`; native message prose is evidence,
not the classifier.

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
| Hello Triangle | `examples/scratch_helloTriangle/` |
| Uniform Triangle | `examples/scratch_uniformTriangle/` |
| Compute Readback | `examples/scratch_computeReadback/` |
| Hello Vertex Buffer | `examples/scratch_helloVertexBuffer/` |
| Texture Sampling | `examples/scratch_textureSampling/` |
| Render To Texture | `examples/scratch_renderToTexture/` |
| DEM Layer (legacy) | `examples/m_demLayer/` |
| Flow Layer (legacy) | `examples/m_flowLayer/` |
| Hello GAW (legacy) | `examples/x_helloGAW/` |

## Development Notes

- Keep public exports routed through `src/index.ts` and package exports pointed at `dist/`.
- Add browser/WebGPU demos under `examples/<name>/index.html` and `examples/<name>/main.js`.
- Keep ordinary example images and shaders beside their owning example, using relative asset URLs or raw shader imports.
- Keep library-owned runtime assets beside the source module that owns them, under `src/`.
- Use `examples/public/` only for large local data that must be loaded by stable absolute URLs such as `/json/...`.
- Use `npm test` for Node-compatible checks, and verify rendering changes in a WebGPU-capable browser.

[npm]: https://img.shields.io/npm/v/geoscratch
[npm-url]: https://www.npmjs.com/package/geoscratch
