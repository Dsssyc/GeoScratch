# DEM GPU-Normalized Render-Patch Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound DEM terrain geometry with a GPU-selected, pitch-aware complete quadtree cut while preserving independent Virtual Raster data-page LoD.

**Architecture:** Extend the shared GPU camera metadata with explicit pitch, count a fixed set of complete render-patch cuts on the GPU, choose the finest cut inside a viewport-derived budget, and emit it indirectly. Correct the DEM data-frontier metric to represent one raster texel rather than one render-mesh cell.

**Tech Stack:** TypeScript, WGSL, WebGPU compute and indirect draw, Mocha/Chai, Vite browser examples.

## Global Constraints

- Keep Scratch free of tile, terrain, camera-policy, and DEM concepts.
- Keep Worker, cache, Virtual Raster residency, data-page LoD, and render-patch LoD as separate authorities.
- Do not add CPU traversal, GPU count readback control, a legacy path, or per-frame GPU objects.
- Never truncate an emitted frontier; selection must produce a complete prefix-free cut.
- Preserve the user's existing `AGENTS.md` worktree change without staging it.

---

### Task 1: Lock Budget and Camera Contracts

**Files:**
- Modify: `tests/dem-render-patch-frontier.test.js`
- Modify: `tests/geo-gpu-tile-frontier.test.js`
- Modify: `tests/scratch-dem-layer-clean-cut.test.js`

**Interfaces:**
- Consumes: existing projected-grid helpers and `GpuTileFrontierView` fixtures.
- Produces: executable expectations for `demRenderPatchFrameBudget`, `demRenderPatchSelectBudgetBias`, the 144-byte pitch-bearing map layout, and GPU count/select dispatch ordering.

- [x] **Step 1: Add failing unit tests for budget interpolation and bias selection**

```js
expect(demRenderPatchFrameBudget({
    viewport: [1024, 768],
    cameraPitchRadians: 0,
})).to.deep.include({ baselinePatchBudget: 9, framePatchBudget: 9 })
expect(demRenderPatchSelectBudgetBias([80, 52, 27, 8], 30, 0)).to.equal(2)
```

- [x] **Step 2: Add failing layout and clean-cut integration assertions**

```js
expect(gpuTileFrontierLayouts.mapMeta.fieldOffsets.cameraPitchRadians).to.equal(140)
expect(renderPatchShader).to.include('countRenderPatchTrials')
expect(renderPatchShader).to.include('selectRenderPatchBudget')
```

- [x] **Step 3: Run focused tests and confirm RED**

Run: `npm test -- --grep "DEM render-patch frontier|one LayoutCodec-derived|separates the bounded data frontier"`

Expected: failures name the missing budget helpers, pitch field, and GPU kernels.

### Task 2: Add Explicit Camera Pitch Metadata

**Files:**
- Modify: `packages/geoscratch/src/geo/gpu-tile-frontier-layout.ts`
- Modify: `packages/geoscratch/src/geo/gpu-tile-frontier.ts`
- Modify: `packages/geoscratch/src/geo/gpu-tile-frontier-reference.ts`
- Modify: `examples/demLayer/dem-layer.ts`
- Modify: affected test and browser view fixtures under `tests/`

**Interfaces:**
- Consumes: `DemCameraState.pitchDegrees`.
- Produces: required `GpuTileFrontierView.cameraPitchRadians: number` and WGSL `mapMeta.cameraPitchRadians` at byte offset 140.

- [x] **Step 1: Extend the TypeScript view and LayoutCodec**

```ts
cameraPitchRadians: number
```

- [x] **Step 2: Validate pitch in `[0, Math.PI / 2]` and pack it into map metadata**

```ts
cameraPitchRadians: camera.pitchDegrees * Math.PI / 180
```

- [x] **Step 3: Update deterministic reference keys and fixtures**

All view constructors must supply pitch explicitly; zero is the top-down default.

- [x] **Step 4: Run Geo frontier tests**

Run: `npm test -- --grep "GPU tile frontier|LayoutCodec-derived"`

Expected: PASS.

### Task 3: Implement GPU-Normalized Complete-Cut Selection

**Files:**
- Modify: `examples/demLayer/dem-render-patch-frontier.ts`
- Modify: `examples/demLayer/shaders/render-patch-frontier.wgsl`
- Modify: `examples/demLayer/dem-layer.ts`
- Modify: `examples/demLayer/main.ts`

**Interfaces:**
- Consumes: source visible instances, source indirect count, viewport, camera pitch, and the existing maximum four-level candidate tree.
- Produces: persistent `count`, `select`, `expand`, and `finalize` commands plus diagnostic budget facts.

- [x] **Step 1: Implement CPU oracle helpers used by tests**

```ts
demRenderPatchFrameBudget(input): {
    baselinePatchBudget: number
    framePatchBudget: number
}
demRenderPatchSelectBudgetBias(counts, budget, previousBiasStep): number
```

- [x] **Step 2: Expand policy and state contracts**

Add a maximum count ratio of `3`, 17 quarter-level trial counters, selected bias,
requested count, source-floor count, and baseline/frame budgets.

- [x] **Step 3: Replace vertical AABB area with two horizontal elevation-plane footprints**

The projected-grid function returns the larger valid footprint and treats near-plane
intersection conservatively.

- [x] **Step 4: Add the count and selection kernels**

`countRenderPatchTrials` evaluates every threshold using one precomputed branch path.
`selectRenderPatchBudget` chooses the finest in-budget trial and applies bounded
hysteresis. `expandRenderPatches` emits only the selected complete cut.

- [x] **Step 5: Insert persistent commands in GPU order**

```text
reset -> count -> select -> expand -> finalize
```

- [x] **Step 6: Decode and publish the extended diagnostic state**

The browser dataset must expose requested count, source-floor count, both budgets,
selected bias, and budget-limited status.

- [x] **Step 7: Run focused render-patch and clean-cut tests**

Run: `npm test -- --grep "DEM render-patch frontier|separates the bounded data frontier"`

Expected: PASS.

### Task 4: Correct Raster Data-Page LoD and Verify End to End

**Files:**
- Modify: `examples/demLayer/dem-layer.ts`
- Modify: `examples/demLayer/README.md`
- Create: `docs/decisions/ADR-066-dem-gpu-normalized-render-patch-budget.md`
- Modify: `tests/browser/scratch-dem-layer.mjs`

**Interfaces:**
- Consumes: OGC WebMercatorQuad `cellSize` and GPU diagnostic facts.
- Produces: mesh-independent source-page LoD and reproducible top-down/pitched browser gates.

- [x] **Step 1: Change the DEM data metric to one raster texel**

```ts
geometricErrorMeters: matrix.cellSize
```

- [x] **Step 2: Add browser assertions for budget consistency**

Selected count must be within the frame budget unless the reported source-floor count
itself exceeds that budget. Descriptor and lookup overflow remain zero.

- [x] **Step 3: Run all automated verification**

Run: `npm test`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [x] **Step 4: Run real WebGPU scenarios**

Run the existing browser harness at top-down and high-pitch poses for zoom 10 and 14.
Record source count, requested render count, selected render count, budget, selected
bias, level range, overflow counters, and screenshot evidence.

- [x] **Step 5: Record the accepted implementation and commit**

The ADR must describe the measured GPU normalization, source-floor behavior, and
verification evidence. Stage only files owned by this change and commit with an
imperative subject.
