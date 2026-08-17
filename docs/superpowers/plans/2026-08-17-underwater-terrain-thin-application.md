# Underwater Terrain Thin Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Underwater Terrain to explicit page bootstrap plus focused application assembly by completing the reusable Geo view-source and terrain-frame contracts.

**Architecture:** A generic `GeoViewSource` captures immutable view and surface-size facts; a MapLibre planar source implements it. The WebMercator terrain renderer consumes that capture and returns `GeoFrameResult` directly, while `main.ts` delegates resource assembly to `application.ts`.

**Tech Stack:** TypeScript 6, WebGPU/WGSL, MapLibre GL JS 4.7.1 structural API, Mocha/Chai, Vite, Playwright Chrome.

## Global Constraints

- No compatibility aliases during `0.x.x`.
- No MapLibre package dependency in `geoscratch`.
- No DEM/PNG/cache/UI semantics in public Geo view or renderer APIs.
- No hidden global runtime, map, renderer, frame, or lifetime authority.
- English API docs remain canonical with reviewed Chinese translations.
- Real browser proof and performance gates must remain at their existing thresholds.

---

### Task 1: Add Geo View Sources

**Files:**
- Modify: `packages/geoscratch/src/geo/geo-view.ts`
- Modify: `packages/geoscratch/src/geo/maplibre-planar-view.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `tests/geo-view-demand.test.js`
- Modify: `tests/geo-planar-view-stability.test.js`
- Modify: `tests/types/public-api.ts`

**Interfaces:**
- Produces: `GeoViewSourceCapture<View>`, `GeoViewSource<View>`, and `createGeoViewSource()`.
- Produces: `mapLibrePlanarViewSource()` returning one source of camera plus `SurfaceSize`.

- [ ] Write failing tests for immutable size capture, descriptor snapshotting, invalid sizes, and MapLibre camera equivalence.
- [ ] Run focused tests and record RED.
- [ ] Implement and export the minimal source contracts and MapLibre composition.
- [ ] Run package build, focused tests, and raw TypeScript gates to GREEN.
- [ ] Commit with `Add Geo view sources`.

### Task 2: Make Terrain Rendering A Native Geo Frame Result

**Files:**
- Modify: `packages/geoscratch/src/geo/web-mercator-terrain-renderer.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `tests/scratch-underwater-terrain-clean-cut.test.js`
- Modify: `tests/types/public-api.ts`

**Interfaces:**
- Consumes: `GeoViewSourceCapture<ViewInput>`.
- Produces: `WebMercatorTerrainRenderer.render(capture)` returning
  `Promise<GeoFrameResult<WebMercatorTerrainFrameValue<ViewInput, Presentation>>>`.
- Removes: public `renderFrame`, public `resize`, and `requestedPageCount`.

- [ ] Write failing tests for same-size submission, changed-size resize plus submission, direct settlement compatibility, and removed methods.
- [ ] Run focused tests and record RED.
- [ ] Rename the private submit path, add the public `render()` orchestration, and align settlement fields.
- [ ] Update public type coverage and run focused/static gates to GREEN.
- [ ] Commit with `Align terrain rendering with Geo frames`.

### Task 3: Split Page Bootstrap From Application Assembly

**Files:**
- Create: `examples/underwaterTerrain/application.ts`
- Modify: `examples/underwaterTerrain/main.ts`
- Modify: `examples/underwaterTerrain/map.ts`
- Modify: `tests/scratch-underwater-terrain-clean-cut.test.js`
- Modify: `tests/examples-structure.test.js`
- Modify: `tests/browser/support/underwater-terrain-proof.ts` only for import/type movement.
- Modify: `tests/browser/scratch-underwater-terrain.mjs` only for cleanup expectation changes.

**Interfaces:**
- Produces: `startUnderwaterTerrainApplication(options)` and a narrow returned presentation command.
- Removes: manual window resize, frame settlement adaptation, renderer size comparison, and runtime assembly from `main.ts`.

- [ ] Add failing structural tests for the 180-line main limit and forbidden responsibilities.
- [ ] Run the structural tests and record RED.
- [ ] Move explicit application assembly without introducing a broad facade or hidden owner.
- [ ] Replace the frame capture path with `mapLibrePlanarViewSource` and renderer `render`.
- [ ] Run focused, type, and clean-cut tests to GREEN.
- [ ] Commit with `Thin the terrain example entry`.

### Task 4: Document And Verify The Clean Cut

**Files:**
- Create: `docs/decisions/ADR-080-geo-view-source-terrain-frame-composition.md`
- Modify: `docs/api/geo/views-frames.md`
- Modify: `docs/api/geo/views-frames_zh.md`
- Modify: `docs/api/geo/terrain-rendering.md`
- Modify: `docs/api/geo/terrain-rendering_zh.md`
- Modify: `examples/underwaterTerrain/README.md`
- Modify: `AGENTS.md`
- Regenerate: `docs/api/reference/*`
- Modify exact public topology/emit manifests only when generated facts prove the delta.

**Interfaces:**
- Documents: source/adapter/driver/controller/renderer ownership and the thin example path.

- [ ] Write ADR-080 and bilingual current API documentation.
- [ ] Run docs generation, translation acknowledgement, and docs check.
- [ ] Run `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Run full Underwater Terrain WebGPU scenario and wireframe/performance proofs headlessly.
- [ ] Verify `main.ts <= 180`, clean worktree diff, exact commits, and no retained processes.
- [ ] Commit with `Document thin terrain composition`.
