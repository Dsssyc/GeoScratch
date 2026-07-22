# Repository Guidelines

## Project Structure & Module Organization

GeoScratch is an npm workspace repository. The publishable ES module WebGPU library lives in `packages/geoscratch/`; its TypeScript public entrypoint source is `packages/geoscratch/src/index.ts`, with `packages/geoscratch/src/scratch.ts` kept as the `geoscratch/scratch` compatibility shim. Package exports point to generated `packages/geoscratch/dist/` JavaScript and declaration files. Scratch core under `packages/geoscratch/src/scratch/` is TypeScript source-first and must not use same-source JavaScript or hand-written declaration files. Shared primitives live in `packages/geoscratch/src/core/`; geospatial helpers and tiling structures are in `packages/geoscratch/src/geo/`; reusable mesh generators are in `packages/geoscratch/src/geometry/`; WebGPU resources are in `packages/geoscratch/src/gpu/`; loaders are in `packages/geoscratch/src/loaders/`; effects helpers are in `packages/geoscratch/src/effects/`; and higher-level terrain code is in `packages/geoscratch/src/applications/`. Vite examples are an independent consumer workspace under `examples/` and must import `geoscratch` instead of reaching into library source by relative path. Documentation and branding assets live in `docs/assets/`; architecture decision records live in `docs/decisions/`; forward-looking architecture vision docs live in `docs/vision/`; living review notes and temporary-but-active design audits live in `docs/review/`; example-only assets live beside their owning example; library-owned assets live beside their source module. Tests belong in `tests/`.

## Documentation & Decisions

Keep `README.md` and `README_zh.md` focused on user-facing overview, quick start, examples, and public package usage. Put contributor workflow, repository layout rules, and agent-specific guidance in this file. Record non-trivial rendering, public API, asset ownership, and module-boundary decisions as ADRs under `docs/decisions/` using sequential names such as `ADR-001-dem-flow-layer-artifact-cleanup.md`.

Use `docs/vision/` for forward-looking design material that has not yet become an accepted ADR, and `docs/review/` for living design reviews that are meant to be updated rather than archived as legacy notes. Before changing the `scratch` GPU-kernel API, read `docs/vision/scratch-graphics-kernel.md`, the modular bilingual docs under `docs/vision/scratch-api/`, and active review notes under `docs/review/`. The `scratch-api` docs define the current target model: explicit async runtime, runtime/surface separation, logical resources with allocation versions and content epochs, layout codecs as preparation artifacts for CPU packing/WGSL accessors/readback views, explicit CPU/GPU transfer operations, readback operation lifecycle and diagnostics, indexed `QuerySetResource` slots limited to timestamp/occlusion in core, explicit readiness policies, explicit bind layouts with shader inspection only as a helper, shader `Program` contracts that do not own concrete resources, stable pipelines plus executable `Command` objects, unified machine-readable `ScratchDiagnostic` reports, persistent `PassSpec` objects, `SubmissionBuilder` plus `SubmittedWork`, and explicit submission order with dependency validation. During `0.x.x`, old `scratch` APIs are reference material rather than compatibility constraints unless a later ADR says otherwise. Do not introduce `Material` / `material` / material-like scene terms into scratch core; style, symbolizer, layer, and material-like packages belong above scratch and must lower into `Program`, `BindSet`, `Pipeline`, and `Command`. Do not create prose-only validation errors for new scratch API surfaces; use the diagnostic envelope in `docs/vision/scratch-api/09-diagnostics-validation/`.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: delegate to the `examples` workspace and start the Vite examples browser.
- `npm run build`: build the `geoscratch` package into `packages/geoscratch/dist/`, then build standalone example pages into `dist/examples/`.
- `npm run serve`: preview the built Vite output locally.
- `npm test`: run Mocha tests from `tests/`.

## Coding Style & Naming Conventions

Use ES module imports/exports and keep public exports routed through `packages/geoscratch/src/index.ts` when adding public API. Preserve `packages/geoscratch/src/scratch.ts` as a compatibility re-export only. Follow the surrounding style: no semicolons, compact object literals, and 4-space indentation inside functions/classes. Prefer descriptive lower camelCase for factory functions and upper PascalCase for classes, matching pairs such as `screen`/`Screen` and `vertexBuffer`/`VertexBuffer`. Keep TypeScript source and emitted declarations synchronized by running the package build; do not add hand-written declarations beside Scratch source. Keep runnable demos under `examples/<name>/index.html` plus `main.ts`; do not add a root `index.html`. Store ordinary example-only shaders and images beside the owning example. Use `examples/public/` only for large local data that must be loaded by stable absolute URL.

## Testing Guidelines

Mocha and Chai are available for tests. Add tests as `tests/*.test.js`, import Scratch and public API checks from `geoscratch` or its public subpaths, and keep browser/WebGPU-only behavior separated from Node-compatible unit checks. Run `npm test` before submitting. For rendering or shader changes, also run `npm run dev` and manually verify the affected example in a WebGPU-capable browser.

## Commit & Pull Request Guidelines

Existing history uses short imperative subjects, often one line, with occasional PR references such as `Update implementation of flow layer (#2)`. Prefer concise but specific messages, for example `Update terrain layer LOD` instead of `update`. After each verified phase of work, create a commit before starting the next phase so the repository keeps clear rollback checkpoints. Pull requests should describe the changed module or example, list verification commands run, link related issues, and include screenshots or screen recordings for visible rendering changes.

## Security & Configuration Tips

Do not commit `node_modules/`, generated build output, local data under `examples/public/json/examples/`, or machine-specific files. Keep large demo data out of git unless it is required for reproducible examples.
