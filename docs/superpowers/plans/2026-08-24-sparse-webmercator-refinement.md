# Sparse WebMercatorQuad Refinement Implementation Plan

- [x] Add source and behavior regressions that fail while refinement decisions are unioned
  into one rectangle per level.
- [x] Replace CPU reference windows with exact sparse parent decisions and subtree
  materialization.
- [x] Replace WGSL refinement windows with a temporary exact-identity set, sparse
  materialization, visibility compaction, and existing 2:1 closure.
- [x] Replace determinant-only cell quality with maximum singular stretch and calibrate the
  built-in terrain threshold through a settled 0-to-85-degree pitch sweep.
- [x] Convert terrain to indexed indirect drawing so the corrected high-pitch quality remains
  inside shaded and wireframe latency gates.
- [x] Verify CPU/GPU parity, overflow behavior, continuous pitch, shaded/wireframe runtime,
  request bounds, and performance.
- [x] Update canonical English/Chinese API docs and repository guardrails; remove dead window
  helpers and regenerate facts.
- [x] Run focused tests, typecheck, full tests, builds, docs gates, diff review, and browser
  acceptance.
