# ADR-111: Continuous Narrow-Band Flow Boundary Distance

## Status

Accepted. Replaces ADR-110's cell-local distance rule, not its reconstructed contour,
raw history, particle lifecycle, A/B default, or source-precision restrictions.

## Date

2026-09-06

## Evidence

The original shader found the nearest segment only in the current marching-squares
cell. Neighboring cells with masks 3 and 1 agree on their shared vertices and contour,
but at shared-edge y=0.25 their local distances are 0.25 and 0.1767767. At the default
0.25 feather, coverage jumps from 1 to 0.792893. Original single-cell tests did not
cover this adjacency invariant. Increasing feather width does not fix that defect.

## Decision

Keep current-cell topology for the inside/outside sign. Find the unsigned distance
to finite contour segments in the surrounding 3x3 cells, using the same global
source-center values. Homogeneous cells contribute no contour. Do not take the
absolute value of the old local helper outside its cell: straight cases describe
infinite lines and sign-zero extensions can incorrectly report zero distance.

The signed distance is clamped to a 0.35-source-texel narrow band. Outside the 3x3
neighborhood, a segment is at least one source texel away and cannot affect that
band. Query only cells whose bounding box lies within the band, caching up to nine
needed center values in a fixed 16-entry shader-register array. This also gives
either side of a shared edge the same geometric query footprint; a farther missing
halo is irrelevant. A relevant missing/fallback center still returns unmodified A
ink rather than inventing a dry boundary or a partially known distance.

Retain the all-active-current-cell fast path. The closest possible external contour
is the cut across a diagonally adjacent cell, at distance sqrt(1/8), approximately
0.353553. Therefore the entire supported band is opaque inside that current cell.
Any future width increase beyond 0.35 must revisit both this proof and the truncated
distance contract. Feather widths must remain strictly positive.

No distance texture, compute pass, CPU raster, cache, network channel or runtime is
added. The existing temporal sampler and canonical addressing remain the only field
and projection authorities. B performs additional bounded fragment work near mixed
cells. A retains its original draw. This fixes distance continuity for a coherent
known field; it does not restore unsampled banks, extend hard-empty color, or promise
stable SDF coverage across changing residency/LoD/time support.

## Verification

The native distance proof retains all 16 single-cell cases and adds all 65,536
binary 4x4 vertex patterns, random positions, shared-edge pairs, finite-segment
extension counterexamples and an independent segment oracle. Its legacy baseline
must reproduce the old coverage jump; the new path must remove it. Actual temporal
atlas tests cover global page identity, near/far missing halos, fixed-ink A/B/A,
current-alpha cancellation and activation. Live browser gates retain camera/time
continuity, cleanup and playing-only DPR2 throughput measurements.
