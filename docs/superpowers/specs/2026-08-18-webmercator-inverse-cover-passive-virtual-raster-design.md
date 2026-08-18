# WebMercatorQuad Inverse Cover and Passive Virtual Raster Design

## Status

Approved on 2026-08-18. This English document is the canonical design. The paired
Chinese document is a reviewed translation; English governs conflicts.

## Problem

The current terrain path has two independent LoD authorities. `GpuTileFrontier`
refines and coarsens a residency-aware data frontier, while
`GpuRenderPatchFrontier` traverses immutable safety-cover roots to choose geometry.
This duplicates selection state, lets implementation history obscure ownership, and
keeps root-forward quadtree traversal in the hot path even though the final visible
cover is small.

The replacement must preserve three facts that are easy to conflate:

1. WebMercator map tiles have immutable OGC `WebMercatorQuad` identities.
2. Geometry density is a view decision and may exceed source raster detail.
3. Virtual Raster residency is asynchronous availability, not a LoD decision.

## Non-Negotiable Invariants

### Standard tile identity

Every geometry cover item, raster demand, cache address, and source request uses a
standard tile-matrix identity:

```text
(tileMatrixSet = WebMercatorQuad, tileMatrix, tileRow, tileCol)
```

Camera-centered LoD regions may choose which standard tiles participate, but they
must not translate, rotate, resize, or otherwise invent a camera-local tile grid.
Horizontal world repetition is render-instance metadata: the canonical data key is
`z/x/y`; `wrap` never creates a second cached page.

### One view-cover authority

The camera-derived cover is the only geometry LoD authority. It starts from the
standard tile containing the canonical camera position at the requested finest
level, not from world roots or resident atlas pages. It directly enumerates standard
matrix tiles in nested level bands, conservatively rejects invisible candidates,
closes adjacency to a maximum level difference of one, and emits one prefix-free
cover.

No previous-frame topology, atlas state, request state, or render-root trial may
select a settled geometry cut.

### Passive Virtual Raster

Virtual Raster receives explicit page demand. It may deduplicate, prioritize within
caller policy, schedule, cancel obsolete requests, retry, cache, evict, publish,
resolve fallback, and report facts. It must not inspect camera zoom, compute
screen-space error, refine or coarsen tiles, enforce geometry adjacency, or rewrite
the requested semantic level.

### Distinct levels

The implementation preserves four separate facts:

```text
geometryLevel       view-selected mesh patch level
desiredSampleLevel  producer-selected raster precision
resolvedSampleLevel currently resident exact or ancestor page
sourceLevelCeiling  highest level the source declares available
```

A z14 geometry patch may request z14 data and currently resolve z10. If the source
declares z10 as its ceiling, the demand producer requests the z10 ancestor directly
while retaining z14 geometry and the desired sampling footprint as diagnostic facts.

## Architecture

```text
GeoViewSnapshot + WebMercatorQuad profile + cover policy
    -> GpuWebMercatorQuadCover
        -> canonical RenderTileSet
        -> render-patch lookup
        -> indirect draw arguments
        -> bounded desired-raster feedback

desired-raster feedback
    -> ViewDemandProducer
    -> VirtualRasterDemandSet
    -> VirtualRasterRequestScheduler
    -> VirtualRasterResidency
    -> page table + atlas + slot table

RenderTileSet + global field coordinate
    -> Virtual Raster shader accessor
    -> exact resident page or nearest resident ancestor
```

`GpuWebMercatorQuadCover` belongs to Geo. It understands the standard matrix,
camera-relative coordinates, view footprint, level bands, cover completeness,
adjacency, and indirect rendering. It does not understand terrain height payloads,
worker execution, cache policy, URLs, or atlas ownership.

Virtual Raster remains a generic Geo resource system. The terrain renderer composes
the cover with a raster-demand producer and terrain shaders; the Underwater Terrain
example only supplies source and presentation policy.

## Inverse Standard Cover

### Camera anchor and visibility

The GPU derives the finest standard tile from the camera's canonical fixed
WebMercator position and requested zoom. This is a level-selection anchor, not a
camera-local geometry grid and not a claim that the anchor itself must be visible in
a pitched view. Parent-aligned windows expand from that standard tile, while the
relative view-projection facts and configured elevation interval conservatively
reject generated candidates outside the view.

### Matrix-aligned level bands

The cover uses view-centered nested bands only as a level-selection field. For each
participating matrix level, it intersects the parent-aligned window with standard
top-left-origin tile row and column limits and enumerates those identities directly.
Fine regions are snapped to complete parent groups before the next coarser band is
formed. Consequently, the selected regions are nested in standard tile space rather
than in a moving game-style grid.

The implementation may use bounded matrix-aligned windows or an equivalent direct
band enumerator, but it must prove these observable properties:

- work is bounded by levels and candidate/output cover, not rejected ancestors;
- no root-to-leaf DFS or repeated trial cut exists;
- emitted identities are valid under the configured `TileMatrixCoverage`;
- the settled cover is deterministic, prefix-free, complete over the visible source
  footprint, and edge-adjacent by at most one level;
- top-down symmetric inputs cannot acquire a directional tie bias;
- zoom-in cannot coarsen a still-visible location under otherwise fixed inputs;
- pitched distance cannot make a farther equivalent tile finer than a nearer tile.

A final conservative tile/footprint test is allowed. It runs over the directly
generated bounded candidates; it is not an excuse to restore world-root traversal.

### Geometry and sampling

Each render tile instantiates the reusable terrain grid and participates in the same
cross-LoD mesh-stitching lookup used today. Terrain vertices sample by global field
coordinate. The virtual page table may therefore resolve different parts of one
geometry patch to exact or ancestor pages without changing its standard geometry
identity.

Availability changes never alter geometry topology. Existing logical cross-page
filtering continues to blend spatial LoD boundaries, and samples keep requested and
resolved levels observable. This selector clean cut does not claim a temporal
parent-to-child residency morph: that requires explicit previous-snapshot and physical
assignment lifetime authority and must be designed independently rather than hidden
inside cover selection.

## Demand and Availability

The view/sample producer, not Virtual Raster, chooses desired pages. Each feedback
record contains a standard page identity, priority, generation, producer/view
provenance, intent, and reason. Cover completeness requests are required; guard-band
or predicted pages are prefetch.

Source capability is handled before request execution:

- if the source ceiling is known, finer desired geometry/sample footprints lower to
  the corresponding available ancestor without issuing impossible requests;
- if the source declares an exact page but loading is pending or retryable, rendering
  uses the resident ancestor and keeps the exact demand current;
- a terminally unavailable page remains an explicit unavailable fact and resolves to
  an ancestor; it is not retried every frame;
- requested and resolved identities are never collapsed into one field.

Cover feedback capacity is independent from physical residency capacity. Runtime
composition first reserves slots for the pinned minimum-matrix safety cover, then
bounds dynamic view demand to the remaining request and physical-page capacity.
Within that bound, desired sample precision sorts first and wrapped standard-tile
distance to the camera anchor sorts equal-precision pages.
Exact-resident selected pages remain in reconciliation so the scheduler can mark them
used; filtering them out before scheduling would permit a tight atlas to oscillate
between equally current pages forever.

## Clean Cut

After parity and browser proof:

- remove `GpuTileFrontier` as a view/LoD authority;
- remove `GpuRenderPatchFrontier`, immutable render roots, 17 trial cuts, global
  bias selection, and their feedback vocabulary;
- retain reusable high-precision addressing, tile topology/profile, view capture,
  demand types, Virtual Raster residency/page-table/atlas, terrain grid,
  mesh-stitching semantics, indirect draw, and structured diagnostics;
- keep no legacy selector, compatibility flag, or hidden CPU fallback.

## Verification

Node/reference gates must prove standard identity, source limits, prefix-free cover,
complete visible coverage, deterministic ordering, 2:1 adjacency, top-down symmetry,
zoom monotonicity, near/far ordering, wrap canonicalization, requested/resolved level
separation, known source-ceiling lowering, retryable fallback, and passive scheduler
ownership.

Real Chrome/WebGPU gates must cover shaded and wireframe top-down, pitched, rotated,
zoom, pan, pitch-down/pitch-up, and A-to-B-to-A paths. They must report no holes,
stale decisions, overflow, uncaptured WebGPU error, device loss, or source-request
storm. The 90-frame pitched benchmarks remain mandatory, but their selection facts
must describe inverse-cover work rather than optimized root traversal.

## References

- [OGC Two Dimensional Tile Matrix Set and Tile Set Metadata 2.0](https://docs.ogc.org/is/17-083r4/17-083r4.html)
- [MapLibre covering tiles](https://github.com/maplibre/maplibre-gl-js/blob/main/src/geo/projection/covering_tiles.ts)
- [GPU-Based Geometry Clipmaps](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry)
- [WGSL texture built-ins](https://gpuweb.github.io/gpuweb/wgsl/#texture-builtin-functions)
