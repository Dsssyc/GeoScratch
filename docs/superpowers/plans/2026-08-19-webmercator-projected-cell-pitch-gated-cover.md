# WebMercatorQuad Pitch-Gated Projected-Cell Cover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the fixed two-tile LoD field with a 60-degree pitch-gated, GPU projected-cell cover that is uniform over the complete low-pitch viewport and variable by local projective scale at high pitch.

**Architecture:** Keep the single direct `GpuWebMercatorQuadCover` authority and passive Virtual Raster boundary. Add explicit projected-cell policy, restore the rotation-invariant Jacobian inside the cover kernel, derive bounded direct windows from view facts, and expose selection mode and cell-span evidence without restoring roots or trial cuts.

**Tech Stack:** TypeScript, WGSL, WebGPU, Scratch persistent commands, Mocha/Chai, Vite, Playwright/Chrome, generated bilingual API docs.

## Global Constraints

- Standard identities remain OGC `WebMercatorQuad` matrix/row/column values.
- Pitch `< threshold` is uniform; pitch `>= threshold` is variable. Default threshold is exactly 60 degrees.
- `VITE_UNDERWATER_TERRAIN_VARIABLE_LOD_PITCH_DEGREES` is example composition only; Geo never reads environment state.
- No root traversal, trial cuts, previous topology, atlas-driven geometry, CPU tile list, or compatibility selector.
- Virtual Raster remains passive; source ceiling cannot coarsen geometry.
- English API docs are canonical and Chinese pages are reviewed translations.

---

### Task 1: Lock Public Policy and RED Reference Behavior

**Files:**
- Modify: `tests/geo-webmercator-quad-cover.test.js`
- Modify: `tests/types/public-api.ts`
- Modify: `tests/scratch-underwater-terrain-clean-cut.test.js`

**Interfaces:**
- Consumes: existing `gpuWebMercatorQuadCoverPolicy()` and CPU reference evaluator.
- Produces: required policy fields `cellsPerPatchEdge`, `maximumCellSpanPixels`, and `variableLodPitchThresholdRadians`; expected feedback field `selectionMode`.

- [x] Add policy tests accepting `Math.PI / 3`, rejecting values outside `[0, Math.PI / 2]`, and assigning pitch 60 exactly to variable mode.
- [x] Add a 1512 by 864, zoom 13.25, pitch-zero reference case whose visible patches must all share one geometry level.
- [x] Add a paired pitch-70 case asserting nearer equivalent coverage is not coarser than farther coverage and adjacency remains at most one.
- [x] Add public type fixtures containing the three explicit policy fields and selection evidence.
- [x] Run `npm run build --workspace geoscratch && npx mocha tests/geo-webmercator-quad-cover.test.js tests/scratch-underwater-terrain-clean-cut.test.js` and retain failures caused by the absent policy/behavior.

### Task 2: Normalize Policy, Layout, and Feedback

**Files:**
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover.ts`
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-layout.ts`
- Test: `tests/geo-webmercator-quad-cover.test.js`
- Test: `tests/types/public-api.ts`

**Interfaces:**
- Consumes: Task 1 policy fixtures.
- Produces:

```ts
type GpuWebMercatorQuadCoverPolicy = Readonly<{
    minimumMatrixLevel: number
    maximumMatrixLevel: number
    sourceMaximumMatrixLevel: number
    maximumPatches: number
    cellsPerPatchEdge: number
    maximumCellSpanPixels: number
    variableLodPitchThresholdRadians: number
}>
```

```ts
type GpuWebMercatorQuadCoverSelectionFacts = Readonly<{
    selectionMode: 'uniform' | 'variable'
    minimumCellSpanPixels?: number
    maximumCellSpanPixels?: number
    // existing facts remain
}>
```

- [x] Extend validation with positive-safe-integer cells, positive finite pixel span, and finite threshold in `[0, PI / 2]`.
- [x] Pack policy values into the uniform codec and add state words for mode plus Q8 minimum/maximum projected span.
- [x] Decode mode `0` as `uniform`, mode `1` as `variable`, reject every other value, and omit span facts only for an empty cover.
- [x] Update TSDoc on the policy factory and feedback types.
- [x] Run the focused tests until policy/layout/type cases pass, then commit `Define projected-cell WebMercator cover policy`.

### Task 3: Implement CPU Oracle Before WGSL

**Files:**
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-reference.ts`
- Test: `tests/geo-webmercator-quad-cover.test.js`

**Interfaces:**
- Consumes: normalized policy from Task 2 and existing `GeoViewSnapshot` projection facts.
- Produces: deterministic uniform and variable reference cuts plus selection/cell-span facts.

- [x] Port homogeneous polygon clipping and the ADR-077 determinant metric into pure reference helpers.
- [x] Implement conservative four-corner viewport footprint bounds for both elevation planes.
- [x] In uniform mode, test levels coarse-to-fine and choose the first complete visible level below the pixel threshold.
- [x] In variable mode, derive a focal-length search radius, probe standard parent candidates per level, and build nested child windows only from parents exceeding the metric.
- [x] Preserve final visibility, prefix freedom, deterministic sorting, demand lowering, and hard capacity errors.
- [x] Run the focused reference tests until wide-screen uniformity, exact boundary ownership, near/far order, and zoom monotonicity pass, then commit `Model pitch-gated WebMercator projected LoD`.

### Task 4: Lower the Same Model to WGSL

**Files:**
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-wgsl.ts`
- Modify: `tests/scratch-underwater-terrain-clean-cut.test.js`
- Test: `tests/geo-webmercator-quad-cover.test.js`

**Interfaces:**
- Consumes: Task 3 oracle and Task 2 layouts.
- Produces: one persistent GPU dispatch with the same uniform/variable cut.

- [x] Replace `COVER_DISTANCE_BAND_RADIUS_TILES` and `coverPitchLevelBoost()` with projected-cell policy helpers.
- [x] Port clip-plane polygon clipping, perspective derivatives, determinant span, and camera-plane guard from the accepted ADR-077 implementation.
- [x] Implement direct uniform footprint level testing below the threshold.
- [x] Implement per-level direct parent probing and nested variable refinement windows at or above the threshold.
- [x] Keep final frustum rejection, prefix-free emission, 2:1 closure, lookup, demand, and indirect argument stages unchanged.
- [x] Record selection mode and emitted cell-span Q8 extrema in state.
- [x] Add structural gates rejecting the fixed-radius constant, root/trial vocabulary, and a second selector.
- [x] Run focused tests and `npm run typecheck`, then commit `Select WebMercator LoD from projected cells`.

### Task 5: Compose the 60-Degree Default and Environment Override

**Files:**
- Modify: `packages/geoscratch/src/geo/web-mercator-terrain-renderer.ts`
- Modify: `examples/underwaterTerrain/application.ts`
- Modify: `examples/underwaterTerrain/main.ts`
- Modify: `examples/underwaterTerrain/README.md`
- Modify: `tests/scratch-underwater-terrain-clean-cut.test.js`
- Modify: `tests/browser/underwater-terrain-tile-wireframe.mjs`

**Interfaces:**
- Consumes: `variableLodPitchThresholdRadians` from Task 2.
- Produces: optional renderer descriptor override and the Vite environment variable.

- [x] Add `variableLodPitchThresholdRadians?: number` to the terrain renderer descriptor and normalize missing input to `Math.PI / 3`.
- [x] Pass `cellsPerPatchEdge: 64`, `maximumCellSpanPixels: 8`, and the normalized threshold into the cover policy.
- [x] Parse `VITE_UNDERWATER_TERRAIN_VARIABLE_LOD_PITCH_DEGREES` in example composition; blank means 60 and invalid values fail before application startup.
- [x] Expose the normalized policy through the existing graph contract and document the variable in the example README.
- [x] Set the variable to 55 in one managed Vite proof and assert the graph contract contains `55 * PI / 180`; keep the default proof at 60.
- [x] Run focused structure/type tests and commit `Configure terrain variable LoD pitch`.

### Task 6: Add Wide-Screen and Boundary Chrome Gates

**Files:**
- Modify: `tests/browser/underwater-terrain-tile-wireframe.mjs`
- Modify: `tests/browser/scratch-underwater-terrain.mjs`

**Interfaces:**
- Consumes: browser proof API and selection feedback.
- Produces: visual/runtime proof for uniform and variable modes.

- [x] Parameterize the wireframe proof viewport and run settled 1280 by 800 plus 1512 by 864 scenarios.
- [x] At zoom 13.25 and pitches 0 and 59.9, assert `selectionMode === 'uniform'` and `minimumMatrixLevel === maximumMatrixLevel`.
- [x] At pitches 60 and 70, assert `selectionMode === 'variable'`, adjacency at most one, no overflow, and bounded density.
- [x] Capture wide top-down and high-pitch canvases and require nonblank multicolor pixels without a fixed center-only level island.
- [x] Preserve 90-frame shaded/wireframe construction, observation, lag, stale-transition, and in-flight gates.
- [x] Run the managed browser proof and commit `Prove pitch-gated terrain cover in Chrome`.

### Task 7: Update Current API and Complete Gates

**Files:**
- Modify: `docs/api/geo/view-cover.md`
- Modify: `docs/api/geo/view-cover_zh.md`
- Modify: `docs/api/geo/terrain-rendering.md`
- Modify: `docs/api/geo/terrain-rendering_zh.md`
- Modify: `docs/decisions/ADR-083-webmercator-inverse-cover-passive-virtual-raster.md`
- Modify: `AGENTS.md`
- Generated: `docs/api/reference/geo.md`
- Generated: `docs/api/reference/geo-api.json`
- Generated: `docs/api/reference/api-docs.json`

**Interfaces:**
- Consumes: final normalized source and browser facts.
- Produces: canonical bilingual current API and generated declarations.

- [x] Replace constant 36-candidate wording with viewport-bounded projected-cell selection and document exact pitch-boundary ownership.
- [x] Document policy fields, selection feedback, renderer default, application env boundary, failure modes, and Virtual Raster non-ownership in English and Chinese.
- [x] Amend ADR-083 with the accepted projected-cell correction while preserving historical supersession facts.
- [x] Update AGENTS.md mandatory gates for wide top-down uniformity and 60-degree ownership.
- [x] Run `npm run docs:generate`, review generated diffs, run `npm run docs:translations`, then `npm run docs:check`.
- [x] Run `npm run typecheck`, `npm test`, `npm run build`, managed Chrome wireframe, lifecycle, streaming, cache, and 90-frame performance gates.
- [x] Run `git diff --check`, inspect status and commits, then commit `Document projected-cell WebMercator cover`.
