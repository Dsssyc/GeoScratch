# ADR-092: Statistical-Ceiling Flow COG with Semantic Overviews

## Status

Accepted and implemented for the example-owned offline Flow Field resource tool. This
supersedes ADR-091's explicit matrix override, z12 artifact, and no-overview clauses. It does
not change the frozen `Flow Layer` example or the public Geo/Scratch packages, and it does
not approve the artifact for particle simulation.

## Date

2026-08-28

## Context

ADR-091 established a deterministic statistical source ceiling but retained a coarser matrix
override because its preflight treated two uncompressed raster copies as required disk space.
That produced a useful z12 construction prototype, but it mixed a resource limit with the
sampling decision. The accepted target is the same model used by Underwater Terrain: create
one COG whose full-resolution IFD reaches the source-supported ceiling, then carry reduced
resolution access inside that COG.

Ordinary image overviews are not correct for this vector product. Exact `(0, 0)` means
non-advectable and particles die immediately. A generic average can mix an invalid zero with
moving children and create a nonzero parent, while a generic nearest reducer can select one
side of a boundary. A two-band output also cannot preserve a separate validity state.

## Decision

The COG base grid is always the matrix returned by `StationSpacingResolution`. There is no
`matrix_override` Python parameter and no `--matrix` CLI option. Budgets may approve or reject
the selected construction, but never select another grid.

For the current source the unique base grid is WebMercatorQuad z15:

```text
effective station spacing  12.504520100907706 m
target pixel size           6.252260050453853 m or finer
z15 pixel size              4.777314267823516 m
base dimensions             70,400 x 77,056
base blocks                 82,775
base raw U/V bytes          43,397,939,200
```

### Representable base support

The triangle/stationary policy first produces interpolated float32 U/V and raw support. A
base sample is representable only when raw support is true and its rounded float32 U/V is not
both exact zero. A cross-block 3 by 3 all-true erosion is applied to that representable
support before the base value is stored. Invalid output is canonical positive `(0, 0)`.

### Recursive overview semantics

Each overview is generated from the immediately finer stored level. For parent `(r, c)`, the
four children are fixed in NW, NE, SW, SE order. The parent candidate is valid only when all
four child U/V values are finite and not both exact zero. Each component is calculated as:

```text
Float32(((Float64(NW) + Float64(NE)) +
         (Float64(SW) + Float64(SE))) * 0.25)
```

The cast occurs once. If the rounded mean is `(0, 0)`, cancellation is non-advectable and can
never be resurrected by a coarser level. A new cross-block 3 by 3 erosion is applied to the
parent candidates before storage. Raster exterior and a missing child at an odd terminal edge
are invalid. Every zero component is canonicalized to positive zero. NaN or infinity fails
construction.

The nominal factors are:

```text
2, 4, 8, 16, 32, 64, 128, 256, 512
```

The first eight levels retain exact power-of-two WebMercator pixel registration. The terminal
`138 x 151` COG overview shares the base extent, so GDAL reports an effective decimation of
510 rather than the nominal recursive factor 512. This terminal level satisfies the optimized
COG requirement that the smallest reduced-resolution subfile has one tile across or down. It
is a COG access level, not a new WebMercator tile-matrix identity.

### COG assembly and verification

Rasterio's `build_overviews()` accepts only predefined resamplers, so it is not used. The
builder writes the base and every semantic overview as temporary tiled Float32 GeoTIFFs,
declares them as explicit per-band VRT overviews, and calls the GDAL COG driver with
`OVERVIEWS=FORCE_USE_EXISTING`. rio-cogeo remains the strict structural validator; it does not
generate overview pixels.

The verifier opens each physical overview IFD explicitly. It checks exact count, dimensions,
derived transform, finite two-band Float32 structure, no nodata/mask/alpha, and pixel
SHA-256. Digest traversal is explicitly block-row-major from top-left to bottom-right; within
each logical 256 block it hashes all band-1 north-up row-major Float32-le bytes followed by
all band-2 bytes, with partial edge blocks truncated to their logical window. The manifest
binds this layout, the complete overview policy, and every level's support counts and digest
into construction identity.

### Work and staging budgets

Preflight bounds logical work rather than pretending it is simultaneous disk use:

```text
base blocks                  82,775
overview blocks              27,883
total blocks                 110,658
base raw bytes               43,397,939,200
overview raw bytes           14,465,925,704
total raw pyramid bytes      57,863,864,904
```

Temporary GeoTIFFs use DEFLATE-1; the final COG uses DEFLATE-9 with floating-point predictor
3. GDAL performs bounded multi-tile compression and decode with a 256 MiB cache. A separate
staging guard checks actual compressed bytes throughout construction, reserves 8 GiB free
space, and proves capacity for the intermediate pyramid plus final copy before CreateCopy.
Atomic installation occurs only after all IFD hashes validate.

## Verified Artifact

The t00 build completed locally in roughly 28 minutes and produced:

```text
schema version               2
package version              0.4.0
content version              flow-cog-00343edcd11320c9-t00-z15-v2
COG bytes                    1,584,930,583
COG SHA-256                  0013f530793c6d209df22a9c46346c52258c6ea13238f35e9b6db983cd3f7333
base pixel SHA-256           d90b570753bd709dc8c995146b62ec5ae3a17a32042a21fef16e134b6aa5603d
peak compressed staging      4,792,334,976 bytes
strict COG warnings/errors   0 / 0
```

The quality record remains `particleSimulation: not-approved` with reason
`inferred-topology-and-source-semantics-unapproved`. This reflects unapproved hydrodynamic
topology/unit/time semantics, not a missing raster level or failed COG build.

## Alternatives Rejected

- Keep z12 as the final base: rejected because operational budgets must not choose source
  resolution.
- Keep an explicit matrix override: rejected because it reintroduces two resolution
  authorities.
- GDAL average or nearest overview generation: rejected because neither preserves exact-zero
  non-advectable support.
- Direct Delaunay sampling at every COG level: rejected because those bytes would not be
  recursively reduced versions of the z15 base and support would not be nested.
- Persist a mask/support band: rejected because the approved runtime product is U/V-only.

## Consequences

- The COG now follows one resolution authority from station statistics through final bytes.
- Dynamic valid support remains encoded only by U/V; offline support booleans are temporary.
- Coarser support can shrink but cannot expand or resurrect a zero child.
- The final COG is suitable as the source for a later COG window/tile adapter, but no browser
  source or temporal stack is introduced by this decision.
- ADR-090's independent direct-level RG32F page product remains historical/current on its own
  contract; this recursive rule applies specifically to internal COG overviews.

## References

- OGC Cloud Optimized GeoTIFF 1.0 overview requirements:
  <https://docs.ogc.org/is/21-026/21-026.html#_requirement_reduced_resolution_subfiles_number>
- GDAL VRT explicit overviews:
  <https://gdal.org/en/stable/drivers/raster/vrt.html#vrtrasterband>
- GDAL COG `OVERVIEWS=FORCE_USE_EXISTING`:
  <https://gdal.org/en/stable/drivers/raster/cog.html#creation-options>
- GDAL GeoTIFF multi-threaded compression and decode:
  <https://gdal.org/en/stable/drivers/raster/gtiff.html>
- GDAL cache configuration:
  <https://gdal.org/en/stable/user/configoptions.html#performance-and-caching>
- Rasterio scoped GDAL environments:
  <https://rasterio.readthedocs.io/en/stable/api/rasterio.env.html>
- rio-cogeo validation API:
  <https://cogeotiff.github.io/rio-cogeo/API/>
