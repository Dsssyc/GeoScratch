# DEM Tile Wireframe Debug View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, live-switchable DEM tile wireframe pipeline whose stable logical-tile colors expose GPU scheduling and the exact post-stitch triangle topology.

**Architecture:** Keep one terrain vertex entry point so shaded and diagnostic draws execute identical fixed-coordinate, virtual-raster, LoD-map, and mesh-stitching logic. Pre-create a second fragment program, pipeline, and parity command set; a graph presentation state selects one immutable command at submission time. Evolve the cache-only Tweakpane into a DEM control panel with an independently persisted live rendering checkbox.

**Tech Stack:** TypeScript, WGSL, Scratch `GPURuntime`, GPU indirect draws, Tweakpane 4, Mocha/Chai, Playwright with real Chrome WebGPU.

## Global Constraints

- Tile color is keyed only by `(matrixLevel, tileRow, tileCol)`, never `physicalSlot`.
- The diagnostic draw uses the existing terrain vertex entry point and the existing GPU-produced indirect argument.
- Both terrain programs, pipelines, and parity command sets are created before the first frame.
- A mode switch allocates no CPU/GPU data and performs no upload, compilation, bind-set preparation, frontier reset, or virtual-raster mutation.
- The checkbox switches live, persists independently in `localStorage`, and never requires `Apply & Reload`.
- Invalid or unavailable preference storage falls back to shaded terrain without blocking initialization.
- The feature remains example-owned under `examples/demLayer/`; no tile-specific Scratch or Geo API is added.
- Preserve the user-owned `AGENTS.md` working-tree change and do not stage it.

---

### Task 1: Rendering Preference State

**Files:**
- Create: `examples/demLayer/dem-rendering-preference.ts`
- Modify: `tests/geo-virtual-raster-dem.test.js`

**Interfaces:**
- Produces: `DEM_RENDERING_PREFERENCE_STORAGE_KEY`, `DemRenderingPreference`, `resolveDemRenderingPreference(serialized)`, and `serializeDemRenderingPreference(preference)`.
- Consumes: a nullable raw `localStorage` string; no DOM or GPU dependency.

- [ ] **Step 1: Write the failing preference tests**

Add cases that require the default, valid round trip, strict rejection of malformed/version-mismatched state, and a boolean-only payload:

```js
expect(resolveDemRenderingPreference(null)).to.deep.equal({
    preference: { tileWireframe: false },
    storageStatus: 'missing',
})
const stored = serializeDemRenderingPreference({ tileWireframe: true })
expect(resolveDemRenderingPreference(stored)).to.deep.equal({
    preference: { tileWireframe: true },
    storageStatus: 'valid',
})
expect(resolveDemRenderingPreference('{"version":2,"tileWireframe":true}').storageStatus)
    .to.equal('invalid')
expect(resolveDemRenderingPreference('{"version":1,"tileWireframe":"yes"}').storageStatus)
    .to.equal('invalid')
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --grep "DEM rendering preference"`

Expected: FAIL because `dem-rendering-preference.ts` does not exist.

- [ ] **Step 3: Implement the strict versioned codec**

Implement immutable values and a non-throwing read boundary:

```ts
export const DEM_RENDERING_PREFERENCE_STORAGE_KEY =
    'geoscratch.examples.demLayer.rendering.v1'

export type DemRenderingPreference = Readonly<{ tileWireframe: boolean }>

export function resolveDemRenderingPreference(serialized: string | null) {
    if (serialized === null) return Object.freeze({
        preference: Object.freeze({ tileWireframe: false }),
        storageStatus: 'missing' as const,
    })
    try {
        const value: unknown = JSON.parse(serialized)
        if (!isRecord(value) || value.version !== 1 ||
            typeof value.tileWireframe !== 'boolean' ||
            Object.keys(value).some(key => ![ 'version', 'tileWireframe' ].includes(key))) {
            throw new TypeError('invalid DEM rendering preference')
        }
        return Object.freeze({
            preference: Object.freeze({ tileWireframe: value.tileWireframe }),
            storageStatus: 'valid' as const,
        })
    } catch {
        return Object.freeze({
            preference: Object.freeze({ tileWireframe: false }),
            storageStatus: 'invalid' as const,
        })
    }
}
```

`serializeDemRenderingPreference()` must validate the boolean and emit exactly
`{"version":1,"tileWireframe":<boolean>}`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --grep "DEM rendering preference"`

Expected: PASS.

- [ ] **Step 5: Commit the preference model**

```bash
git add examples/demLayer/dem-rendering-preference.ts tests/geo-virtual-raster-dem.test.js
git commit -m "Add DEM rendering preference model"
```

### Task 2: Persistent Tile Wireframe Rendering Path

**Files:**
- Modify: `examples/demLayer/shaders/terrain-mesh.wgsl`
- Modify: `examples/demLayer/dem-layer.ts`
- Modify: `tests/scratch-dem-layer-clean-cut.test.js`

**Interfaces:**
- Produces: `DemTerrainPresentation = 'shaded' | 'tile-wireframe'`, `setTerrainPresentation(presentation)`, and `state().terrainPresentation`.
- Consumes: the existing terrain shader source, visible-instance logical tile fields, existing indirect draw arguments, bind sets, pass, and resources.

- [ ] **Step 1: Write failing shader and graph-contract tests**

Require the exact diagnostic contract and persistent graph shape:

```js
expect(terrainShader).to.include('@location(5) barycentric: vec3f')
expect(terrainShader).to.include('@location(6) @interpolate(flat) tileColor: vec3f')
expect(terrainShader).to.include('fn logicalTileColor(')
expect(terrainShader).to.include('@fragment\nfn fTileWireframe(')
expect(terrainShader).to.include('fwidth(input.barycentric)')
expect(terrainShader).to.include('discard;')
expect(terrainShader.slice(
    terrainShader.indexOf('fn logicalTileColor('),
    terrainShader.indexOf('@vertex')
)).not.to.include('physicalSlot')
```

Extend the fake-GPU graph test to require three programs, three pipelines, six
draw commands, stable identities across both presentation switches, and the
submitted pipeline changing between shaded and wireframe frames.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --grep "DEM Layer clean cut"`

Expected: FAIL because the wireframe shader entry point, pipeline, commands, and presentation setter do not exist.

- [ ] **Step 3: Add barycentric and logical-tile outputs to the shared vertex path**

Use vertex invocation order to assign barycentrics and a deterministic integer hash:

```wgsl
fn barycentricForVertex(vertexIndex: u32) -> vec3f {
    let corner = vertexIndex % 3u;
    return vec3f(
        select(0.0f, 1.0f, corner == 0u),
        select(0.0f, 1.0f, corner == 1u),
        select(0.0f, 1.0f, corner == 2u),
    );
}

fn logicalTileColor(instance: GpuTileFrontierVisibleInstance) -> vec3f {
    var hash = instance.matrixLevel * 0x9e3779b9u;
    hash = hash ^ (instance.tileRow * 0x85ebca6bu);
    hash = hash ^ (instance.tileCol * 0xc2b2ae35u);
    hash = (hash ^ (hash >> 16u)) * 0x7feb352du;
    hash = (hash ^ (hash >> 15u)) * 0x846ca68bu;
    hash = hash ^ (hash >> 16u);
    return vec3f(
        0.35f + 0.65f * f32(hash & 255u) / 255.0f,
        0.35f + 0.65f * f32((hash >> 8u) & 255u) / 255.0f,
        0.35f + 0.65f * f32((hash >> 16u) & 255u) / 255.0f,
    );
}
```

Assign both outputs on every vertex return path. Implement
`fTileWireframe()` with `fwidth`, `smoothstep`, interior `discard`, and
premultiplied output.

- [ ] **Step 4: Pre-create and select both immutable terrain paths**

Create a second program using the same vertex entry point and
`fTileWireframe`; create the matching pipeline and parity commands during graph
construction. Store commands as:

```ts
type DemTerrainPresentation = 'shaded' | 'tile-wireframe'
type TerrainCommands = Readonly<Record<
    DemTerrainPresentation,
    readonly [DrawCommand, DrawCommand]
>>
```

Add `setTerrainPresentation()` with enum validation and disposed-state
rejection. In `renderFrame()`, snapshot the current presentation once and use
that command for submission and provenance verification. Include every
persistent path in identity snapshots and contract facts.

- [ ] **Step 5: Run focused tests, typecheck, and verify GREEN**

Run:

```bash
npm test -- --grep "DEM Layer clean cut"
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit the persistent rendering path**

```bash
git add examples/demLayer/shaders/terrain-mesh.wgsl examples/demLayer/dem-layer.ts tests/scratch-dem-layer-clean-cut.test.js
git commit -m "Add persistent DEM tile wireframe pipeline"
```

### Task 3: Live DEM Control Panel

**Files:**
- Move: `examples/demLayer/dem-cache-panel.ts` to `examples/demLayer/dem-control-panel.ts`
- Move: `examples/demLayer/dem-cache-panel.css` to `examples/demLayer/dem-control-panel.css`
- Modify: `examples/demLayer/index.html`
- Modify: `examples/demLayer/main.ts`
- Modify: `tests/browser/dem-cache-panel.mjs`
- Modify: `examples/demLayer/README.md`

**Interfaces:**
- Produces: `prepareDemControlPanel()`, a `Rendering` checkbox callback, and DOM facts `terrainPresentation`, `wireframeEnabled`, and `renderingStorageStatus`.
- Consumes: Task 1 preference codec and Task 2 `setTerrainPresentation()`.

- [ ] **Step 1: Extend the browser panel proof and verify RED**

Require `#DemControlPanel`, pane title `DEM Layer`, tagged `rendering` and
`tile-wireframe` controls, a `Cache` folder, immediate callback state, and
persisted reload state. The proof must verify the checkbox does not click
`Apply & Reload` and cache URL parameters remain unchanged.

Run: `GEO_VIRTUAL_RASTER_DEM_HEADLESS=1 node tests/browser/dem-cache-panel.mjs`

Expected: FAIL because the generalized panel and wireframe checkbox do not exist.

- [ ] **Step 2: Generalize the panel without coupling cache and rendering state**

Rename the panel owner and container to `DemControlPanel`. Build this hierarchy:

```ts
const pane = new Pane({ title: 'DEM Layer', container: options.container })
const rendering = pane.addFolder({ title: 'Rendering', expanded: true })
const tileWireframe = rendering.addBinding(renderingDraft, 'tileWireframe', {
    label: 'Tile wireframe',
})
const cache = pane.addFolder({ title: 'Cache', expanded: true })
```

On checkbox change, serialize the rendering preference independently, update
the panel dataset, and call `onTileWireframeChange(enabled)`. Storage failure
must update status facts but must not roll back the live mode.

- [ ] **Step 3: Connect the panel to the graph and frame scheduler**

Resolve the preference before initialization. Keep the latest checkbox value
while async graph construction is underway, pass it as the graph's initial
presentation, and install a live callback after `requestRender()` exists:

```ts
applyTerrainPresentation = enabled => {
    graph.setTerrainPresentation(enabled ? 'tile-wireframe' : 'shaded')
    requestRender()
}
```

Clear the callback during page stop. Publish active mode and storage facts on
the canvas and panel container.

- [ ] **Step 4: Run panel proof, focused unit tests, build, and typecheck**

Run:

```bash
GEO_VIRTUAL_RASTER_DEM_HEADLESS=1 node tests/browser/dem-cache-panel.mjs
npm test -- --grep "DEM rendering preference|DEM Layer clean cut"
npm run build
npm run typecheck
```

Expected: all commands pass.

- [ ] **Step 5: Commit the live control surface**

```bash
git add examples/demLayer/dem-control-panel.ts examples/demLayer/dem-control-panel.css examples/demLayer/dem-rendering-preference.ts examples/demLayer/index.html examples/demLayer/main.ts examples/demLayer/README.md tests/browser/dem-cache-panel.mjs
git commit -m "Add live DEM tile wireframe control"
```

### Task 4: Real Chrome Tile And Stitching Evidence

**Files:**
- Create: `tests/browser/dem-tile-wireframe.mjs`
- Modify: `examples/package.json`
- Modify: `docs/superpowers/specs/2026-08-07-dem-tile-wireframe-debug-view-design.md` only if browser evidence reveals a factual contradiction.

**Interfaces:**
- Produces: deterministic JSON evidence and shaded/wireframe/restored screenshots under a configurable output directory.
- Consumes: the live checkbox, canvas dataset facts, graph identity facts, runtime diagnostics, DEM tile server, and Vite example server.

- [ ] **Step 1: Write the failing real-browser proof**

The proof must use real Chrome with WebGPU, open a pitched DEM view, wait for
frontier convergence, and capture baseline facts. It then clicks the tagged
checkbox and verifies:

```js
wireframe.terrainPresentation === 'tile-wireframe'
wireframe.stableIdentityHash === baseline.stableIdentityHash
wireframe.pipelineCount === baseline.pipelineCount
wireframe.pageErrors.length === 0
wireframe.consoleErrors.length === 0
wireframe.pixelEvidence.nonTransparentPixels > 0
wireframe.pixelEvidence.colorClusterCount >= 4
```

After the second click it must require shaded restoration with the same graph
identity. Capture screenshots for all three states and include the camera,
frontier, pipeline, command, storage, and pixel facts in terminal JSON.

- [ ] **Step 2: Run the proof and verify RED**

Run: `GEO_VIRTUAL_RASTER_DEM_HEADLESS=1 node tests/browser/dem-tile-wireframe.mjs`

Expected: FAIL until selectors, live facts, pixel classifier, or rendering details are complete.

- [ ] **Step 3: Fix only evidence-backed rendering or integration defects**

Adjust line coverage, premultiplied alpha, panel scheduling, or proof waits only
when the captured browser facts isolate a defect. Do not change LoD selection,
mesh stitching, virtual-raster residency, or cache behavior.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```bash
GEO_VIRTUAL_RASTER_DEM_HEADLESS=1 node tests/browser/dem-tile-wireframe.mjs
GEO_VIRTUAL_RASTER_DEM_HEADLESS=1 node tests/browser/dem-cache-panel.mjs
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all commands pass, the browser proof emits terminal JSON with no
failures, and all three screenshots are nonblank and visually coherent.

- [ ] **Step 5: Review and commit browser evidence**

Review the implementation diff for regressions, inspect the wireframe
screenshot, confirm only `AGENTS.md` remains outside the feature commits, then:

```bash
git add tests/browser/dem-tile-wireframe.mjs examples/package.json
git commit -m "Verify DEM tile wireframe debug view"
```
