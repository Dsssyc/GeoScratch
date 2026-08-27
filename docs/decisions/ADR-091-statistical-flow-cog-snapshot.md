# ADR-091: Statistical Resolution for a Flow COG Snapshot

## Status

Accepted for the example-owned reconstruction prototype. This extends ADR-090 without
approving the generated raster for particle simulation and without changing the frozen
`Flow Layer` example or the public Geo/Scratch packages.

## Date

2026-08-27

## Context

A Flow Field source time contains station longitude/latitude pairs and one U/V pair per
station. It has no authoritative raster resolution. The absolute minimum station distance
is not a safe resolution authority: the current source contains an approximately `0.8493 m`
nearest pair caused by the precision of its float32 longitude coordinates, while its real
station layout contains several much more strongly supported spacing bands.

A Cloud Optimized GeoTIFF supplies an internally tiled, range-readable container, but the
container does not decide the physical sampling resolution. Choosing a very fine raster can
make construction and storage infeasible; silently selecting a coarser grid from a resource
budget would instead hide a numerical decision inside an operational limit.

## Decision

The first single-snapshot COG path uses a deterministic
`StationSpacingResolution` strategy:

1. convert station coordinates to float64 and remove exact coordinate duplicates;
2. project the unique coordinates to EPSG:3857;
3. compute every station's nearest non-self distance;
4. histogram `log2(distance / 1 m)` in fixed `1/16`-octave bins anchored at one metre;
5. smooth counts with the fixed `[1, 4, 6, 4, 1] / 16` kernel;
6. accept a peak only when its `+/-0.25`-octave window contains at least
   `max(1024, ceil(1% * uniqueStationCount))` stations and its prominence divided by peak
   height is at least `0.25`;
7. select the leftmost accepted peak and use the median original nearest distance inside its
   support window as the effective spacing;
8. target two raster samples per effective spacing; and
9. choose the first WebMercatorQuad matrix whose projected pixel size is not coarser than
   that target.

If no peak satisfies the complete support and prominence contract, selection fails. It does
not manufacture a fallback confidence value. Input order and exact duplicates do not change
the result.

Budgets do not participate in resolution selection. A read-only `CogBuildPlan` records both
the statistically selected grid and the actual output grid, plus independent block, raw-byte,
staging-space, and free-space assessments. With no override, the output grid is the selected
grid. An explicit `matrix_override` may request a coarser or finer prototype; its relation to
the selected matrix remains visible in the plan and manifest. Construction refuses a plan
whose output assessment is not approved.

The COG product is one immutable model-time snapshot with this encoding:

- one tile-aligned EPSG:3857 GeoTIFF;
- band 1 U and band 2 V, both float32;
- 256 by 256 pixel-interleaved internal blocks;
- standard pixel-center registration;
- DEFLATE compression with floating-point predictor 3;
- no nodata value, alpha band, mask band, boundary plane, or overview levels; and
- exact `(0, 0)` wherever triangle support is non-advectable after the existing one-pixel
  bilinear-safe erosion.

The writer streams one block at a time into a temporary tiled GeoTIFF, translates it with
rio-cogeo, validates the resulting COG structure, and proves that translation preserved every
float32 pixel. The manifest content identity binds the selected source snapshot, topology,
interpolation, resolution algorithm facts, selected and output grids, encoding, support
statistics, COG bytes, and pixel digest. Atomic replacement is limited to a marker-owned
`cog-cache` containing exactly one manifest and one declared COG.

For the current source, the selected mode is:

| Fact | Value |
| --- | ---: |
| Source / unique stations | `117,148 / 117,137` |
| Effective spacing | `12.504520 m` |
| Mode support | `5,766` stations (`4.922%`) |
| Target pixel size | `6.252260 m` or finer |
| Selected matrix / pixel size | `z15 / 4.777314 m` |
| Selected grid | `275 x 301` blocks (`70,400 x 77,056` pixels) |
| Selected raw U/V bytes | `43,397,939,200` (`40.4175 GiB`) |

The default two-GiB raw-byte and 4,096-block limits therefore reject z15. The verified local
prototype uses an explicit z12 override: `36 x 39` blocks, `9,216 x 9,984` pixels, and
`736,100,352` raw bytes. The manifest retains both the rejected z15 facts and the approved z12
output facts.

## Consequences

- “Highest resolution” now means the finest statistically supported station-spacing mode,
  not the smallest observed pair and not the finest grid that happens to fit a budget.
- A COG can hold the full selected extent as one logical raster while clients range-read its
  internal blocks. It does not make z15 construction free; all selected pixels still have to
  be interpolated and written.
- No overview is generated in this prototype. Zoomed-out access therefore has no reduced
  representation. Any future overview policy must preserve zero-as-non-advectable support and
  cannot use an unchecked average that turns invalid support into motion.
- One COG represents one U/V snapshot. A temporal product can later reference multiple
  snapshot COG identities or introduce another container contract without changing the
  resolution selector.
- The z12 artifact remains a reconstruction and resource-tool proof. Its quality record is
  explicitly `particleSimulation: not-approved`; visual integration must not treat successful
  COG validation as hydrodynamic accuracy approval.

## References

- OGC Cloud Optimized GeoTIFF 1.0: <https://docs.ogc.org/is/21-026/21-026.html>
- Rasterio dataset writing: <https://rasterio.readthedocs.io/en/stable/topics/writing.html>
- rio-cogeo Python API: <https://cogeotiff.github.io/rio-cogeo/API/>
- rio-cogeo creation profiles: <https://cogeotiff.github.io/rio-cogeo/profile/>
