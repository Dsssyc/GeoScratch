# Reference-Pixel Terrain LoD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Completed checkbox (`- [x]`) state is retained as execution evidence.

**Status:** Completed and verified on 2026-08-22. The implementation landed as the
bounded commits `5d3e7ee` through `4f0298b`; all steps below are retained as execution
history rather than future work.

**Goal:** Make WebMercator terrain geometry and raster demand invariant under DPR while adopting a 512-reference-pixel, 128-cell terrain mesh and immutable per-tile elevation bounds.

**Architecture:** `GeoViewSnapshot.referenceViewport` owns logical camera/LoD pixels and `GeoViewSourceCapture.presentationSize` owns physical attachments. The existing GPU inverse cover remains the only geometry authority, but receives reference-pixel quality facts, a numerical tolerance, and an immutable dense elevation-bound hierarchy. Virtual Raster remains a passive consumer of unchanged standard-page demand.

**Tech Stack:** TypeScript ESM, WGSL compute/render shaders, WebGPU Scratch API, Mocha/Chai, Playwright Chrome WebGPU proofs, Python/FastAPI/rio-tiler COG tile server, bilingual generated API documentation.

## Global Constraints

- Work on `dev-feature`; do not introduce compatibility aliases for renamed 0.x APIs.
- Keep standard OGC `WebMercatorQuad` identities, direct inverse construction, prefix-free output, and edge-adjacent level delta at most one.
- Keep Virtual Raster, cache, Worker, residency, and atlas contents out of geometry-LoD authority.
- Use 512 reference pixels, 128 cells per terrain patch, eight reference pixels per cell, 0.005 refinement tolerance, and an exact 60-degree variable-mode boundary.
- Update canonical English API docs, reviewed Chinese translations, ADRs, generated reference facts, and agent-visible repository guidance.
- Remove obsolete fields, constants, tests, prose, and dependencies after their replacements pass.

---

### Task 1: Commit the accepted pixel-domain decision

**Files:**
- Create: `docs/decisions/ADR-084-reference-pixel-terrain-lod.md`
- Create: `docs/superpowers/specs/2026-08-22-reference-pixel-terrain-lod-design.md`

**Interfaces:**
- Consumes: ADR-080 view-source composition and ADR-083 inverse-cover authority.
- Produces: exact naming, policy constants, elevation hierarchy, cleanup, and acceptance constraints for all later tasks.

- [x] **Step 1: Self-review the spec and ADR**

Run:

```bash
rg -n 'TBD|TODO|implement later|fill in|compatibility alias' \
  docs/decisions/ADR-084-reference-pixel-terrain-lod.md \
  docs/superpowers/specs/2026-08-22-reference-pixel-terrain-lod-design.md
```

Expected: no placeholder; only the explicit statement that compatibility aliases are absent.

- [x] **Step 2: Check formatting and commit**

```bash
git diff --check
git add docs/decisions/ADR-084-reference-pixel-terrain-lod.md \
  docs/superpowers/specs/2026-08-22-reference-pixel-terrain-lod-design.md
git commit -m "Define reference-pixel terrain LoD"
```

### Task 2: Separate logical view pixels from physical presentation size

**Files:**
- Modify: `packages/geoscratch/src/geo/geo-view.ts`
- Modify: `packages/geoscratch/src/geo/maplibre-planar-view.ts`
- Modify: `packages/geoscratch/src/geo/web-mercator-terrain-renderer.ts`
- Modify: `examples/underwaterTerrain/application.ts`
- Modify: `tests/geo-planar-view-stability.test.js`
- Modify: `tests/geo-view-demand.test.js`
- Modify: `tests/types/public-api.ts`
- Modify: structural tests matching old names.

**Interfaces:**
- Produces: `GeoViewSnapshot.referenceViewport`, `GeoViewSourceCapture.presentationSize`, and `MapLibrePlanarViewSourceDescriptor.presentationSize()`.
- Consumes: `map.transform.width/height` as MapLibre reference pixels and application canvas backing size as presentation pixels.

- [x] **Step 1: Write failing source-separation tests**

Add a MapLibre source case where transform size is 1280 by 800 and presentation size is 2560 by 1600. Assert:

```js
expect(captured.view.referenceViewport).to.deep.equal([1280, 800])
expect(captured.presentationSize).to.deep.equal({width: 2560, height: 1600})
expect(captured).not.to.have.property('size')
expect(captured.view).not.to.have.property('viewport')
```

- [x] **Step 2: Verify RED**

```bash
npm --workspace geoscratch run build
npx mocha tests/geo-planar-view-stability.test.js tests/geo-view-demand.test.js
```

Expected: failures for missing clean-cut fields.

- [x] **Step 3: Implement the clean cut**

Rename public types and validation to the approved fields. In `mapLibrePlanarViewSource.capture()` read:

```ts
const presentationSize = readPresentationSize()
const referenceViewport = {
    width: map.transform.width,
    height: map.transform.height,
}
return {
    view: adapter.camera({ map, referenceViewport, minimumElevationMeters }),
    presentationSize,
}
```

The renderer resizes from `capture.presentationSize`; the cover map-meta upload reads `view.referenceViewport`.

- [x] **Step 4: Remove old names and verify GREEN**

```bash
rg -n 'GeoViewSourceCapture<.*size|captured\.size|descriptor\.viewport|view\.viewport' \
  packages/geoscratch/src/geo examples/underwaterTerrain tests
npm --workspace geoscratch run build
npx mocha tests/geo-planar-view-stability.test.js tests/geo-view-demand.test.js
npm run typecheck
```

Expected: no old Geo view/presentation names; focused tests and typecheck pass.

- [x] **Step 5: Commit**

```bash
git add packages/geoscratch/src/geo examples/underwaterTerrain/application.ts tests
git commit -m "Separate Geo view and presentation pixels"
```

### Task 3: Adopt reference-pixel projected quality and a 128-cell terrain mesh

**Files:**
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover.ts`
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-layout.ts`
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-wgsl.ts`
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-reference.ts`
- Modify: `packages/geoscratch/src/geo/web-mercator-terrain-renderer.ts`
- Modify: `packages/geoscratch/src/geo/web-mercator-terrain-wgsl.ts`
- Modify: `tests/geo-webmercator-quad-cover.test.js`
- Modify: cover structural/type tests.

**Interfaces:**
- Produces policy fields `referenceTileSizePixels`, `maximumCellSpanReferencePixels`, and `refinementTolerance` plus reference-pixel feedback names.
- Produces built-in terrain constants 512, 128, 8, and 0.005.

- [x] **Step 1: Write failing policy and uniform-level tests**

Assert policy validation, old-name absence, and top-down levels:

```js
expect(policy).to.include({
    referenceTileSizePixels: 512,
    cellsPerPatchEdge: 128,
    maximumCellSpanReferencePixels: 8,
    refinementTolerance: 0.005,
})
for (const zoom of [8, 9, 10, 11, 12, 13, 14]) {
    expect(resultAt(zoom).facts.minimumMatrixLevel).to.equal(zoom)
    expect(resultAt(zoom).facts.maximumMatrixLevel).to.equal(zoom)
}
```

- [x] **Step 2: Verify RED**

```bash
npm --workspace geoscratch run build
npx mocha tests/geo-webmercator-quad-cover.test.js
```

Expected: missing policy fields and old uniform levels.

- [x] **Step 3: Implement policy ABI and reference oracle**

Uniform mode uses:

```ts
const anchoredLevel = clamp(
    Math.floor(view.zoomHint + Math.log2(512 / policy.referenceTileSizePixels)),
    policy.minimumMatrixLevel,
    policy.maximumMatrixLevel
)
const effectiveThreshold = policy.maximumCellSpanReferencePixels *
    (1 + policy.refinementTolerance)
const adjustment = maximumSpan > effectiveThreshold
    ? Math.ceil(Math.log2(maximumSpan / effectiveThreshold))
    : 0
```

Mirror the same calculation in WGSL. Variable refinement compares against the same effective threshold.

- [x] **Step 4: Generate the 128-cell terrain mesh and remove 64-cell assumptions**

Set the built-in sector size to 128, derive capacity from
`cellsPerPatchEdge * maximumCellSpanReferencePixels`, and ensure all terrain WGSL receives the same value.

- [x] **Step 5: Verify GREEN and cleanup**

```bash
rg -n 'maximumCellSpanPixels|minimumCellSpanPixels|TERRAIN_SECTOR_SIZE = 64|\* 8' \
  packages/geoscratch/src/geo tests docs/api docs/decisions/ADR-084-reference-pixel-terrain-lod.md
npm --workspace geoscratch run build
npx mocha tests/geo-webmercator-quad-cover.test.js \
  tests/scratch-underwater-terrain-clean-cut.test.js
npm run typecheck
```

Expected: old API names and stale 64-cell assumptions are absent; tests pass.

- [x] **Step 6: Commit**

```bash
git add packages/geoscratch/src/geo tests
git commit -m "Align terrain cover with reference pixels"
```

### Task 4: Generate and validate immutable DEM elevation bounds

**Files:**
- Modify: `examples/underwaterTerrain/tile-server/src/geoscratch_dem_tiles/build.py`
- Modify: `examples/underwaterTerrain/tile-server/tests/test_build.py`
- Modify: `examples/underwaterTerrain/dem-source.ts`
- Modify: `tests/geo-virtual-raster-dem.test.js`
- Modify: DEM source structural tests.

**Interfaces:**
- Produces manifest schema 3 and complete `tileElevationBounds` records in unexaggerated meters.
- Produces `DemTileSource.elevationBounds` as an immutable validated array.

- [x] **Step 1: Write failing Python and TypeScript manifest tests**

Require one unique ordered bounds record for every tile in every declared limit, reject missing/duplicate/out-of-range records, and verify `minimumElevationMeters <= maximumElevationMeters`.

- [x] **Step 2: Verify RED**

```bash
examples/underwaterTerrain/tile-server/.venv/bin/python -m pytest \
  examples/underwaterTerrain/tile-server/tests/test_build.py -q
npm --workspace geoscratch run build
npx mocha tests/geo-virtual-raster-dem.test.js
```

Expected: schema/bounds assertions fail.

- [x] **Step 3: Generate bounds from valid COG pixels**

For every declared standard tile, read the COG tile mask, compute min/max valid encoded samples, convert through manifest scale/offset, sort by matrix/row/column, and write schema 3 with content-version suffix `cog-wmq-v4`.

- [x] **Step 4: Validate and snapshot bounds in the example source**

The parser proves exact coverage completeness before constructing `DemTileSource`. No partial fallback or mutable map remains.

- [x] **Step 5: Verify GREEN and commit**

```bash
examples/underwaterTerrain/tile-server/.venv/bin/python -m pytest \
  examples/underwaterTerrain/tile-server/tests -q
npm --workspace geoscratch run build
npx mocha tests/geo-virtual-raster-dem.test.js
git add examples/underwaterTerrain/tile-server examples/underwaterTerrain/dem-source.ts tests
git commit -m "Publish immutable terrain elevation bounds"
```

### Task 5: Lower immutable elevation bounds into the GPU cover

**Files:**
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-layout.ts`
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover.ts`
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-wgsl.ts`
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-reference.ts`
- Modify: `packages/geoscratch/src/geo/web-mercator-terrain-renderer.ts`
- Modify: `examples/underwaterTerrain/application.ts`
- Modify: `tests/geo-webmercator-quad-cover.test.js`
- Modify: browser proof support facts.

**Interfaces:**
- Produces public `WebMercatorTileElevationBounds` records accepted by cover and renderer descriptors.
- Produces cover facts `elevationBoundsMode: 'global' | 'hierarchy'` and `elevationBoundCount`.

- [x] **Step 1: Write failing hierarchy validation and selection tests**

Test complete exact metadata, partial rejection, source-ceiling ancestor resolution for z11-z14 geometry, global fallback, and a shallow tile that is no longer expanded by another tile's deep bound.

- [x] **Step 2: Verify RED**

```bash
npm --workspace geoscratch run build
npx mocha tests/geo-webmercator-quad-cover.test.js
```

- [x] **Step 3: Add the immutable dense GPU buffer**

Add one codec for `{minimumElevationMeters, maximumElevationMeters}`, one offset in each coverage-limit record, one read-only binding, initialization upload, ownership facts, and command read dependencies. Geometry above the source ceiling indexes the source-ceiling ancestor.

- [x] **Step 4: Use one exact/global patch-bound resolver**

Replace direct global-z construction in `coverPatchBounds()` and the CPU oracle with a shared conceptual rule. Scale hierarchy values by renderer exaggeration before cover creation.

- [x] **Step 5: Verify GREEN, lifecycle, and cleanup**

```bash
npm --workspace geoscratch run build
npx mocha tests/geo-webmercator-quad-cover.test.js \
  tests/geo-virtual-raster-dem.test.js \
  tests/scratch-underwater-terrain-clean-cut.test.js
npm run typecheck
```

Expected: hierarchy and fallback tests pass; no orphan buffer, bind entry, or global-only helper remains.

- [x] **Step 6: Commit**

```bash
git add packages/geoscratch/src/geo examples/underwaterTerrain tests
git commit -m "Use static elevation bounds in terrain cover"
```

### Task 6: Update bilingual API contracts and remove superseded prose

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/api/geo/views-frames.md`
- Modify: `docs/api/geo/views-frames_zh.md`
- Modify: `docs/api/geo/view-cover.md`
- Modify: `docs/api/geo/view-cover_zh.md`
- Modify: `docs/api/geo/terrain-rendering.md`
- Modify: `docs/api/geo/terrain-rendering_zh.md`
- Modify: `examples/underwaterTerrain/README.md`
- Modify: superseded design/plan status text where current claims conflict.
- Generate: `docs/api/reference/*`

**Interfaces:**
- Documents the exact current public contract and clean-cut names.

- [x] **Step 1: Rewrite canonical English and Chinese semantic pages**

Document reference/presentation pixels, fixed page identity across DPR, 512/128 quality, tolerance, immutable hierarchy/fallback, and picking conversion boundaries.

- [x] **Step 2: Remove stale claims and regenerate facts**

```bash
rg -n 'density.*increase.*geometry|64 cells|GeoViewSourceCapture.*size|viewport reader|maximumCellSpanPixels' \
  AGENTS.md docs/api examples/underwaterTerrain/README.md
npm run docs:generate
npm run docs:translations
npm run docs:check
```

- [x] **Step 3: Commit**

```bash
git add AGENTS.md docs examples/underwaterTerrain/README.md
git commit -m "Document reference-pixel terrain contracts"
```

### Task 7: Prove browser behavior, performance, and final cleanliness

**Files:**
- Modify: `tests/browser/underwater-terrain-tile-wireframe.mjs`
- Modify: `tests/browser/support/underwater-terrain-proof.ts`
- Modify only if required by evidence: focused implementation or tests from Tasks 2-5.

**Interfaces:**
- Produces DPR, top-down, pitch-boundary, streaming, lifecycle, and performance evidence.

- [x] **Step 1: Add multi-DPR proof assertions**

Run identical logical views at DPR 1, 1.25, 1.5, 2, and 3. Compare cover levels/counts/demands while asserting physical presentation sizes differ by the expected rounded scale.

- [x] **Step 2: Run required focused browser gates**

```bash
UNDERWATER_TERRAIN_HEADLESS=1 node tests/browser/underwater-terrain-tile-wireframe.mjs
node tests/browser/underwater-terrain-streaming.mjs
node tests/browser/scratch-underwater-terrain.mjs
node tests/browser/underwater-terrain-cache-panel.mjs
```

Expected: all JSON reports have `status: "passed"`; top-down uses one level, 60 degrees owns variable mode, 2:1 and overflow facts pass, and 90-frame shaded/wireframe timing remains within the existing gate.

- [x] **Step 3: Run repository-wide verification**

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

- [x] **Step 4: Audit dead code and dependencies**

```bash
rg -n 'GeoViewSourceCapture.*size|captured\.size|\.viewport\b|maximumCellSpanPixels|minimumCellSpanPixels|TERRAIN_SECTOR_SIZE = 64|cog-wmq-v3' \
  packages/geoscratch/src/geo examples/underwaterTerrain tests docs/api AGENTS.md
git status --short --branch
git log --oneline --decorate -8
```

Every match must be an unrelated Scratch render viewport or an explicitly historical document. Remove stale imports, codecs, fields, constants, helpers, tests, and prose discovered by the audit.

- [x] **Step 5: Commit final proof/cleanup**

```bash
git add -A
git commit -m "Verify reference-pixel terrain LoD"
```
