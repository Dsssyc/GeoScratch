# DEM Render-Patch LoD Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep DEM raster residency bounded by the source `z10` ceiling while allowing the GPU terrain mesh to continue refining through `z14`, restoring camera-zoom-dependent geometric smoothing without inventing unavailable raster detail.

**Architecture:** Preserve `GpuTileFrontier` as the data-page and residency authority. Add an example-owned GPU render-patch stage that expands each visible resident data page into bounded descendant render patches, culls those patches against the current frustum, writes explicit render-patch descriptors, and produces LoD-map and terrain indirect draw arguments. The LoD map records both geometry level and sampling level so mesh stitching and cross-patch height sampling remain correct when geometry is finer than its backing raster page.

**Tech Stack:** TypeScript, WGSL, Scratch `GPURuntime`, compute pipelines, storage buffers, indirect draw, Mocha/Chai, Playwright with real Chrome WebGPU.

## Global Constraints

- Data-page requests, residency, cache keys, and virtual-raster sampling remain within manifest levels `z4..z10`.
- Geometry refinement is an independent render-patch policy and reaches the legacy-equivalent ceiling `z14`.
- Render patches are GPU-generated from the bounded resident page frontier; no CPU quadtree traversal or per-frame readback is introduced.
- One source page may emit at most `4^4 = 256` render patches, keeping expansion bounded.
- Render-patch identity is `(matrixLevel, tileRow, tileCol)`; backing data identity remains explicit and separate.
- Mesh edge snapping follows geometry level. Shared-edge height sampling follows the coarser of the two explicit sampling levels.
- LoD-map and terrain draws consume GPU-produced indirect arguments from the render-patch stage.
- Every GPU resource, pipeline, bind set, pass, and command remains persistent across frames and resize.
- Wireframe color follows render-patch identity so zoom-dependent mesh subdivision is directly observable.
- Preserve the user-owned `AGENTS.md` working-tree change and do not stage it.

---

### Task 1: Lock The Independent LoD Contract

**Files:**
- Modify: `tests/scratch-dem-layer-clean-cut.test.js`
- Create: `tests/dem-render-patch-frontier.test.js`

- [x] Add RED assertions for a `render-patch-compute` stage, `z10` data ceiling, `z14` render ceiling, four-level bounded expansion, explicit render/sampling fields, and GPU-produced indirect arguments.
- [x] Add pure policy tests proving zooms `10..14` continue to increase render level without increasing requested sampling level.
- [x] Run focused tests and record the expected failure before implementation.

### Task 2: Add The Persistent GPU Render-Patch Frontier

**Files:**
- Create: `examples/demLayer/dem-render-patch-frontier.ts`
- Create: `examples/demLayer/shaders/render-patch-frontier.wgsl`
- Modify: `examples/demLayer/dem-layer.ts`

- [x] Define a typed `DemRenderPatch` storage ABI and a compact render-patch policy uniform.
- [x] Create parity output buffers, counters, draw arguments, bind sets, shader modules, compute pipelines, pass, and dispatch commands once during graph construction.
- [x] Reset, expand/cull, and finalize each parity entirely on GPU after the data frontier and before render passes.
- [x] Use the current map metadata and fixed-coordinate camera representation for frustum culling.
- [x] Publish stable identity, capacity, stage activity, provenance, and contract facts.

### Task 3: Make Stitching Respect Geometry And Sampling LoD Separately

**Files:**
- Modify: `examples/demLayer/shaders/lod-map.wgsl`
- Modify: `examples/demLayer/shaders/terrain-mesh.wgsl`
- Modify: `examples/demLayer/dem-layer.ts`

- [x] Bind render-patch descriptors instead of data-frontier visible instances.
- [x] Encode render matrix level in LoD-map red and sampling level in green.
- [x] Keep edge vertex snapping based on neighboring render matrix levels.
- [x] Select shared-edge height sampling from explicit neighboring sampling levels, independent of geometry-level delta.
- [x] Keep virtual-raster sampling world-coordinate based and capped by the source level count.

### Task 4: Expose Diagnostics And Browser-Prove The Fix

**Files:**
- Modify: `examples/demLayer/main.ts`
- Modify: `tests/browser/dem-tile-wireframe.mjs`
- Modify: `docs/review/scratch-dem-layer-migration-audit.md`
- Create: `docs/decisions/ADR-063-dem-render-patch-lod-decoupling.md`

- [x] Expose separate data-frontier level facts and render-patch target/capacity facts through the example dataset without adding a per-frame count readback.
- [x] In real Chrome/WebGPU, hold the raster ceiling at `z10`, visit zooms `10`, `11`, `12`, and `14`, and prove render-patch levels continue increasing.
- [x] Prove no tile request above `z10`, indirect draws remain active, and wireframe pixels change as patches refine.
- [x] Record the ownership and LoD-separation decision in the ADR and migration audit.

### Task 5: Close The Regression Gate

- [x] Run focused unit tests.
- [x] Run `npm run typecheck` and `npm run build`.
- [x] Run the DEM wireframe browser regression with the integrated zoom proof.
- [x] Run the complete test suite.
- [x] Review the final diff, confirm only `AGENTS.md` remains unrelated, and commit the verified implementation without pushing.
