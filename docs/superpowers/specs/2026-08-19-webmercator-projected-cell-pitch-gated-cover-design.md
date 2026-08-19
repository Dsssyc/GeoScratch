# WebMercatorQuad Pitch-Gated Projected-Cell Cover

## Status

Approved on 2026-08-19. This English document is canonical. The paired Chinese
document is a reviewed translation; English governs conflicts.

This design corrects the quality model inside ADR-083's inverse standard cover. It
does not restore a root-forward frontier or give Virtual Raster any LoD authority.

## Observed Defect

The current cover assigns every non-minimum level a constant two-tile radius around
the canonical camera position. Parent alignment can expand one axis to at most six
tiles, but the radius does not depend on viewport size, field of view, device pixel
ratio, terrain elevation, or projected patch scale.

A controlled Chrome/WebGPU reproduction at a 1512 by 864 viewport, zoom 13.25, pitch
zero, and bearing zero selects 23 patches across z12 through z14 with no overflow,
device error, cache miss, or unsettled request. The center-only fine region is
therefore the deterministic output of the level policy, not asynchronous residency.

The existing browser proof did not reject this result. It used a 1280 by 800 viewport
and asserted only monotonic minimum/maximum level ranges, parity symmetry, adjacency,
and density. It did not require a top-down visible footprint to use one projected-cell
quality level.

## Inherited Boundaries

- Every geometry patch and demand remains an OGC `WebMercatorQuad` identity.
- `GpuWebMercatorQuadCover` remains the only geometry-LoD authority.
- Candidate generation remains camera/view-derived and directly enumerated; no z0,
  source-root, safety-root, render-root, or previous-topology traversal returns.
- Virtual Raster remains a passive demand, residency, fallback, and publication
  service. Availability cannot choose geometry.
- Output remains deterministic, prefix-free, complete over visible configured
  coverage, and edge-adjacent by at most one level.
- Camera-relative wide-fixed addressing, mesh stitching, indirect drawing,
  double-flight resources, lifecycle, and diagnostics remain intact.
- Candidate work may scale with the bounded visible footprint and hard patch capacity;
  it must not claim a constant bound independent of viewport size.

## Industrial Basis

MapLibre Native keeps one zoom level until pitch exceeds a configurable threshold;
its current default is 60 degrees. MapLibre GL JS computes a per-tile desired level
from camera height, tile-AABB distance, field of view, and off-nadir scale. Cesium
refines terrain against a maximum screen-space-error threshold. deck.gl's planar tile
cover enumerates one viewport zoom over visible bounds.

The shared principle is that visible projected quality, not a constant tile radius,
chooses level. GeoScratch retains its direct inverse construction and GPU authority;
it does not copy the root traversals or availability coupling in those systems.

## Public Policy

`GpuWebMercatorQuadCoverPolicy` adds three required normalized facts:

```ts
type GpuWebMercatorQuadCoverPolicy = Readonly<{
    minimumMatrixLevel: number
    maximumMatrixLevel: number
    sourceMaximumMatrixLevel: number
    maximumPatches: number
    cellsPerPatchEdge: number
    maximumCellSpanPixels: number
    variableLodPitchThresholdRadians: number
}>
```

`cellsPerPatchEdge` is the geometry grid resolution represented by one standard tile.
`maximumCellSpanPixels` is the maximum area-equivalent projected span of one grid cell.
`variableLodPitchThresholdRadians` is in `[0, PI / 2]`. A pitch strictly below the
threshold uses a uniform visible-footprint cut; a pitch at or above it uses variable
projected-cell LoD. The exact boundary therefore has one deterministic owner.

The terrain renderer supplies 64 cells, an eight-pixel threshold, and a default pitch
threshold of `PI / 3`. Its descriptor accepts an optional normalized threshold so an
application can override the default without reconstructing the cover.

The Underwater Terrain example reads
`VITE_UNDERWATER_TERRAIN_VARIABLE_LOD_PITCH_DEGREES`. Missing or blank input means 60.
Finite values from 0 through 90 are converted once to radians and passed into the
renderer. Invalid input fails before GPU initialization with the variable name and
accepted range; the library itself never reads process or bundler environment state.

## Projected-Cell Metric

The GPU restores ADR-077's local projective Jacobian. For a standard patch and each
configured elevation plane, it clips the horizontal patch polygon to WebGPU's six
homogeneous clip planes. At every surviving vertex it differentiates perspective
division for one Web Mercator grid-cell displacement along x and y. If those pixel
vectors are `Jx` and `Jy`, the scalar quality evidence is:

```text
cellSpanPixels = sqrt(abs(Jx.x * Jy.y - Jx.y * Jy.x))
```

The maximum over visible vertices and both elevation planes controls level. A cell
that can cross the camera plane returns the viewport maximum and refines
conservatively. The determinant is invariant under rotation of the horizontal basis
and includes viewport scale, perspective, foreshortening, and elevation.

## Uniform Mode Below the Threshold

Uniform mode first derives a conservative camera-centered world-space envelope for
the complete viewport footprint on the minimum and maximum elevation planes. The
envelope uses camera altitude, vertical FOV, viewport aspect, pitch, and all four
corner rays; it is expanded by one standard tile before parent-group alignment.
Because the envelope is radial in world space, bearing rotates visibility inside it
without changing its guaranteed coverage.

The kernel evaluates the complete footprint once at the clamped `ceil(zoomHint)` probe
level. Projected cell span changes by exactly a factor of two per standard matrix level,
so `ceil(log2(maximumSpan / maximumCellSpanPixels))` directly resolves the uniform
level without repeated level scans. The resolved aligned window is emitted alone; the
maximum level is the terminal fallback. No finer island or coarse safety patch may
exist inside the same settled top-down footprint.

Observable uniform-mode invariants:

- all visible patches have the same geometry level before source-coverage clipping;
- widening or increasing the pixel density of a viewport may increase patch count or
  the uniform level, but cannot leave a fixed-size fine island in the center;
- zoom-in cannot coarsen a still-visible location;
- bearing, camera-tile parity, and navigation history cannot change the settled cut.

## Variable Mode At or Above the Threshold

Variable mode directly probes bounded standard parent candidates around the precise
camera coordinate at every possible child level. Its conservative search radius in
parent-tile units is derived from viewport focal length, `cellsPerPatchEdge`, and
`maximumCellSpanPixels`, with a parent-group guard. It is not a fixed constant.

For each visible parent candidate the GPU evaluates the projected-cell metric. A
parent whose maximum cell span exceeds the threshold contributes its four standard
children to that level's refinement window. The bounding window may conservatively
include holes, but it may never omit a candidate that exceeds the threshold. Finer
windows are nested through parent projection; final visibility rejection, prefix-free
emission, and 2:1 closure remain the existing terminal stages.

This is inverse level probing, not quadtree traversal: each level starts from a direct
camera/view-derived standard-tile search window and does not consume parent topology,
world roots, atlas slots, or the previous frame's cut.

## Observability

Selection feedback adds:

```ts
selectionMode: 'uniform' | 'variable'
minimumCellSpanPixels?: number
maximumCellSpanPixels?: number
```

The values describe emitted visible patches and are observation-only. Policy facts
expose the normalized threshold and projected-cell settings. Overflow remains a hard
diagnostic; the selector must not silently coarsen to satisfy capacity.

## Verification

Reference and Node gates must prove:

- default and explicit pitch-threshold validation, including exact 60-degree
  ownership;
- top-down wide and Retina footprints select one level over all visible patches;
- viewport growth expands candidate/output work instead of preserving a fixed island;
- variable mode refines a nearer equivalent tile no less than a farther tile;
- projected-cell determinant rotation invariance and camera-plane protection;
- zoom monotonicity, standard identity, prefix freedom, complete visible coverage,
  deterministic order, and 2:1 adjacency;
- source ceiling changes demand only, never geometry.

Real Chrome/WebGPU gates must include 1280 by 800 and 1512 by 864 viewports, DPR 1 and
2 where supported, fractional zoom 13.25, pitches 0, 59.9, 60, and 70 degrees, bearing
round trips, A-to-B-to-A identity, resize, streaming, cancellation, cache, lifecycle,
and shaded/wireframe 90-frame performance. The default graph contract must report 60
degrees, and a Vite environment override must be observable in the normalized cover
policy.

## Non-Goals

- No root-forward selector, trial cut, compatibility mode, or CPU-selected tile list.
- No Virtual Raster, atlas, Worker, cache, source protocol, or terrain shader redesign.
- No temporal geometry hysteresis or availability-driven topology.
- No generic globe policy; this contract remains planar `WebMercatorQuad`.

## References

- https://github.com/maplibre/maplibre-native/blob/main/src/mbgl/util/tile_cover.cpp
- https://github.com/maplibre/maplibre-native/blob/main/src/mbgl/map/map_impl.hpp
- https://github.com/maplibre/maplibre-gl-js/blob/main/src/geo/projection/covering_tiles.ts
- https://github.com/maplibre/maplibre-gl-js/blob/main/developer-guides/covering-tiles.md
- https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Scene/QuadtreePrimitive.js
- https://github.com/visgl/deck.gl/blob/master/modules/geo-layers/src/tileset-2d/utils.ts
