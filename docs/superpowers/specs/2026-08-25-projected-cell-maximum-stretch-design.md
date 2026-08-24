# Projected-Cell Maximum-Stretch Design

## Goal

Prevent terrain LoD from coarsening long, foreshortened cells during a continuous camera
pitch while preserving rotation invariance, deterministic current-view selection, bounded
GPU work, and the sparse exact-parent cover from ADR-087.

## Metric

For the local pixel-space projective Jacobian `J`, use its largest singular value. This
is the maximum screen displacement produced by any unit direction in one geometry cell.
It is invariant under rotations of the world-cell basis and screen basis. The previous
`sqrt(abs(det(J)))` reports an area-equivalent scale and can hide an arbitrarily long
axis when the orthogonal axis is foreshortened.

The CPU reference and WGSL kernel use the closed-form largest eigenvalue of `J^T J`.
Near-plane crossing remains a conservative reference-viewport maximum.

## Calibration

The built-in 128-cell WebMercator terrain patch uses five reference pixels and 0.005
numerical tolerance. The value is consumer policy, not a global cover default. At the
canonical 1280 by 800, zoom-10 MapLibre view it preserves the eight-patch top-down cut,
then grows without a settled patch-count regression through every integer pitch from 0
to 85 degrees; the peak is 88 of 512 patches.

## Verification

- an anisotropic CPU projection refines more deeply than an equal-area isotropic one;
- sparse-parent, prefix-free, deterministic, and 2:1 tests remain green;
- the native Chrome pitch sweep has 86 settled samples, no coarsening, no overflow, and
  no adjacent level delta above one;
- shaded/wireframe tracking and DPR invariance retain their existing latency and identity
  gates.

