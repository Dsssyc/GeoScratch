# Repository Guidelines

## Project Structure & Module Organization

GeoScratch is an ES module WebGPU library. The public entrypoint is `src/index.js`, with `src/scratch.js` kept as a compatibility shim. TypeScript declaration files (`*.d.ts`) live beside matching JavaScript modules. Shared primitives live in `src/core/`; geospatial helpers and tiling structures are in `src/geo/`; reusable mesh generators are in `src/geometry/`; WebGPU resources are in `src/gpu/`; loaders are in `src/loaders/`; postprocessing helpers are in `src/effects/`; and higher-level terrain code is in `src/applications/`. Vite examples are under `examples/`. Documentation and branding assets live in `docs/assets/`; architecture decision records live in `docs/decisions/`; example-only assets live beside their owning example; library-owned assets live beside their source module. Tests belong in `tests/`.

## Documentation & Decisions

Keep `README.md` and `README_zh.md` focused on user-facing overview, quick start, examples, and public package usage. Put contributor workflow, repository layout rules, and agent-specific guidance in this file. Record non-trivial rendering, public API, asset ownership, and module-boundary decisions as ADRs under `docs/decisions/` using sequential names such as `ADR-001-dem-flow-layer-artifact-cleanup.md`.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: start the Vite development server rooted at `examples/`.
- `npm run build`: build the examples browser and standalone example pages into `dist/examples/`.
- `npm run serve`: preview the built Vite output locally.
- `npm test`: run Mocha tests from `tests/`.

## Coding Style & Naming Conventions

Use ES module imports/exports and keep exports routed through `src/index.js` when adding public API. Preserve `src/scratch.js` as a compatibility re-export only. Follow the surrounding style: no semicolons, compact object literals, and 4-space indentation inside functions/classes. Prefer descriptive lower camelCase for factory functions and upper PascalCase for classes, matching pairs such as `screen`/`Screen` and `vertexBuffer`/`VertexBuffer`. Keep declaration files synchronized with public JavaScript modules. Keep runnable demos under `examples/<name>/index.html` plus `main.js`; do not add a root `index.html`. Store ordinary example-only shaders and images beside the owning example. Use `examples/public/` only for large local data that must be loaded by stable absolute URL.

## Testing Guidelines

Mocha and Chai are available for tests. Add tests as `tests/*.test.js`, import from `../src/index.js` or the target module, and keep browser/WebGPU-only behavior separated from Node-compatible unit checks. Run `npm test` before submitting. For rendering or shader changes, also run `npm run dev` and manually verify the affected example in a WebGPU-capable browser.

## Commit & Pull Request Guidelines

Existing history uses short imperative subjects, often one line, with occasional PR references such as `Update implementation of flow layer (#2)`. Prefer concise but specific messages, for example `Update terrain layer LOD` instead of `update`. After each verified phase of work, create a commit before starting the next phase so the repository keeps clear rollback checkpoints. Pull requests should describe the changed module or example, list verification commands run, link related issues, and include screenshots or screen recordings for visible rendering changes.

## Security & Configuration Tips

Do not commit `node_modules/`, generated build output, local data under `examples/public/json/examples/`, or machine-specific files. Keep large demo data out of git unless it is required for reproducible examples.
