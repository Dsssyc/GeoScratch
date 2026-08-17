# Repository Guidelines

## Project Structure & Module Organization

GeoScratch is an npm workspace repository. The publishable ES module WebGPU library lives in `packages/geoscratch/`; its TypeScript public entrypoint source is `packages/geoscratch/src/index.ts`, with `packages/geoscratch/src/scratch.ts` as the formal `geoscratch/scratch` facade. Package exports point to generated `packages/geoscratch/dist/` JavaScript and declaration files. The package root exports only `scratch` and `geo` namespaces. Scratch GPU, Worker, Persistent Cache, diagnostics, geometry, and internal helpers live under `packages/geoscratch/src/scratch/`; geospatial helpers, standard tile-matrix structures, and virtual-raster contracts live under `packages/geoscratch/src/geo/`. Production source is TypeScript source-first and must not use same-source JavaScript or hand-written declaration files. Vite examples are an independent consumer workspace under `examples/` and must import foundation contracts from `geoscratch/scratch` and geographic contracts from `geoscratch/geo` instead of reaching into library source by relative path. Documentation and branding assets live in `docs/assets/`; architecture decision records live in `docs/decisions/`; forward-looking architecture vision docs live in `docs/vision/`; living review notes and temporary-but-active design audits live in `docs/review/`; current API knowledge lives in `docs/api/`; example-only assets live beside their owning example; library-owned assets live beside their source module. Tests belong in `tests/`.

## Documentation & Decisions

Keep `README.md` and `README_zh.md` focused on user-facing overview, quick start, examples, and public package usage. Put contributor workflow, repository layout rules, and agent-specific guidance in this file. Record non-trivial rendering, public API, asset ownership, and module-boundary decisions as ADRs under `docs/decisions/` using sequential names such as `ADR-001-dem-flow-layer-artifact-cleanup.md`.

Before changing implementation, read `docs/api/README.md` and the English canonical API page for every subsystem touched. TypeScript source and package entrypoints are executable API facts; English pages under `docs/api/` are the canonical current semantic contract; paired `_zh.md` pages are Chinese translations and English governs conflicts. ADRs explain accepted or superseded decisions. Vision documents describe direction, while reviews and audits record bounded evidence. If source and canonical API prose disagree, investigate the discrepancy instead of silently choosing one or rewriting history.

Update the relevant English API page and its Chinese counterpart whenever a public symbol, signature, responsibility, ownership rule, lifecycle transition, revision, invalidation behavior, scheduling rule, diagnostic, failure mode, dependency direction, or composition contract changes. Add a concise behavior-and-ownership TSDoc summary to every public runtime class, function, variable, or enum. Do not edit `docs/api/reference/` manually. After reviewing both languages, run `npm run docs:generate`, `npm run docs:translations`, and the read-only `npm run docs:check`. The translation command updates revision digests only; it does not prove translation quality.

Use `docs/vision/` for forward-looking design material that has not yet become an accepted ADR, and `docs/review/` for living design reviews that are meant to be updated rather than archived as legacy notes. Before changing the `scratch` GPU-kernel API, read `docs/vision/scratch-graphics-kernel.md`, the modular bilingual docs under `docs/vision/scratch-api/`, and active review notes under `docs/review/`. The `scratch-api` docs define the current target model: explicit async runtime, runtime/surface separation, logical resources with allocation versions and content epochs, layout codecs as preparation artifacts for CPU packing/WGSL accessors/readback views, explicit CPU/GPU transfer operations, explicit WGSL language-feature contracts, per-command immediate data snapshotted once per actual submission step without Resource or epoch semantics, readback operation lifecycle and diagnostics, indexed `QuerySetResource` slots limited to timestamp/occlusion in core, explicit readiness policies, explicit bind layouts with shader inspection only as a helper, shader `Program` contracts that do not own concrete resources, stable pipelines plus executable `Command` objects, unified machine-readable `ScratchDiagnostic` reports, persistent `PassSpec` objects, `SubmissionBuilder` plus `SubmittedWork`, and explicit submission order with dependency validation. During `0.x.x`, old `scratch` APIs are reference material rather than compatibility constraints unless a later ADR says otherwise. Do not introduce `Material` / `material` / material-like scene terms into scratch core; style, symbolizer, layer, and material-like packages belong above scratch and must lower into `Program`, `BindSet`, `Pipeline`, and `Command`. Do not create prose-only validation errors for new scratch API surfaces; use the diagnostic envelope in `docs/vision/scratch-api/09-diagnostics-validation/`.

Before changing Worker, tile-matrix, virtual-raster, cache, or DEM streaming behavior, read `docs/decisions/ADR-055-high-precision-virtual-raster-dem.md` through the latest related ADR, the Tiles/LoD vision module, and the active Geo virtual-raster audits. Keep ownership frozen: Worker and Persistent Cache are independent generic Scratch capabilities with no GPU/Geo/DEM dependency; Geo owns standard tile identity, demand, cache address/coherence adaptation, owned transfer, residency, snapshots, fallback, and GPU lowering; applications own cache presence and total budgets; the GPU domain must not acquire Worker, tile, cache, CRS, virtual-raster, or DEM concepts. Persistent Cache stores IndexedDB metadata and optional OPFS raw payloads under immutable `(id, revision)` keys; it has no built-in memory tier or GPU conversion API. Editable working state is not cache, a decoded payload has exactly one owner at any instant, and immutable snapshots never own decoded bytes. `createWebMercatorTerrainRenderer` and `webMercatorTerrainWgslModule` own WebMercator terrain vertex generation, camera-relative precision, render-patch lookup, cross-LoD mesh stitching, Virtual Raster height sampling, and the built-in tile-wireframe fragment; a consuming example may add presentation WGSL but must not duplicate those mechanisms. The DEM normal path is OGC `WebMercatorQuad` only; do not reintroduce a generic `TerrainFieldRenderer` alias, application-owned terrain vertex shader, local pyramid, old endpoint alias, full-image browser fallback, main-thread image decode, encoded-PNG persistent records, or legacy/new feature flag.

Scratch is domain-neutral and must not depend on Geo, examples, maps, tiles, DEM, or application policy. Geo may compose Scratch into geographic semantics. Examples demonstrate source-specific assembly; they are evidence of a possibly missing primitive, not permission to move an example-shaped abstraction unchanged into Scratch or Geo. Prefer explicit ownership, lifetime, revisions, invalidation, scheduling, diagnostics, and WebGPU-native work over hidden global authority or implicit CPU round trips.

The active terrain example is `examples/underwaterTerrain/`, titled `Underwater Terrain`.
Use that name for its route, page, controls, runtime labels, tests, and current documentation.
Application-owned cache controls and full-example browser proofs also use the
`Underwater Terrain` identity.
Reserve `DEM` names inside the example for facts that specifically describe the elevation
raster, tile payload, source protocol, or cache identity. Historical `m_demLayer` references
may remain only when they identify the removed legacy source.

Keep Geo view and frame authority orthogonal to renderers. Independent applications use
`createGeoFrameController()` directly; MapLibre-hosted overlays compose
`createGeoFrameController({ driver: mapLibreFrameDriver(...) })`. Do not reintroduce
application-owned MapLibre `move`/`render` revision state, renderer host-mode flags, or a second
frame controller. A driver synchronizes frame admission but never claims shared WebGL/WebGPU
context, depth, render-pass, or presentation ownership.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: delegate to the `examples` workspace and start the Vite examples browser.
- `npm run build`: build the `geoscratch` package into `packages/geoscratch/dist/`, then build standalone example pages into `dist/examples/`.
- `npm run serve`: preview the built Vite output locally.
- `npm run docs:generate`: regenerate committed API facts from the public TypeScript entrypoints.
- `npm run docs:translations`: update reviewed Chinese translation revision digests.
- `npm run docs:check`: verify generated facts, API coverage, links, and translation freshness without modifying files.
- `npm test`: run the documentation gate, package build, and Mocha tests from `tests/`.

## Coding Style & Naming Conventions

Use ES module imports/exports and route public API through the explicit `scratch` or `geo` facade. Preserve `packages/geoscratch/src/index.ts` as the namespace-only root and `packages/geoscratch/src/scratch.ts` as the formal Scratch re-export. Follow the surrounding style: no semicolons, compact object literals, and 4-space indentation inside functions/classes. Prefer descriptive lower camelCase for factory functions and upper PascalCase for classes. Keep TypeScript source and emitted declarations synchronized by running the package build; do not add hand-written declarations beside Scratch or Geo source. Keep runnable demos under `examples/<name>/index.html` plus `main.ts`; do not add a root `index.html`. Store ordinary example-only shaders and images beside the owning example. Use `examples/public/` only for large local data that must be loaded by stable absolute URL.

## Testing Guidelines

Mocha and Chai are available for tests. Add tests as `tests/*.test.js`, import Scratch and public API checks from `geoscratch` or its public subpaths, and keep browser/WebGPU-only behavior separated from Node-compatible unit checks. Run focused tests first, followed by `npm run typecheck`, `npm test`, and `npm run build`. For rendering or shader changes, also run `npm run dev` and manually verify the affected example in a WebGPU-capable browser.

## Browser Debugging Etiquette

Do not disrupt the user's primary display or active browser while testing frontend behavior. Use headless browser automation by default for DOM, network, lifecycle, and non-visual checks. Use a headed browser only when native WebGPU behavior or visual rendering cannot be verified correctly in headless mode.

When headed Chrome is required on macOS, first discover the active display bounds and select a non-main display. Launch a dedicated debug Chrome instance in the background with an isolated temporary `--user-data-dir`, a dedicated remote-debugging port, and `--window-position` / `--window-size` values that place the entire window on that non-main display; use a non-activating launcher such as `open -g`, then connect Playwright through CDP. Do not use a direct headed Playwright launch when it can activate a foreground window. Do not activate, navigate, resize, move, or close the user's existing Chrome windows or tabs. Close only the dedicated debug instance created by the agent.

If no non-main display is connected, or display placement and non-activation cannot be confirmed, do not launch a headed browser automatically. Stay headless and report the visual-verification limitation unless the user explicitly asks to open a foreground browser. Opening a page for the user's own inspection is also subject to this rule: prefer a background-opened tab/window on the non-main display and never steal keyboard focus from the user's current application.

## Commit & Pull Request Guidelines

Existing history uses short imperative subjects, often one line, with occasional PR references such as `Update implementation of flow layer (#2)`. Prefer concise but specific messages, for example `Update terrain layer LOD` instead of `update`. After each verified phase of work, create a commit before starting the next phase so the repository keeps clear rollback checkpoints. Pull requests should describe the changed module or example, list verification commands run, link related issues, and include screenshots or screen recordings for visible rendering changes.

## Security & Configuration Tips

Do not commit `node_modules/`, generated build output, local data under `examples/public/json/examples/`, or machine-specific files. Keep large demo data out of git unless it is required for reproducible examples.
