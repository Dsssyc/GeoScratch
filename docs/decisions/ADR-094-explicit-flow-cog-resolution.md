# ADR-094: Explicit Flow COG Base Resolution

## Status

Accepted and implemented for the example-owned `Flow Field` resource tool. This partially
supersedes ADR-092's single statistical-resolution-authority clause and extends ADR-093's
snapshot and temporal collection entrypoints. It does not change semantic overview pixels,
the frozen `Flow Layer` example, or the public Geo/Scratch packages.

## Date

2026-09-01

## Context

The station-spacing strategy correctly estimates the finest statistically supported sampling
ceiling. For the current source it selects WebMercatorQuad z15, whose complete U/V pyramid has
about 57.9 GB of logical raw work. That result answers a data-analysis question; it does not
mean every operational product must be built at z15.

Users also need to make an explicit product-resolution choice such as z10. Treating that choice
as a budget fallback would be ambiguous: a later machine with a different disk budget could
silently produce different pixels. Faking station-spacing evidence for an explicit choice would
be equally misleading.

## Decision

`ResolutionSpec` supports two discriminated strategies:

- `StationSpacingResolution` remains the default when the caller supplies no resolution. It
  performs the complete nearest-neighbour mode analysis defined by ADR-092.
- `FixedWebMercatorResolution(matrix_id=N)` selects exactly one OGC WebMercatorQuad matrix in
  the inclusive range z0 through z24. The CLI spelling is `--matrix N`.

The fixed strategy validates finite station coordinates and requires at least three unique
stations, but it does not construct a KD-tree or calculate spacing modes. Its manifest records
`fixed-web-mercator-matrix`, the requested matrix, its exact projected pixel size, and station
counts. It does not contain fabricated spacing, peak, support, or samples-per-spacing fields.

The snapshot plan records the selected and output matrix plus one of two relations:

```text
statistically-selected
explicitly-requested
```

The output grid must equal the selected matrix. Snapshot and collection verifiers derive the
relation from the discriminated resolution manifest, validate the complete selection contract,
and cross-check the grid and matrix decision. The resolution choice is part of construction and
request identity, so an explicit z10 product remains distinct from a statistical strategy that
happens to resolve to z10.

Budgets approve or reject the already selected matrix. They never convert a rejected z15 plan
to z10, choose a matrix from available disk, or remove model times. Selecting z10 is an explicit
caller decision and carries no claim that z10 is the statistically supported ceiling.

A single-snapshot COG accepts every matrix supported by the resolution type. The current
temporal COG adapter advertises runtime pages through z9 and therefore requires a base matrix
of at least z9. Explicit z10 is valid for the collection; explicit z8 is rejected during
planning. The same resolution strategy applies to every snapshot in one collection.

Semantic overview reduction, exact-zero non-advectable support, Delaunay topology, triangle
linear interpolation, pixel-centre registration, two-band Float32 encoding, and the absence of
boundary, mask, depth, SDF, wet/dry, or activity planes are unchanged.

## Verified z10 Proof

The current source t00 was built in an isolated temporary directory at explicit z10. The
result used a `2,560 x 2,816` base, four semantic overviews, 154 total blocks, and
`76,820,480` logical raw pyramid bytes. Construction completed in 4.94 seconds with
`25,139,486` peak staged bytes. The final COG is `11,953,369` bytes, has SHA-256
`4458198552459df68709409dbcd0aa03b9bd174565e6fe8c19ad8b455a08e71f`, and passed the deep
snapshot verifier with no COG warnings. Its content version is
`flow-cog-0ce0c5c0597eeae4-t00-z10-v2`.

The same snapshot was published through the temporal collection path. Its 59 advertised
z4-z9 RG32F pages passed deep verification with page-set SHA-256
`7ab9c53e4321cc12b9bd2046f363c625a540cc5636cf7ce869121faa844a822e`; the one-time collection
occupies `12,012,275` bytes and has content version
`flow-cog-collection-a4a4d1fa7b51a374-t1-z10-v1`.

Using that measured compressed size, the 27-time plan projects `322,740,963` final COG bytes.
The conservative default staging caps and reserve raise required available space to
`43,272,413,923` bytes; this is transient headroom, not projected final storage. The measured
plan was approved with `50,831,773,696` available bytes.

## Consequences

- Omitting `resolution` or `--matrix` preserves the existing statistical behavior and z15
  result for the current source.
- Callers can deliberately trade spatial detail, build time, and storage without encoding that
  choice as a resource-budget side effect.
- Fixed and statistical products remain auditable and cannot be confused by matching matrix
  numbers alone.
- A measured compressed snapshot size is still required before planning a multi-time
  collection; a z15 measurement must not be reused as if it were a z10 measurement.
- Package `0.6.0` adds this API and CLI surface. Because collection request identity includes
  the tool version, continuing an older collection request can require an explicit new build
  and replacement even when unchanged snapshot COG bytes would otherwise compare equal.

## Alternatives Rejected

- Automatically lower resolution after a budget rejection: rejected because operational state
  would become a hidden sampling authority.
- Reuse `StationSpacingResolution(minimum_matrix=N, maximum_matrix=N)` as the user entrypoint:
  rejected because it still performs statistics and falsely presents the result as a supported
  spacing decision.
- Add a generic numeric pixel-size parameter: rejected for now because snapping and CRS would
  need a second contract; the existing runtime and COG grid are WebMercatorQuad-native.
- Encode resolution in a new raster band: rejected because it is immutable artifact metadata,
  not a per-pixel field.

## References

- [ADR-092: Statistical-Ceiling Flow COG with Semantic Overviews](./ADR-092-statistical-ceiling-flow-cog-overviews.md)
- [ADR-093: Temporal Flow COG Collection and Window Adapter](./ADR-093-temporal-flow-cog-collection.md)
