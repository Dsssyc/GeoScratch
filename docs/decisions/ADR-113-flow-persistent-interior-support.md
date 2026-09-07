# ADR-113: Preserve Valid Interior Flow In B Presentation

## Status

Accepted. Corrects ADR-112's global opacity policy. A, particle motion/death, raw
history, source data, sampling intent, runtime budgets and the Feather control are
unchanged. This remains example-owned presentation, not a new Scratch/Geo API.

## Date

2026-09-07

## Evidence

At t23/t24 alpha 0.54772, actual z10 data at tile 10/416/856, texel (103,167), has
endpoint vectors (0.7833013,-0.3385036) and (-0.6200280,0.2681697). Current speed is
approximately 0.0159326, over 8.8 times the 0.0018093 kill threshold, but ADR-112's
relative-cancellation coefficient is approximately 0.04287. The display policy
therefore suppresses valid interior motion even though no tile is missing.

An isolated full-page A/B/A reproduction at that model time confirmed z10 demand,
resident/nonzero inspector status and zero pending Worker tasks. B removed most
stable interior ink; A immediately restored it without a particle reset. A second
actual source point showed stronger suppression. A background-subtracted regression
fails on the prior implementation, rather than merely checking nonempty output.

## Decision

For each known endpoint center, support is exactly `speed > 0 && speed >= kill`.
There is no speed-to-opacity ramp for weak but valid motion. The temporal support
weight is:

- 1 when both endpoints support that center, independent of their relative speeds
  or directions;
- 0 when neither endpoint supports it;
- the previous endpoint interpolation and current-velocity cancellation fade only
  when one endpoint is supported and the other is not.

Exact alpha endpoints return the corresponding support bit. The supported footprint
shared by both times is thus protected before the existing continuous SDF-coverage
integral. This is equivalent to replacing q by max(q, intersectionSupport) in the
continuous extension, not a second texture or an additional reconstruction pass.

The binary spatial coverage is monotone in the active center set: its reconstructed
active regions are nested as bits are added, including the disconnected-diagonal
cases. The extension therefore retains at least the common endpoint footprint's
coverage. If endpoint support masks are identical and the current point remains
advectable, B reduces to the existing spatial SDF presentation regardless of velocity
variation. A shared time sample has the same
support bits in either adjacent time pair, including valid low-speed samples.

Remove the global point-speed opacity cap. The actual temporal sampler remains the
authority for the current point: reliable non-advectable or exact-zero results still
return zero. Unknown, fallback and legacy paths retain the existing A behavior.
The opaque shortcut still checks the already loaded bilinear vector with the exact
integer-derived nearest-zero owner; risky points use the full sampler before any
opaque result. No inferred boundary may override a real current zero.
Zero-k frames always use the full sampler because the opaque shortcut then has no
positive numerical margin against fractional-coordinate rounding differences.

## Consequences And Limits

Stable interior flow no longer fades because its interpolated vector is much smaller
than its endpoint vectors. Genuine support appearance/disappearance still receives
temporal fading. A changing-support patch may be geographically inside a river; this
policy distinguishes represented endpoint support, not an unavailable physical bank.

Protecting valid interior motion means a true current zero can still stop/clear it
according to the original A rules. It is not possible to simultaneously promise full
opacity until that instant and a pre-zero fade in the same region. No hidden residual
ink or relaxed death threshold is introduced. Requested LoD/residency changes can
still affect presentation; this correction is not a new loading policy.

## Verification

Retain spatial-continuity and mathematical coverage tests. Update the support-weight
oracle to distinguish support coverage from the final current-motion veto. Verify
weak/equal-threshold common support, opposing endpoint vectors with legal current
speed, exact temporal/spatial cancellation, source-support-changing fringes, pair
joins, unknown halos and wide-fixed texel ownership. The actual t23/t24 interior
regression must retain A's stable ink in B, with no reset, while final zero still
clears. Run the complete example's camera/time/cleanup and DPR2 performance gates.
