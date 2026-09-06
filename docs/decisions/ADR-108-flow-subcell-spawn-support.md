# ADR-108: Bounded Subcell Flow Spawn Support

## Status

Accepted. Example-local correction to Flow Field's GPU spawn index. No data-plane,
particle-count, candidate-capacity, texture or runtime-budget increase.

## Date

2026-09-06

## Context

A default spawn group spans 4x4 source texels but previously tested only its center.
One- and two-texel flow strips could therefore have no birth candidates solely due
to grid phase. Increasing the group grid from 64 to 256 would multiply the candidate
buffers by sixteen. The existing 32-byte record has enough reserved bits instead.

## Decision

Each group checks its 4x4, 2x2 or 1x1 texel centers, according to the existing allowed
64/128/256 group grid. One output record retains a low-16-bit occupancy mask and a
two-bit log2 subcell-side tag in its reserved word. There is still at most one output
record per input group. Birth chooses a set bit and jitters within that subcell, then
performs the usual current-time, threshold and viewport validation. Rejection is one
bounded attempt, not an unbounded search. The 56-byte canonical particle record is
unchanged.

Occupancy is the union of both endpoints' nonzero nearest-texel support. Missing or
fallback information may be conservatively included; explicit source exclusion and
invalid data are not. This allows reuse across alpha changes and opposite-direction
cancellation, because actual birth samples the current interpolated field. With the
ADR-107 zero-footprint contract this covers the represented active texel footprints;
old v2 data has only a source-center coverage guarantee, not every bilinear spill.

Rebuilding all subcells each display tick is unnecessary. The index key includes
pair/binding identity, both publication epochs, candidate count/content and subcell
size, but not alpha or camera matrices themselves. Inputs remain potentially mutable:
owned staging bytes are compared before reuse. Changing output allocation/content
epochs also invalidates the cached index.

`encode` returns an owned build/reuse ticket. `observe(ticket, submitted)` verifies
the correct executed dispatch, produced output epochs and successful native completion
before accepting a build as reusable. Pending, unsubmitted, failed or superseded builds
cannot become cache hits. The renderer includes this observer in its existing all-settled
frame observation before releasing the temporal capture. Reuse retains no old temporal
lease and performs no upload, clear or support dispatch. There is no extra readback.

## Verification

Node tests cover mutable input bytes, alpha reuse, publication/pair/content changes,
unsubmitted or wrong receipts, failed native work and resource mutation. Native GPU
tests cover every one-/two-texel strip phase for side 1/2/4, future-only support,
endpoint union, empty support and 512 selected positions per case. End-to-end tests
must also measure rebuild/cache-hit facts, camera continuity, time handoff, visual
coverage, steady throughput and disposal within unchanged budgets.
