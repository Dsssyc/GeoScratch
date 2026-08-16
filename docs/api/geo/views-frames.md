---
docId: geo.views-frames
canonical: true
apiSources:
  - packages/geoscratch/src/geo/frame-controller.ts
  - packages/geoscratch/src/geo/geo-view.ts
  - packages/geoscratch/src/geo/maplibre-planar-view.ts
---
# Views And Frame Control

[简体中文](./views-frames_zh.md) | [Geo overview](./README.md)

`GeoViewAdapter` reads an external camera or map and produces immutable
`GeoViewSnapshot` values containing viewport, matrices, camera position, zoom,
orientation, and a monotonic revision. The MapLibre planar adapter translates
MapLibre-compatible state without making MapLibre the owner of Geo resources.

Snapshots are observations, not global camera state. Screen-based demand may consume
them for visualization, while simulations, prefetch, editing, or offline processes may
produce independent demand. This distinction prevents camera locality from becoming a
universal resource policy.

`GeoFrameController` coordinates host-state capture, resize, prepare, render, feedback,
and invalidation for one assembled field. It owns frame-loop authority only when the
descriptor gives it that responsibility. It does not own the external map, GPU runtime,
or field resources unless those are explicitly registered for cleanup.

An optional synchronous `capture()` returns a `GeoFrameCapture` containing a non-negative,
monotonically increasing revision and an immutable host snapshot. `invalidateNow()` calls
`capture()` inside the already-running host render callback, before any Promise or asynchronous
frame construction. A new revision replaces the pending capture in a latest-only mailbox;
an identical revision increments `deduplicatedInvalidationCount`, returns `false`, and does
not schedule another submission. A revision lower than the latest accepted capture stops the
controller with `GEO_FRAME_CAPTURE_STALE`. The asynchronous `render()` callback receives the
frozen snapshot selected for that submission, so later host mutation cannot change an already
admitted frame.

`invalidate()` remains a forceful application or convergence invalidation. It coalesces work
onto the configured frame scheduler and still renders when the host capture revision is
unchanged. This distinction lets camera-locked overlays reject unrelated host style or source
repaints without suppressing presentation changes, residency completion, or GPU convergence.
When no `capture()` is configured, both invalidation methods preserve the uncaptured scheduling
behavior.

`invalidateNow()` also cancels a queued callback and admits the captured state from the current
host render callback. Only construction of one submitted frame is mutually exclusive. The
construction slot is released before native observation and delayed settlement complete, while
a separate `maximumInFlightFrames` budget bounds submissions awaiting native observation. Its default
is three and its accepted range is one through eight. At capacity, repeated invalidations
collapse into one newest-state request; the next completed observation releases that request
without replaying intermediate camera states. This keeps map tracking asynchronous without
building an unbounded GPU queue. Only the latest submitted frame may request bounded
convergence or residency follow-ups, so stale async results cannot revive an obsolete camera
decision. `snapshot()` exposes the configured budget, current in-flight count, deduplicated
invalidations, and latest accepted and submitted capture revisions.

The budget is an application latency-throughput choice, not a universal quality setting.
Camera-locked overlays should normally select one in-flight frame so an external map cannot
build a throughput-oriented queue of obsolete camera presentations. Capacity-blocked
invalidations still coalesce to the newest camera. Independent rendering or compute workloads
may use a larger bounded value when throughput matters more than newest-state latency.
