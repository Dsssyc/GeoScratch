# DEM Cache Configuration Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a polished, persistent DEM cache configuration panel whose validated draft is applied only through an explicit page reload.

**Architecture:** Keep URL/storage resolution in a pure example-owned TypeScript module and keep Tweakpane/DOM/location behavior in a separate browser adapter. The existing `readDemCachePolicy()` remains the only runtime parser; the panel only produces its established query contract before DEM runtime initialization.

**Tech Stack:** TypeScript 6, Tweakpane 4.0.5, URLSearchParams, localStorage, Mocha/Chai, Playwright, Vite.

## Global Constraints

- Do not hot-switch a running Worker, `PersistentCache`, or GPU virtual raster.
- Keep all panel code under `examples/demLayer/`; do not export it from `geoscratch`.
- Persist only versioned configuration, never cache entries, payloads, metadata, keys, or diagnostics.
- Preserve every non-cache URL parameter during apply/reset.
- Explicit cache URL parameters outrank local preferences and remain strictly validated.
- `Restore defaults` resets configuration only; it does not delete durable IndexedDB/OPFS data.
- Do not stage or modify the user's existing `AGENTS.md` change.
- Do not push during this goal.

---

### Task 1: Pure cache panel configuration state

**Files:**
- Create: `examples/demLayer/dem-cache-panel-state.ts`
- Modify: `examples/demLayer/dem-cache-policy.ts`
- Modify: `tests/geo-virtual-raster-dem.test.js`

**Interfaces:**
- Produces `DemCachePanelConfig`, `DemCachePanelResolution`, `DEM_CACHE_PANEL_DEFAULT_CONFIG`, `DEM_CACHE_PANEL_STORAGE_KEY`, `resolveDemCachePanelConfig()`, `serializeDemCachePanelConfig()`, `replaceDemCacheParameters()`, and `removeDemCacheParameters()`.
- Consumes the existing `readDemCachePolicy(URLSearchParams): DemCachePolicy` as the final validator.

- [ ] **Step 1: Write RED tests for the semantic configuration model**

Add focused tests that import the planned module and prove:

```js
expect(resolveDemCachePanelConfig(new URLSearchParams(), null)).to.deep.include({
    source: 'default',
    storageStatus: 'missing',
    config: DEM_CACHE_PANEL_DEFAULT_CONFIG,
})

const stored = serializeDemCachePanelConfig({
    policy: 'durable',
    namespace: 'editable-dem',
    maxMiB: 512,
    maxEntries: 8192,
    persistence: 'request',
})
expect(resolveDemCachePanelConfig(new URLSearchParams(), stored).source).to.equal('storage')

expect(resolveDemCachePanelConfig(
    new URLSearchParams('cache=none'),
    stored
).source).to.equal('url')

expect(() => resolveDemCachePanelConfig(
    new URLSearchParams('cacheLifecycle=session'),
    stored
)).to.throw()
```

Also cover all four policy mappings, invalid JSON/schema/fields, duplicate URL parameters, unrelated parameter preservation, and defaults reset.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- --grep "DEM cache panel"
```

Expected: FAIL because `dem-cache-panel-state.ts` does not exist.

- [ ] **Step 3: Export query bounds and implement strict state resolution**

Expose immutable defaults, limits, and parameter names from `dem-cache-policy.ts` so UI code cannot duplicate them:

```ts
export const DEM_CACHE_POLICY_DEFAULTS = Object.freeze({
    namespace: 'geoscratch-dem-webmercator-raw-v2',
    maxMiB: 128,
    maxEntries: 2048,
    persistence: 'best-effort' as const,
    lifecycle: 'session' as const,
})

export const DEM_CACHE_POLICY_LIMITS = Object.freeze({
    minMiB: 1,
    maxMiB: 4096,
    minEntries: 1,
    maxEntries: 65_536,
})

export const DEM_CACHE_PARAMETER_NAMES = Object.freeze([
    'cache',
    'cacheNamespace',
    'cacheLifecycle',
    'cacheMaxMiB',
    'cacheMaxEntries',
    'cachePersistence',
] as const)
```

Then implement the pure module:

The pure module must:

```ts
export function resolveDemCachePanelConfig(
    current: URLSearchParams,
    stored: string | null
): DemCachePanelResolution

export function serializeDemCachePanelConfig(config: DemCachePanelConfig): string

export function replaceDemCacheParameters(
    current: URLSearchParams,
    config: DemCachePanelConfig
): URLSearchParams

export function removeDemCacheParameters(current: URLSearchParams): URLSearchParams
```

Use a discriminated storage status of `missing | valid | invalid`. Any cache-prefixed URL parameter must be validated as explicit URL state before storage is considered. Generated persistent queries always include all six canonical parameters; disabled output includes only `cache=none`.

- [ ] **Step 4: Run focused and adjacent tests GREEN**

Run:

```bash
npm test -- --grep "DEM cache"
npm run typecheck
```

Expected: all matching tests and typechecks pass.

- [ ] **Step 5: Commit the pure model**

```bash
git add examples/demLayer/dem-cache-policy.ts \
    examples/demLayer/dem-cache-panel-state.ts \
    tests/geo-virtual-raster-dem.test.js
git commit -m "Add DEM cache panel configuration model"
```

---

### Task 2: Tweakpane browser integration

**Files:**
- Create: `examples/demLayer/dem-cache-panel.ts`
- Create: `examples/demLayer/dem-cache-panel.css`
- Modify: `examples/demLayer/index.html`
- Modify: `examples/demLayer/main.ts`
- Modify: `examples/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes the Task 1 configuration functions.
- Produces `prepareDemCachePanel()` returning `{ parameters, config, source, storageStatus, mount() }` and a mounted `{ dispose() }` owner.

- [ ] **Step 1: Install the pinned panel dependency**

Run:

```bash
npm install --workspace examples tweakpane@4.0.5
```

Expected: only `examples/package.json` and `package-lock.json` dependency metadata change.

- [ ] **Step 2: Add the panel mount point and scoped visual treatment**

Add `<aside id="DemCachePanel" aria-label="DEM cache configuration"></aside>` after the canvas. Style it as a fixed 304 px dark tool surface with `max-width: calc(100vw - 24px)`, neutral borders, restrained teal focus/accent, no gradients, and a z-index above MapLibre/WebGPU. On viewports no wider than 640 px, initialize the pane collapsed.

- [ ] **Step 3: Implement safe browser storage preparation**

`prepareDemCachePanel()` must safely acquire/probe `window.localStorage`, remove malformed stored state when possible, resolve effective parameters before `readDemCachePolicy()`, and retain an explicit availability fact:

```ts
const prepared = prepareDemCachePanel({
    parameters: new URLSearchParams(window.location.search),
    storage: window.localStorage,
    location: window.location,
})

const cachePolicy = readDemCachePolicy(prepared.parameters)
const panel = prepared.mount()
```

Storage access failures must not prevent URL/default operation.

- [ ] **Step 4: Build the complete Tweakpane controls**

Create:

```text
DEM Cache
  Cache policy: Disabled | Session | Durable | Clear on open
  Status: Saved | Unsaved changes | Invalid configuration | Local preference unavailable
  Advanced (collapsed)
    Namespace
    Maximum MiB
    Maximum entries
    Persistence: Best effort | Request
  Apply & Reload
  Restore defaults
```

Keep a mutable draft separate from the frozen effective config. Disable Advanced controls for `disabled`; disable Apply until the draft differs and validates through the existing policy parser.

- [ ] **Step 5: Implement apply/reset navigation**

Apply must serialize validated state, write it when storage is available, replace only cache query keys in a `new URL(window.location.href)`, and call `location.replace(url.href)`. Reset must remove the storage key, remove all cache query keys, preserve pathname/hash/unrelated query, and reload. Both actions must remain functional through full URL state when storage writes fail.

- [ ] **Step 6: Integrate with DEM lifecycle and facts**

Prepare parameters before the module-level `readDemCachePolicy()` call. Mount the panel after `createDemLifecycle()` and register `panel.dispose()` with `pageLifetime.deferStop()`. Publish panel source/storage status as bounded canvas dataset facts for the browser proof; do not include the stored JSON or namespace history.

- [ ] **Step 7: Run static gates**

Run:

```bash
npm run typecheck
npm run build
npm test -- --grep "DEM cache"
```

Expected: all commands pass and Vite includes Tweakpane locally.

- [ ] **Step 8: Commit the UI integration**

```bash
git add examples/demLayer/dem-cache-panel.ts \
    examples/demLayer/dem-cache-panel.css \
    examples/demLayer/index.html \
    examples/demLayer/main.ts \
    examples/package.json package-lock.json
git commit -m "Add DEM cache configuration panel"
```

---

### Task 3: Browser proof and documentation

**Files:**
- Create: `tests/browser/dem-cache-panel.mjs`
- Modify: `examples/demLayer/README.md`

**Interfaces:**
- Exercises the real bundled Tweakpane controls and existing DEM runtime facts in Chrome/WebGPU.

- [ ] **Step 1: Write the focused browser proof**

The script must start the existing COG tile service and Vite on available ports, launch Chrome with WebGPU, and verify:

```text
bare URL -> Disabled/default
edit full durable configuration -> Unsaved changes without runtime mutation
Apply & Reload -> canonical URL + localStorage + runtime facts agree
bare URL in the same origin -> stored configuration restored
explicit cache=none -> URL overrides stored durable preference
Restore defaults -> storage key and cache query keys removed, runtime returns to none
```

Also emulate localStorage unavailability in a separate context and prove explicit URL configuration still reaches `ready` while the panel reports degradation.

- [ ] **Step 2: Add visual and accessibility assertions**

Capture desktop 1440×900 and mobile 390×844 screenshots. Assert the panel bounding box remains inside the viewport, the collapsed mobile pane does not cover the primary map viewport, all visible values fit their controls, the apply/reset buttons are keyboard reachable, and no console/page/WebGPU error occurs.

- [ ] **Step 3: Run the focused proof GREEN**

Run:

```bash
GEO_VIRTUAL_RASTER_DEM_HEADLESS=1 node tests/browser/dem-cache-panel.mjs
```

Expected: terminal JSON reports `status: "passed"`, all spawned processes close, and screenshot paths are reported.

- [ ] **Step 4: Update DEM usage documentation**

Document panel semantics, complete controls, `Apply & Reload`, storage key, URL precedence, localStorage degradation, and the fact that reset does not delete durable cache payloads.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm run typecheck
npm test
npm run build
node tests/browser/scratch-persistent-cache.mjs
GEO_VIRTUAL_RASTER_DEM_HEADLESS=1 node tests/browser/dem-cache-panel.mjs
GEO_VIRTUAL_RASTER_DEM_HEADLESS=1 node tests/browser/geo-virtual-raster-dem.mjs
git diff --check
```

Expected: all deterministic gates pass. If the existing DEM cancellation timing assertion alone remains red in headless Chrome, record its exact evidence separately and do not weaken it.

- [ ] **Step 6: Commit proof and docs**

```bash
git add tests/browser/dem-cache-panel.mjs examples/demLayer/README.md
git commit -m "Verify DEM cache configuration panel"
```

- [ ] **Step 7: Final bounded review**

Confirm `git status --short` contains only the user's pre-existing `AGENTS.md` modification, inspect the three feature commits, and report either `confirmed-clean` or exact remaining findings. Do not push.
