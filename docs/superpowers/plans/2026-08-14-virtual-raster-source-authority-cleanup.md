# Virtual Raster Source Authority Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Virtual Raster executor ownership explicit, remove the disconnected legacy source API, and reduce the DEM adapter to one validated immutable source authority without moving DEM, COG, PNG, HTTP, cache-policy, or presentation semantics into Geo.

**Architecture:** `VirtualRasterRuntime` accepts an explicit owned or borrowed request-executor binding. Geo owns scheduler shutdown and, only for an owned binding, executor disposal after scheduler settlement; initialization failure follows the same authority. The DEM example validates its manifest once, creates one immutable source adapter, and separately exposes source/worker proof facts rather than changing the generic runtime fact shape.

**Tech Stack:** TypeScript, WebGPU, Mocha/Chai, Vite, Playwright/Chrome, generated bilingual API documentation.

## Global Constraints

- Scratch remains independent of Geo, tiles, virtual rasters, DEM, COG, HTTP, and cache policy.
- Geo does not infer executor ownership and does not hide application-owned Worker or Cache authorities.
- The DEM normal path remains OGC `WebMercatorQuad`, Worker-decoded raw `uint8`, and a finite GPU atlas.
- No compatibility alias or second source/runtime path is retained during `0.x.x`.
- Public API changes update English canonical docs, Chinese translation, generated references, and topology/type tests.
- Every behavior change begins with a focused failing test and ends with a verified commit.

---

### Task 1: Explicit Virtual Raster Executor Authority

**Files:**
- Modify: `packages/geoscratch/src/geo/virtual-raster-runtime.ts`
- Modify: `tests/geo-virtual-raster-runtime.test.js`
- Modify: `tests/types/public-api.ts`
- Modify: `docs/api/geo/virtual-raster.md`
- Modify: `docs/api/geo/virtual-raster_zh.md`
- Create: `docs/decisions/ADR-073-virtual-raster-executor-authority.md`

**Interfaces:**
- Consumes: `VirtualRasterRequestExecutor` and its optional asynchronous `dispose()` capability.
- Produces: `VirtualRasterExecutorBinding`, an explicit `owned` or `borrowed` descriptor consumed by `VirtualRasterRuntimeDescriptor.executor`.

- [ ] **Step 1: Write failing ownership tests**

Add tests proving that borrowed executors are never disposed, owned executors are disposed exactly once after active request settlement, owned executor disposal failures join runtime disposal failures, and initialization failure disposes only owned executors.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm --workspace geoscratch run build && npx mocha tests/geo-virtual-raster-runtime.test.js`

Expected: failures because the descriptor still accepts a bare executor and runtime does not own executor disposal.

- [ ] **Step 3: Implement explicit authority**

Use the clean-cut descriptor shape:

```ts
export type VirtualRasterExecutorBinding =
    | Readonly<{ ownership: 'borrowed'; executor: VirtualRasterRequestExecutor }>
    | Readonly<{ ownership: 'owned'; executor: VirtualRasterRequestExecutor & Readonly<{
        dispose(): Promise<void>
    }> }>
```

Normalize no implicit form. Stop the scheduler before disposing an owned executor, aggregate independent disposal failures, and preserve idempotence.

- [ ] **Step 4: Verify GREEN and public types**

Run: `npm --workspace geoscratch run build && npx mocha tests/geo-virtual-raster-runtime.test.js`
Run: `npm run typecheck`

- [ ] **Step 5: Update bilingual semantics and ADR, then commit**

Document exact borrowed/owned creation, failure rollback, shutdown order, and non-ownership of Cache or WorkerSystem outside the supplied executor.

Commit: `Make Virtual Raster executor authority explicit`

### Task 2: Delete The Disconnected Source API

**Files:**
- Modify: `packages/geoscratch/src/geo/virtual-raster.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `tests/scratch-foundation-public-topology.test.js`
- Modify: `tests/types/public-api.ts`
- Modify: `docs/api/geo/virtual-raster.md`
- Modify: `docs/api/geo/virtual-raster_zh.md`

**Interfaces:**
- Removes: `VirtualRasterSource`, `VirtualRasterSourceDescriptor`, `VirtualRasterSourceLoadContext`, and `virtualRasterSource()`.
- Retains: `VirtualRasterRequestExecutor` as the sole executable asynchronous page-source boundary used by scheduling and runtime composition.

- [ ] **Step 1: Change topology/type tests and verify RED**

Require all four disconnected symbols to be absent from public Geo exports and generated facts.

Run: `npm --workspace geoscratch run build && npx mocha tests/scratch-foundation-public-topology.test.js`

- [ ] **Step 2: Remove the unused source declarations, factory, and exports**

Do not add an alias or adapter. Update the canonical docs to call `VirtualRasterRequestExecutor` the executable source boundary.

- [ ] **Step 3: Verify focused tests and commit**

Run: `npm --workspace geoscratch run build && npx mocha tests/scratch-foundation-public-topology.test.js tests/geo-virtual-raster.test.js`

Commit: `Remove disconnected Virtual Raster source API`

### Task 3: One Immutable DEM Source Authority

**Files:**
- Rename: `examples/demLayer/dem-virtual-raster.ts` to `examples/demLayer/dem-source.ts`
- Modify: `examples/demLayer/main.ts`
- Modify: `tests/geo-virtual-raster-dem.test.js`
- Modify: `tests/scratch-dem-layer-clean-cut.test.js`
- Modify: `tests/assets-layout.test.js`
- Modify: `tests/browser/support/dem-layer-proof.ts`

**Interfaces:**
- Produces: `DemTileSource`, created only by manifest validation, containing the immutable manifest, WebMercator model, stable tile URL mapping, and source facts.
- Produces: a small `createDemVirtualRaster()` adapter returning generic `VirtualRasterRuntime` plus separately inspectable DEM worker/source facts.

- [ ] **Step 1: Add failing source-authority tests**

Prove one parser invocation establishes the immutable source used by model construction, tile URL generation, cache coherence, and executor creation. Prove tile URL generation performs no validation or clone per page. Prove generic runtime facts remain generic.

- [ ] **Step 2: Verify RED**

Run: `npm --workspace geoscratch run build && npx mocha tests/geo-virtual-raster-dem.test.js tests/scratch-dem-layer-clean-cut.test.js tests/assets-layout.test.js`

- [ ] **Step 3: Implement the source adapter and update imports**

Keep exact DEM manifest/schema validation and URL semantics in the example. Remove raw/validated manifest dual use, the custom runtime `inspect()` override, duplicated stopped state, and manual executor cleanup now owned by Geo.

- [ ] **Step 4: Keep proof facts separate**

Pass a source/executor facts reader to the browser proof binding instead of casting `VirtualRasterRuntimeFacts` to a DEM-extended shape.

- [ ] **Step 5: Verify focused behavior and commit**

Run: `npm --workspace geoscratch run build && npx mocha tests/geo-virtual-raster-dem.test.js tests/scratch-dem-layer-clean-cut.test.js tests/assets-layout.test.js`

Commit: `Consolidate DEM Virtual Raster source authority`

### Task 4: Full Documentation And Runtime Gates

**Files:**
- Regenerate: `docs/api/reference/*`
- Update: active Virtual Raster audits when ownership/source facts change

**Interfaces:**
- Consumes: final public TypeScript entrypoints and DEM browser path.
- Produces: current bilingual API facts and executable regression evidence.

- [ ] **Step 1: Regenerate and validate API documentation**

Run: `npm run docs:generate`
Run: `npm run docs:translations`
Run: `npm run docs:check`

- [ ] **Step 2: Run complete static and Node gates**

Run: `npm run typecheck`
Run: `npm test`
Run: `npm run build`
Run: `git diff --check`

- [ ] **Step 3: Run real browser DEM proof**

Start the documented Vite and tile-server commands, load `/demLayer/` in isolated Chrome with WebGPU, wait for `#GPUFrame[data-status="ready"]`, and require zero Vite overlays, console errors, page errors, pending native observations, and terminal ownership residue.

- [ ] **Step 4: Review final diff and commit**

Confirm no DEM/COG/PNG/HTTP semantics entered Geo, no old source symbols remain, no compatibility path exists, and the worktree contains only intended changes.

Commit: `Verify Virtual Raster source authority cleanup`
