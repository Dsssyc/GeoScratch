# ADR-090: Flow Field Velocity-Only Virtual Raster Backend

## Status

ADR-107 supersedes the default all-moving triangle rule and neighborhood erosion
for new COG products; existing v2 data retains the interpretation recorded below.

Accepted. Supersedes the D3-specific, fixed-degree support, texel-center storage, and
recursive coarse-reduction clauses in the Flow Field implementation plan. It does not
change the frozen `Flow Layer` example or add a Geo/Scratch public API. ADR-091 records the
historical single-snapshot COG prototype; ADR-092 defines the current statistical-ceiling COG.

## Date

2026-08-27

## Context

The Flow Field source currently provides 117,148 longitude/latitude station rows and 27
time-varying U/V arrays, but no authoritative cell connectivity. Different hydrodynamic
sources may later provide triangular, rectilinear, nested-grid, or polygon-cell topology.
Treating one generated triangulation as the universal grid model would make those future
inputs lose information.

The first tile builder invoked D3 through a Node subprocess, treated its generated triangle
count as a source fact, filtered triangles with one `0.04` degree threshold, rasterized only
z9, and recursively averaged z8 through z4. It also sampled stored values at texel centers,
while the current Geo Virtual Raster accessor treats integer global texel coordinates as the
bilinear lattice. These choices left topology provenance implicit and caused half-texel and
cross-LoD reconstruction drift.

The source also contains 11 pairs of exactly coincident station coordinates. Their U/V values
are not always equal; the largest vector difference over the 27 times is approximately
`0.306681`. A triangulation cannot represent two values at one geometric vertex without an
explicit source policy.

## Decision

The example-owned Python builder exposes typed `topology` and `interpolation` parameters.
Omitted generic strategy values resolve to `DelaunayTopology()` and
`TriangleLinearInterpolation()`. Only those types are implemented now. An unsupported object
fails with `UNSUPPORTED_TOPOLOGY` or `UNSUPPORTED_INTERPOLATION`; it never silently falls back.

The committed source descriptor explicitly requests:

```text
DelaunayTopology(
    duplicate_policy="mean",
    local_spacing_neighbors=8,
    maximum_edge_ratio=16,
    maximum_edge_length_meters=5000,
)

TriangleLinearInterpolation(
    stationary_policy="require-all-moving",
    stationary_epsilon=0,
)
```

The strict `DelaunayTopology()` default still rejects duplicates. `mean` is a reviewed choice
for this source, not a universal rule. A future authoritative topology may legitimately keep
coincident node identities separate.

The normal RG32F page construction uses NumPy and SciPy only:

1. validate all source hashes, lengths, shapes, and finite U/V pairs;
2. reduce exact duplicates deterministically according to the topology request;
3. project stations to EPSG:3857, center them, and apply one uniform normalization scale;
4. create one SciPy Delaunay topology with fixed Qhull options;
5. reject numerical degeneracy and configured metric long-bridge candidates;
6. compile target simplex identities and float64 barycentric weights once per spatial page;
7. reuse each page stencil for U and V at every model time;
8. write exact zero when the target is outside the convex hull, belongs to a rejected
   triangle, or any triangle vertex is stationary for that time; and
9. prepare a one-texel cross-page halo and retain a central lattice velocity only when its
   complete 3 by 3 advectable neighborhood is valid, preventing ordinary four-corner
   bilinear filtering from leaking velocity across representable invalid support; and
10. convert the final interleaved U/V page to little-endian float32.

The bridge rule is an inferred-support heuristic, not a water boundary or physical topology.
The manifest records requested and resolved strategy, SciPy version, Qhull options, topology
hash, input/unique/duplicate counts, accepted/rejected triangle counts, rejection reasons,
and the complete heuristic configuration.

Every z4 through z9 page is sampled directly from the same prepared topology. Stored texel
`(0, 0)` is the integer global texel coordinate at the page origin. Neighboring pages
therefore form one continuous global lattice for the current runtime bilinear accessor.
Coarser pages are not derived from finer page bytes.

The normal payload remains exactly two float32 velocity components. Stationary-triangle
gating is evaluated while applying each time field and produces exact U/V zero; it creates no
boundary, activity, depth, wet/dry, SDF, or vector-feature plane.

The content version is derived from source identity, build algorithm version, resolved
topology and interpolation facts, exact matrix limits, page size, lattice registration,
direct-level policy, support filter, and a canonical SHA-256 root over the complete ordered
page set. The builder, verifier, and service reject incomplete address products, altered
budgets, malformed page metadata, and stale construction contracts.

Before atomic installation, the builder reproduces the Geo accessor's outer-boundary clamp and
runtime bilinear sample at every unique topology vertex for every z4 through z9 level. It
records per-level/per-time velocity error, angular error, stationary-to-moving mismatches,
moving-to-zero collapses, raw advectable lattice count, bilinear-safe lattice count, and
maximum false-moving speed. These are explicit QA facts, not a claim that a raster level can
preserve source variations below its texel scale.

Construction performs a page/byte/free-space preflight before topology preparation. It only
replaces an explicit non-symlink `cache` directory that carries a Flow Field artifact marker or
a narrowly recognized legacy Flow Field layout. Installation remains staged and atomic; an
unowned cache directory is never recursively removed.

The first v4 build of the committed source makes the resolution tradeoff visible. At z9, the
bilinear-safe filter retains a median 97.6% of raw advectable lattice samples. Across all 27
times, station reconstruction reports 118 stationary-to-moving cases out of 307,723 stationary
vertex-times and 336,799 moving-to-zero cases out of 2,854,976 moving vertex-times. At z4 the
moving-to-zero fraction is about 74.4%. This is conservative failure at coarse resolution, not
permission to treat z4 as a physically accurate simulation field. A later runtime/LoD decision
must use these facts rather than hiding them behind successful byte verification.

Accordingly, the v4 manifest and service health explicitly report particle simulation as
`not-approved` with reason `resolution-error-budget-unset`. The artifact is available for
resource inspection and the next LoD decision, but no current level is claimed as a validated
particle-simulation field. Sub-texel invalid triangle interiors remain unresolved by a finite
velocity-only lattice.

## Consequences

- The normal RG32F page builder no longer depends on Node, D3, C++, QuikGrid, GDAL, PROJ,
  packed PNGs, seed textures, or projection textures. ADR-091's optional COG writer adds the
  already established Rasterio/rio-cogeo stack only to the example-owned offline tool.
- One immutable topology and page stencil set is reused across all 27 time fields.
- Exact duplicate behavior is deterministic and auditable.
- Dynamic non-advectable support is encoded only as zero U/V and follows each time field.
- Direct per-level sampling removes recursive zero-value spreading and accumulated LoD error;
  one-texel support erosion prevents bleed across invalid support represented on that level's
  lattice, but does not recover invalid source detail below the texel scale.
- The current Delaunay result remains an inferred fallback. It cannot prove riverbanks,
  holes, disconnected water bodies, nested-grid priority, or conservative polygon-cell
  remapping from XY alone.
- The recorded all-level reconstruction facts must guide later resolution/storage decisions;
  passing byte/hash and support-safety verification alone is not numerical-accuracy approval.

Future topology types are additive descriptors such as authoritative indexed triangles,
rectilinear grids, nested grids, and polygon cells. Each must lower into the same reusable
page-stencil and RG32F writer contract without changing the normal runtime data plane.

## Reference

SciPy documents Delaunay simplices, omitted/coplanar inputs, `find_simplex()` outside value
`-1`, and the `transform` matrices used for barycentric coordinates:
<https://docs.scipy.org/doc/scipy/reference/generated/scipy.spatial.Delaunay.html>.

The single-snapshot statistical resolution and COG contract is recorded by
[ADR-091](./ADR-091-statistical-flow-cog-snapshot.md) and its accepted replacement,
[ADR-092](./ADR-092-statistical-ceiling-flow-cog-overviews.md).
