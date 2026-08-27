# Flow Field velocity tile server

This example-owned tool builds and serves the immutable velocity-only data product used by
`Flow Field`. It does not modify or import the frozen `Flow Layer` implementation and it does
not add source behavior to the GeoScratch package.

## Source contract

The default source directory is `examples/public/json/examples/flow/`. It contains one
little-endian interleaved longitude/latitude `station.bin` and 27 little-endian interleaved
U/V files named `uv_0.bin` through `uv_26.bin`. `source-dataset.json` freezes their byte
counts, station count, field order, SHA-256 values, topology request, and interpolation
request before construction starts.

The files do not establish physical units, an east/north basis, or model phase. The manifest
therefore records `legacy-flow-unit`, `source-u-v`, ordinal model times `0..26`, and
`phase: unspecified` without making a stronger claim.

## Deterministic construction

The source descriptor is schema version 2. Its current strategy is explicitly:

```json
{
  "topology": {
    "kind": "delaunay",
    "duplicatePolicy": "mean",
    "localSpacingNeighbors": 8,
    "maximumEdgeRatio": 16.0,
    "maximumEdgeLengthMeters": 5000.0
  },
  "interpolation": {
    "kind": "triangle-linear",
    "stationaryPolicy": "require-all-moving",
    "stationaryEpsilon": 0.0
  }
}
```

`DelaunayTopology()` remains strict by default and rejects duplicate coordinates. The
repository dataset explicitly selects `mean` because its 117,148 source rows contain 11
pairs of coincident coordinates with conflicting U/V values. Construction records the
source count, unique vertex count, duplicate count, maximum duplicate velocity difference,
and chosen policy instead of allowing the triangulation library to discard duplicates.

The builder:

1. validates every source byte length, SHA-256, and finite float32 pair;
2. projects unique stations to EPSG:3857 and prepares one SciPy Delaunay topology;
3. rejects numerically degenerate triangles and configured long-bridge candidates using
   metric local-spacing facts;
4. compiles one float64 barycentric stencil for each spatial page and reuses it for every
   model time;
5. writes a triangle only when all three station velocities can move a particle in that model
   time; otherwise its targets remain exact U/V zero without another raster plane;
6. samples every z4 through z9 page directly on the global WebMercator texel lattice instead
   of recursively averaging a finer level; and
7. verifies every 524,288-byte little-endian RG32F page before atomically installing `cache/`.

The lattice registration matches the runtime accessor: page texel `(0, 0)` represents the
integer global texel coordinate at that page origin, and bilinear sampling spans to the next
global texel, including across page seams. Every level is reconstructed independently from
the same topology, so a zero outside topology support is never averaged into a coarser page.
Before installation, the builder also reproduces the runtime's finest-level bilinear sampling
at every unique topology vertex. The manifest records per-time velocity and angular error,
stationary vertices reconstructed as moving, moving vertices reconstructed as zero, and the
largest false-moving speed. These are QA facts rather than another runtime data plane.

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
determinism gate used during normal development. Additional tests freeze duplicate handling,
degenerate input errors, bridge rejection, convex barycentric weights, exact outside-support
zeroes, strategy rejection, global-lattice page seams, and direct per-level construction.

## Python construction API

The descriptor supplies the normal build strategies. Programmatic callers may explicitly
override them with the currently implemented typed modes:

```python
from geoscratch_flow_field_tiles import (
    DelaunayTopology,
    TriangleLinearInterpolation,
)
from geoscratch_flow_field_tiles.build import build_velocity_tiles

build_velocity_tiles(
    topology=DelaunayTopology(
        duplicate_policy="mean",
        local_spacing_neighbors=8,
        maximum_edge_ratio=16.0,
        maximum_edge_length_meters=5_000.0,
    ),
    interpolation=TriangleLinearInterpolation(
        stationary_policy="require-all-moving",
        stationary_epsilon=0.0,
    ),
)
```

No other topology or interpolation kind is accepted yet. Unsupported objects fail with
`UNSUPPORTED_TOPOLOGY` or `UNSUPPORTED_INTERPOLATION`; they never silently fall back to
Delaunay. Future authoritative triangle, rectilinear, nested-grid, or polygon-cell strategies
can extend these typed parameters without changing the build entrypoint.

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
