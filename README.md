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
| `packages/geoscratch/` | Publishable library package. |
| `packages/geoscratch/src/index.ts` | TypeScript source for the main public package entrypoint. |
| `packages/geoscratch/src/scratch.ts` | TypeScript source for the `geoscratch/scratch` compatibility entrypoint. |
| `packages/geoscratch/src/scratch/` | TypeScript source-first Scratch API core. |
| `packages/geoscratch/dist/` | Generated package JavaScript and declaration output. |
| `packages/geoscratch/src/core/` | Shared data references, math, object, and bounding box primitives. |
| `packages/geoscratch/src/geo/` | Geospatial helpers and geographic tiling structures. |
| `packages/geoscratch/src/geometry/` | Reusable geometry generators such as sphere and plane meshes. |
| `packages/geoscratch/src/gpu/` | WebGPU device, buffers, bindings, passes, pipelines, shaders, textures, samplers, and director. |
| `packages/geoscratch/src/loaders/` | Image and shader loading helpers. |
| `packages/geoscratch/src/effects/` | Reusable postprocessing effects. |
| `packages/geoscratch/src/applications/` | Higher-level geospatial application modules, including terrain. |
| `examples/` | Examples workspace, examples browser, and standalone demo pages. |
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

## Examples

Run `npm run dev` and open the examples browser. Each demo also has a standalone page:

| Example | Path |
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

## Development Notes

- Keep public exports routed through `packages/geoscratch/src/index.ts` and package exports pointed at `packages/geoscratch/dist/`.
- Add browser/WebGPU demos under `examples/<name>/index.html` and `examples/<name>/main.js`.
- Examples must import the package as `geoscratch`, not reach into library source by relative path.
- Keep ordinary example images and shaders beside their owning example, using relative asset URLs or raw shader imports.
- Keep library-owned runtime assets beside the source module that owns them, under `packages/geoscratch/src/`.
- Use `examples/public/` only for large local data that must be loaded by stable absolute URLs such as `/json/...`.
- Use `npm test` for Node-compatible checks, and verify rendering changes in a WebGPU-capable browser.

[npm]: https://img.shields.io/npm/v/geoscratch
[npm-url]: https://www.npmjs.com/package/geoscratch
