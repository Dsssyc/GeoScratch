# ADR-121: Reuse Loaded Flow Footprints For Readiness And Interpolation

## Status

Accepted. Example-local optimization of the pixel-center registration adapter.
No public Geo API, atlas ABI, source format, or frozen Flow Layer change.

## Date

2026-09-08

## Context

After ADR-120 removed unchanged spatial builds, particle simulation still measured
approximately 6.52 ms at the resident zoom-9 benchmark. A normal endpoint sample
performed four registration-layer resolution queries, another four inside the
general sampler, and four actual texel loads which resolved the same pages again.
The temporary no-preflight experiment showed a cost but did not prove correctness
at missing data, transitions or common-level fallback.

## Decision

Each registered endpoint sampler loads its four logical texels through Geo's
existing `_load_global()` helper exactly once and retains the resulting Samples
in invocation-local values. Their status and resolved-level facts decide whether
the footprint can be used. If accepted, their values feed the original nested
bilinear `mix` operations in the original order. The wrapper no longer re-enters
`_sample_level()` or emits a duplicate resolution-only helper.

The factory still rejects a payload `noData` sentinel. Under this existing
contract a status 3 from a loaded sample has the same metadata meaning as the old
preflight. Keep the original per-endpoint precedence: failed, missing, metadata
no-data, invalid resolved level, coarser-level signal, edge-transition signal,
then interpolation. Do not extend this argument to a generic payload-NoData
sampler without a separate design.

The outer temporal sampler is unchanged. It re-registers the original canonical
position at each new common level, arbitrates both endpoints, and preserves
source containment, zero-speed death, A/B nearest-owner zero gating and C/D center
interpolation. Even a zero-weight corner and a time endpoint at alpha 0 or 1 still
participate in the original readiness decision. No new nearest-neighbor mode,
physical page clamp, CPU padding or persistent per-particle address is introduced.

All physical atlas lookup, clamping, decode and cross-page access stay inside Geo.
For a normal fine sample, logical page resolutions drop from twelve to four per
endpoint while the four U/V loads remain. Error/fallback paths can load values
that are subsequently discarded; their benchmark is a separate acceptance gate,
not a presumed improvement.

## Verification And Rollback

Compare the actual generated Geo sampler with the preceding registration adapter
on resident interiors, page seams, source clamps, fine/coarse transitions,
multi-level common fallback, status precedence and zero-owner/time cancellation.
Timing tests must not include sample-count atomics in the hot kernel. Real-page
particle, history, boundary, time and camera tests remain separate from numerical
sampler parity. Record fresh measurements in the
[per-phase benchmark record](../review/flow-pipeline-optimization-benchmarks.md).

This change follows spatial-reuse commit `8e38f5f` and is committed separately.
Reverting only this phase restores the preceding sampler without undoing spatial
reuse or requiring backend regeneration.
