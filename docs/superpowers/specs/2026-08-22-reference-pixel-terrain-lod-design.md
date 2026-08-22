# Reference-Pixel Terrain LoD Design

## Status

Implemented and verified on 2026-08-22. This English document is canonical; the paired
Chinese document is a reviewed translation, and English governs conflicts. This design
refines the projected-cell cover accepted in
`2026-08-19-webmercator-projected-cell-pitch-gated-cover-design.md`; it does not
restore root-forward traversal or give Virtual Raster LoD authority.

## Problem

The MapLibre planar adapter currently supplies one device-pixel canvas size as both
the presentation extent and the `GeoViewSnapshot` viewport. The cover therefore
interprets device pixels as geometry-quality pixels. At the same 1512 by 864 CSS
viewport and top-down camera, DPR 1 selected 28 patches at z11 while DPR 2 selected
104 patches at z12. MapLibre 4.7.1 retained the same cover at both DPR values.

The terrain policy also represents one standard patch with 64 by 64 cells. Its
eight-pixel projected-cell threshold consequently behaves like a 256-screen-pixel
tile policy at DPR 1. MapLibre's 512-screen-pixel terrain cover uses a reusable
128 by 128 mesh, so it keeps comparable cell density with fewer tile identities.

Finally, the cover applies one global elevation range to every patch. The Underwater
Terrain example exaggerates the source fifty times, so a global deep-water minimum
expands otherwise shallow patch bounds and can inflate top-down coverage.

## External Evidence

Mapbox GL JS 3.29 stores [transform width and height without pixel ratio](https://github.com/mapbox/mapbox-gl-js/blob/v3.29.0/src/geo/transform.ts#L97-L99),
defines cover `tileSize` in screen pixels, and multiplies only the
[painter extent](https://github.com/mapbox/mapbox-gl-js/blob/v3.29.0/src/render/painter.ts#L518-L525)
and canvas by device pixel ratio. MapLibre uses the same separation and
[tests](https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/ui/map_tests/map_pixel_ratio.test.ts#L21-L37)
that a 512 by 512 container with pixel ratio two produces a 1024 by 1024 painter and
canvas. Both keep canonical tile identity independent from DPR. Raster `@2x` is a
representation variant of the same `(z, x, y)` tile, while Mapbox's
[Raster DEM path explicitly disables the 2x URL variant](https://github.com/mapbox/mapbox-gl-js/blob/v3.29.0/src/source/raster_dem_tile_source.ts#L67-L71).

Mapbox also guards terrain split boundaries with a
[small numerical tolerance](https://github.com/mapbox/mapbox-gl-js/blob/v3.29.0/src/geo/transform.ts#L1315-L1320)
and uses [per-tile elevation bounds when available](https://github.com/mapbox/mapbox-gl-js/blob/v3.29.0/src/geo/transform.ts#L1392-L1408).
MapLibre 4.7.1 fixes the logical tile convention at
[512 pixels](https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/geo/transform.ts#L77-L79)
and sets the terrain mesh to
[128 cells](https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/render/terrain.ts#L138-L145).
The separately inspected MapLibre commit
[`49491068aff0f1801c942de1bdc9da5ada0297b0`](https://github.com/maplibre/maplibre-gl-js/blob/49491068aff0f1801c942de1bdc9da5ada0297b0/src/render/terrain.ts#L153-L160)
retains the 128-cell terrain mesh; the design does not rely on a floating `main` claim.

## Pixel Domains

Geo exposes two independent dimensions:

```ts
type GeoViewSnapshot = Readonly<{
    referenceViewport: readonly [number, number]
    // camera, matrix, zoom, orientation, and revision facts
}>

type GeoViewSourceCapture<View> = Readonly<{
    view: View
    presentationSize: Readonly<SurfaceSize>
}>
```

`referenceViewport` is the stable logical pixel space used by camera math, projected
quality, tile cover, and picking. A MapLibre host supplies `map.transform.width` and
`map.transform.height`, which are CSS-pixel dimensions. A standalone camera chooses
and documents its own logical reference pixel space.

`presentationSize` is the physical color/depth attachment extent. It may change with
DPR, browser zoom, output scaling, or GPU limits without changing a settled cover.
The ratio between the two dimensions is presentation scale, not geographic LoD.

The clean cut removes the old `GeoViewSourceCapture.size`,
`GeoViewSnapshot.viewport`, and `MapLibrePlanarViewSourceDescriptor.viewport` names.
No compatibility aliases remain during 0.x.

## MapLibre Source Composition

`mapLibrePlanarViewSource()` accepts a `presentationSize()` reader. Each capture:

1. reads and freezes the physical presentation size;
2. reads the reference viewport from the same MapLibre transform used to construct
   the projection matrix;
3. creates the camera from that reference viewport;
4. returns the camera and presentation size as separate facts.

The source rejects non-positive or non-finite transform dimensions. It does not read
`window.devicePixelRatio`; the application remains responsible for sizing its own
WebGPU canvas and Surface.

## Terrain Geometry Policy

The built-in WebMercator terrain policy uses:

```ts
referenceTileSizePixels: 512
cellsPerPatchEdge: 128
maximumCellSpanReferencePixels: 8
refinementTolerance: 0.005
variableLodPitchThresholdRadians: Math.PI / 3
```

`zoomHint` is defined in the conventional 512-reference-pixel WebMercator zoom space.
Below the pitch boundary, uniform mode starts at the clamped
`floor(zoomHint + log2(512 / referenceTileSizePixels))` level. It evaluates the whole
visible footprint there and may only refine the complete footprint when measured
cell span exceeds `maximumCellSpanReferencePixels * (1 + refinementTolerance)`.
It never coarsens below the zoom-anchored level.

At or above the pitch boundary, variable mode retains direct inverse level probing,
projected-cell evidence, prefix-free output, and 2:1 closure. It uses the same
reference-pixel threshold and tolerance. DPR never enters either mode.

The public policy and feedback names use `ReferencePixels`. The old ambiguous
`maximumCellSpanPixels` policy/feedback field and `minimumCellSpanPixels` feedback field
are removed rather than deprecated.

## Immutable Elevation Bounds

The tile source manifest carries one complete immutable elevation-bound record for
every tile in its declared WebMercatorQuad limits:

```ts
type WebMercatorTileElevationBounds = Readonly<{
    matrixLevel: number
    tileRow: number
    tileCol: number
    minimumElevationMeters: number
    maximumElevationMeters: number
}>
```

The COG build computes bounds from valid source pixels before encoding. Manifest
validation requires unique, complete, ordered records matching the declared limits.
The source snapshots these records and passes them to the terrain renderer.

The GPU cover stores a dense immutable bounds buffer. Geometry above the source
ceiling resolves the source-ceiling ancestor. A missing hierarchy uses the declared
global elevation range, but a partial hierarchy is invalid and never falls back per
tile. Residency, cache state, request completion, and atlas contents cannot change
the hierarchy or the selected geometry.

The renderer scales both global and tile bounds by terrain exaggeration before cover
creation. Cover facts report `elevationBoundsMode` and record count.

## Representation Density

DPR does not request a finer WebMercatorQuad matrix level. A future raster source may
select a denser payload for the same page identity as an explicit representation
variant. Underwater Terrain has one 256 by 256 DEM payload representation and therefore
makes identical page demands at every DPR.

## Cleanup

Implementation removes:

- physical-pixel viewports from camera and cover metadata;
- the 64-cell built-in terrain geometry and its stale capacity assumptions;
- old pixel-field names and compatibility shims;
- global-only patch-bound code once the shared exact/global resolver exists;
- documentation that claims pixel density may change geometry level;
- tests that encode the old physical-pixel or 64-cell behavior.

No worker, cache, Virtual Raster, root-frontier, clipmap, skirt, or application-local
LoD abstraction is added.

## Acceptance Gates

- DPR 1, 1.25, 1.5, 2, and 3 produce identical cover identities, levels, counts,
  adjacency facts, and DEM demands for the same logical view.
- Presentation size changes with DPR and renderer resize still follows the physical
  extent.
- Top-down zoom 8 through 14 is monotonic, uniform, history-independent, and in the
  same tile-count order as a 512-pixel MapLibre cover.
- The exact 60-degree boundary belongs to variable mode and has no one-frame fine
  spike or coarse collapse.
- Pitched covers remain prefix-free, 2:1 balanced, overflow-free, and bounded.
- Static per-tile bounds reduce conservative global-range coverage without making
  topology dependent on residency.
- Picking and camera projection use reference coordinates; physical readback converts
  only at the presentation boundary.
- Typecheck, documentation generation/checks, all unit tests, package/example build,
  wide browser proof, streaming proof, lifecycle proof, and 90-frame shaded and
  wireframe benchmarks pass.
