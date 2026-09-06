# ADR-107: Flow COG Support Without Repeated Erosion

## Status

Accepted for Flow Field. Supersedes ADR-090/092's default all-moving triangle and
3x3 erosion rules for new COG products. Existing v2 products retain their immutable
interpretation. No Scratch/Geo public API, extra raster channel or boundary feature.

## Date

2026-09-06

## Evidence

The highest-resolution z10 product already contained broken narrow channels. In
the approximate north-branch diagnostic window [121, 121.65] x [31.65, 31.95],
t10 ordinary triangle interpolation covers 23,348 pixel centers. The all-moving
vertex rule reduces that to 19,199; neighborhood erosion reduces it to 16,067 and
splits its dominant connected region. This is a bounded source-data comparison,
not a reconstruction of the user's exact camera or authoritative shoreline truth.

## Decision

New base pixels store ordinary component-wise triangle-linear velocity at pixel
centers over the same accepted inferred topology. A zero vertex participates in
interpolation rather than deleting the entire triangle. A zero resulting vector
remains non-advectable. Explicit `require-all-moving` remains a supported input
policy, not the default. Base storage adds no neighborhood erosion.

Overviews retain the zero-absorbing 2x2 rule: all four children must be finite and
nonzero before their Float64 component mean is cast once to Float32. A zero child
or a mean that becomes zero makes the parent zero. No additional 3x3 operation is
performed. Thus a stored parent cannot resurrect any represented zero descendant;
odd exterior children remain zero. There is no unconditional any-child averaging.

The frontend constrains activity separately from interpolation magnitude. At each
resolved common temporal level, a nearest stored texel with exact zero suppresses
its endpoint velocity over that texel's whole footprint. Otherwise the original
bilinear velocity is retained, without weight normalization. The two gated endpoint
velocities are then interpolated in model time. This removes the need to erode
source pixels to stop bilinear activation of an already represented zero cell.
Missing/fallback and valid zero retain their different lifecycle semantics.

## Version And Ownership

New COG snapshots/collections use schema 3 and `-v3` content identities. The bounded
runtime manifest remains schema 2, with the mutually validated combination:

- adapter/algorithm `flow-cog-wmq-rg32f-v3`;
- support filter `recursive-zero-preserving-vector-box-v2`;
- representation `activitySupport: nearest-texel-zero`.

The reader accepts old adapter v2 only with its original support filter and no new
activity field. Mixed reader versions and mismatched policies fail closed. Source,
construction, physical overview tags, content hashes, derived pages and runtime
metadata all participate in the version boundary. Old data is not reinterpreted
or reused under new hashes. Replacement data must be verified before service switch,
and the old bounded collection remains recoverable.

New support counts say what was stored: `candidatePixelCount`,
`storedNonzeroPixelCount`, and `zeroStoredCandidatePixelCount`; zero may result from
cancellation or Float32 rounding. Historical v2 counters retain their old meaning.

## Limits And Verification

This preserves the raster's represented activity, not an unavailable physical wet/dry
boundary. Unsampled subpixel dry barriers and channels cannot be reconstructed from
two center values; z10 still has approximately 130-metre ground texels here. At coarse
levels the all-four rule can remove sub-resolution channels. The source ceiling and
explicit matrix choice remain unchanged, and quality remains unapproved for physical
simulation use. Basemap shoreline is not a replacement for model topology.

The local proof checks original source hashes and reconstructs every old z10-z6
support level exactly before comparing the new policy. Synthetic tests cover narrow
channels, represented dry strips, odd boundaries, cancellation and rounding. Native
GPU proof uses real RG32F atlases, reversed page slots and cross-page samples to
check whole zero footprints, unchanged bilinear amplitudes and temporal activation.
