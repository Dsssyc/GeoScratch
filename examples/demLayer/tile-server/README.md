# DEM COG tile server

This temporary example-owned adapter turns the repository DEM PNG into a
georeferenced Cloud Optimized GeoTIFF and exposes a bounded local raster pyramid.
It is not part of the `geoscratch` package API.

The source PNG stores logical rows south-to-north because the existing DEM shader
maps increasing latitude to increasing texture `v`. The generated COG is standard
north-up and therefore contains a vertical flip. HTTP tile rows are flipped back
to the example's southwest-origin logical raster convention. `255` is a valid
source value, so the COG declares no NoData value.

## Setup and build

From the repository root:

```bash
python3 -m venv examples/demLayer/tile-server/.venv
examples/demLayer/tile-server/.venv/bin/python -m pip install -e 'examples/demLayer/tile-server[test]'
examples/demLayer/tile-server/.venv/bin/dem-tile-build
```

Generated files are written to `examples/demLayer/tile-server/cache/` and are
ignored by Git. Rebuilding from the unchanged source produces the same pixel and
metadata semantics.

## Serve

```bash
examples/demLayer/tile-server/.venv/bin/dem-tile-serve --port 8787
```

Endpoints are `/health`, `/manifest.json`, `/tiles/{z}/{x}/{y}.png`, and `/stats`.
Zoom `3` is the original `1024 x 558` resolution; zooms `2`, `1`, and `0` select
the `2`, `4`, and `8` COG overview levels. Tiles use a southwest origin and fixed
`256 x 256` payloads. Edge validity is declared by response headers and manifest
dimensions; padded pixels are outside the logical address space.

## Verify

```bash
examples/demLayer/tile-server/.venv/bin/python -m pytest examples/demLayer/tile-server/tests
examples/demLayer/tile-server/.venv/bin/rio cogeo validate examples/demLayer/tile-server/cache/dem.cog.tif
```

The second command is the installed rio-cogeo 7.0.2 CLI equivalent of the goal's
module-shaped validation placeholder.
