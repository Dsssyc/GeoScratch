# Repository Guidelines

## Project Structure & Module Organization

GeoScratch is an ES module WebGPU library. The public entrypoint is `src/scratch.js`, with TypeScript declaration files (`*.d.ts`) kept beside the matching JavaScript modules. Core math, geometry, data, and geospatial helpers live in `src/core/`; WebGPU resources, passes, pipelines, bindings, textures, and context code live in `src/platform/`; loaders are in `src/resource/`; postprocessing helpers are in `src/function/`; and higher-level terrain code is in `src/application/`. Vite examples are under `example/`, with shared static assets and WGSL shaders in `public/`. Tests belong in `test/`.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: start the Vite development server for `index.html` and the examples.
- `npm run build`: run the Vite production build.
- `npm run serve`: preview the built Vite output locally.
- `npm test`: run Mocha tests from `test/`.

## Coding Style & Naming Conventions

Use ES module imports/exports and keep exports routed through `src/scratch.js` when adding public API. Follow the surrounding style: no semicolons, compact object literals, and 4-space indentation inside functions/classes. Prefer descriptive lower camelCase for factory functions and upper PascalCase for classes, matching pairs such as `screen`/`Screen` and `vertexBuffer`/`VertexBuffer`. Keep declaration files synchronized with public JavaScript modules. Store feature shaders under `public/shaders/<feature>/` or `public/shaders/examples/<example>/`.

## Testing Guidelines

Mocha and Chai are available for tests. Add tests as `test/*.js`, import from `../src/scratch.js` or the target module, and keep browser/WebGPU-only behavior separated from Node-compatible unit checks. Run `npm test` before submitting. For rendering or shader changes, also run `npm run dev` and manually verify the affected example in a WebGPU-capable browser.

## Commit & Pull Request Guidelines

Existing history uses short imperative subjects, often one line, with occasional PR references such as `Update implementation of flow layer (#2)`. Prefer concise but specific messages, for example `Update terrain layer LOD` instead of `update`. Pull requests should describe the changed module or example, list verification commands run, link related issues, and include screenshots or screen recordings for visible rendering changes.

## Security & Configuration Tips

Do not commit `node_modules/`, generated build output, local data under `public/json/examples/`, or machine-specific files. Keep large demo data out of git unless it is required for reproducible examples.
