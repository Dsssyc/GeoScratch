# WebMercatorQuad Continuous Distance-Band Symmetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the directionally biased fixed 4 by 4 finest window with high-precision continuous camera-to-tile AABB distance bands while preserving the complete ADR-083 inverse-cover architecture.

**Architecture:** The CPU oracle and WGSL kernel derive the same per-level standard-tile interval directly from the camera's two-limb fixed coordinate. Each interval guarantees a two-tile continuous radius, expands outward to complete parent groups, remains nested with the finer interval, and feeds the existing frustum cull, prefix removal, 2:1 closure, lookup, demand, and indirect draw path.

**Tech Stack:** TypeScript, WGSL, WebGPU, Mocha/Chai, Playwright with real Chrome, MapLibre-hosted Underwater Terrain example.

## Global Constraints

- Preserve canonical OGC `WebMercatorQuad` matrix/row/column identities.
- Preserve one GPU view-cover authority; do not restore root traversal, repeated trials, or previous-frame topology.
- Keep Virtual Raster, Worker, Cache, atlas, source ceiling, terrain shader, mesh geometry, and mesh stitching unchanged.
- Use the existing wide-fixed camera limbs; do not derive the band from projected f32 camera values.
- Keep `ceil(zoomHint)` plus the current pitch boost as the finest-level policy.
- Expand parent alignment outward only; never shift or shrink the continuous radius.
- Retain hard overflow diagnostics, prefix freedom, visible completeness, maximum adjacent delta one, indirect draw, and double-flight ownership.
- Keep non-minimum candidate work bounded to at most 36 tiles per level.

---

### Task 1: Lock the Directional-Bias Regression in the CPU Oracle

**Files:**
- Modify: `tests/geo-webmercator-quad-cover.test.js`
- Test: `tests/geo-webmercator-quad-cover.test.js`

**Interfaces:**
- Consumes: `evaluateGpuWebMercatorQuadCoverReference(input)` and the existing `fixture`, `patchAt`, `WORLD_WIDTH`, and `HALF_WORLD` helpers.
- Produces: regression expectations for arbitrary odd row/column camera positions and exact parent-center ties.

- [ ] **Step 1: Add projected-coordinate and mirror-level test helpers**

```js
function projectedCameraAtTile(level, tileCol, tileRow, fractionX, fractionY) {
    const scale = 2 ** level
    const normalizedX = (tileCol + fractionX) / scale
    const normalizedY = (tileRow + fractionY) / scale
    return {
        x: normalizedX * WORLD_WIDTH - HALF_WORLD,
        y: HALF_WORLD - normalizedY * WORLD_WIDTH,
        normalizedX,
        normalizedY,
    }
}

function selectedLevel(result, x, y) {
    const patch = patchAt(result, x, y)
    expect(patch, `cover at ${x},${y}`).not.to.equal(undefined)
    return patch.matrixLevel
}
```

- [ ] **Step 2: Add the odd-column and odd-row mirror regressions**

```js
it('keeps equal-distance samples symmetric at odd camera tile indices', () => {
    const setup = fixture()
    for (const sample of [
        { level: 14, col: 13_697, row: 6_670, fx: 0.966, fy: 0.354, axis: 'x' },
        { level: 12, col: 3_424, row: 1_667, fx: 0.491, fy: 0.589, axis: 'y' },
    ]) {
        const camera = projectedCameraAtTile(
            sample.level, sample.col, sample.row, sample.fx, sample.fy
        )
        const delta = 1 / 2 ** sample.level
        const result = setup.evaluate({
            currentView: setup.view({
                x: camera.x,
                y: camera.y,
                zoom: sample.level - 0.75,
            }),
            visibleBounds: {
                west: camera.normalizedX - delta * 4,
                east: camera.normalizedX + delta * 4,
                north: camera.normalizedY - delta * 4,
                south: camera.normalizedY + delta * 4,
            },
        })
        const left = sample.axis === 'x'
            ? [camera.normalizedX - delta, camera.normalizedY]
            : [camera.normalizedX, camera.normalizedY - delta]
        const right = sample.axis === 'x'
            ? [camera.normalizedX + delta, camera.normalizedY]
            : [camera.normalizedX, camera.normalizedY + delta]
        expect(selectedLevel(result, ...left)).to.equal(selectedLevel(result, ...right))
    }
})
```

- [ ] **Step 3: Add the exact odd parent-center tie regression**

```js
it('expands both directions at an exact odd parent-center boundary', () => {
    const setup = fixture()
    const level = 10
    const camera = projectedCameraAtTile(level, 513, 417, 0, 0)
    const delta = 1.5 / 2 ** level
    const result = setup.evaluate({
        currentView: setup.view({ x: camera.x, y: camera.y, zoom: 9.25 }),
        visibleBounds: {
            west: camera.normalizedX - delta * 3,
            east: camera.normalizedX + delta * 3,
            north: camera.normalizedY - delta * 3,
            south: camera.normalizedY + delta * 3,
        },
    })
    expect(selectedLevel(result, camera.normalizedX - delta, camera.normalizedY))
        .to.equal(selectedLevel(result, camera.normalizedX + delta, camera.normalizedY))
    expect(selectedLevel(result, camera.normalizedX, camera.normalizedY - delta))
        .to.equal(selectedLevel(result, camera.normalizedX, camera.normalizedY + delta))
})
```

- [ ] **Step 4: Run the reference tests and verify RED**

Run:

```bash
npm --workspace geoscratch run build
node_modules/.bin/mocha tests/geo-webmercator-quad-cover.test.js
```

Expected: the new odd-column/odd-row or exact-boundary expectations fail because the old window places an odd focus tile at one edge. Existing tests remain green.

---

### Task 2: Implement the Continuous Fixed-Coordinate Band in the CPU Oracle

**Files:**
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-reference.ts`
- Test: `tests/geo-webmercator-quad-cover.test.js`

**Interfaces:**
- Consumes: `WebMercatorPlanarTileSpatialProfile.encodeCamera()`, `GpuWebMercatorQuadCoverReferenceInput`, `IntegerBounds`, `alignToParentGroups`, `fitWindow`, and `geometryLimit`.
- Produces: `cameraFixedPosition(input)` and `distanceBandWindow(fixedAxis, matrixLevel, coordinateBits)` as package-internal helpers used only by `coverWindows()`.

- [ ] **Step 1: Replace the fixed-span constants with one radius**

```ts
const DISTANCE_BAND_RADIUS_TILES = 2
```

Delete `FINE_WINDOW_SPAN` and `LEVEL_HALO_TILES`; the radius now defines every non-minimum band directly.

- [ ] **Step 2: Derive exact two-limb camera coordinates**

```ts
function cameraFixedPosition(
    input: GpuWebMercatorQuadCoverReferenceInput
): readonly [bigint, bigint] {
    const projected: readonly [number, number] = [
        input.view.cameraHigh[0] + input.view.cameraLow[0],
        input.view.cameraHigh[1] + input.view.cameraLow[1],
    ]
    const encoded = input.spatialProfile.encodeCamera(projected)
    return Object.freeze([
        (BigInt(encoded.high[0]) << 32n) | BigInt(encoded.low[0]),
        (BigInt(encoded.high[1]) << 32n) | BigInt(encoded.low[1]),
    ])
}
```

- [ ] **Step 3: Implement the exact continuous AABB interval**

```ts
function distanceBandAxis(
    fixed: bigint,
    matrixLevel: number,
    coordinateBits: number
): readonly [number, number] {
    const fractionalBits = BigInt(coordinateBits - matrixLevel)
    const tile = Number(fixed >> fractionalBits)
    const fractionalMask = (1n << fractionalBits) - 1n
    const hasFraction = (fixed & fractionalMask) !== 0n
    return Object.freeze([
        tile - DISTANCE_BAND_RADIUS_TILES,
        tile + DISTANCE_BAND_RADIUS_TILES - (hasFraction ? 0 : 1),
    ])
}

function distanceBandWindow(
    fixed: readonly [bigint, bigint],
    matrixLevel: number,
    coordinateBits: number
): IntegerBounds {
    const [minTileCol, maxTileCol] = distanceBandAxis(
        fixed[0], matrixLevel, coordinateBits
    )
    const [minTileRow, maxTileRow] = distanceBandAxis(
        fixed[1], matrixLevel, coordinateBits
    )
    return alignToParentGroups({
        minTileRow,
        maxTileRow,
        minTileCol,
        maxTileCol,
    })
}
```

- [ ] **Step 4: Generate each nested band from the continuous camera**

```ts
function unionBounds(left: IntegerBounds, right: IntegerBounds): IntegerBounds {
    return {
        minTileRow: Math.min(left.minTileRow, right.minTileRow),
        maxTileRow: Math.max(left.maxTileRow, right.maxTileRow),
        minTileCol: Math.min(left.minTileCol, right.minTileCol),
        maxTileCol: Math.max(left.maxTileCol, right.maxTileCol),
    }
}
```

In `coverWindows()`, compute `fixed = cameraFixedPosition(input)`. For levels from finest to minimum:

```ts
const limit = geometryLimit(input, matrixLevel)
if (matrixLevel === input.policy.minimumMatrixLevel) {
    windows.set(matrixLevel, limit)
    continue
}
let band = distanceBandWindow(
    fixed,
    matrixLevel,
    input.spatialProfile.coordinateBits
)
const finer = windows.get(matrixLevel + 1)
if (finer !== undefined) {
    band = unionBounds(band, {
        minTileRow: Math.floor(finer.minTileRow / 2),
        maxTileRow: Math.floor(finer.maxTileRow / 2),
        minTileCol: Math.floor(finer.minTileCol / 2),
        maxTileCol: Math.floor(finer.maxTileCol / 2),
    })
}
windows.set(matrixLevel, fitWindow(alignToParentGroups(band), limit))
```

- [ ] **Step 5: Run the reference suite and verify GREEN**

Run:

```bash
npm --workspace geoscratch run build
node_modules/.bin/mocha tests/geo-webmercator-quad-cover.test.js tests/geo-webmercator-inverse-cover-clean-cut.test.js
```

Expected: all tests pass, including odd-index mirror and tie cases. Candidate and patch capacities remain valid.

---

### Task 3: Lock and Implement WGSL Parity with the CPU Oracle

**Files:**
- Modify: `tests/scratch-underwater-terrain-clean-cut.test.js`
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-wgsl.ts`
- Test: `tests/scratch-underwater-terrain-clean-cut.test.js`
- Test: `tests/geo-webmercator-quad-cover.test.js`

**Interfaces:**
- Consumes: `coverCameraTileIndex()`, `GpuWebMercatorQuadCoverWindow`, `coverAlignToParentGroups()`, `coverFitWindow()`, `coverGeometryWindow()`, and the two-limb camera fields in `mapMeta`.
- Produces: WGSL helpers `coverCameraHasTileFraction()`, `coverDistanceBandWindow()`, and `coverUnionWindow()`.

- [ ] **Step 1: Add a structural RED gate for removal of the biased formula**

```js
expect(wgsl).to.include('fn coverCameraHasTileFraction(')
expect(wgsl).to.include('fn coverDistanceBandWindow(')
expect(wgsl).to.include('fn coverUnionWindow(')
expect(wgsl).not.to.include(
    '((focusRow - COVER_FINE_WINDOW_SPAN / 2i) / 2i) * 2i'
)
expect(wgsl).not.to.include('COVER_LEVEL_HALO_TILES')
```

- [ ] **Step 2: Run the structural test and verify RED**

Run:

```bash
node_modules/.bin/mocha tests/scratch-underwater-terrain-clean-cut.test.js
```

Expected: FAIL because the new helpers are absent and the old directional formula remains.

- [ ] **Step 3: Implement exact fractional-bit detection in WGSL**

```wgsl
fn coverCameraHasTileFraction(low: u32, high: u32, matrixLevel: u32) -> bool {
    let fractionalBits = coverPolicy.coordinateBits - matrixLevel;
    if (fractionalBits < 32u) {
        let mask = (1u << fractionalBits) - 1u;
        return (low & mask) != 0u;
    }
    if (fractionalBits == 32u) { return low != 0u; }
    let highBits = fractionalBits - 32u;
    let highMask = (1u << highBits) - 1u;
    return low != 0u || (high & highMask) != 0u;
}
```

The policy guarantees `coordinateBits - matrixLevel >= 8`, so no zero-width shift occurs.

- [ ] **Step 4: Implement camera-centered outward-aligned bands**

```wgsl
fn coverDistanceBandWindow(matrixLevel: u32) -> GpuWebMercatorQuadCoverWindow {
    let tileRow = i32(coverCameraTileIndex(
        mapMeta.cameraFixedLow.y, mapMeta.cameraFixedHigh.y, matrixLevel
    ));
    let tileCol = i32(coverCameraTileIndex(
        mapMeta.cameraFixedLow.x, mapMeta.cameraFixedHigh.x, matrixLevel
    ));
    let rowFraction = coverCameraHasTileFraction(
        mapMeta.cameraFixedLow.y, mapMeta.cameraFixedHigh.y, matrixLevel
    );
    let colFraction = coverCameraHasTileFraction(
        mapMeta.cameraFixedLow.x, mapMeta.cameraFixedHigh.x, matrixLevel
    );
    return coverAlignToParentGroups(GpuWebMercatorQuadCoverWindow(
        tileRow - COVER_DISTANCE_BAND_RADIUS_TILES,
        tileRow + COVER_DISTANCE_BAND_RADIUS_TILES - select(1i, 0i, rowFraction),
        tileCol - COVER_DISTANCE_BAND_RADIUS_TILES,
        tileCol + COVER_DISTANCE_BAND_RADIUS_TILES - select(1i, 0i, colFraction),
    ));
}
```

Add `coverUnionWindow()` using component-wise min/max. Replace the old finest-window and parent-plus-halo loop with the same finest-to-minimum independent-band/parent-union loop used by the CPU oracle. Preserve the minimum-level full `coverGeometryWindow()`.

- [ ] **Step 5: Run TypeScript and focused structural/reference gates**

Run:

```bash
npm --workspace geoscratch run build
node_modules/.bin/mocha \
  tests/geo-webmercator-quad-cover.test.js \
  tests/geo-webmercator-inverse-cover-clean-cut.test.js \
  tests/scratch-underwater-terrain-clean-cut.test.js
```

Expected: all focused tests pass and WGSL source contains no directional minimum-only alignment.

- [ ] **Step 6: Commit the tested CPU/WGSL repair**

```bash
git add \
  packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-reference.ts \
  packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-wgsl.ts \
  tests/geo-webmercator-quad-cover.test.js \
  tests/scratch-underwater-terrain-clean-cut.test.js
git commit -m "Center WebMercator cover bands on camera distance"
```

---

### Task 4: Extend Real-Browser Symmetry and Performance Evidence

**Files:**
- Modify: `tests/browser/underwater-terrain-tile-wireframe.mjs`
- Test: `tests/browser/underwater-terrain-tile-wireframe.mjs`
- Test: `tests/browser/scratch-underwater-terrain.mjs`
- Test: `tests/browser/underwater-terrain-streaming.mjs`

**Interfaces:**
- Consumes: existing `settle()`, `capture()`, `readFacts()`, camera tracking, managed Vite/tile-server lifecycle, and wireframe presentation.
- Produces: persisted odd-parity direct/history evidence in the inverse-cover proof result.

- [ ] **Step 1: Add the default odd-parity top-down camera path**

```js
const oddParityTopDownCamera = Object.freeze({
    center: camera.center,
    zoom: 13.25,
    pitch: 0,
    bearing: 180,
})
```

In `runProof()`, settle directly at this camera, capture it, move through
`{ ...oddParityTopDownCamera, pitch: 70 }`, return to the exact top-down camera,
and capture again. Store both as `oddParityTopDown.direct` and
`oddParityTopDown.returned`.

- [ ] **Step 2: Add path-independence and bounded-density assertions**

```js
const oddDirect = oddParityTopDown?.direct
const oddReturned = oddParityTopDown?.returned
expect(failures,
    oddDirect?.capture?.canvas?.sha256 === oddReturned?.capture?.canvas?.sha256 &&
    oddDirect?.coverFeedback?.patchCount === oddReturned?.coverFeedback?.patchCount &&
    oddDirect?.coverFeedback?.candidateCount === oddReturned?.coverFeedback?.candidateCount,
    'odd-parity top-down cover depended on navigation history'
)
expect(failures,
    oddDirect?.coverPatchCount > 0 && oddDirect.coverPatchCount <= 96 &&
    oddDirect.coverFeedback?.maximumAdjacentLevelDelta <= 1,
    'odd-parity top-down cover exceeded density or adjacency gates'
)
```

Retain screenshots as review artifacts. Manual acceptance compares bearing 0/180 with the control panel hidden and confirms no one-sided finest region.

- [ ] **Step 3: Run the managed inverse-cover browser proof**

Run:

```bash
UNDERWATER_TERRAIN_HEADLESS=1 \
node tests/browser/underwater-terrain-tile-wireframe.mjs \
  > /tmp/geoscratch-distance-band-proof.json
```

Expected: `status: "passed"`, no console/page/network/WebGPU failures, maximum adjacent delta one, source requests at or below z10, and managed processes closed.

- [ ] **Step 4: Run lifecycle and streaming browser proofs**

Run:

```bash
UNDERWATER_TERRAIN_HEADLESS=1 \
node tests/browser/scratch-underwater-terrain.mjs \
  > /tmp/geoscratch-distance-band-lifecycle.json

UNDERWATER_TERRAIN_HEADLESS=1 \
node tests/browser/underwater-terrain-streaming.mjs \
  > /tmp/geoscratch-distance-band-streaming.json
```

Expected: both report `status: "passed"`; the two-page atlas remains stable with zero eviction churn, cancellation/404/cache proofs retain their exact ownership outcomes, and every managed process closes.

---

### Task 5: Synchronize Current Documentation and Run Final Gates

**Files:**
- Modify: `docs/superpowers/specs/2026-08-18-webmercator-inverse-cover-passive-virtual-raster-design.md`
- Modify: `docs/superpowers/specs/2026-08-18-webmercator-inverse-cover-passive-virtual-raster-design_zh.md`
- Modify: `docs/api/geo/view-cover.md`
- Modify: `docs/api/geo/view-cover_zh.md`
- Modify if generated: `docs/api/reference/api-docs.json`
- Modify if generated: `docs/api/reference/geo-api.json`
- Modify if generated: `docs/api/reference/geo.md`

**Interfaces:**
- Consumes: implemented `GpuWebMercatorQuadCover` behavior and the approved 2026-08-19 symmetry design.
- Produces: current English API truth, reviewed Chinese translation, current digests, and a clean verified branch.

- [ ] **Step 1: Update active docs without rewriting architecture history**

Replace descriptions of a fixed camera-derived window with continuous AABB-distance
bands, the two-tile guaranteed radius, outward parent-group expansion, and the
36-candidate-per-level bound. Keep ADR-083's authority boundaries unchanged and link
the 2026-08-19 repair design.

- [ ] **Step 2: Regenerate and verify API knowledge**

Run:

```bash
npm run docs:generate
npm run docs:translations
npm run docs:check
```

Expected: 811 public symbols, 20 canonical API pages, 20 translations, and no stale generated files.

- [ ] **Step 3: Run all static gates**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: zero failures; only the two explicitly optional browser gates remain pending in `npm test`. Production build may retain the existing runtime chunk-size warning but no new errors.

- [ ] **Step 4: Review the final diff against non-goals**

Run:

```bash
git diff --name-status ae08d48..HEAD
git status --short --branch
rg -n "GpuTileFrontier|GpuRenderPatchFrontier|rootTraversalCount|trialCount" \
  packages/geoscratch/src examples/underwaterTerrain docs/api tests/browser
```

Expected: only cover/reference/tests/docs files from this repair; no frontier vocabulary or unrelated subsystem edits; clean worktree after commit.

- [ ] **Step 5: Commit documentation and final proof changes**

```bash
git add \
  docs/superpowers/specs/2026-08-18-webmercator-inverse-cover-passive-virtual-raster-design.md \
  docs/superpowers/specs/2026-08-18-webmercator-inverse-cover-passive-virtual-raster-design_zh.md \
  docs/api/geo/view-cover.md docs/api/geo/view-cover_zh.md \
  docs/api/reference tests/browser/underwater-terrain-tile-wireframe.mjs
git commit -m "Verify continuous WebMercator cover symmetry"
```

The final report must include exact commits, test counts, browser patch/candidate counts,
90-frame p95 timings, screenshots, remaining warnings, and whether the branch was pushed.
