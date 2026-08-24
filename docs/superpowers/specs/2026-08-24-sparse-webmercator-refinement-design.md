# Sparse WebMercatorQuad Refinement Design

## Goal

Remove repeatable refine-then-coarsen topology flashes caused by level-wide rectangular
refinement windows while preserving GeoScratch's bounded GPU-driven inverse cover.

## Invariants

1. Every descriptor is an OGC `WebMercatorQuad` identity.
2. Refinement is keyed by an exact parent identity and replaces only that parent's four
   children.
3. A child decision is reachable only through selected ancestors.
4. The output is visible, deterministic, prefix-free, capacity-bounded, and 2:1 balanced.
5. Camera-derived probing stays bounded; no complete world-root traversal is introduced.
6. Virtual Raster and atlas residency remain passive and cannot alter geometry LoD.
7. CPU reference and WGSL implementation express the same construction.

## GPU Construction

The compute invocation uses the cover lookup buffer in two non-overlapping phases. First it
is a sparse set of exact parent identities selected for refinement. Each level probes the
existing camera-centered bounded search window; candidates above the minimum level are
considered only if their own parent is in the set. Second, the kernel seeds visible minimum-
level patches and materializes selected subtrees by replacing each marked parent with four
children. It compacts invisible children, performs local 2:1 closure, compacts again, clears
the temporary set, and builds the public final-cover lookup.

## Failure Semantics

Temporary refinement-set overflow, descriptor overflow, and final lookup overflow are hard
diagnostics. No failure path silently emits a coarser cut.

## Verification

- source guards reject level-wide refinement unions;
- CPU tests prove exact-parent replacement, prefix freedom, determinism, and 2:1 adjacency;
- CPU and native GPU observations agree for representative top-down and pitched views;
- a settled continuous pitch sweep contains no unrelated strip collapse;
- shaded and wireframe browser paths retain frame responsiveness and bounded requests.

