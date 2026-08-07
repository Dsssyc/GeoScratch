# DEM Projected-Grid LoD Implementation Plan

**Goal:** Correct over-dense pitched DEM geometry by replacing the false two-pixel
distance SSE with bounded GPU projected-grid spacing and observable selection facts.

## Steps

- [x] Add RED policy, shader-contract, feedback-decoding, and example-publication tests.
- [x] Project candidate AABBs with the live clip matrix and stop at an eight-pixel
  geometric-mean cell span.
- [x] Add two persistent parity readbacks for selected count, level range, projected
  cell-span range, overflow counters, and frame epoch.
- [x] Publish the delayed render-patch facts through DEM state and canvas datasets.
- [x] Supersede the old SSE wording in contracts, ADRs, and migration audits.
- [x] Run focused tests, typecheck, build, full tests, and an exact-camera real Chrome
  WebGPU before/after density comparison.
- [x] Review and commit only the implementation and its evidence; leave `AGENTS.md`
  untouched and do not push.
