# Geo Executable Field Runtime Clean Cut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all reusable DEM camera, Virtual Raster, GPU LoD, and terrain execution behavior into public Scratch/Geo products so `examples/demLayer` is a thin data-source and shader consumer.

**Architecture:** Scratch gains only a domain-independent asynchronous phase budget. Geo gains explicit MapLibre view adaptation, a WebMercator Virtual Raster field/runtime, a GPU render-patch frontier, and a terrain-field renderer; each product has explicit borrowed/owned lifetimes and machine-readable facts. The DEM example keeps its manifest, Worker decoder/cache policy, controls, terrain WGSL, and short application wiring.

**Tech Stack:** TypeScript 6, WebGPU, WGSL, Mocha/Chai, Vite, Playwright browser proofs.

## Global Constraints

- Preserve the behavior frozen by checkpoint `db3006c`.
- Production library source is TypeScript-only and exported through `geoscratch/scratch` or `geoscratch/geo`.
- Use structured Scratch/Geo diagnostics for new public validation.
- Do not add hidden runtime, Worker, cache, map, or Surface ownership.
- Keep Worker and Persistent Cache independent; applications choose cache presence and budgets.
- Keep the normal DEM path OGC `WebMercatorQuad` only.
- Preserve GPU-driven selection, indirect drawing, delayed feedback, 2:1 balancing, and camera-relative precision.
- Remove old example implementations after consumers and tests use public APIs.

---

### Task 1: Freeze The Thin-Example Boundary

**Files:**
- Modify: `tests/scratch-dem-layer-clean-cut.test.js`
- Modify: `tests/examples-structure.test.js`
- Modify: `tests/scratch-foundation-public-topology.test.js`
- Modify: `tests/types/public-api.ts`

**Interfaces:**
- Produces structural gates for `TaskPhaseBudget`, `MapLibrePlanarViewAdapter`,
  `WebMercatorVirtualRasterField`, `VirtualRasterRuntime`,
  `GpuRenderPatchFrontier`, and `TerrainFieldRenderer`.

- [ ] Write tests requiring the new public names and forbidding low-level GPU
  graph construction under `examples/demLayer`.
- [ ] Run the focused tests and confirm they fail because the public products do
  not exist and the example still owns the implementations.
- [ ] Keep the failing output as the migration baseline.

### Task 2: Generalize The Scratch Phase Budget

**Files:**
- Create: `packages/geoscratch/src/scratch/worker/task-phase-budget.ts`
- Modify: `packages/geoscratch/src/scratch/worker/index.ts`
- Modify: `packages/geoscratch/src/scratch/index.ts`
- Modify: `examples/demLayer/dem-worker-source.ts`
- Modify: `tests/geo-virtual-raster-dem.test.js`
- Delete: `examples/demLayer/dem-phase-budget.ts`

**Interfaces:**
- Produces `TaskPhaseBudget<Phase extends string>`, `TaskPhasePermit`, and
  immutable per-phase facts.

- [ ] Add a focused failing test for arbitrary phase names, priority ordering,
  cancellation, and idempotent release.
- [ ] Implement the generic budget by preserving the proven queue algorithm.
- [ ] Migrate DEM Worker source to `TaskPhaseBudget<'network' | 'decode'>`.
- [ ] Run focused Worker/DEM tests and package type checking.

### Task 3: Move MapLibre Camera Precision Into Geo

**Files:**
- Create: `packages/geoscratch/src/geo/maplibre-planar-view.ts`
- Modify: `packages/geoscratch/src/geo/geo-view.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `examples/demLayer/main.ts`
- Modify: `tests/dem-camera-stability.test.js`
- Modify: `tests/geo-view-demand.test.js`
- Delete: `examples/demLayer/dem-map.ts`

**Interfaces:**
- Produces `mapLibrePlanarViewAdapter(descriptor)` whose `read(source, context)`
  returns one camera state and immutable `GeoViewSnapshot` with caller-supplied
  frame and residency epochs.

- [ ] Change `GeoViewAdapter.read` to receive provenance context separately from
  the adapter source and update its tests first.
- [ ] Move the validated camera-relative f64 matrix and high/low encoding into Geo.
- [ ] Keep map creation/style in a small example application helper or `main.ts`.
- [ ] Run camera stability, Geo view, type, and structure tests.

### Task 4: Add The WebMercator Virtual Raster Field And Runtime

**Files:**
- Create: `packages/geoscratch/src/geo/web-mercator-virtual-raster-field.ts`
- Create: `packages/geoscratch/src/geo/virtual-raster-runtime.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `examples/demLayer/dem-virtual-raster.ts`
- Modify: `examples/demLayer/main.ts`
- Modify: `tests/geo-virtual-raster-dem.test.js`
- Modify: `tests/geo-virtual-raster-gpu-feedback.test.js`
- Modify: `tests/types/public-api.ts`

**Interfaces:**
- Produces `webMercatorVirtualRasterField(descriptor)` with generated namespaced
  shader accessors and `createVirtualRasterRuntime(descriptor)` with explicit
  request-executor borrowing and shutdown phases.

- [ ] Add failing tests for field construction, safety cover, shader generation,
  runtime publication authority, feedback reconciliation, and executor ownership.
- [ ] Move generic model/address/shader behavior from the DEM module into Geo.
- [ ] Move demand leases, residency, scheduler, GPU state, and publication logic
  into `VirtualRasterRuntime` without moving Worker/cache creation.
- [ ] Reduce the DEM module to manifest parsing, URL/source creation, and descriptor
  translation.
- [ ] Run Virtual Raster, feedback, DEM source, type, and structure tests.

### Task 5: Move GPU Render-Patch Selection Into Geo

**Files:**
- Create: `packages/geoscratch/src/geo/gpu-render-patch-frontier.ts`
- Create: `packages/geoscratch/src/geo/gpu-render-patch-frontier-wgsl.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `tests/dem-render-patch-frontier.test.js`
- Modify: `tests/types/public-api.ts`
- Delete: `examples/demLayer/dem-render-patch-frontier.ts`
- Delete: `examples/demLayer/shaders/render-patch-frontier.wgsl`

**Interfaces:**
- Produces `GpuRenderPatchFrontier`, `createGpuRenderPatchFrontier`, structured
  feedback, constants, and a terrain-shader lookup ABI module.

- [ ] Migrate the existing decoder tests to public Geo names and watch them fail.
- [ ] Move and rename the TypeScript algorithm without changing packed layouts.
- [ ] embed the current WGSL kernel as a library-owned TypeScript string and remove
  the shader option from the public factory.
- [ ] Run decoder, GPU frontier, package build, and type tests.

### Task 6: Add The Terrain Field Renderer

**Files:**
- Create: `packages/geoscratch/src/geo/terrain-field-renderer.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `examples/demLayer/main.ts`
- Modify: `examples/demLayer/shaders/terrain-mesh.wgsl`
- Modify: `tests/scratch-dem-layer-clean-cut.test.js`
- Modify: `tests/types/public-api.ts`
- Delete: `examples/demLayer/dem-layer.ts`

**Interfaces:**
- Produces `createTerrainFieldRenderer({ runtime, surface, fieldLayer,
  virtualRaster, size, shader, presentations })` with `initialize`, `renderFrame`,
  `setPresentation`, `resize`, `facts`, and `dispose`.

- [ ] Port current fake-GPU graph tests to the public renderer and confirm failure.
- [ ] Move the persistent Scratch graph, resize, provenance, feedback, and indirect
  draw orchestration into Geo using generic names.
- [ ] Accept only application terrain WGSL; inject library field and render-patch
  modules internally.
- [ ] Make `renderFrame` consume the `MapFieldLayer` adapter source and supply
  frame/residency provenance itself.
- [ ] Run clean-cut, submission provenance, type, and package tests.

### Task 7: Thin The DEM Application And Remove Residue

**Files:**
- Modify: `examples/demLayer/main.ts`
- Modify: `examples/demLayer/dem-virtual-raster.ts`
- Modify: `examples/demLayer/README.md`
- Modify: `tests/examples-structure.test.js`
- Modify: `tests/workspace-layout.test.js`
- Modify: `docs/decisions/ADR-067-geo-view-field-tile-spatial-profile.md`
- Create: `docs/decisions/ADR-069-geo-executable-field-runtime.md`
- Modify: `docs/review/scratch-dem-layer-migration-audit.md`

**Interfaces:**
- Leaves one thin example path through public APIs with no compatibility wrapper.

- [ ] Remove stale imports, old files, duplicated helpers, and DEM-named generic
  implementation symbols.
- [ ] Keep source, Worker task, cache choice, controls, shader, and short render loop.
- [ ] Update architecture docs with exact final ownership and limitations.
- [ ] Run dead-code searches and assert the removed implementation names do not
  remain outside historical docs.

### Task 8: Full Verification

**Files:**
- Modify only files required by failures attributable to this migration.

**Interfaces:**
- Produces reproducible unit, type, build, and browser evidence.

- [ ] Run `npm test` and require zero failures.
- [ ] Run `npm run typecheck` and require zero failures.
- [ ] Run `npm run build` and require zero failures.
- [ ] Start the tile server and Vite server on unused local ports.
- [ ] Run the existing DEM browser proofs for shaded terrain, wireframe, pitched
  distance LoD, camera movement, resize, cache modes, and disposal.
- [ ] Inspect the final diff, line counts, public exports, and Git status; report
  any residual limitation without weakening the clean cut.
