# ADR-103: Targeted Particle Refill For Newly Visible Flow

## Status

Accepted. Example-local particle population policy. Frozen Flow Layer, Scratch,
Geo, the time window and the transmitted U/V dataset remain unchanged.

## Date

2026-09-05

## Context

After tilting the camera, newly visible flow remained sparsely populated even
after its requested pages were resident. Flow Field births only in active support
cells, so most slots remain occupied by valid particles in the old view. A camera
expansion can preserve those particles and leave only the natural 0.003–0.004
per-step retirement rate to populate the new region. Frozen Flow Layer's
whole-rectangle rejection sampling maintains a larger continuously recycling pool.

A global one-quarter reseed was tested and rejected: many replacements returned
to the already populated region, and it also disturbed views with no newly visible
support. Raising permanent retirement or clearing all history would change the
reference trail behavior.

## Decision

The renderer retains the last populated immutable camera snapshot. A changed view
may request refill only after same-camera cover feedback, the requested sample
level, and all demanded pages of both temporal endpoints agree. Pending feedback
or loading does not consume the old snapshot. Explicit full visual resets also
reset this baseline. No application MapLibre move listeners or second controller
are introduced.

An optional GPU pass projects the existing active spawn-cell centers into the
current and previous view. It counts current-visible candidates and compacts the
indices of candidates that were not previously visible. It creates neither another
velocity image nor boundary data.

The additional replacement budget is
`min(floor(particleCount / 4), ceil(particleCount * revealed / visible))`.
Zero revealed or zero visible candidates give zero additional replacements.
This is a candidate-count heuristic, not exact screen-area density; mixed LoD and
coarse-cell center aliasing remain limitations of the existing spawn model.

A cyclic slot range enforces the exact budget. Its start is hashed from the frame
seed so consecutive camera updates do not repeatedly remove the same newborn
cohort. Selected slots use only the revealed index, with the existing cell jitter.
The resulting position must still be currently visible, outside the previous view,
and supported by nonzero current velocity. Rebirth sets previous equal to current
and velocity to zero, so it never draws a bridge from the old location. A bounded
follow-up frame allows those newborns to draw even when model playback is paused.

Other slots retain canonical position and normal lifetime rules. History is not
cleared. Stationary playback executes no reveal-index pass and does not change the
natural drop probability or displacement scale.

The frequently called current-camera test retains direct uniform access. Ordinary
simulation and reveal-enabled simulation use two stable pipeline specializations
of the same WGSL entry point. A WebGPU override removes reveal selection and
previous-view tests from the ordinary kernel; a runtime-only branch regressed the
high-DPR, near-first-sample workload even when no refill pass was requested.

## Ownership And Cost

The particle spawn-binding adapter owns two additional buffers: eight bytes of
counters and `capacity * 4` bytes of candidate indices (about 0.74 MiB at the
example's current bound). It owns their clear commands and releases them after
borrowing particle commands are disposed. Inputs remain borrowed spawn-index bytes.
The 272-byte particle uniform includes the previous camera. Initialization/reset
explicitly clears both buffers; later index builds clear only the counters.

Separate Scratch compute steps order index construction before simulation. All
bound read/write access is declared, including conservative writable-binding access
in a pass that does not use a particular binding. There is no production readback,
CPU particle mirror, new backend payload, or extra texture.

## Verification

- Native reveal-index proof executes the actual production helpers for expansion,
  contraction, identical views, no visible candidates, proportional quota, and
  high/low camera-coordinate changes.
- Native particle proof checks exact natural/forced slot sets, distinct consecutive
  cohorts, unchanged survivor continuity, zero-length birth, and zero-speed death.
- Command tests cover initialization, coalescing, one-shot requests, reset priority,
  clear/build/simulate order, and disposal.
- The camera-reveal browser proof compares an isolated disabled-refill control with
  current behavior in newly visible valid pixels, and exercises continuous pitch
  plus stationary settlement. It checks early population, not immediate mature
  trail coverage or bitwise visual equality with the differently reconstructed
  frozen example.
- Camera, high-pitch, temporal-handoff and high-DPR motion tests cover adjacent paths.
