# Flow Field velocity tile server

This example-owned tool builds and serves the immutable velocity-only data product used by
`Flow Field`. It does not modify or import the frozen `Flow Layer` implementation and it does
not add source behavior to the GeoScratch package.

## Source contract

The default source directory is `examples/public/json/examples/flow/`. It contains one
little-endian interleaved longitude/latitude `station.bin` and 27 little-endian interleaved
U/V files named `uv_0.bin` through `uv_26.bin`. `source-dataset.json` freezes their byte
counts, station count, field order, and SHA-256 values before construction starts.

The files do not establish physical units, an east/north basis, or model phase. The manifest
therefore records `legacy-flow-unit`, `source-u-v`, ordinal model times `0..26`, and
`phase: unspecified` without making a stronger claim.

## Deterministic construction

The builder:

1. validates every source byte length, SHA-256, and finite float32 pair;
2. invokes the repository-pinned D3 Delaunay helper exactly once for one global topology;
3. samples z9 WebMercatorQuad texel centers using float64 barycentric weights;
4. writes unsupported triangles (maximum edge greater than `0.04` degrees) as U/V zero;
5. derives z8 through z4 with component-wise 2x2 averages; and
6. verifies every 524,288-byte little-endian RG32F page before atomically installing `cache/`.

There is no second raster plane. In particular, construction emits no boundary, depth,
wet/dry, SDF, activity, or vector-feature payload. Runtime display exclusion remains an
application policy.

The canonical source extent covers 59 spatial pages across z4-z9. With 27 times the normal
artifact contains 1,593 pages and 835,190,784 raw page bytes. This is an expected storage
measurement, not an optimization claim. Unit tests use a small synthetic source and do not
materialize the full artifact.

```bash
python3 -m venv examples/flowField/tile-server/.venv
examples/flowField/tile-server/.venv/bin/python -m pip install -e \
  'examples/flowField/tile-server[test]'
examples/flowField/tile-server/.venv/bin/python -m pytest \
  examples/flowField/tile-server/tests -q

# Materializes the full local 835,190,784-byte artifact.
examples/flowField/tile-server/.venv/bin/flow-field-tile-build

# Recomputes manifest and page integrity checks for the installed artifact.
examples/flowField/tile-server/.venv/bin/flow-field-tile-build --verify-existing
```

Two synthetic builds are compared byte-for-byte by `test_build.py`; this is the lightweight
determinism gate used during normal development.

## Static service

```bash
examples/flowField/tile-server/.venv/bin/flow-field-tile-serve --port 8788
```

The service performs no interpolation or downsampling. It exposes:

- `GET /health`
- `GET /manifest.json`
- `GET /tiles/WebMercatorQuad/tNN/{matrix}/{row}/{col}.rg32f`
- `GET /stats`

Manifest and page responses use immutable SHA-256 ETags. An address outside the manifest is a
404 `FLOW_FIELD_TILE_OUT_OF_RANGE`; a declared page whose artifact is unavailable is a 503
`FLOW_FIELD_TILE_ARTIFACT_UNAVAILABLE`. `/stats` retains bounded aggregate counters only.
