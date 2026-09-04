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

The generator's Delaunay default rejects duplicate coordinates. The repository source is a
reviewed exception: it contains 11 coincident pairs and therefore requires the same explicit
duplicate/bridge policy as the committed descriptor when regenerating it:

```bash
examples/flowField/tile-server/.venv/bin/flow-field-source-describe \
  --source examples/public/json/examples/flow \
  --output /path/to/source-dataset.json \
  --dataset-id geoscratch-flow-field-velocity \
  --source-revision station-uv-sha256-v1 \
  --duplicate-policy mean \
  --maximum-edge-ratio 16 \
  --maximum-edge-length-meters 5000
```

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

For the repository data the default strategy resolves `12.504520 m` effective spacing to z15
at `4.777314 m/pixel`. Its complete extent is `275 x 301` blocks, `70,400 x 77,056` pixels,
and `43,397,939,200` raw U/V bytes (`40.4175 GiB`).

Callers may instead select one explicit WebMercatorQuad matrix with
`FixedWebMercatorResolution(matrix_id=N)` or `--matrix N`. This bypasses station-spacing
statistics and records `explicitly-requested` in construction identity; it never claims that
the chosen matrix is the statistical ceiling. Omitting the parameter preserves the default
statistical strategy. Budgets only approve or reject the selected matrix and never silently
turn a rejected z15 plan into z10.

The COG contains recursively generated semantic overviews until its terminal level fits the
COG access requirement. A parent candidate requires all four child vectors to be finite and
nonzero, uses one fixed-order float64 component mean and one float32 cast, treats a mean that
rounds to `(0, 0)` as non-advectable, then applies a new cross-block 3 by 3 support erosion
before storing the parent. This prevents ordinary bilinear filtering at every overview from
leaking velocity across a representable zero boundary. The support booleans are temporary
construction state and never enter the COG.

The default z15 artifact has nine nominal factors `2..512`; its first eight levels preserve
exact power-of-two WebMercator pixel registration, while the terminal `138 x 151` level has
extent-preserving GDAL decimation 510. The explicit z10 artifact has four exact factors
`2, 4, 8, 16`. All level dimensions, transforms, support counts, and pixel SHA-256 values are
bound into the manifest. Custom pixels are assembled through VRT explicit overviews and GDAL
COG `OVERVIEWS=FORCE_USE_EXISTING`; rio-cogeo is used only for strict structural validation.

The verified local t00 artifact is schema 2 / package 0.4.0:

- content version `flow-cog-00343edcd11320c9-t00-z15-v2`;
- `1,584,930,583` compressed bytes;
- COG SHA-256 `0013f530793c6d209df22a9c46346c52258c6ea13238f35e9b6db983cd3f7333`;
- 110,658 base-plus-overview blocks and `57,863,864,904` logical raw bytes;
- `4,792,334,976` peak compressed staging bytes; and
- strict COG validation with no errors or warnings.

The explicit-z10 t00 proof built with tool package 0.6.0 in 4.94 seconds:

- content version `flow-cog-0ce0c5c0597eeae4-t00-z10-v2`;
- `2,560 x 2,816` base pixels, 154 base-plus-overview blocks, and `76,820,480`
  logical raw pyramid bytes;
- `11,953,369` compressed bytes and `25,139,486` peak compressed staging bytes;
- COG SHA-256 `4458198552459df68709409dbcd0aa03b9bd174565e6fe8c19ad8b455a08e71f`;
- pixel SHA-256 `4a10ce75371c4ce5be9c53bf0d25d2fd0393ace5c9dc1ae09f9fa61b0f52d631`;
  and
- strict deep verification with no COG warnings.

The same t00 COG was previously published under the v1 adapter as a one-time z10 collection
with all 59 z4-z9 runtime pages.
Its total artifact size is `12,012,275` bytes, page-set SHA-256 is
`7ab9c53e4321cc12b9bd2046f363c625a540cc5636cf7ce869121faa844a822e`, and the collection deep
verifier passed.

The schema-v2 / adapter-v2 proof publishes the complete bounded z4-z10 product: 169 pages,
including 110 z10 pages. Its 46,215-byte runtime manifest records source ceiling z10,
`sampleKey: t00`, subset coverage against 27 source samples, no invented adjacency, complete
unconfirmed authority, pixel-centre representation, and `particleSimulation: not-approved`.
Deep collection verification passed with page-set SHA-256
`92c5e3a632288c5181ab5c06f18b88b17fdef71bcd62861a52a629cdf67e3d26`.

The COG quality record remains `particleSimulation: not-approved` with reason
`inferred-topology-and-source-semantics-unapproved`. The statistical raster ceiling and
overview bytes are now settled; model connectivity, physical unit/basis, and time semantics
remain separate source-authority questions.

Planning is read-only and reports the selected grid, complete pyramid work, and both
logical-work and compressed-staging budgets:

```bash
examples/flowField/tile-server/.venv/bin/flow-field-cog-build --plan-only

# Builds only uv_0 at the statistically selected source ceiling.
examples/flowField/tile-server/.venv/bin/flow-field-cog-build --time-index 0

# Explicitly plan or build z10; this is a caller choice, not a budget fallback.
examples/flowField/tile-server/.venv/bin/flow-field-cog-build --matrix 10 --plan-only
examples/flowField/tile-server/.venv/bin/flow-field-cog-build --matrix 10 --time-index 0

# Recomputes marker, manifest, container, encoding, file, and pixel identity.
examples/flowField/tile-server/.venv/bin/flow-field-cog-build --verify-existing
```

Replacing an existing owned `cog-cache` retains the previous snapshot as a sibling backup and
reports it as `replacedBackup`; inspect or restore that directory before manually removing it.
The snapshot builder never recursively deletes a replaced backup.

COG internal tiling and compression do not avoid interpolating every selected base pixel.
Preflight bounds total blocks and raw pyramid work; construction separately monitors actual
compressed staging and a free-space reserve. The verified local build completed in roughly
28 minutes without exceeding 0.8 GiB RSS during generation. See
[ADR-092](../../../docs/decisions/ADR-092-statistical-ceiling-flow-cog-overviews.md),
[ADR-094](../../../docs/decisions/ADR-094-explicit-flow-cog-resolution.md), and
[ADR-095](../../../docs/decisions/ADR-095-bounded-flow-runtime-manifest.md).

## Temporal COG collection

`flow-field-cog-collection-build` composes independently verifiable snapshot COGs into one
temporal product without changing their pixels or three-file snapshot contract. Its output is:

```text
cog-collection/
  .flow-field-cog-collection.json
  manifest.json
  runtime-manifest.json
  snapshots/tNN/{.flow-field-cog-artifact.json,manifest.json,flow-tNN.cog.tif}
```

The backend generates `runtime-manifest.json` during collection publication and the service
returns those exact bytes from `GET /manifest.json`. Schema 2 makes `sampleKey` the runtime
time identity, declares whether consecutive published samples are interpolable or separated by
an omitted-source gap, and promotes source authority, quality, source ceiling, and the
pixel-centre RG32F representation to frontend-visible facts. `timeIndex` remains source
provenance and is not an array offset.
The backend collection separately embeds and re-hashes the complete descriptor time inventory,
so `full` versus `subset` is not inferred from repeated count fields alone.

Browser publication is bounded independently from COG construction resolution. A z9 COG
publishes z4-z9; a z10 or finer COG publishes z4-z10. The real source ceiling remains visible
in `sourceCeiling`, while `tileMatrixSet.maxTileMatrix` is the requestable ceiling. This avoids
turning a default z15 build into a multi-million-page runtime index.

Time selection is explicit and canonical. Choose exactly one of all descriptor fields, a
half-open range, or a comma-separated list:

```bash
# Read-only full-product plan. The estimate must come from a measured or justified snapshot.
examples/flowField/tile-server/.venv/bin/flow-field-cog-collection-build \
  --all-times \
  --matrix 10 \
  --plan-only \
  --estimated-snapshot-bytes 11953369

# Build every time only after the plan is capacity-approved.
examples/flowField/tile-server/.venv/bin/flow-field-cog-collection-build \
  --all-times \
  --matrix 10 \
  --estimated-snapshot-bytes 11953369 \
  --batch-size 2 \
  --events-stderr

# Other legal selections create explicit subset collections.
examples/flowField/tile-server/.venv/bin/flow-field-cog-collection-build \
  --time-range 0:4 --matrix 10 --estimated-snapshot-bytes 11953369
examples/flowField/tile-server/.venv/bin/flow-field-cog-collection-build \
  --time-indices 0,4,9 --matrix 10 --estimated-snapshot-bytes 11953369
```

The compressed estimate is planning input, not permission to exceed storage. Before publish,
the builder measures every regular file in the payload, enforces `--max-collection-bytes`, and
records exact snapshot, runtime-manifest, collection-manifest, marker, and total bytes under
`manifest.storage`. For the current source, simply multiplying the measured t00 COG size by 27
projects `42,793,125,741` compressed COG bytes before child manifests and collection metadata.
Preflight adds the larger of the per-snapshot and aggregate-batch execution peaks. With defaults,
the per-snapshot `32 GiB` staging cap plus `8 GiB` reserve governs, so this estimate requires at
least `85,742,798,701` available bytes before metadata. It therefore rejects the complete
default-z15 collection on this workstation; capacity rejection never changes the selected
matrix or silently omits times.

An explicit z10 collection is legal because the current runtime adapter requires a base matrix
of at least z9. z8 and below remain valid for standalone COG construction but are rejected by
the temporal collection plan. Measure one z10 snapshot first, then use that compressed size
rather than the z15 measurement:

```bash
examples/flowField/tile-server/.venv/bin/flow-field-cog-collection-build \
  --all-times \
  --matrix 10 \
  --plan-only \
  --estimated-snapshot-bytes 11953369
```

Using that t00 measurement projects `322,740,963` compressed COG bytes for all 27 snapshots.
With the deliberately conservative default staging caps, the current plan requires
`43,272,413,923` available bytes and is approved on the measured workstation. The projected
final bytes are the storage estimate; the larger availability requirement includes transient
construction headroom and the free-space reserve.

The output lock is acquired before reading mutable resume state and is held for the whole job.
Verified children are skipped, and a complete child left in request-owned work is verified
before promotion. Incomplete GDAL staging is never deleted because its name looks temporary.
The default is fail-closed and preserve; rebuilding it requires explicit authorization:

```bash
examples/flowField/tile-server/.venv/bin/flow-field-cog-collection-build \
  --all-times \
  --matrix 10 \
  --estimated-snapshot-bytes 11953369 \
  --resume

# Only use after inspecting the matching request-owned incomplete work.
examples/flowField/tile-server/.venv/bin/flow-field-cog-collection-build \
  --all-times \
  --matrix 10 \
  --estimated-snapshot-bytes 11953369 \
  --resume --discard-incomplete-work
```

The lock is cooperative. Keep the output parent exclusive to this job; device/inode checks
prevent observed pathname reuse during cleanup but do not defend against another local process
that can maliciously rewrite the parent in the final filesystem-operation window.

`--replace-existing` is also explicit. It installs the new verified collection but retains the
previous owned collection as a sibling backup and returns its path as `replacedBackup`. Inspect
or restore that backup before manually removing it; the builder never recursively deletes it.

Verification has two levels. Identity verification re-hashes every child COG and validates all
containers/contracts. Deep verification additionally recomputes every child semantic overview
and every advertised RG32F runtime page:

```bash
examples/flowField/tile-server/.venv/bin/flow-field-cog-collection-build \
  --verify-existing --identity-only
examples/flowField/tile-server/.venv/bin/flow-field-cog-collection-build \
  --verify-existing
```

Missing snapshots are built in bounded batches of at most two by default. Each batch reads and
validates station coordinates once, prepares one Delaunay topology, and traverses the spatial
blocks once. Pixel centres and the triangle-linear stencil are shared for that block; U/V
application, support counts, overview construction, COG validation, manifest, and installation
remain independent per time. Completed children survive a later child failure and are recovered
before the next batch. `--batch-size 1|2`, `--max-batch-staged-bytes`, and
`--batch-minimum-free-bytes` control execution only; no batch field enters a snapshot or
collection construction identity.

Synthetic parity freezes batch-size one and two to the same child construction facts, support
and overview digests, COG SHA/size, and content version. A collection additionally binds each
complete child manifest SHA. Honest preflight facts inside that child manifest include observed
free space and staging values, so builds performed under different operational observations can
produce different child-manifest SHA and therefore a different collection content version even
when the COG bytes are identical. With fixed preflight observations, batch-size one and two
produce the same collection identity.

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
from geoscratch_flow_field_tiles import FixedWebMercatorResolution
from geoscratch_flow_field_tiles.source import load_source_snapshot

snapshot = load_source_snapshot(time_index=0)
resolution = FixedWebMercatorResolution(matrix_id=10)
plan = plan_velocity_cog_snapshot(
    snapshot.stations,
    snapshot.geographic_bounds,
    output_parent="examples/flowField/tile-server",
    resolution=resolution,
)
plan.require_output_approved()

result = build_velocity_cog_snapshot(
    time_index=0,
    resolution=resolution,
    budget=CogBuildBudget(),
)
```

The temporal API uses the same typed strategies and makes selection, resume, replacement, and
budgets explicit:

```python
from geoscratch_flow_field_tiles import FixedWebMercatorResolution
from geoscratch_flow_field_tiles.collection import (
    CogCollectionBudget,
    build_velocity_cog_collection,
    plan_velocity_cog_collection,
    verify_velocity_cog_collection,
)

times = tuple(range(27))
resolution = FixedWebMercatorResolution(matrix_id=10)
plan = plan_velocity_cog_collection(
    time_indices=times,
    resolution=resolution,
    collection_budget=CogCollectionBudget(
        estimated_snapshot_bytes=11_953_369,
    ),
)
plan.require_output_approved()

result = build_velocity_cog_collection(
    time_indices=times,
    resolution=resolution,
    collection_budget=CogCollectionBudget(
        estimated_snapshot_bytes=11_953_369,
    ),
    resume=True,
)
verify_velocity_cog_collection(result.output_directory)
```

## RG32F service

```bash
# Historical pre-cut page artifact.
examples/flowField/tile-server/.venv/bin/flow-field-tile-serve \
  --output examples/flowField/tile-server/cache --port 8788

# Temporal COG collection through the same network paths.
examples/flowField/tile-server/.venv/bin/flow-field-tile-serve \
  --output examples/flowField/tile-server/cog-collection --port 8788
```

Both backends expose:

- `GET /health`
- `GET /manifest.json`
- `GET /tiles/WebMercatorQuad/{sampleKey}/{matrix}/{row}/{col}.rg32f`
- `GET /stats`

Manifest and page responses use SHA-256 ETags with `Cache-Control: public, no-cache`, because
the stable URLs can be replaced and must revalidate before reuse. An address outside the manifest is a
404 `FLOW_FIELD_TILE_OUT_OF_RANGE`; a declared page whose artifact is unavailable is a 503
`FLOW_FIELD_TILE_ARTIFACT_UNAVAILABLE`. `/stats` retains bounded aggregate counters only and
reports `cogWindowReads` for the collection backend.

The collection service returns the exact page bytes and SHA declared at publication. Published
z7 through `min(sourceCeiling, z10)` physical values use exact integer IFD windows. z6-z4 are
recursively derived from globally aligned z7 values with the same conservative vector reducer;
the terminal COG IFD is validated as container content but never treated as WebMercator address
authority.
It never invokes generic image resampling, exposes the `.tif`, or returns partial Range data.
`runtime-manifest.json` schema 2 declares
`representation.sampleRegistration: pixel-center`; the current browser still uses the
historical integer-lattice sampler, so frontend half-texel migration remains required before
switching the active Flow Field example to this backend.

The server snapshots collection identity and COG fingerprints at startup; it does not hot reload.
Replacing a collection while its old process is running makes that process fail requests with 503
after the fingerprint changes. Restart the service to admit and serve the new collection.
