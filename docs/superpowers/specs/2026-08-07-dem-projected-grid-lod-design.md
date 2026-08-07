# DEM Projected-Grid LoD Correction

## Problem

The current DEM render-patch selector labels horizontal grid spacing as terrain
"geometric error" and refines until one grid cell is at most two screen pixels.
That is not a terrain approximation error. With a 64 by 64 mesh it routinely
drives visible source pages from `z10` to `z14`, oversampling the source DEM and
making the wireframe nearly solid.

## Correct Model

Raster residency and render geometry remain separate:

- `GpuTileFrontier` owns bounded raster demand and residency through source `z10`.
- The DEM example owns render-patch subdivision through bounded `z14` descendants.
- Each candidate patch projects its relative-world AABB with the current
  `clipFromRelativeWorld` matrix.
- The selector clips the projected AABB to the viewport and computes the geometric
  mean screen span of one 64 by 64 grid cell.
- A patch refines only while that cell span exceeds eight pixels. This corresponds
  to a nominal 512-pixel patch span, while perspective foreshortening naturally
  keeps distant pitched-map patches coarser.
- Near-plane intersection refines conservatively, but remains bounded by the
  existing four descendant levels and fixed output capacity.

This metric is explicitly projected grid spacing. It must not be called geometric
error or screen-space error.

## Diagnostics

The example keeps one persistent consume-on-read state readback per parity. Each
frame reports, one bounded frame later:

- selected render-patch count;
- minimum and maximum selected matrix level;
- minimum and maximum projected cell span;
- descriptor and lookup overflow counts;
- the originating frame epoch.

The readback is observability only. It never participates in selection, rendering,
residency, or cache decisions.

## Invariants

- No CPU quadtree traversal or per-patch CPU decision path.
- No raster request above source `z10`.
- No dynamic GPU resource or command creation per frame.
- Render descriptors, lookup, counts, and terrain draw remain GPU-produced.
- Mesh stitching and virtual-raster sampling semantics remain unchanged.
- Wireframe colors continue to identify render patches, now at useful density.
