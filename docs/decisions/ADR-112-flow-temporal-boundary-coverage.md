# ADR-112: Continuous Current-Time SDF Coverage

## Status

Accepted for the example-local B presentation. Extends ADR-111's spatially continuous
binary SDF basis with continuous activity weights. A, particle motion/death, hard
history cleanup, source bytes and temporal runtime budgets are unchanged.

## Date

2026-09-07

## Context

Interpolating U/V before thresholding them into binary corners does not interpolate
the displayed boundary: its discrete mask changes in one step. The previous proofs
covered spatial continuity, not that temporal quantization. In a bounded read-only
sample of z10 pages (416,856) and (416,857), t00–t04, interior cancellation between
active endpoint vectors contributed about two thirds of threshold crossings. Some
inactive intervals last only a few tens of milliseconds at default playback speed.
Smoothing only temporal pair handoffs would miss those events.

Moving scalar contour crossings alone is insufficient: a zero set can appear or
disappear, causing its nearest distance to jump even for continuous scalar inputs.
Mixing two endpoint SDFs also misses interior vector cancellation. A time-history mask
would add storage, reprojection and invalidation state. We instead extend the existing
binary coverage continuously using only the currently captured field values.

## Decision

Each resident source center derives display activity q in [0,1]. Let k be the unchanged
particle kill speed, si the endpoint speeds and s the speed of the interpolated vector:

- ai = smoothstep(k, 4k, si), with explicit zero-k handling;
- E = mix(max(s0-k,0), max(s1-k,0), alpha);
- cancellation = smoothstep(0, 0.15, clamp(max(s-k,0)/E, 0, 1)), or zero when E is zero;
- q = mix(a0, a1, alpha) * cancellation.

Exact time endpoints return the corresponding ai directly. The shared sample therefore
has identical activity across a pair handoff, independent of the other endpoint's
magnitude. Activation/extinction and interior cancellation are separate terms; no
particle threshold or source-unit interpretation changes. The low-speed band dims
weak but still valid B ink instead of pretending those pixels are physically dry.

For a canonical position p, F(S) is the existing ADR-111 inward SDF coverage when S is
the set of active source centers. B reconstructs:

`coverage(p,q) = integral from 0 to 1 of F({i | qi >= threshold}) dthreshold`.

The integral is evaluated exactly over sorted distinct q values, not by random or
fixed temporal samples. Use each interval's upper threshold with >= membership to
avoid midpoint rounding. At binary q the integral reproduces the original basis.
Uniform central q returns q, including whole-region birth/extinction. Sorting-order
changes cannot cause a finite jump: coverage differences are bounded by the sum of
the componentwise q differences. This is a continuous coverage extension, not a claim
that the blended result is one exact signed-distance field. The general level-set
extension construction is described in [Bach's Lovász-extension discussion](https://www.di.ens.fr/~fbach/2200000039-Bach-Vol6-MAL-039.pdf).

Only thresholds between the minimum and maximum central q require evaluation. Below
that minimum F=1; above the maximum F=0. The existing 0.35-source-texel band and logical
halo rules remain sufficient. Up to nine relevant centers are cached in a fixed
16-entry shader-local array. Successive threshold selection needs no second array;
at most sixteen bounded iterations are admitted. Unrelated far values cannot affect
the band. The uniform-central fast path needs no halo. Shader-local storage is not
a guarantee that every compiler keeps all intermediates in physical registers.

The final result is capped by the actual current sampler's low-speed display gain,
using min rather than multiplication to avoid double attenuation of uniform slow flow.
This handles cancellation within a bilinear footprint and fades ink before reliable
zero clears raw history. A saturated central field uses its already loaded vectors
and the integer-address-derived nearest-zero gate to reject cancellation risk cheaply;
risky or fractional cases consult the original
temporal sampler for common-level/status and velocity. Unknown, failed, fallback,
legacy and unavailable temporal-capture paths retain their prior unmodified-A policy.

For the common co-directed case, endpoint squared speeds >=16k² and a nonnegative
dot product prove full gain and cancellation ratio >=0.609, above the fixed 0.15
fade band. This avoids three square roots without changing q. A broader RMS-based
shortcut was mathematically valid but slower in a fixed-camera browser comparison,
and is not retained. Exact-zero and zero-k cases remain
explicit. Threshold classification uses half-planes for its local sign,
not unnecessary distance square roots; numerical tests compare these fast paths with
independent unoptimized formulas.

## Ownership And Limits

No texture, network channel, frame history, cache, readback or runtime is added.
The same native submission holds the borrowed temporal binding through completion.
Only B's final alpha changes; confidence never feeds back into raw trails or particle
state. Feather still controls spatial width, not model time or particle speed.

The guarantee concerns a coherent known field at fixed sampling semantics. Residency,
LoD, requested-time discontinuities, Float32 precision and hard support changes may
still affect presentation. It does not promise smooth transitions while switching
between unknown-A and known-B, or invent post-death ink after hard cleanup. Finite
frame rates can still skip a very fast continuous transition. At k=0 the absolute
point-speed ramp collapses to exact-zero handling; it is not a finite pre-death band.
Additional arithmetic
is bounded but must be measured in the real DPR2 example, not called cost-free.

## Verification

Retain the binary spatial oracle. Add native current-activity/coverage comparisons
against an independent CPU level-set integral, with dense alpha sweeps, sorting ties,
whole-region changes, saddle patterns, shared edges, weak flow and reversal. Exercise
actual COG-derived windows as well as synthetic pairs and three-sample joins. Full
shader tests retain fixed-ink A/B/A, unknown halos and zero-speed correctness. Live
browser tests measure playing throughput, camera/time continuity, controls and cleanup.
