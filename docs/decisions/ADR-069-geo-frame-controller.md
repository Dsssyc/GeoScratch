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
- permits one asynchronous render operation at a time;
- observes submitted native work before completing a frame;
- schedules a new frame when bounded residency work settles;
- permits at most a configured number of autonomous convergence follow-ups;
- exposes immutable counters for diagnostics and browser proof; and
- stops idempotently while caller-owned `LifetimeScope` remains responsible for
  draining tracked work and releasing resources.

The renderer callback returns explicit `observation`, `residencySettlement`,
`residencyWorkCount`, and `needsFollowUp` facts. The controller does not inspect a DEM,
tile atlas, MapLibre map, shader, canvas, or GPU resource. Applications still own event
wiring, presentation controls, source URLs, cache policy, and page lifetime.

## Consequences

- DEM no longer carries a private RAF and asynchronous convergence state machine.
- Other Geo renderers can reuse one bounded scheduling contract without adopting DEM
  source semantics.
- Scratch remains the generic asynchronous lifetime owner; Geo owns camera/residency
  frame convergence; the application only connects events and business policy.
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
