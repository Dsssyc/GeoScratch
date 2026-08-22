# Unified Adaptive WebMercatorQuad Cover Design

## Status

Approved for implementation on `dev-feature`. ADR-086 is the accepted decision record.

## Objective

Replace the pitch-gated `uniform`/`variable` WebMercatorQuad cover with one adaptive
projected-cell selector and cleanly separate geometry selection from raster demand and
patch-mesh draw preparation. Preserve the existing high-precision, GPU-driven,
standard-tile, passive-Virtual-Raster, deterministic, prefix-free, and 2:1 contracts.

## Authority Boundaries

### `GpuWebMercatorQuadCover`

Owns one bounded geometry cut for a `GeoViewSnapshot`:

- standard `(matrixLevel, tileRow, tileCol)` patch identities;
- immutable vertical bounds used for AABB visibility and projected quality;
- projected-cell refinement at every camera pitch;
- full-identity lookup and 2:1 closure;
- GPU patch/state buffers and state feedback.

It does not own source ceilings, raster request identities, worker priorities, atlas
residency, mesh vertex counts, or draw-indirect arguments.

### WebMercatorQuad demand projection

Consumes a cover frame and one source representation's immutable matrix limits. It
maps each desired geometry patch to an executable source tile, deduplicates requests,
assigns deterministic camera-distance priority, records desired level separately from
source ceiling, and exposes bounded GPU feedback. It does not select geometry.

### Patch draw preparation

Consumes one cover frame and a consumer-owned vertex count. It writes or copies the
cover patch count into a consumer-owned draw-indirect buffer. Terrain drawing consumes
that product, but the cover does not know the terrain grid.

### Virtual Raster

Consumes explicit `ViewTileDemandSet` pages and owns request scheduling, cancellation,
cache integration, transfer, residency, eviction, publication, and ancestor fallback.
It never reads pitch or selects geometry.

### Future feature conformance

A future Geo compute stage will read feature geometry plus a surface geometry product
or matching field sampler and emit conformed GPU geometry with feature IDs and indirect
arguments. It may depend on the current surface product but never adopts terrain tile
identity or render-to-texture draping. This task records the boundary but does not ship
a speculative feature API.

## Public API Clean Cut

Remove:

- `GpuWebMercatorQuadCoverPolicy.sourceMaximumMatrixLevel`;
- `GpuWebMercatorQuadCoverPolicy.variableLodPitchThresholdRadians`;
- `GpuWebMercatorQuadCoverDescriptor.vertexCount`;
- `GpuWebMercatorQuadCoverSelectionFacts.selectionMode`;
- cover-level demand fields and demand feedback;
- cover-level draw-argument products;
- the Underwater Terrain pitch environment variable.

Rename:

- `WebMercatorTileElevationBounds` to `WebMercatorTileVerticalBounds`;
- cover `elevationRangeMeters` to `verticalRangeMeters`;
- cover `elevationBounds` to `verticalBounds`;
- cover `visibleInstances` to `patches`;
- cover render templates to geometry templates.

Terrain renderer inputs retain `elevation*` names because terrain source metadata is
genuinely elevation data. It converts those facts to generalized vertical bounds when
constructing the cover.

Add public Geo components for source-demand projection and patch draw preparation only
when their implementations have focused lifecycle, ownership, and API tests.

## Unified Selection

The CPU oracle and GPU kernel always execute the current adaptive parent-window path:

1. seed the declared minimum standard geometry window;
2. probe bounded parent windows around the precise fixed-point camera position;
3. refine visible parents whose area-equivalent projected cell span exceeds the
   reference-pixel threshold plus explicit tolerance;
4. nest standard child windows back through their ancestors;
5. emit a prefix-free visible cut;
6. perform 2:1 closure;
7. finalize lookup and projected-quality facts.

There is no pitch branch, retained previous cut, root-forward traversal, atlas-driven
selection, or moving clipmap grid.

The first calibrated quality candidate is four reference pixels per cell because the
built-in patch has 128 cells over a 512-reference-pixel tile convention. Acceptance is
based on browser measurements rather than that arithmetic alone.

## Vertical Bounds

`WebMercatorTileVerticalBounds` stores one immutable conservative vertical range for a
standard tile. Complete hierarchical bounds must match the supplied spatial profile;
partial metadata remains invalid. Geometry above the highest bounds level resolves the
corresponding ancestor. Missing hierarchy uses one global `verticalRangeMeters`.

Bounds influence only visibility and projected quality. Cache hits, current atlas
pages, source requests, and asynchronous publication cannot change them.

## Frame Data Flow

```text
GeoViewSnapshot
    -> cover view upload
    -> adaptive cover compute
         writes patches, lookup, cover state
    -> source demand projection compute
         writes demand state and demand records
    -> patch-count to draw-arguments preparation
    -> terrain drawIndirect
    -> bounded cover and demand feedback
    -> ViewTileDemandSet
    -> VirtualRaster reconciliation
```

All stages use persistent parity resources. No selected patch list is materialized on
the CPU before drawing.

## Acceptance

- No public, source, generated WGSL, example, or current API documentation reference to
  `variableLodPitchThresholdRadians`, `selectionMode`, or the old environment variable.
- CPU oracle and GPU kernel have one adaptive path.
- Equal views remain deterministic and DPR-invariant.
- Adjacent final patches differ by at most one level.
- Geometry topology is independent from source ceiling and residency.
- Source demand retains desired level, source ceiling, executable request tile,
  priority, frame epoch, and residency snapshot epoch as separate facts.
- Cover identity objects contain no demand buffer or draw-argument buffer.
- Patch draw arguments remain GPU-produced without CPU patch-count readback.
- Top-down views are rotation/translation symmetric and use a bounded practical patch
  count; crossing 60 degrees has no discontinuity.
- Zoom-in does not coarsen the same stable top-down footprint.
- Existing delayed-feedback, A-B-A identity, lifecycle, wireframe, cache, failure,
  shaded, high-pitch, overflow, and native-observation gates pass.
- English current API docs and reviewed Chinese translations match source.
