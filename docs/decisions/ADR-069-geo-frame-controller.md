# ADR-069: Geo Owns Bounded Asynchronous Frame Convergence

## Status

Accepted

## Date

2026-08-13

## Context

The Underwater Terrain example previously owned a second rendering subsystem around the public Geo
terrain renderer: animation-frame coalescing, in-flight render exclusion, native-work
observation, residency settlement, bounded convergence follow-ups, cancellation, and
failure routing. Those rules are not DEM source semantics. Every camera-driven Geo
renderer that consumes delayed GPU selection or asynchronous residency needs the same
coordination.

Keeping that state machine in each example would make the examples authoritative for
Geo lifecycle behavior and would encourage subtly different convergence loops.
Moving it into Scratch would be equally incorrect because Scratch has no camera,
residency, or Geo-frame policy.

## Decision

Geo exports `createGeoFrameController()`. A controller:

- coalesces external invalidations into animation frames;
- permits one frame-construction operation at a time and releases that submission slot
  before native observation or delayed settlement completes;
- permits one through eight native frames in flight, defaults to three, and collapses
  capacity-blocked invalidations into one newest-state request;
- lets an already-running host render callback use `invalidateNow()` to cancel a queued
  callback and submit against the host's current camera revision;
- observes submitted native work independently from delayed feedback settlement;
- schedules a new frame when bounded residency work settles;
- permits at most a configured number of autonomous convergence follow-ups;
- exposes immutable counters for diagnostics and browser proof; and
- stops idempotently while caller-owned `LifetimeScope` remains responsible for
  draining tracked work and releasing resources.

The renderer callback returns immediate `observation` and `needsFollowUp` facts plus an
optional delayed `settlement`. Settlement carries `residencySettlement`,
`residencyWorkCount`, and its own `needsFollowUp` fact. Only the latest submitted frame
may schedule work from either async path; stale observation or settlement cannot revive
an obsolete camera decision. The controller does not inspect a DEM, tile atlas,
MapLibre map, shader, canvas, or GPU resource. Applications still own event wiring,
presentation controls, source URLs, cache policy, and page lifetime.

## Consequences

- DEM no longer carries a private RAF and asynchronous convergence state machine.
- Other Geo renderers can reuse one bounded scheduling contract without adopting DEM
  source semantics.
- Scratch remains the generic asynchronous lifetime owner; Geo owns camera/residency
  frame convergence; the application only connects events and business policy.
- Map-host camera submission is not serialized behind GPU readback, resource loading,
  or `queue.onSubmittedWorkDone()`, while a bounded three-frame default prevents continuous
  host motion from building an unbounded WebGPU queue.
- Browser-only proof instrumentation lives under `tests/browser/support` and is loaded
  only for explicit development proof runs.

## Rejected Alternatives

### Keep the scheduler in every example

Rejected because it duplicates Geo policy and makes examples part of the runtime
implementation.

### Put the frame controller in Scratch

Rejected because residency-triggered convergence and camera invalidation are Geo
semantics, not WebGPU foundation semantics.

### Retry until convergence without a bound

Rejected because a delayed or inconsistent producer could create an unbounded render
loop. External invalidation and residency settlement may restart the bounded sequence,
but one autonomous sequence is always finite.
