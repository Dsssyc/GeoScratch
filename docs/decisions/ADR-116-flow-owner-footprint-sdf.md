# ADR-116: Use One Owner-Footprint Boundary For Flow SDF Display

## Status

Accepted. Replaces B's center-marching geometry and subsequent stationary visibility
product from ADR-111/112/115. Keeps the temporal support-weight formula, A, particle
death/advection, raw/visible texture ownership, backend data and public Scratch/Geo
contracts unchanged. The implementation remains in the Flow Field example.

## Date

2026-09-08

## Evidence

With an isolated zero texel surrounded by supported texels, center marching makes
a dry diamond, whereas the original owning texel is a dry square. Near the square
corner, the former SDF already reaches full coverage while the owner still forces
zero. A fully resident GPU reproduction at feather .35 measured a jump from 0 to
1 across the corner and 0 to about .906 along the nearby side. Widening feather
cannot make these two different boundaries coincide.

## Decision

For each threshold of the existing temporal weights q, define the wet set as the
union of its original supported unit texel squares. A dry owner has coverage zero.
For a wet owner, compute distance to the complement by finding the nearest dry
square, then apply smoothstep(0, feather, distance). Integrate that binary coverage
over threshold in [0, q_owner]. Uniform support q retains coverage q.

Only a 3x3 square neighborhood is needed for feather <= .35: more distant squares
are at least one texel away. Geometry queries are limited to squares closer than
the actual feather width; irrelevant unqueried entries contribute no attenuation.
Bounds are checked before clamping loads. Relevant unknown neighbors cause the
existing A fallback, never a fabricated dry square.

The actual temporal sampler's readiness and common resolved level are checked
before interpreting even a known fine owner as dry. A positive metadata proof
uses its public four-corner resolution operations at the exact registered position,
plus both edge-transition weights where a coarser level exists. The pixel-center
contract forbids a NoData sentinel, so these exact metadata checks prove the normal
sampler would resolve at the requested level without fetching/interpolating U/V.
If the proof fails, the original A sampler remains the sole fallback authority.
This removes redundant velocity work without changing source/transition policy;
real two-level tests compare the proof with the full sampler, including coarse
neighbors outside the four-corner footprint. B uses this square-union
coverage as its sole known-resident display support. Do not multiply by A's
stationary coverage or reapply a current-speed veto afterward: those would restore
a second, inconsistent clipping boundary. Current velocity still exclusively
governs particle motion and death. For common supported interiors, existing finite
ink remains visible through reversal; zero-support owners remain empty.

This intentionally changes partial stationary B presentation from the previous
center-SDF-times-A product to square-union coverage. It does not redefine A or the
temporal support weights. No new texture, uniform, compute pass, cache record or
backend channel is required. Old center-marching helpers are removed, not retained
as an alternate production path.

## Continuity And Limits

At a shared edge between owner weights qA and qB, threshold levels above min(qA,qB)
have a dry neighbor touching the boundary, so their inward coverage tends to zero.
Below that value both sides use the same wet union. Thus known coverage agrees at
owner edges and corners; q's explicit time endpoints also preserve pair joins.

One-texel wet strips retain a .30-texel fully opaque core even at maximum feather.
Diagonal texels touching at only one point remain visually disconnected there.
Euclidean distance rounds the wet-side coverage contours around convex dry
corners, but the zero contour is still raster geometry. This does not recover
sub-z10 shorelines or guarantee every contour looks curved. Inward feather can
make a dry hole appear visually larger without painting into it. Missing ink,
source-extent clipping and unknown/fallback transitions remain separate limits.
Encoded U/V support is not a physical wet/dry truth.

## Verification And Rollback

Exhaust all 512 binary neighborhoods and test their rotation/reflection, shared
edges/corners, narrow strips, isolated texels and diagonal contact. Verify the
continuous threshold integral against an independent oracle, including time joins
and real source values. Full VT probes must retain source-zero owners and show
near-zero wet-side coverage at the former 0-to-1 corner jump. Keep A, reversal,
retained-image lifecycle, particle death and camera/time/cleanup proofs passing.

Baseline 51a023f is retained by local branch
`socu/flow-before-owner-sdf-51a023f`. Land this as one separate commit and use
`git revert` on that commit to undo only this slice.
