# ADR-102: Validate Flow Support Only For Visible History

## Status

Accepted. Example-local execution-order optimization; no change to velocity units,
particle integration, frame admission, raster demand, or the frozen Flow Layer.

## Date

2026-09-05

## Evidence

Both examples advance particles by `U/V * 50` per admitted visual tick. Flow Field
does not divide displacement by its color-scale maximum. Native particle readback
also found comparable sampled velocity magnitudes and per-step distances.

At a fixed z9 camera, a 1512 by 861 logical viewport and DPR 2, headless native
Chrome measured approximately 60 visual steps/s in Flow Layer but 30 in Flow Field.
At DPR 1 both were near 60. The frame-dependent reference integration made the
half-rate execution visible as slower motion and longer wall-clock trail retention.

The history fragment checked current temporal-raster support before reading history.
It performed expensive screen-to-ground conversion and two-endpoint Virtual Raster
sampling even for the empty majority of the 3024 by 1722 physical pixels. A browser
ablation changing only this order improved the same Flow Field case from 29.91 to
57.90 steps/s. A subsequent default-rate run measured 58.60 steps/s.

These are local workload measurements, not a universal frame-rate guarantee. The
model clock still selects time independently; this repair does not implement a
wall-clock particle integrator or raise the single-frame admission bound.

## Decision

Read or reproject history first, then apply the existing UNORM fade and cutoff.
Return transparent immediately when no visible history remains. Only surviving
history pixels call `FlowHistory_supported` before returning their color.

The support check must still use the **current** screen coordinate, not the sampled
previous-history coordinate. Empty-pixel rejection must occur **after** reprojection:
a camera move can bring visible old history into a previously empty destination.
Moving, zero, unavailable, and invalid flow retain their original cleanup semantics.
The independent retained inspector path is unchanged.

No additional texture, CPU mirror, approximate boundary, or persistent cache is
introduced. Increasing the displacement multiplier would hide the scheduling cost
and exaggerate motion when the workload returns to full rate, so it is not used.

## Verification

`tests/browser/flow-field-history.mjs` checks native pixels and instruments its
fixture sampler to count support evaluations, including empty and reprojected
history. The shipped sampler is also compiled as a real pipeline.

`tests/browser/flow-field-motion-performance.mjs` is a separate high-DPR benchmark.
It runs frozen Flow Layer, an isolated Flow Field page with eager support restored,
and current Flow Field, then reports observed steps/s and ratios. It must run alone
without competing GPU tests; portable correctness does not depend on a fixed FPS
threshold. Camera, pitched rendering, and temporal-handoff proofs guard the adjacent
presentation paths.
