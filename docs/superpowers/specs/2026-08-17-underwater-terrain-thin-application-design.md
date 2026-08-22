# Underwater Terrain Thin Application Design

## Status

Approved for implementation on 2026-08-17.

ADR-084 supersedes the capture field names and pixel semantics: current captures use
`{ view, presentationSize }`, while the view owns a separate `referenceViewport`.

## Goal

Make Underwater Terrain a context-efficient application assembly without hiding ownership or
moving DEM-, PNG-, cache-UI-, or server-specific policy into GeoScratch library layers.

## Current Residue

The previous frame-driver change removed application-owned MapLibre frame scheduling, but the
example still adapts three public contracts itself:

- it reads MapLibre camera and viewport facts inside the frame-driver callback;
- it converts `WebMercatorTerrainFrameSettlement.requestedPageCount` into
  `GeoFrameSettlement.residencyWorkCount`;
- it compares renderer size and invokes renderer resize before each changed-size frame.

`main.ts` also mixes page bootstrap and development proof injection with the resource assembly
that users need to study.

## Public Target

### `GeoViewSource<View>`

Geo adds one generic source contract whose `capture()` returns an immutable `{ view, size }`
pair. `createGeoViewSource()` validates the stable id, positive integer surface size, and
captures the descriptor function instead of retaining mutable policy.

`mapLibrePlanarViewSource()` composes a `MapLibrePlanarViewAdapter`, structural map, viewport
reader, and minimum elevation into a `GeoViewSource<MapLibrePlanarCameraState>`. It owns no map,
events, frame revision, or renderer.

### Terrain renderer frame result

`WebMercatorTerrainRenderer.render(capture)` replaces public `renderFrame(input)` and
`resize(size)`. It:

1. resizes its Surface/depth target only when `capture.size` changed;
2. submits one terrain frame from `capture.view`;
3. returns a `GeoFrameResult` whose value contains the submitted terrain frame and view.

`WebMercatorTerrainFrameSettlement` directly extends `GeoFrameSettlement` and uses
`residencyWorkCount`; no terrain-specific alias remains.

This is a `0.x.x` clean cut. No deprecated renderer methods or compatibility aliases remain.

## Example Target

`main.ts` owns only:

- URL/control-panel preparation;
- optional development proof loading;
- page `LifetimeScope`, startup failure, pagehide disposal, and status presentation;
- delegation to `startUnderwaterTerrainApplication()`.

`application.ts` owns explicit application assembly:

- MapLibre map, Scratch runtime and Surface;
- DEM source, Worker modules, Virtual Raster, field layer, and terrain renderer;
- `mapLibrePlanarViewSource`, `mapLibreFrameDriver`, and `GeoFrameController`;
- presentation command wiring and proof observations.

MapLibre 4.7.1 keeps `trackResize: true` by default and uses `ResizeObserver` to call map resize
and redraw. The example removes its redundant window resize listener. The frame driver observes
the resulting MapLibre `resize` event.

## Ownership Boundaries

- DEM manifest validation remains application-owned because its PNG encoding, uint8 sample,
  overview, scale/offset, COG, and cache-validator rules are source protocol.
- DEM Worker/protocol/executor remain application-owned implementations of public generic
  Worker and Virtual Raster contracts.
- Cache controls and localStorage remain application policy.
- Map style, default camera, terrain exaggeration, and presentation WGSL remain application
  presentation.
- Geo owns view-source validation, MapLibre planar capture adaptation, frame convergence, and
  terrain renderer lifecycle.

## Simplicity Gates

- `main.ts` is no more than 180 lines and contains no GPU, Virtual Raster, terrain renderer,
  MapLibre camera, or frame-controller construction.
- `application.ts` contains no URL/localStorage/Tweakpane parsing or top-level page bootstrap.
- The example contains no `window.resize`, `graph.resize`, `graph.renderFrame`, settlement field
  translation, local LoD, Virtual Raster sampling, mesh stitching, or camera precision logic.
- Public use is one view source, one frame driver, one frame controller, and one renderer.
- All existing behavior, fault injection, browser proof, performance bounds, and cleanup order
  remain verified.

## Non-Goals

- Reducing total source by hiding DEM protocol or UI behavior behind a broad facade.
- Adding a MapLibre dependency to `geoscratch`.
- Moving example bootstrap into Scratch or Geo.
- Refactoring Flow Layer, Hello GAW, or unrelated examples.
