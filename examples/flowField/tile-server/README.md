# Flow Field velocity resource tools

This example-owned tool builds and serves the immutable velocity-only data product used by
`Flow Field`. It does not modify or import the frozen `Flow Layer` implementation and it does
not add source behavior to the GeoScratch package.

## Source contract

The default source directory is `examples/public/json/examples/flow/`. It contains one
little-endian interleaved longitude/latitude `station.bin` and 27 little-endian interleaved
U/V files named `uv_0.bin` through `uv_26.bin`. `source-dataset.json` freezes their byte
counts, station count, field order, SHA-256 values, topology request, and interpolation
request before construction starts.

The repository descriptor remains strict schema version 2. Those files do not establish
physical units, an east/north basis, or model phase, so it records `legacy-flow-unit`,
`source-u-v`, ordinal model times `0..26`, and `phase: unspecified` without making a stronger
claim. The reader also accepts schema version 3, which adds `timeUnit` plus explicit authority
for unit, basis, time, phase, and topology. Version 3 keeps dense `timeIndex` values while
allowing finite, strictly increasing numeric `modelTime` values. The currently implemented
Delaunay topology is always `inferred`.

`flow-field-source-describe` generates a schema-v3 descriptor from `station.bin` and
numerically ordered `uv_N.bin` files. It hashes and validates every file, requires matching
finite little-endian float32-pair counts, and defaults all scientific labels to `unspecified`
with `unconfirmed` authority; it never promotes inferred file conventions to authoritative
model semantics. Administrative dataset identity remains explicit:

```bash
examples/flowField/tile-server/.venv/bin/flow-field-source-describe \
  --source /path/to/source \
  --output /path/to/source-dataset.json \
  --dataset-id example-flow \
  --source-revision source-files-v1
```

Use `--model-times`, `--unit`, `--basis`, `--time-unit`, `--phase`, and their authority flags
only when those facts come from the source model. Existing output is never replaced without
`--overwrite`.

## Deterministic construction

The repository source descriptor is schema version 2. Its current strategy is explicitly:

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
6. evaluates a one-texel halo across page seams and keeps a central sample only when its 3x3
   neighborhood is advectable, so ordinary bilinear filtering cannot bleed velocity across
   representable invalid support;
7. samples every z4 through z9 page directly on the global WebMercator texel lattice instead
   of recursively averaging a finer level; and
8. verifies every 524,288-byte little-endian RG32F page before atomically installing `cache/`.

The lattice registration matches the runtime accessor: page texel `(0, 0)` represents the
integer global texel coordinate at that page origin, and bilinear sampling spans to the next
global texel, including across page seams. Every level is reconstructed independently from
the same topology, so a zero outside topology support is never averaged into a coarser page.
Before installation, the builder reproduces the Geo runtime's clamped bilinear sampling at
every unique topology vertex for every z4 through z9 level. The manifest records per-level and
per-time velocity and angular error, stationary vertices reconstructed as moving, moving
vertices reconstructed as zero, raw versus bilinear-safe support counts, and the largest
false-moving speed. These are QA facts rather than another runtime data plane.
They deliberately expose that coarse fallback is conservative and may retire moving particles;
successful byte verification is not a numerical-accuracy approval for every LoD.
The current manifest and `/health` therefore report particle simulation as `not-approved`
(`resolution-error-budget-unset`). The generated pages are an inspectable backend artifact,
not yet an approved simulation input.

The manifest also carries a canonical digest of its complete ordered page set. Verification
requires the exact `times × limits` address product, matching budgets, page paths, lengths,
hashes, and maximum speeds. A configurable preflight bounds spatial pages and raw bytes and
reserves free disk space before topology preparation. Atomic replacement rejects symlinked or
unowned directories even when they happen to be named `cache`.

There is no second raster plane. In particular, construction emits no boundary, depth,
wet/dry, SDF, activity, or vector-feature payload. Runtime display exclusion remains an
application policy.

The canonical source extent covers 59 spatial pages across z4-z9. With 27 times the normal
artifact contains 1,593 pages and 835,190,784 raw page bytes. This is an expected storage
measurement, not an optimization claim. Unit tests use a small synthetic source and do not
materialize the full artifact.

## Single-snapshot COG

`flow-field-cog-build` builds one selected U/V time as one internally tiled, two-band
float32 COG. It uses the same Delaunay topology and stationary-triangle rule as the RG32F
page builder, but samples standard GeoTIFF pixel centres. The output is EPSG:3857, band 1 U,
band 2 V, 256 by 256 pixel-interleaved blocks, DEFLATE predictor 3, and no
nodata/mask/alpha. Exact `(0, 0)` remains the only representation of non-advectable support;
the COG adds no boundary, wet/dry, depth, SDF, activity, or third raster plane.

The default resolution strategy does not use the absolute minimum station distance. It:

1. deduplicates exact station coordinates and projects them to EPSG:3857;
2. computes nearest non-self distance for each unique station;
3. finds the leftmost statistically supported mode in a fixed, smoothed log2 histogram;
4. requires at least 1% or 1,024 supporting stations plus 25% peak prominence;
5. uses the median original distance in that mode's `+/-0.25`-octave window; and
6. chooses the first WebMercatorQuad matrix providing at least two samples per spacing.

For the repository data this resolves `12.504520 m` effective spacing to z15 at
`4.777314 m/pixel`. That z15 result is the only accepted COG base grid; the API and CLI have
no coarser matrix override. Its complete extent is `275 x 301` blocks,
`70,400 x 77,056` pixels, and `43,397,939,200` raw U/V bytes (`40.4175 GiB`).

The COG contains nine recursively generated semantic overviews. A parent candidate requires
all four child vectors to be finite and nonzero, uses one fixed-order float64 component mean
and one float32 cast, treats a mean that rounds to `(0, 0)` as non-advectable, then applies a
new cross-block 3 by 3 support erosion before storing the parent. This prevents ordinary
bilinear filtering at every overview from leaking velocity across a representable zero
boundary. The support booleans are temporary construction state and never enter the COG.

Nominal overview factors are `2..512`. The first eight levels preserve exact power-of-two
WebMercator pixel registration; the terminal COG level is `138 x 151` and GDAL reports its
extent-preserving decimation as 510. All level dimensions, transforms, support counts, and
pixel SHA-256 values are bound into the manifest. Custom pixels are assembled through VRT
explicit overviews and GDAL COG `OVERVIEWS=FORCE_USE_EXISTING`; rio-cogeo is used only for
strict structural validation.

The verified local t00 artifact is schema 2 / package 0.4.0:

- content version `flow-cog-00343edcd11320c9-t00-z15-v2`;
- `1,584,930,583` compressed bytes;
- COG SHA-256 `0013f530793c6d209df22a9c46346c52258c6ea13238f35e9b6db983cd3f7333`;
- 110,658 base-plus-overview blocks and `57,863,864,904` logical raw bytes;
- `4,792,334,976` peak compressed staging bytes; and
- strict COG validation with no errors or warnings.

The COG quality record remains `particleSimulation: not-approved` with reason
`inferred-topology-and-source-semantics-unapproved`. The statistical raster ceiling and
overview bytes are now settled; model connectivity, physical unit/basis, and time semantics
remain separate source-authority questions.

Planning is read-only and reports the selected z15 grid, complete pyramid work, and both
logical-work and compressed-staging budgets:

```bash
examples/flowField/tile-server/.venv/bin/flow-field-cog-build --plan-only

# Builds only uv_0 at the statistically selected source ceiling.
examples/flowField/tile-server/.venv/bin/flow-field-cog-build --time-index 0

# Recomputes marker, manifest, container, encoding, file, and pixel identity.
examples/flowField/tile-server/.venv/bin/flow-field-cog-build --verify-existing
```

COG internal tiling and compression do not avoid interpolating every selected base pixel.
Preflight bounds total blocks and raw pyramid work; construction separately monitors actual
compressed staging and a free-space reserve. The verified local build completed in roughly
28 minutes without exceeding 0.8 GiB RSS during generation. See
[ADR-092](../../../docs/decisions/ADR-092-statistical-ceiling-flow-cog-overviews.md).

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
    BuildBudget,
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
    budget=BuildBudget(
        max_spatial_pages=4_096,
        max_raw_page_bytes=8 * 1024**3,
        minimum_free_bytes=64 * 1024**2,
    ),
)
```

No other topology or interpolation kind is accepted yet. Unsupported objects fail with
`UNSUPPORTED_TOPOLOGY` or `UNSUPPORTED_INTERPOLATION`; they never silently fall back to
Delaunay. Future authoritative triangle, rectilinear, nested-grid, or polygon-cell strategies
can extend these typed parameters without changing the build entrypoint.

The COG path exposes the same typed upper-level parameters and keeps planning separate from
construction:

```python
from geoscratch_flow_field_tiles.cog import (
    CogBuildBudget,
    build_velocity_cog_snapshot,
    plan_velocity_cog_snapshot,
)
from geoscratch_flow_field_tiles.source import load_source_snapshot

snapshot = load_source_snapshot(time_index=0)
plan = plan_velocity_cog_snapshot(
    snapshot.stations,
    snapshot.geographic_bounds,
    output_parent="examples/flowField/tile-server",
)
plan.require_output_approved()

result = build_velocity_cog_snapshot(
    time_index=0,
    budget=CogBuildBudget(),
)
```

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
