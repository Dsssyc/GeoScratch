# ADR-114: Separate Flow Trail Retention From Current Visibility

## Status

Accepted. Supersedes destructive current-velocity cleanup of raw history in the
Flow Field example. Particle death, temporal sampling, backend data, activity
thresholds and ADR-113's support weights are unchanged. No public Scratch/Geo API
or frozen Flow Layer source changes.

## Date

2026-09-07

## Evidence

Playing t14/t15 near alpha 0.93 at the fixed zoom-12 camera reproduces the reported
comb-shaped interior holes in both A and B with all requested z10 pages ready and
zero pending Worker tasks. Warming at the final model time alone does not reproduce
them. The current zero/low-speed locus moves during interpolation; clearing the
raw history at each position leaves a swept scar after flow becomes valid again.

An isolated browser counterfactual disabled only destructive history support
cleanup. The comb-shaped scars disappeared while B's final current-velocity veto
remained active. This separates the defect from missing tiles, coarse fallback,
SDF feather width and remaining one-endpoint support fading. The latter is a
separate presentation limitation, not modified by this decision.

## Decision

Raw trail accumulation owns reprojection, quantized finite decay and cutoff only.
It does not sample current U/V or destroy ink because a point temporarily becomes
non-advectable. Particle simulation retains its immediate zero/threshold death.

Both current presentations clip after drawing fresh segments as well as old ink.
A applies the existing hard support condition. B keeps its SDF coverage and actual
current-sample veto; reconstruction fallbacks now use the hard condition, never
unfiltered raw ink. Unknown/fallback is not dry. Reliable failed/outside/zero data
does not become visible merely because an SDF halo is unavailable. Inspector views
and contour remain unfiltered diagnostics, including zero and failure colors.

The two existing rgba8unorm textures have explicit alternating roles. For one
direction, compose raw B into A, then clip raw A into B after the old B source is
consumed. Copy visible B to the Surface. The next ready frame reads raw A, writes
raw B, then visible A. Clipping into rgba8unorm does not blend; Surface presentation
applies the normal blend exactly once. Visible output never feeds raw accumulation.
This adds a simple full-screen display copy, not another texture or data channel.

Unavailable frames read only the saved visible texture and reproject it directly
to the Surface. They do not mutate either texture, advance the direction, change
the last-ready camera provenance, or retain a temporal lease. Resume reprojects
raw ink from that same last-ready view. Boundary/feather facts describe the saved
visible result; pending choices wait for a ready frame. Reset/resize invalidate
the saved image. Owned temporal presentation commands retire before suspension.

## Limits

A real zero is still hidden immediately. This does not fill genuinely unsupported
pixels or extrapolate flow. Previously drawn ink may be revealed when flow recovers,
but only before ordinary finite decay/cutoff expires; it is not a live stationary
particle. Unavailable-frame display is the existing frozen-time policy and does
not advance trail age. No source support, SDF weight or particle threshold is
relaxed to disguise the remaining one-endpoint fading issue.

## Verification

Native tests separate raw retention and hard visibility, including zero-hidden
recovery, destructive-cleanup counterfactual, finite expiry, fresh-segment clipping,
empty-ink sampling avoidance, unknown, outside, failed and camera projection.
Exercise the actual two-texture graph through both directions, retained loading,
camera A-B-A and reset/resize. The full-page regression must play through the
cancellation interval, not merely seek and warm at its final time. Also run B's
native sampler, A/B control/time/camera proof, particle lifecycle, typecheck, full
tests and build. Performance measurements run alone at fixed DPR and camera.
