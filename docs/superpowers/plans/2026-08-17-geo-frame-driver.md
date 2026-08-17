# Geo Frame Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one composable Geo frame-driver boundary so MapLibre-hosted and independent GeoScratch applications use the same frame controller and renderer without application-owned host scheduling state.

**Architecture:** `GeoFrameController` optionally owns a `GeoFrameDriver<Capture>` that supplies capture, scheduling, and lifecycle. A dependency-light MapLibre driver implements that contract with a no-draw custom layer; the existing descriptor capture/scheduler path remains the independent and low-level path.

**Tech Stack:** TypeScript 6, MapLibre GL JS 4.7.1 structural API, WebGPU, Mocha/Chai, Vite, Playwright Chrome CDP.

## Global Constraints

- Keep `geoscratch/geo` dependency-light and do not import MapLibre.
- Do not add renderer mode flags or a second frame controller.
- `driver` is mutually exclusive with descriptor-level `capture` and `scheduler`.
- A supplied driver is owned and stopped by `GeoFrameController`.
- The MapLibre custom layer performs no WebGL work.
- English API documentation is canonical and Chinese is its reviewed translation.
- Underwater Terrain remains a thin application and does not own host frame revisions.

---

### Task 1: Add The Driver Contract And Synchronous Frame Admission

**Files:**
- Modify: `packages/geoscratch/src/geo/frame-controller.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `tests/geo-frame-controller.test.js`
- Modify: `tests/types/public-api.ts`

**Interfaces:**
- Produces: `GeoFrameDriver<Capture>` with `id`, `scheduler`, `capture`, `start`, and `stop`.
- Produces: `GeoFrameControllerDescriptor.driver?: GeoFrameDriver<Capture>`.
- Preserves: descriptor-level `capture` plus `scheduler` for independent/manual use.

- [ ] **Step 1: Write failing controller tests**

Add tests proving that `render()` is invoked before the scheduler callback returns, a driver starts once, `controller.stop()` stops it once, and mixed driver/capture or driver/scheduler descriptors fail with `GEO_FRAME_CONTROLLER_INVALID`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npm --workspace geoscratch run build && npx mocha tests/geo-frame-controller.test.js
```

Expected: failures because `GeoFrameDriver` and `descriptor.driver` do not exist and render admission is deferred through a Promise microtask.

- [ ] **Step 3: Implement the driver contract**

Add the public contract:

```ts
export type GeoFrameDriver<Capture> = Readonly<{
    kind: 'geo-frame-driver'
    id: string
    scheduler: GeoFrameScheduler
    capture(): GeoFrameCapture<Capture>
    start(invalidate: () => boolean): void
    stop(): boolean
}>
```

Validate and defensively bind it. Reject simultaneous descriptor-level `driver` and
`capture`/`scheduler`. Invoke `render()` synchronously, then wrap its returned Promise-like
result for observation. Start the driver after the frozen controller object exists and stop
it idempotently from `controller.stop()`.

- [ ] **Step 4: Add public type coverage and run GREEN**

Run:

```bash
npm --workspace geoscratch run build && npx mocha tests/geo-frame-controller.test.js
npm run typecheck
```

Expected: focused tests and public typecheck pass.

- [ ] **Step 5: Commit the controller slice**

```bash
git add packages/geoscratch/src/geo/frame-controller.ts packages/geoscratch/src/geo/index.ts tests/geo-frame-controller.test.js tests/types/public-api.ts
git commit -m "Add Geo frame driver contract"
```

### Task 2: Implement The Dependency-Light MapLibre Driver

**Files:**
- Create: `packages/geoscratch/src/geo/maplibre-frame-driver.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Create: `tests/maplibre-frame-driver.test.js`
- Modify: `tests/types/public-api.ts`

**Interfaces:**
- Consumes: `GeoFrameDriver<Capture>`, `GeoFrameCapture<Capture>`, and `GeoFrameScheduler`.
- Produces: `mapLibreFrameDriver<Capture>(descriptor): MapLibreFrameDriver<Capture>`.
- Produces: structural `MapLibreFrameMap`, descriptor, layer, and driver types.

- [ ] **Step 1: Write failing MapLibre driver tests**

Use a fake structural map to prove initial attachment, `triggerRepaint()` scheduling,
callback execution inside custom-layer `render`, one capture per host revision, `move` and
`resize` invalidation, style-load reattachment, duplicate-id diagnostics, queued callback
cancellation, and idempotent stop.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npm --workspace geoscratch run build && npx mocha tests/maplibre-frame-driver.test.js
```

Expected: module/export resolution fails because the driver does not exist.

- [ ] **Step 3: Implement the structural driver**

The factory captures descriptor functions once, installs this no-draw layer shape, and
does not inspect callback arguments:

```ts
{
    id,
    type: 'custom',
    renderingMode: '2d',
    render(..._arguments: unknown[]) {
        flushScheduledFrame()
    },
}
```

The scheduler stores bounded callbacks by numeric handle and requests a host repaint.
Host `move`/`resize` events advance a monotonic revision, clear the cached capture, and call
the controller invalidator supplied to `start()`.

- [ ] **Step 4: Export, typecheck, and run GREEN**

Run:

```bash
npm --workspace geoscratch run build && npx mocha tests/maplibre-frame-driver.test.js tests/geo-frame-controller.test.js
npm run typecheck
```

Expected: driver/controller tests and public type coverage pass.

- [ ] **Step 5: Commit the MapLibre driver slice**

```bash
git add packages/geoscratch/src/geo/maplibre-frame-driver.ts packages/geoscratch/src/geo/index.ts tests/maplibre-frame-driver.test.js tests/types/public-api.ts
git commit -m "Add MapLibre Geo frame driver"
```

### Task 3: Migrate Underwater Terrain To The Host Driver

**Files:**
- Modify: `examples/underwaterTerrain/main.ts`
- Modify: `examples/underwaterTerrain/map.ts`
- Modify: `tests/scratch-underwater-terrain-clean-cut.test.js`
- Modify: `tests/browser/support/underwater-terrain-proof.ts` only if proof facts need the driver identity.

**Interfaces:**
- Consumes: `createGeoFrameController({ driver: mapLibreFrameDriver(...) })`.
- Removes: application-owned host revision cache and MapLibre render/move/resize frame listeners.
- Preserves: window resize ownership for calling `map.resize()`.

- [ ] **Step 1: Add a failing structural ownership test**

Require `main.ts` to use `mapLibreFrameDriver`, reject `map.on('render')`, reject a local
`hostViewRevision`, and retain only the window resize bridge needed to invoke `map.resize()`.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx mocha tests/scratch-underwater-terrain-clean-cut.test.js
```

Expected: structural test fails against the current event-owned example.

- [ ] **Step 3: Replace local frame authority with the driver**

Nest the driver in the existing controller descriptor. Its capture callback reads and
caches camera plus canvas size per driver revision. Remove manual MapLibre listener cleanup,
remove `frameController.invalidate()` after `jumpTo()`, and let all presentation and
convergence invalidations schedule through MapLibre repaint.

- [ ] **Step 4: Run focused unit and type gates**

Run:

```bash
npx mocha tests/scratch-underwater-terrain-clean-cut.test.js tests/maplibre-frame-driver.test.js tests/geo-frame-controller.test.js
npm run typecheck
```

Expected: all focused tests and typecheck pass.

- [ ] **Step 5: Commit the example migration**

```bash
git add examples/underwaterTerrain/main.ts examples/underwaterTerrain/map.ts tests/scratch-underwater-terrain-clean-cut.test.js tests/browser/support/underwater-terrain-proof.ts
git commit -m "Drive terrain frames from MapLibre"
```

### Task 4: Record The Public Contract And Verify End To End

**Files:**
- Create: `docs/decisions/ADR-079-geo-frame-driver-authority.md`
- Modify: `docs/api/geo/views-frames.md`
- Modify: `docs/api/geo/views-frames_zh.md`
- Modify: `examples/underwaterTerrain/README.md`
- Regenerate: `docs/api/reference/geo.md`
- Regenerate: `docs/api/reference/geo-api.json`
- Regenerate: `docs/api/reference/api-docs.json`

**Interfaces:**
- Documents: independent controller mode, driver-owned host mode, ownership, lifecycle,
  synchronous admission, and the two-context limitation.

- [ ] **Step 1: Write the ADR and bilingual current API documentation**

State present-tense behavior only. Cite the MapLibre 4.7.1 custom-layer source and current
official interface documentation. Update the example README from post-render events to the
custom-layer frame driver.

- [ ] **Step 2: Regenerate and validate documentation**

Run:

```bash
npm run docs:generate
npm run docs:translations
npm run docs:check
```

Expected: generated references, coverage, links, and translation digests pass.

- [ ] **Step 3: Run full static and unit gates**

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected: zero failures; only previously accepted build-size warnings may remain.

- [ ] **Step 4: Run the real WebGPU browser proof**

Start or reuse isolated development servers, then run the repository's Underwater Terrain
browser proof and performance gate. Verify camera motion, vertical/pitched LoD scenarios,
A-to-B-to-A revision stability, capture-to-submission lag, one in-flight frame, zero stale
transitions, zero console/page errors, and complete disposal.

- [ ] **Step 5: Review the final diff and commit**

```bash
git diff --check
git status --short
git add docs/decisions/ADR-079-geo-frame-driver-authority.md docs/api examples/underwaterTerrain/README.md
git commit -m "Document Geo frame driver authority"
```
