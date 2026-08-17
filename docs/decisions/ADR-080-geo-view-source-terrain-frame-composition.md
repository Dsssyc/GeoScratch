# ADR-080: Compose View Sources Directly Into Terrain Geo Frames

## Status

Accepted. Extends ADR-079 and replaces the public terrain `renderFrame` plus `resize` split.

## Date

2026-08-17

## Context

ADR-079 gave MapLibre-hosted and independent applications one frame-controller contract, but
Underwater Terrain still assembled camera plus viewport, compared renderer size, called renderer
resize, submitted a terrain frame, and translated terrain page requests into
`GeoFrameSettlement.residencyWorkCount`. Those operations were no longer application policy.

The same `main.ts` also mixed page configuration, proof loading, and failure presentation with
the resource assembly that downstream users need to study. Hiding everything behind a broad
Underwater-Terrain factory would reduce visible lines while making ownership harder to inspect.

## Decision

### Add one view-source contract

`GeoViewSource<View>` synchronously returns an immutable `GeoViewSourceCapture<View>` containing
`view` and positive integer `SurfaceSize`. It owns no camera, host events, revision, renderer, or
lifetime. `createGeoViewSource()` captures the reader and copies size facts at every observation.

`mapLibrePlanarViewSource()` composes the existing planar adapter, structural map, viewport
reader, and minimum elevation. It does not overlap `mapLibreFrameDriver()`: the source reads view
facts, while the driver owns host revision, repaint scheduling, custom-layer registration, and
listener cleanup.

### Make terrain rendering a Geo frame producer

`WebMercatorTerrainRenderer.render(capture)` is the only public render operation. It resizes the
Surface and depth target only when capture size changes, submits from the exact captured view,
and returns `GeoFrameResult<WebMercatorTerrainFrameValue>`. Immediate terrain frame facts live in
the result value; native observation, delayed feedback, and residency settlement remain on the
Geo frame result.

`WebMercatorTerrainFrameSettlement` directly satisfies `GeoFrameSettlement` and exposes
`residencyWorkCount`. The terrain-specific `requestedPageCount` alias is removed. Public
`renderFrame()` and `resize()` are removed during `0.x.x` rather than retained as compatibility
paths.

### Split bootstrap from application assembly

Underwater Terrain `main.ts` owns URL/control state, optional browser proof loading, pagehide,
failure presentation, and the page lifetime. `application.ts` explicitly assembles map, runtime,
Surface, source, Worker modules, Virtual Raster, field layer, terrain renderer, view source,
frame driver, and frame controller.

MapLibre GL JS 4.7.1 defaults `trackResize` to true and observes its container. The redundant
application window-resize listener is removed; MapLibre emits the resize observed by the frame
driver.

## Consequences

- Renderer consumers no longer translate resize or settlement semantics.
- MapLibre and a future standalone camera can provide the same view-source capture shape.
- Underwater Terrain page bootstrap is 147 lines and contains no GPU or Geo runtime assembly.
- The explicit application assembly remains visible rather than becoming a hidden global owner.
- DEM manifest, PNG decoding, Worker protocol, cache UI, map style, and presentation WGSL remain
  application-owned because they are actual source and product policy.

## Rejected Alternatives

### Add a complete Underwater Terrain facade to Geo

Rejected because it would move DEM, PNG, MapLibre style, cache, and UI policy into a public API
that only fits one example.

### Keep renderer resize and settlement adapters in applications

Rejected because every controller integration would repeat the same renderer-owned operations
and could drift in ordering or work-count semantics.

### Merge all example files to reduce file count

Rejected because source protocol, Worker execution, UI state, page bootstrap, and GPU assembly
have different change reasons. Context-local files are easier for developers and agents to read
than one shorter file list containing several thousand interleaved lines.
