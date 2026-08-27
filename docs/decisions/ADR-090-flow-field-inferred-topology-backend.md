# ADR-090: Flow Field Inferred-Topology Backend

## Status

Accepted. Supersedes the D3-specific, fixed-degree support, texel-center storage, and
recursive coarse-reduction clauses in the Flow Field implementation plan. It does not
change the frozen `Flow Layer` example or add a Geo/Scratch public API.

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

Construction uses NumPy and SciPy only:

1. validate all source hashes, lengths, shapes, and finite U/V pairs;
2. reduce exact duplicates deterministically according to the topology request;
3. project stations to EPSG:3857, center them, and apply one uniform normalization scale;
4. create one SciPy Delaunay topology with fixed Qhull options;
5. reject numerical degeneracy and configured metric long-bridge candidates;
6. compile target simplex identities and float64 barycentric weights once per spatial page;
7. reuse each page stencil for U and V at every model time;
8. write exact zero when the target is outside the convex hull, belongs to a rejected
   triangle, or any triangle vertex is stationary for that time; and
9. convert the final interleaved U/V page to little-endian float32.

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
topology and interpolation facts, tile matrix range, page size, lattice registration, and
direct-level policy. The service and verifier reject stale construction contracts.

Before atomic installation, the builder reproduces the runtime's finest-level bilinear sample
at every unique topology vertex and records per-time velocity error, angular error,
stationary-to-moving mismatches, moving-to-zero collapses, and maximum false-moving speed.
These are explicit QA facts, not a claim that z9 meets an unchosen physical error budget.

## Consequences

- The active builder no longer depends on Node, D3, C++, QuikGrid, GDAL, PROJ, packed PNGs,
  seed textures, or projection textures.
- One immutable topology and page stencil set is reused across all 27 time fields.
- Exact duplicate behavior is deterministic and auditable.
- Dynamic non-advectable support is encoded only as zero U/V and follows each time field.
- Direct per-level sampling removes recursive zero-value spreading and accumulated LoD error.
- The current Delaunay result remains an inferred fallback. It cannot prove riverbanks,
  holes, disconnected water bodies, nested-grid priority, or conservative polygon-cell
  remapping from XY alone.
- The recorded z9 station-reconstruction facts must guide a later resolution/storage decision;
  passing byte/hash verification alone is not numerical-accuracy approval.

Future topology types are additive descriptors such as authoritative indexed triangles,
rectilinear grids, nested grids, and polygon cells. Each must lower into the same reusable
page-stencil and RG32F writer contract without changing the normal runtime data plane.

## Reference

SciPy documents Delaunay simplices, omitted/coplanar inputs, `find_simplex()` outside value
`-1`, and the `transform` matrices used for barycentric coordinates:
<https://docs.scipy.org/doc/scipy/reference/generated/scipy.spatial.Delaunay.html>.
