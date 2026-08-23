# Unified Adaptive WebMercatorQuad Cover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pitch-gated cover with one adaptive selector and separate geometry-cut, source-demand, and patch-draw ownership without regressing Underwater Terrain.

**Architecture:** `GpuWebMercatorQuadCover` emits only standard geometry-cut products. A new GPU source-demand projection consumes those products and a new patch-draw adapter combines patch count with consumer-owned mesh facts. Terrain remains the first consumer; future feature conformance is documented but not speculatively implemented.

**Tech Stack:** TypeScript, WGSL, WebGPU, Scratch explicit resources/commands/submissions, Mocha/Chai, Playwright browser proofs.

## Global Constraints

- Work on `dev-feature`; do not add a compatibility flag or legacy API alias.
- Keep Scratch domain-neutral and Virtual Raster passive.
- Preserve standard OGC identities, fixed-point camera coordinates, deterministic output, prefix-free completeness, 2:1 adjacency, double-flight parity, and structured diagnostics.
- Write failing behavior/type/structure tests before each production slice.
- Update English current API docs and reviewed Chinese translations.

---

### Task 1: Governance and target contracts

**Files:**
- Create: `docs/decisions/ADR-086-unified-adaptive-webmercator-cover.md`
- Create: `docs/superpowers/specs/2026-08-22-unified-webmercator-cover-design.md`
- Create: `docs/superpowers/specs/2026-08-22-unified-webmercator-cover-design_zh.md`
- Modify: `AGENTS.md`

- [ ] Record the accepted authority split and explicitly supersede pitch-gated portions of ADR-083/084.
- [ ] Replace the obsolete AGENTS pitch-threshold mandate with the unified-selector and separated-demand/draw mandate.
- [ ] Scan the documents for placeholders and contradictions.
- [ ] Commit the documentation authority baseline.

### Task 2: Unified adaptive cover and vertical bounds

**Files:**
- Modify: `tests/geo-webmercator-quad-cover.test.js`
- Modify: `tests/types/public-api.ts`
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-layout.ts`
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-reference.ts`
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-wgsl.ts`
- Modify: `packages/geoscratch/src/geo/gpu-web-mercator-quad-cover.ts`
- Modify: `packages/geoscratch/src/geo/index.ts`

- [ ] Add failing tests proving the policy has no pitch/source/draw fields, feedback has no mode/demands, and all pitches use one adaptive result.
- [ ] Run the focused test and confirm contract failures.
- [ ] Remove the uniform branch and pitch ABI from CPU and GPU paths.
- [ ] Rename cover elevation contracts to vertical bounds and validate complete immutable hierarchy facts.
- [ ] Reduce cover feedback and identity to geometry-cut products.
- [ ] Run focused unit/type tests and commit the unified cover.

### Task 3: GPU source-demand projection

**Files:**
- Create: `packages/geoscratch/src/geo/gpu-web-mercator-quad-demand-layout.ts`
- Create: `packages/geoscratch/src/geo/gpu-web-mercator-quad-demand-wgsl.ts`
- Create: `packages/geoscratch/src/geo/gpu-web-mercator-quad-demand.ts`
- Create: `tests/geo-webmercator-quad-demand.test.js`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `tests/types/public-api.ts`

- [ ] Add failing lifecycle, ownership, deduplication, source-ceiling, priority, overflow, stale-frame, and identity-object tests.
- [ ] Implement persistent parity demand buffers, one bounded compute projection, and bounded feedback readback.
- [ ] Keep desired geometry level and executable request level separate.
- [ ] Run focused tests/typecheck and commit demand projection.

### Task 4: GPU patch-draw preparation

**Files:**
- Create: `packages/geoscratch/src/geo/gpu-web-mercator-quad-patch-draw.ts`
- Create: `tests/geo-webmercator-quad-patch-draw.test.js`
- Modify: `packages/geoscratch/src/geo/index.ts`
- Modify: `tests/types/public-api.ts`

- [ ] Add a failing test proving cover identity has no draw buffer while patch draw owns one indirect buffer per parity.
- [ ] Implement a persistent one-workgroup compute adapter that reads current-step cover state and writes consumer-owned indirect arguments; do not weaken exact-epoch `CopyCommand` semantics.
- [ ] Validate runtime/frame ownership and expose stable identity facts.
- [ ] Run focused tests/typecheck and commit patch draw preparation.

### Task 5: Terrain integration and quality calibration

**Files:**
- Modify: `packages/geoscratch/src/geo/web-mercator-terrain-renderer.ts`
- Modify: `examples/underwaterTerrain/application.ts`
- Modify: `examples/underwaterTerrain/main.ts`
- Modify: `tests/scratch-underwater-terrain-clean-cut.test.js`
- Modify: `tests/browser/underwater-terrain-tile-wireframe.mjs`
- Modify: `tests/browser/scratch-underwater-terrain.mjs`

- [ ] Add failing structural/lifecycle tests for cover -> demand projection -> patch draw -> terrain composition and removal of the environment threshold.
- [ ] Integrate the new components while preserving double-flight feedback convergence and passive Virtual Raster lowering.
- [ ] Calibrate the unified selector from the four-reference-pixel baseline using top-down and pitched browser facts.
- [ ] Verify no CPU patch list or patch-count readback enters the draw path.
- [ ] Run focused Node/browser gates and commit terrain integration.

### Task 6: Current API documentation and complete verification

**Files:**
- Modify: `docs/api/geo/view-cover.md`
- Modify: `docs/api/geo/view-cover_zh.md`
- Modify: `docs/api/geo/terrain-rendering.md`
- Modify: `docs/api/geo/terrain-rendering_zh.md`
- Modify: `examples/underwaterTerrain/README.md`
- Generated: `docs/api/reference/*`

- [ ] Update public ownership, lifecycle, feedback, naming, failure, and composition contracts in English and Chinese.
- [ ] Run `npm run docs:generate`, `npm run docs:translations`, and `npm run docs:check`.
- [ ] Run `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Run lifecycle, cache, wireframe, streaming, top-down symmetry, pitch sweep, zoom monotonicity, A-B-A, and high-pitch browser gates.
- [ ] Inspect `git diff --check`, public symbol parity, dependency changes, branch status, and final diff.
- [ ] Commit the completed clean cut for user acceptance.
