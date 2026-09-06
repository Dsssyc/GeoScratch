# ADR-110: Non-Destructive Flow Boundary A/B Presentation

## Status

Accepted as an example-local visual comparison. ADR-107's U/V support and ADR-108's
spawn/lifecycle rules remain unchanged. No Scratch/Geo public API or backend change.

## Date

2026-09-06

## Context

At magnification the z10 nearest-zero activity footprints expose large staircase
edges. A distance transform of that exact union of squares would retain the same
zero contour. SDF rendering cannot recover source geometry that was never sampled.
The user requested a selectable SDF comparison while preserving the hard version.

## Decision

`Boundary` defaults to `hard` (A); `sdf` (B) is enabled only in Particles. Both modes
share the exact particle buffers and raw hard-supported, finite-decay history.
Only the final Surface draw changes. A/B does not increment the particle-reset or
history-clear revision. B's alpha is never written back into history, avoiding
repeated soft-mask multiplication and allowing immediate return to A.

B reconstructs a marching-squares contour between four neighboring source texel
centers, then evaluates a signed Euclidean distance to its local line segments.
Distance is truncated outside mixed cells. Ambiguous diagonal cases keep active
regions disconnected. The resulting contour chamfers convex footprint corners;
positive-inside distance maps through `smoothstep(0, 0.25, distance)` in source texels.
Only existing color's final alpha is reduced. There is no color extrapolation into
hard-empty pixels, and no change to speed, reliable-zero death or spawning.

This intentionally implements **inward SDF display**, not complete smooth banks.
It cannot fill concave hard-empty corners, repair absent channels, or recover a
physical wet/dry boundary. The source-space feather remains stable under camera/DPR
changes, but is not screen-footprint antialiasing at minification. Sample status and
all other inspector views remain unmodified; their Boundary selection is retained
but disabled. The activity-contour overlay remains the original diagnostic.

## Source And Lifetime

The presentation borrows the current frame's existing temporal binding through native
completion. Four exact same-level logical loads per endpoint derive support from the
current interpolated vector and activity threshold. It never interpolates endpoint
SDFs, nor adopts the alpha-independent spawn-support union. Logical coordinates come
from the public wide-fixed address module; logical loads resolve physical page slots.
Mixed footprints additionally check the actual temporal sampler's common-level result.

Missing/unknown/fallback neighbors do not seed an artificial dry edge. Such footprints,
legacy representations and unavailable temporal captures use unmodified A ink. This
can expose the original hard edge temporarily while a required halo is unavailable;
we do not claim unchanged B coverage during arbitrary source/runtime gaps.

SDF work is evaluated directly in fragment registers: one extra persistent shader,
program and pipeline, at most two owned draw commands borrowing a single temporal
binding. Replacing that binding, disabling B or disposal retires the owned commands.
No texture, staging copy, readback, dispatch, runtime, network channel or boundary
cache is added. The renderer's existing one-in-flight admission and all-settled
capture lifetime remain authoritative. B has extra per-visible-pixel sampling cost;
A uses the original presentation pipeline with no additional per-frame GPU work.

## Verification

Verify source-center registration, all 16 contour cases, signed distances, diagonal
ambiguity, one-texel strip cores, current-alpha activation/cancellation, swapped atlas
slots, page seams and unknown/fallback. A/B/A over fixed input ink must preserve A
bytes exactly; B may only decrease alpha and must not create color in hard-empty ink.
The live application must preserve particle/reset/history continuity through A/B,
pause, pitch, zoom and time handoff, keep inspector output raw, and dispose all
runtime ownership. Measure throughput while playing, not during idle model pause.
A/B switches can admit a particle step, so same-camera/time live screenshots are
not the byte-identical fixed-ink comparison used by the native fragment proof.
