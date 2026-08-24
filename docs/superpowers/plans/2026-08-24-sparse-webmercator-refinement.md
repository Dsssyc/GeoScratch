# Sparse WebMercatorQuad Refinement Implementation Plan

- [ ] Add source and behavior regressions that fail while refinement decisions are unioned
  into one rectangle per level.
- [ ] Replace CPU reference windows with exact sparse parent decisions and subtree
  materialization.
- [ ] Replace WGSL refinement windows with a temporary exact-identity set, sparse
  materialization, visibility compaction, and existing 2:1 closure.
- [ ] Verify CPU/GPU parity, overflow behavior, continuous pitch, shaded/wireframe runtime,
  request bounds, and performance.
- [ ] Update canonical English/Chinese API docs and repository guardrails; remove dead window
  helpers and regenerate facts.
- [ ] Run focused tests, typecheck, full tests, builds, docs gates, diff review, and browser
  acceptance.

