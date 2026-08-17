# ADR-081: Use Bounded Double-Flight for High-Refresh Terrain Tracking

## Status

Accepted. Refines the Underwater Terrain application policy recorded after ADR-079 and ADR-080.

## Date

2026-08-17

## Context

Underwater Terrain originally selected `maximumInFlightFrames: 1` to prevent obsolete camera
submissions from forming a throughput queue. On the current 120 Hz display, host frame intervals
have a median of 8.3 ms, while native WebGPU observation commonly spans more than one interval.
The controller therefore admitted only 45 distinct camera submission transitions across 90 host
frames. MapLibre continued updating at 120 Hz, so the separate WebGPU canvas visibly tracked at
approximately half rate.

This behavior existed before the view-source and thin-application refactor. Before and after that
refactor, the proof reported the same 45 transitions, lag P95 of one frame, maximum lag of two,
one in-flight frame, and zero stale transitions.

## Decision

Underwater Terrain uses `maximumInFlightFrames: 2`. Capacity-blocked invalidations still occupy
one latest-only mailbox; intermediate camera states are not replayed. At most two already-issued
native frames may await observation.

The performance proof now requires:

- at least 70 distinct submission transitions across 90 host frames;
- zero stale submission transitions;
- submission lag P95 no greater than one frame and maximum lag no greater than two;
- no more than two native frames in flight; and
- frame-interval P95 no greater than 20 ms.

On the acceptance machine, bounded double-flight produces 72 transitions, frame interval P50 of
8.3 ms and P95 of 9.1 ms, lag P95 and maximum lag of one, maximum in-flight count of two, and zero
stale transitions. It improves camera submission coverage by 60 percent and halves worst-case
frame lag without opening an unbounded queue.

## Consequences

- The WebGPU overlay follows a high-refresh MapLibre camera more closely.
- Native observation remains a correctness and diagnostics boundary, but one ordinary delayed
  observation no longer suppresses the next host frame.
- The policy remains application-specific; `GeoFrameController` retains its general default and
  explicit one-through-eight bound.
- A slower GPU can still saturate two slots. The controller then drops intermediate pending views
  in favor of the newest capture rather than expanding the queue.

## Rejected Alternatives

### Retain single-flight

Rejected because measured 120 Hz tracking admitted only half of host camera transitions and
allowed maximum camera lag of two frames.

### Use triple-flight

Rejected because the same proof increased transitions only from 72 to 74 while increasing the
maximum already-issued queue from two to three. The marginal gain did not justify the extra stale
work exposure.

### Remove native-observation backpressure

Rejected because an unbounded submission stream can accumulate obsolete work when rendering is
slower than the host camera. The bounded latest-only controller remains the required authority.
