# DEM COG tile server

Source and dependencies now live in [the shared backend](../../backend/README.md).
This directory retains DEM data and its focused tests. Ordinary browsing uses
`npm run dev`, which serves DEM at `/api/dem/` alongside Flow Field.

This temporary example-owned adapter turns the repository DEM PNG into a
georeferenced Cloud Optimized GeoTIFF and exposes its finite coverage through
the OGC `WebMercatorQuad` tile matrix set. It is not part of the `geoscratch`
package API.

The source PNG, generated COG, and tile responses use standard north-up row-major
storage. WebMercatorQuad tile rows grow from north to south, so the browser and
shader do not apply an additional orientation flip. `255` is a valid source
value, so the COG declares no NoData value. The PNG is an offline COG build input;
it is never exposed as a browser fallback.

## Setup and build

From the repository root:

```bash
npm run backend:setup
examples/backend/.venv/bin/dem-tile-build
```

Generated files are written to `examples/underwaterTerrain/tile-server/cache/` and are
ignored by Git. Rebuilding from the unchanged source produces the same pixel and
metadata semantics.

## Serve

For isolated backend tests or an explicit `?tileServer=` URL:

```bash
examples/backend/.venv/bin/dem-tile-serve --port 8787
```

Endpoints are `/health`, `/manifest.json`,
`/tiles/WebMercatorQuad/{tileMatrix}/{tileRow}/{tileCol}.png`, and `/stats`.
The manifest publishes the finite `TileMatrixLimits` that intersect the source
bounds. Tiles use standard top-left row semantics and fixed `256 x 256` payloads;
the server reads only the requested COG window and does not pre-slice the world.

## Verify

```bash
examples/backend/.venv/bin/python -m pytest examples/underwaterTerrain/tile-server/tests
examples/backend/.venv/bin/rio cogeo validate examples/underwaterTerrain/tile-server/cache/dem.cog.tif
```

The second command is the installed rio-cogeo 7.0.2 CLI equivalent of the goal's
module-shaped validation placeholder.
