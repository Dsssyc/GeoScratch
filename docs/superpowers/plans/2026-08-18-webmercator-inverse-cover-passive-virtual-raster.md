# WebMercatorQuad Inverse Cover and Passive Virtual Raster Implementation Plan

> Canonical design: `docs/superpowers/specs/2026-08-18-webmercator-inverse-cover-passive-virtual-raster-design.md`

## 1. Freeze executable invariants

1. Add a pure reference model for camera-derived, matrix-aligned cover generation.
2. Test valid standard identities, prefix-free completeness, deterministic order,
   top-down symmetry, zoom monotonicity, near/far order, wrap canonicalization, and
   2:1 adjacency.
3. Add source scans and type tests that reject root/trial traversal and LoD policy in
   Virtual Raster demand/residency modules.
4. Run the tests before implementation and retain the expected failures as the red
   side of the change.

## 2. Introduce the inverse-cover contract

1. Add WebMercatorQuad cover layout codecs for policy, level limits, map/view facts,
   patch identity, lookup entries, demand feedback, counters, and indirect arguments.
2. Add public TSDoc types and factory/class surface under `geoscratch/geo`.
3. Keep tile identity structural and source-independent; terrain payload facts do not
   enter the cover descriptor.
4. Add structured Geo diagnostics for invalid profile, level, capacity, coverage,
   epoch, and feedback facts.

## 3. Lower inverse cover to Scratch/WebGPU

1. Compute conservative visible footprint/focus facts from the relative view and
   elevation interval.
2. Generate bounded matrix-level bands/windows and enumerate standard row/column
   candidates directly.
3. Mark visible candidates, canonicalize to a prefix-free set, enforce 2:1 closure,
   build neighbor lookup, and finalize draw/demand counts entirely on GPU.
4. Use stable compaction or another deterministic construction; atomic append order
   cannot become semantic order.
5. Expose bounded feedback and performance facts without per-frame unbounded history.

## 4. Make raster demand explicitly downstream

1. Convert selected cover/sample footprints into standard desired page records.
2. Lower desired pages through the source coverage/ceiling before request execution.
3. Preserve requested and resolved level/page facts in feedback and diagnostics.
4. Reuse `ViewDemandProducer`, `VirtualRasterDemandSet`, scheduler, residency, atlas,
   page table, generation, and fallback paths without granting them LoD authority.
5. Prove known ceilings do not create impossible requests and retryable misses do not
   create request storms.

## 5. Integrate terrain rendering

1. Replace both existing frontier objects in `createWebMercatorTerrainRenderer` with
   the new cover.
2. Bind its patch/lookup buffers to terrain mesh generation and mesh stitching.
3. Feed its demand feedback into existing delayed settlement/reconciliation.
4. Preserve frame-driver authority, bounded double-flight, provenance, resize,
   presentations, wireframe mode, and disposal.
5. Remove root/trial/bias feedback translation and obsolete state snapshots.

## 6. Clean cut and current documentation

1. Delete old GPU tile/render frontier source, WGSL, tests, exports, docs, and dead
   helpers after parity.
2. Update canonical English API pages and reviewed Chinese translations for GPU
   cover, tile demand, Virtual Raster, terrain rendering, view/frame composition, and
   the example.
3. Mark superseded ADR details accurately without rewriting historical evidence.
4. Update `AGENTS.md` with the new authority boundary and mandatory browser gates.
5. Regenerate API references and translation revision digests.

## 7. Verification gates

Run, in order:

```text
focused reference/unit/type tests
npm run typecheck
npm run docs:generate
npm run docs:translations
npm run docs:check
npm test
npm run build
real Chrome/WebGPU shaded and wireframe scenarios
90-frame top-down and pitched performance benchmarks
final source/export/dead-code scan
git diff and status audit
```

Completion requires all design invariants and gates. A faster root traversal, a
working example with a hidden legacy selector, or fallback that overwrites desired
precision is not completion.
