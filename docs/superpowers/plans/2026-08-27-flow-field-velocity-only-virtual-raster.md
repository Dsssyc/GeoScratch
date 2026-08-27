# Flow Field Velocity-Only Virtual Raster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independent `Flow Field` example that streams tiled temporal U/V data through current Geo Virtual Raster APIs, derives particle support and a visible contour on the GPU, and leaves the existing `Flow Layer` and package source frozen.

**Architecture:** A deterministic example-owned builder materializes immutable WebMercatorQuad RG32F velocity pages. Three example-local single-plane Virtual Raster runtimes represent current, next, and prefetch times; public Geo cover, demand, MapLibre view, frame, Worker, cache, and coordinate APIs are composed around them. Flow-specific temporal coordination, particle spawning, lifecycle, contour generation, history, and presentation remain under `examples/flowField/` so later lowering decisions can use implementation evidence.

**Tech Stack:** TypeScript 6, WebGPU/WGSL, GeoScratch `0.0.22`, MapLibre GL JS 4.7.1 structural API, Vite 5, Mocha/Chai, Playwright Chrome, Python 3.12-3.14, NumPy, FastAPI, Morecantile, pytest, and repository-pinned `d3-delaunay` 6.

## Global Constraints

- The example directory, route, page title, catalog label, proof names, and runtime labels use exactly `flowField` / `Flow Field`.
- `examples/flowLayer/` is frozen at Git tree `3f75e4550865ede4270d57bc919f2d3c20460d98`; implementation files cannot be modified, deleted, renamed, or imported by Flow Field.
- `packages/geoscratch/src/` receives zero changes in this implementation. Missing compositions stay under `examples/flowField/` until a separate lowering design is approved.
- Flow Field imports foundation contracts only from `geoscratch/scratch` and geographic contracts only from `geoscratch/geo`; no package-relative source import and no raw `runtime.device` or `runtime.queue` access is allowed.
- Normal time-varying payload is only U/V: WebMercatorQuad z4-z9, 256 by 256 texels, little-endian interleaved float32 RG, exactly 524,288 decoded bytes per page.
- The z9 source ceiling is evidence-based: measured Delaunay edge length is 317.88 m at the median while WebMercatorQuad z9 is about 260.13 m per texel at latitude 31.7 degrees. The declared extent contains 59 spatial pages across z4-z9, or 1,593 time pages and 835,190,784 raw bytes for all 27 times; build and transfer reports must retain these budget facts.
- Source topology is one global D3 Delaunay over 117,148 stations and 234,240 triangles. No tile-local triangulation is allowed.
- Source-support parity retains the `0.04` degree maximum-triangle-edge rule, lowering unsupported texels to zero velocity without a second plane.
- Source time is the explicit ordinal sequence `0..26`; units are recorded as `legacy-flow-unit`, basis as `source-u-v`, and phase as `unspecified` so the example makes no unverified physical claim.
- Particle advance preserves the frozen reference conversion as explicit application policy: `displacementMeters = velocity * 50 * speedFactor` per simulation step. It is labeled legacy scaling, not physical time integration.
- Application defaults use `activitySpawnRatio = 0.001`, `activityKillRatio = 0.0005`, `maximumParticleCount = 262_144`, `maximumInFlightFrames = 1`, and normal `framesPerTime = 300`. Proof mode may use `framesPerTime = 2` without changing normal defaults.
- No boundary, depth, wet/dry, SDF, vector-feature, or activity payload URL, cache identity, texture plane, or geometry residency exists.
- The application owns exactly one `WorkerSystem`; current, next, and prefetch velocity executors borrow it and own only their bounded groups/contexts.
- Boundary response is absorbing death and rebirth. Reflection, projection, sliding, wall normals, and physical wet-boundary claims are out of scope.
- The existing screen-history decay, cutoff, reverse-gather reprojection, resize behavior, and MapLibre presentation relationship remain behavior references, not imported implementation.
- Every task ends with focused tests and an atomic commit. Run `git diff --exit-code 2353553 -- examples/flowLayer packages/geoscratch/src` before every task commit.

---

## Planned File Structure

```text
examples/flowField/
  index.html
  main.ts
  application.ts
  map.ts
  README.md
  flow-dataset.ts
  velocity-source.ts
  velocity-tile-protocol.ts
  velocity-tile-worker.ts
  velocity-tile-executor.ts
  cache-policy.ts
  temporal-velocity-raster.ts
  flow-demand.ts
  flow-particle-policy.ts
  flow-spawn-index.ts
  flow-particles.ts
  flow-contour.ts
  flow-history.ts
  flow-renderer.ts
  shaders/{temporal-velocity,spawn-index.compute,particle-simulation.compute}.wgsl
  shaders/{particles,contour.compute,contour,history,presentation}.wgsl
  tile-server/
    pyproject.toml
    README.md
    source-dataset.json
    tools/delaunay.mjs
    src/geoscratch_flow_field_tiles/{__init__,source,build,service}.py
    tests/{conftest,test_source,test_build,test_parity,test_service}.py

tests/
  flow-field-reference-freeze.test.js
  flow-field-source-contract.test.js
  flow-field-temporal-raster.test.js
  flow-field-demand.test.js
  flow-field-particle-lifecycle.test.js
  flow-field-contour.test.js
  browser/support/flow-field-proof.ts
  browser/scratch-flow-field.mjs
```

---

### Task 1: Freeze Flow Layer And Package Source

**Files:**
- Create: `tests/flow-field-reference-freeze.test.js`
- Test: `tests/scratch-flow-layer-clean-cut.test.js`

**Interfaces:**
- Produces: immutable characterization of the Flow Layer reference and a Flow Field source-boundary scan.
- Protects: all later tasks from importing or modifying the reference and package implementation.

- [ ] **Step 1: Add the characterization test**

Create a test containing the current tracked list and SHA-256 values:

```js
const frozen = Object.freeze({
    'flow-layer.ts': '39068eb9b6e1a2a2bdceecf4ddf1b11f5bbe3998db9901fafeb7bfac37c232fb',
    'flow-lifecycle.ts': '31b2bfde7db19c304f21cfb7be9db195cb6c575ff6d60ee5ae0bacbaee8e288a',
    'flow-map.ts': 'b7c1b1834fc486b7821d137943553180c689d3c2cf20939fef1a40b5ab2156fe',
    'flow-worker.ts': 'cd0e505e26009d7b5af7a7cfd8b3b75da749c4b8052d4016ffe5d909af086512',
    'index.html': 'd4b224e8bb706d21b074a8daf48f1f05c85d008941aae366d8f6db5169fc5a93',
    'main.ts': 'c4e15ee94a6c3f105d3317c88f8db154d515ce2fd82fdf05cbb84e18111e7f4c',
    'shaders/flow/arrow.wgsl': 'ffce4cf43b21f44ed6ff65c21b6d3694a0b98faf33d9ebe961649a26cd988547',
    'shaders/flow/flowLayer.wgsl': '225a94b8fe79c052264a1fcb81f96a7d4ebf36d384bf695645984f551c32382a',
    'shaders/flow/flowShow.wgsl': '9e515dcef0e7cff01e5a9f1828e3dff7561991abc3b54596f33c017b3544733a',
    'shaders/flow/flowVoronoi.wgsl': 'f8fae35c1a5fa35fdbddd8b5cc24f40a53d54877943efa63c7bd8f6e99e7826e',
    'shaders/flow/particles.wgsl': '315d1f806fe4326b28b524a78b4520a43ba5358a5210ff0aed6ad2291c85b715',
    'shaders/flow/simulation.compute.wgsl': 'aedf78a69868f2a3df565ee6f6f39851c975570bfb87449bedc9af5dd0a84748',
    'shaders/flow/swap.wgsl': 'a9f08a0a027e059076f11b3f68969241d74d34e56ac464b608bb931aa5220897',
})
```

The test computes each digest, requires the exact file list, and recursively scans future
`examples/flowField/**/*.{ts,wgsl,html}` content for forbidden `../flowLayer`,
`examples/flowLayer`, `packages/geoscratch/src`, `runtime.device`, and `runtime.queue`.

- [ ] **Step 2: Run the characterization gate**

Run: `npx mocha tests/flow-field-reference-freeze.test.js tests/scratch-flow-layer-clean-cut.test.js`

Expected: PASS; this task intentionally establishes a characterization baseline rather than a feature RED.

- [ ] **Step 3: Verify immutable scopes and commit**

```bash
git diff --exit-code 2353553 -- examples/flowLayer packages/geoscratch/src
git diff --check
git add tests/flow-field-reference-freeze.test.js
git commit -m "Freeze Flow Layer reference"
```

---

### Task 2: Build Deterministic RG32F Velocity Tiles

**Files:**
- Create: `examples/flowField/tile-server/pyproject.toml`
- Create: `examples/flowField/tile-server/README.md`
- Create: `examples/flowField/tile-server/source-dataset.json`
- Create: `examples/flowField/tile-server/tools/delaunay.mjs`
- Create: `examples/flowField/tile-server/src/geoscratch_flow_field_tiles/__init__.py`
- Create: `examples/flowField/tile-server/src/geoscratch_flow_field_tiles/source.py`
- Create: `examples/flowField/tile-server/src/geoscratch_flow_field_tiles/build.py`
- Create: `examples/flowField/tile-server/src/geoscratch_flow_field_tiles/service.py`
- Create: `examples/flowField/tile-server/tests/conftest.py`
- Create: `examples/flowField/tile-server/tests/test_source.py`
- Create: `examples/flowField/tile-server/tests/test_build.py`
- Create: `examples/flowField/tile-server/tests/test_parity.py`
- Create: `examples/flowField/tile-server/tests/test_service.py`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: ignored `examples/public/json/examples/flow/station.bin` and `uv_0.bin` through `uv_26.bin`.
- Produces: `cache/manifest.json` and immutable `cache/tiles/WebMercatorQuad/tNN/{matrix}/{row}/{col}.rg32f` pages.
- Produces HTTP: `/health`, `/manifest.json`, `/tiles/WebMercatorQuad/{time}/{matrix}/{row}/{col}.rg32f`, and `/stats`.

- [ ] **Step 1: Write failing source/build/service tests**

Synthetic fixtures must assert:

```python
assert manifest["schemaVersion"] == 1
assert manifest["tileMatrixSet"]["id"] == "WebMercatorQuad"
assert manifest["encoding"] == {
    "channels": 2,
    "componentOrder": ["u", "v"],
    "sampleType": "float32-le",
    "layout": "rg-interleaved",
    "tileWidth": 256,
    "tileHeight": 256,
}
assert page.stat().st_size == 256 * 256 * 2 * 4
assert not any(word in json.dumps(manifest).lower() for word in (
    "boundary", "depth", "wet", "sdf", "vector-feature"
))
```

Service tests require immutable ETag/304 behavior, 404
`FLOW_FIELD_TILE_OUT_OF_RANGE`, 503 `FLOW_FIELD_TILE_ARTIFACT_UNAVAILABLE`, and bounded aggregate stats without request history.

- [ ] **Step 2: Run tests to verify RED**

```bash
python3 -m venv examples/flowField/tile-server/.venv
examples/flowField/tile-server/.venv/bin/python -m pip install -e 'examples/flowField/tile-server[test]'
examples/flowField/tile-server/.venv/bin/python -m pytest examples/flowField/tile-server/tests -q
```

Expected: FAIL because `geoscratch_flow_field_tiles` and its entrypoints do not exist.

- [ ] **Step 3: Add the package and source descriptor**

Pin `fastapi==0.141.1`, `numpy==2.4.6`, `morecantile==7.0.3`, and
`uvicorn==0.52.1`; test dependencies are `httpx==0.28.1` and `pytest==9.1.1`.
Register `flow-field-tile-build` and `flow-field-tile-serve` scripts.

`source-dataset.json` records `stationCount: 117148`, `fieldCount: 27`, station hash
`1d50f140b8333b78d0c2784a3a85ede2cc3f0085bdb923a0fd3d7d7334409ec1`,
these 27 verified U/V hashes in numeric order, `unit: "legacy-flow-unit"`,
`basis: "source-u-v"`, and ordinal times with `phase: "unspecified"`.

```json
[
  "75d47f2e64178530ba36302e135046768db09edb30040ee5f8bd69426babb81d",
  "6368fccc436309e594f5813e2cba38aa316efafcd924c80ba8bcfc62a4606648",
  "0adf5f0fe1dec72d66a76fac9b0d1a8afad56946b03f9e7da951a56710b5530b",
  "d6d6db6e5ed8fe14ff2d823d1a5c9e7a4c112a83a1cbd0f4ff52c3e29102325d",
  "10d3cc1d1a2681d1e3f5363ae29f42be0e768d95bd7635c11c9f13b087ae816a",
  "c598c9ebca8bad56eafe71102593aa3b3a121250eb9e509d139d1655d25fae8b",
  "b191404c6cb1dc88ad69c64abad85d3a188c30ff3874e3f532fd932a8c29e33b",
  "3794f7e19ccffa9180d78ec0611c2ce314648b42cdbe45904172801168907978",
  "30a649009bc739b5818d0e4039d4bf2e28931c7ae9c58a5905b6f901bff6d80d",
  "cd83e7a864adc031907568b4a62d0ca5c3bcee66caed5f20fdabd1b066d0f648",
  "a5020f32818ab0d1ec290ee4be9263768d1182d5a2f27966f893aa6b538ebb58",
  "3430eea7ac25a630a4a8fb49c19c43a8c73bb47886a5717cab718d4ada873c43",
  "a362bd8b5ba8be8e04eac625f357acd17e121558131cfe9456d5b14ca49ac699",
  "7e7ebec339d629ae82010b5f2dc4c7c778fbcd33fb669ce1b78633c1712dd460",
  "ff79711c754d831435bb3c8e314b9f62491407c48714bb50fed537aca6b34473",
  "5a94a1b0803d98cc9791a25b93205e419af9b0240be17ae3403dc8b2fefe97c2",
  "9137a3dc0a1097c67bb3697908075e12f148cd8aa5004c7add7b2ae9bd54f404",
  "4889b0249f945c2aa86236df4e0c040862de2118efa10b115d502530432a6cfe",
  "449a8ed5964c395c4630b3992fb5c103984ef07afb12239f1b2cd33a688b53f6",
  "0e3351a1dd5789d314b27c414eb88360df11f680353986c4d28f66fffd7b8fa3",
  "0b5b392dd88ffd752a72eac360d3d0253500b314baf8c5bf45942002e0174dbb",
  "afec66ad9f67be51e38ea7581a70fe44d5e14b336902ac8e35d33cef6442c91d",
  "6e06da56c172be5574d64e519757de3f23bb5d1f6ad7e61c3dbdc3b2fe47584c",
  "f1e53cc31048aa1dec52775b252fc4c06fdaec8a869f78b9032f32d780adf060",
  "42744783e565d81b2ed58effd019eafbbcb2fed85197ab03b46c655e081bf759",
  "1d956347384c730f65907d6723ab43cd8695ba38bc22e256c4c08714db08ce04",
  "8d7ad6e84acc954a4210f47d1f40a93c82f0e7497c9ab3d5f10a550be5624f9a"
]
```

- [ ] **Step 4: Implement one D3 topology and deterministic pages**

`tools/delaunay.mjs` uses repository `d3-delaunay`, validates the station count, and
writes little-endian u32 connectivity. `source.py` invokes it exactly once and validates
234,240 triangles. `build.py` uses:

```python
TILE_SIZE = 256
MIN_TILE_MATRIX = 4
MAX_TILE_MATRIX = 9
MAX_TRIANGLE_EDGE_DEGREES = 0.04
PAGE_BYTE_LENGTH = TILE_SIZE * TILE_SIZE * 2 * 4
```

Finest texel centers are inverse-projected to lon/lat, evaluated with float64 barycentric
weights in the one topology, and rounded explicitly to little-endian float32. Coarser
levels are component-wise 2x2 averages; directions are never averaged as angles. Page
mapping is computed once per spatial page and reused across all 27 times. A temporary
sibling directory is atomically installed only after every page/hash/parity record succeeds.

- [ ] **Step 5: Implement immutable static serving**

`service.py` never interpolates. It serves exact bytes with
`Content-Type: application/vnd.geoscratch.flow-rg32f`, page-hash ETag, and
`Cache-Control: public, max-age=31536000, immutable`.

- [ ] **Step 6: Run deterministic and real-source gates**

```bash
examples/flowField/tile-server/.venv/bin/python -m pytest examples/flowField/tile-server/tests -q
examples/flowField/tile-server/.venv/bin/flow-field-tile-build
examples/flowField/tile-server/.venv/bin/flow-field-tile-build --verify-existing
```

Expected: tests PASS and the second build reports identical manifest/page hashes.
Record total raw page bytes and build duration as measurements, not optimization claims.

- [ ] **Step 7: Ignore generated artifacts and commit**

Add Flow Field `.venv/`, `cache/`, `.pytest_cache/`, `__pycache__/`, `*.py[cod]`, and
`*.egg-info/` rules to `.gitignore`; run the immutable-scope gate and commit with
`Build Flow Field velocity tiles`.

---

### Task 3: Add The Velocity Source And Worker Boundary

**Files:**
- Create: `examples/flowField/flow-dataset.ts`
- Create: `examples/flowField/velocity-source.ts`
- Create: `examples/flowField/velocity-tile-protocol.ts`
- Create: `examples/flowField/velocity-tile-worker.ts`
- Create: `examples/flowField/velocity-tile-executor.ts`
- Create: `examples/flowField/cache-policy.ts`
- Modify: `examples/worker-modules.ts`
- Create: `tests/flow-field-source-contract.test.js`
- Modify: `tests/assets-layout.test.js`
- Modify: `tests/browser/underwater-terrain-streaming.mjs`

**Interfaces:**
- Produces: `loadFlowDatasetManifest(url): Promise<FlowDatasetManifest>`.
- Produces: `createVelocityTimeSource(manifest, timeIndex): FlowVelocityTimeSource`.
- Produces: `createVelocityTimeRuntime(options): Promise<FlowVelocityTimeRuntime>`.
- Produces Worker module `geoscratch-flow-field-velocity-tile@1`.

- [ ] **Step 1: Write failing source-contract tests**

Reject wrong counts, hashes, basis, page length, coverage, and times. Source guards require:

```js
expect(source).to.include("fieldKind: 'vector'")
expect(source).to.include('channels: 2')
expect(source).to.include("sampleType: 'float32'")
expect(source).to.include("gpuFormat: 'rg32float'")
expect(source).not.to.match(/runtime\.(?:device|queue)/)
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npx mocha tests/flow-field-source-contract.test.js`

Expected: FAIL because source files do not exist.

- [ ] **Step 3: Implement immutable manifest and source types**

```ts
export type FlowDatasetManifest = Readonly<{
    schemaVersion: 1
    sourceHash: string
    contentVersion: string
    stationCount: 117148
    times: readonly FlowDatasetTime[]
    tileMatrixSet: FlowTileMatrixSetManifest
    encoding: Readonly<{
        channels: 2
        componentOrder: readonly ['u', 'v']
        sampleType: 'float32-le'
        layout: 'rg-interleaved'
        tileWidth: 256
        tileHeight: 256
    }>
    unit: 'legacy-flow-unit'
    basis: 'source-u-v'
    pages: readonly FlowVelocityPageManifest[]
}>

export type FlowDatasetTime = Readonly<{
    timeIndex: number
    modelTime: number
    unit: 'ordinal'
    phase: 'unspecified'
    sourceHash: string
}>

export type FlowTileMatrixSetManifest = Readonly<{
    id: 'WebMercatorQuad'
    uri: string
    tileWidth: 256
    tileHeight: 256
    minTileMatrix: '4'
    maxTileMatrix: '9'
    limits: readonly TileMatrixLimits[]
}>

export type FlowVelocityPageManifest = Readonly<{
    timeIndex: number
    matrixId: string
    tileRow: number
    tileCol: number
    byteLength: 524288
    sha256: string
    maximumSpeed: number
}>

export type FlowVelocityTimeSource = Readonly<{
    timeIndex: number
    model: ReturnType<typeof webMercatorVirtualRasterField>
    tileUrl(page: VirtualRasterPageIdentity): string
    expectedPage(page: VirtualRasterPageIdentity): FlowVelocityPageManifest
}>

export type FlowVelocityTimeRuntime = VirtualRasterRuntime & Readonly<{
    source: FlowVelocityTimeSource
}>
```

`createVelocityTimeRuntime()` requires a caller-owned `WorkerSystem` and binds the
executor as borrowed. Runtime disposal releases only the time-specific executor
group/contexts; application disposal releases the shared WorkerSystem after all three
temporal slots settle.

Create every time model with public `tileMatrixCoverage()` and
`webMercatorVirtualRasterField({ fieldKind:'vector', channels:2,
sampleType:'float32', gpuFormat:'rg32float' })`.

- [ ] **Step 4: Implement the seven-operation Worker path**

Use `lookup -> fetch -> decode -> transfer -> accept -> discard -> facts`. Validate
HTTP status, decoded length 524,288, page SHA-256, and all finite float32 values before
`prepareVirtualRasterPageTransfer({ width:256, height:256, channels:2, data,
contentVersion })`. Cache hits first pass `virtualRasterCacheMetadataMatches()` and
use plane `velocity.tNN` plus immutable content identity.

- [ ] **Step 5: Register Worker and run gates**

Add this entry without changing the DEM entry:

```ts
{
    contract: FLOW_FIELD_VELOCITY_TILE_WORKER,
    entry: './flowField/velocity-tile-worker.ts',
}
```

Update the Underwater Terrain static-deployment validator to find the DEM entry by
`id === 'geoscratch-dem-tile'`, require both known module ids, and stop assuming the
manifest has exactly one entry. Add Flow Worker protocol/executor colocated-asset
assertions to `tests/assets-layout.test.js` while retaining every DEM assertion.

Run Worker build, the focused Mocha/assets tests, and examples typecheck; then run the immutable
scope gate and commit with `Add Flow Field velocity source`.

---

### Task 4: Compose Current, Next, And Prefetch Runtimes

**Files:**
- Create: `examples/flowField/temporal-velocity-raster.ts`
- Create: `examples/flowField/shaders/temporal-velocity.wgsl`
- Create: `tests/flow-field-temporal-raster.test.js`

**Interfaces:**
- Consumes: `createVelocityTimeRuntime()` from Task 3.
- Produces: `createTemporalVelocityRaster(options): Promise<TemporalVelocityRaster>`.
- Produces: immutable `TemporalVelocitySnapshot` and WGSL `FlowVelocity_sample()`.

- [ ] **Step 1: Write failing rotation and coherence tests**

Injected fake runtimes prove three live slots, initial 0/1/2, rotation 1/2/3, wrap
26/0/1, exact-once retired-runtime disposal, immutable pair snapshots, stale-generation
rejection, and prefetch exclusion from sampling.

```ts
export type TemporalVelocitySnapshot = Readonly<{
    generation: number
    currentTimeIndex: number
    nextTimeIndex: number
    progress: number
    temporalResidencyEpoch: number
    currentSnapshotEpoch: number
    nextSnapshotEpoch: number
}>

export type TemporalVelocityRaster = Readonly<{
    current: FlowVelocityTimeRuntime
    next: FlowVelocityTimeRuntime
    prefetch: FlowVelocityTimeRuntime
    snapshot(): TemporalVelocitySnapshot
    advance(): Promise<TemporalVelocitySnapshot>
    dispose(): Promise<void>
}>
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npx mocha tests/flow-field-temporal-raster.test.js`

Expected: FAIL because the coordinator is absent.

- [ ] **Step 3: Implement bounded runtime ownership and temporal WGSL**

Own exactly current/next/prefetch public `VirtualRasterRuntime` objects. Rotation moves
next to current and prefetch to next, creates one new prefetch, drains issued work, then
disposes retired current. Generate two public WebMercator Virtual Raster WGSL modules
with distinct namespaces. Sample both at one wide-fixed position; unavailable members
fail the pair. Resample at the coarser returned level until resolved levels agree, then:

```wgsl
let velocity = mix(current.value.xy, next.value.xy, temporal.progress);
let speed = length(velocity);
let advectable = speed >= temporal.activityKill;
```

Pair rotation replaces and prepares only the two page-table/atlas bind sets; pipelines
and layouts remain stable. Never read private slot-table ABI.

- [ ] **Step 4: Run gates and commit**

Run focused tests and examples typecheck. After immutable-scope verification, commit
with `Add Flow Field temporal velocity`.

---

### Task 5: Produce View And Predictive Velocity Demand

**Files:**
- Create: `examples/flowField/flow-demand.ts`
- Create: `tests/flow-field-demand.test.js`

**Interfaces:**
- Consumes: `GpuWebMercatorQuadCover`, `GpuWebMercatorQuadDemandProjection`, and `TemporalVelocityRaster`.
- Produces: `createFlowDemandCoordinator(options): FlowDemandCoordinator`.
- Produces: bounded candidate logical cells for spawn and contour tasks.

- [ ] **Step 1: Write failing demand tests**

Test deterministic dedupe, wrapped camera-distance priority, filter-footprint halo,
bounded displacement halo, current/next required intent, prefetch intent, per-runtime
producer ownership, capacity rejection, and stale frame/residency provenance.

```ts
export type FlowDemandFrame = Readonly<{
    view: GeoViewSnapshot
    generation: number
    requestedLevel: number
    candidatePages: readonly VirtualRasterPageIdentity[]
    candidateCells: readonly FlowCandidateCell[]
}>

export type FlowCandidateCell = Readonly<{
    page: VirtualRasterPageIdentity
    requestedLevel: number
    cellX: number
    cellY: number
}>

export type FlowDemandCoordinator = Readonly<{
    encode(builder: SubmissionBuilder, view: GeoViewSnapshot): FlowDemandFrame
    reconcile(frame: FlowDemandFrame): Promise<unknown>
    dispose(): Promise<void>
}>
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npx mocha tests/flow-field-demand.test.js`

Expected: FAIL because `flow-demand.ts` is absent.

- [ ] **Step 3: Implement current public cover/demand composition**

Create one `GpuWebMercatorQuadCover` with flat `[0, 0]` vertical bounds and one
`GpuWebMercatorQuadDemandProjection` for velocity source coverage. Expand feedback by
one logical filter texel plus
`ceil(maxSpeed * predictionSeconds / pageWorldExtent)`, dedupe page keys, and enforce
capacity before fan-out. Pass identical descriptors through each runtime's own
`viewDemandProducer.produce()`; never reuse producer ids across runtimes. Spawn/contour
candidate cells derive from explicit demand output, not private GPU residency slots.

- [ ] **Step 4: Run gates and commit**

Run focused tests and examples typecheck. After immutable-scope verification, commit
with `Add Flow Field velocity demand`.

---

### Task 6: Add Canonical Particles And The GPU Spawn Index

**Files:**
- Create: `examples/flowField/flow-particle-policy.ts`
- Create: `examples/flowField/flow-spawn-index.ts`
- Create: `examples/flowField/flow-particles.ts`
- Create: `examples/flowField/shaders/spawn-index.compute.wgsl`
- Create: `examples/flowField/shaders/particle-simulation.compute.wgsl`
- Create: `examples/flowField/shaders/particles.wgsl`
- Create: `tests/flow-field-particle-lifecycle.test.js`

**Interfaces:**
- Consumes: temporal sampler and bounded candidate cells from Tasks 4-5.
- Produces: `FlowSpawnIndex`, `FlowParticles`, and immutable lifecycle/provenance facts.

```ts
export type FlowSpawnIndex = Readonly<{
    capacity: number
    encode(builder: SubmissionBuilder, cells: readonly FlowCandidateCell[]): void
    facts(): Readonly<{ count: number; overflow: boolean; dormant: boolean }>
    dispose(): void
}>

export type FlowParticles = Readonly<{
    maximumCount: 262144
    encode(builder: SubmissionBuilder, spawn: FlowSpawnIndex): void
    facts(): Readonly<{ active: number; dormant: number; retired: number }>
    dispose(): void
}>
```

- [ ] **Step 1: Write failing policy and source tests**

Implement the expected pure policy in the test first:

```ts
export function classifyFlowParticle(input: Readonly<{
    available: boolean
    speed: number
    ageSteps: number
    stagnantSteps: number
    activityKill: number
    maximumAgeSteps: number
    maximumStagnantSteps: number
}>): 'alive' | 'retire' {
    return input.available && input.speed >= input.activityKill &&
        input.ageSteps < input.maximumAgeSteps &&
        input.stagnantSteps < input.maximumStagnantSteps
        ? 'alive'
        : 'retire'
}
```

Source-lock a 56-byte particle record: four u32 current limbs, four u32 previous limbs,
vec2f velocity, and u32 age, stagnant age, RNG state, and lifecycle state.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx mocha tests/flow-field-particle-lifecycle.test.js`

Expected: FAIL because particle modules are absent.

- [ ] **Step 3: Implement bounded support-cell compaction**

`FlowSpawnIndex` owns fixed-capacity cell, counter, indirect-count, and overflow buffers.
Its compute pass evaluates `speed >= activitySpawn` with the same temporal snapshot and
compacts canonical candidate cells. Empty output marks particle slots dormant; no CPU
rejection sampling or particle readback exists.

- [ ] **Step 4: Implement canonical simulation and absorbing rebirth**

Use the public WebMercator position codec and WGSL meter advance. Every bounded
integration substep resamples the candidate. Retirement selects a compacted spawn cell,
jitters and revalidates it, then writes current equal to previous, zero velocity, zero
ages, and active state. No old-to-new segment is emitted. Stagnant age and finite
lifetime reclaim exact and near-zero motion.

- [ ] **Step 5: Run gates and commit**

Run focused tests and examples typecheck. After immutable-scope verification, commit
with `Add Flow Field particles`.

---

### Task 7: Derive The Dynamic Contour And Preserve History

**Files:**
- Create: `examples/flowField/flow-contour.ts`
- Create: `examples/flowField/flow-history.ts`
- Create: `examples/flowField/shaders/contour.compute.wgsl`
- Create: `examples/flowField/shaders/contour.wgsl`
- Create: `examples/flowField/shaders/history.wgsl`
- Create: `examples/flowField/shaders/presentation.wgsl`
- Create: `tests/flow-field-contour.test.js`

**Interfaces:**
- Consumes: temporal sampler, candidate cells, Surface size, and previous/current view facts.
- Produces: bounded `FlowContour` indirect draw and two-direction `FlowHistory` composition.

```ts
export type FlowContour = Readonly<{
    encode(builder: SubmissionBuilder, cells: readonly FlowCandidateCell[]): void
    draw: DrawCommand
    observeOverflow(submitted: SubmittedWork): Promise<void>
    dispose(): void
}>

export type FlowHistory = Readonly<{
    resize(size: Readonly<{ width: number; height: number }>): Promise<void>
    encode(builder: SubmissionBuilder, view: GeoViewSnapshot): void
    dispose(): void
}>
```

- [ ] **Step 1: Write failing contour and history tests**

Cover all 16 marching-squares cases, deterministic asymptotic resolution for cases 5
and 10, half-open page ownership, page-edge equality, overflow, ping-pong direction,
`off/clear/reproject`, decay/cutoff, and resize generation.

- [ ] **Step 2: Run tests to verify RED**

Run: `npx mocha tests/flow-field-contour.test.js`

Expected: FAIL because contour/history modules are absent.

- [ ] **Step 3: Implement tiled marching squares and indirect drawing**

The compute pass samples `speed - activityKill` at four logical cell corners through
the temporal accessor, emits at most two line segments per half-open owned cell, writes
indirect vertex count, and records a fixed-size overflow flag. A bounded
`ReadbackCommand` observes only overflow; truncation is forbidden. Disabling contour
skips commands and creates no payload request.

- [ ] **Step 4: Implement viewport history**

Create two `rgba8unorm` history textures and immutable direction bind sets. Preserve
reverse-gather camera reprojection, decay, cutoff, resize, and Surface presentation.
No mask texture is bound; support death completes before particle drawing.

- [ ] **Step 5: Run gates and commit**

Run focused tests and examples typecheck. After immutable-scope verification, commit
with `Add Flow Field contour and history`.

---

### Task 8: Assemble And Register The Flow Field Page

**Files:**
- Create: `examples/flowField/flow-renderer.ts`
- Create: `examples/flowField/map.ts`
- Create: `examples/flowField/application.ts`
- Create: `examples/flowField/main.ts`
- Create: `examples/flowField/index.html`
- Create: `examples/flowField/README.md`
- Modify: `examples/vite.config.ts`
- Modify: `examples/index.html`
- Modify: `README.md`
- Modify: `README_zh.md`
- Modify: `packages/geoscratch/README.md`
- Modify: `packages/geoscratch/README_zh.md`
- Modify: `examples/README.md`
- Modify: `tests/examples-structure.test.js`
- Modify: `tests/workspace-layout.test.js`
- Modify: `tests/assets-layout.test.js`
- Modify: `tests/scratch-examples-target-api.test.js`
- Modify: `tests/audits/scratch-persistent-binding-views-final-parity.mjs`

**Interfaces:**
- Produces: `startFlowFieldApplication(options): Promise<FlowFieldApplication>`.
- Produces: `FlowFieldRenderer.render(capture): GeoFrameResult<FlowFieldFrame>`.
- Registers: route `flowField` and exact title `Flow Field`.

```ts
export type FlowFieldFrame = Readonly<{
    frameNumber: number
    temporal: TemporalVelocitySnapshot
    submitted: SubmittedWork
}>

export type FlowFieldRenderer = Readonly<{
    render(capture: GeoViewSourceCapture<MapLibrePlanarCameraState>): GeoFrameResult<FlowFieldFrame>
    dispose(): Promise<void>
}>

export type FlowFieldApplication = Readonly<{
    setPaused(paused: boolean): void
}>
```

- [ ] **Step 1: Write failing structure and assembly tests**

Add `flowField` to browser/standalone inventories and require this shell:

```html
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet" />
<link rel="stylesheet" href="../shared/example.css" />
<title>Flow Field | GeoScratch Examples</title>
<canvas id="GPUFrame"></canvas>
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script type="module" src="./main.ts"></script>
```

Catalog tests require `data-id="flowField"`, `data-path="./flowField/"`, and
`data-title="Flow Field"` adjacent to the unchanged Flow Layer link.

- [ ] **Step 2: Run tests to verify RED**

```bash
npx mocha tests/examples-structure.test.js tests/workspace-layout.test.js \
  tests/assets-layout.test.js tests/scratch-examples-target-api.test.js \
  tests/flow-field-reference-freeze.test.js
```

Expected: FAIL because the route and page do not exist.

- [ ] **Step 3: Implement the renderer and public frame composition**

`FlowFieldRenderer.render()` encodes pending current/next Virtual Raster publication,
cover/demand work, spawn compaction, particle simulation, contour, history, and
presentation in declared order and returns one `GeoFrameResult` with explicit residency
settlement.

`application.ts` composes:

```text
LifetimeScope
  + MapLibre map
  + GPURuntime / Surface
  + velocity Worker/source/temporal runtimes
  + mapLibrePlanarViewSource
  + mapLibreFrameDriver
  + createGeoFrameController(maximumInFlightFrames: 1)
  + FlowFieldRenderer
```

Continuous animation uses `onObserved -> frameController.invalidate()` while running;
camera and residency use the same controller. No local frame controller is created.

- [ ] **Step 4: Add thin bootstrap, page, catalog, and docs**

`main.ts` owns URL parameters, proof import, `LifetimeScope`, status, pagehide, failure,
and disposal only. Add Vite input:

```ts
flowField: path.resolve(examplesRoot, 'flowField/index.html'),
```

Add a Flow Field row to each English/Chinese examples table and retain Flow Layer
unchanged. `examples/README.md` states that missing capability stays example-local
pending a later lowering review.

- [ ] **Step 5: Run gates and commit**

```bash
npx mocha tests/examples-structure.test.js tests/workspace-layout.test.js \
  tests/assets-layout.test.js tests/scratch-examples-target-api.test.js \
  tests/flow-field-reference-freeze.test.js
node tests/audits/scratch-persistent-binding-views-final-parity.mjs
npm run typecheck
npm run build
git diff --exit-code 2353553 -- examples/flowLayer packages/geoscratch/src
```

Expected: PASS and two independent Flow pages. Commit with `Register Flow Field example`.

---

### Task 9: Prove Native WebGPU Behavior And Document The Decision

**Files:**
- Create: `tests/browser/support/flow-field-proof.ts`
- Create: `tests/browser/scratch-flow-field.mjs`
- Create: `docs/decisions/ADR-090-flow-field-velocity-only-virtual-raster.md`
- Modify: `docs/review/geo-virtual-raster-flow-readiness.md`
- Modify: `AGENTS.md`
- Modify: `examples/flowField/README.md`
- Modify: `tests/geo-virtual-raster-flow-readiness.test.js`

**Interfaces:**
- Produces: bounded machine-readable `FlowFieldProofFacts` and independent browser lifecycle evidence.
- Records: Flow Layer freeze, Flow Field ownership, velocity-only data surface, and example-local lowering boundary.

- [ ] **Step 1: Write the browser validator before proof instrumentation**

Require these exact aggregate facts:

```text
status=ready
identity=Flow Field
particleMaximum=262144
temporalSlots<=3
current/next/prefetch distinct
two complete 27-time cycles in proof cadence
spawnOutsideSupport=0
crossSupportSegments=0
zeroAndNearZeroRetiredWithinBound=true
contourPageSeams=0
boundary/depth/wet/SDF/vectorFeatureRequestCount=0
pendingWorkAfterDrain=0
uncapturedErrors=0
deviceLosses=0
```

Add failure scenarios for checksum mismatch, invalid simulation WGSL, stale time page,
tile service loss, spawn overflow, contour overflow, and disposal during load.

- [ ] **Step 2: Run proof to verify RED**

Start the tile service on port 8788 and run `node tests/browser/scratch-flow-field.mjs`.

Expected: FAIL because proof instrumentation is absent. Native headed verification must
follow repository display etiquette: isolated Chrome, background non-activating launch
on a confirmed non-main display, then CDP connection. Without that confirmation, run
non-visual checks and report the native visual limitation instead of stealing focus.

- [ ] **Step 3: Add bounded proof instrumentation**

Development-only proof import exposes aggregate facts, never unbounded frame/page
history. Proof cadence uses two frames per time so two 27-time cycles finish in 108
observed frames; normal cadence remains 300. Network auditing filters only the Flow
Field tile-server namespace so MapLibre basemap traffic is not misclassified.

- [ ] **Step 4: Record the accepted architecture**

ADR-090 records the frozen Flow Layer, active Flow Field, velocity-only payload, public
Geo/Scratch-first composition, example-local missing primitives, and later lowering
gate. Update the living Flow readiness review so its destination is Flow Field rather
than mutation of Flow Layer. Update `AGENTS.md` with exact identity/freeze/downstream
rules. Update the readiness source test to require `Flow Field`, the frozen Flow Layer,
and no direct migration wording. No current API page changes are needed because package
exports remain unchanged.

- [ ] **Step 5: Run the complete verification contract**

```bash
examples/flowField/tile-server/.venv/bin/python -m pytest \
  examples/flowField/tile-server/tests -q
npm --workspace examples run workers:build
npm run docs:check
npm run typecheck
npm test
npm run build
node tests/browser/scratch-flow-field.mjs
node tests/browser/scratch-flow-layer.mjs
git diff --exit-code 2353553 -- examples/flowLayer packages/geoscratch/src
git diff --check
git status --short
```

Expected: every command passes, browser/service processes close, frozen paths show no
diff, and status contains only intended Task 9 changes before commit.

- [ ] **Step 6: Commit**

Commit with `Verify Flow Field lifecycle`.

---

## Final Acceptance

Implementation is complete only when:

1. Flow Field is independently navigable and titled exactly `Flow Field`.
2. Flow Layer source and behavior remain frozen and its browser proof passes.
3. `packages/geoscratch/src/` remains unchanged.
4. Normal Flow Field network/cache traces contain only manifest and RG32F velocity pages.
5. Temporal runtime count, requests, staging, atlas, spawn, contour, particle, history,
   diagnostics, and cleanup are bounded and observable.
6. Cold-start support expansion, dormant activation, zero-speed reclamation, absorbing
   rebirth, common-LoD temporal interpolation, and cross-page contour seams pass native
   WebGPU evidence.
7. No implementation-specific primitive is lowered into Geo or Scratch; candidates are
   documented for the next design discussion.
