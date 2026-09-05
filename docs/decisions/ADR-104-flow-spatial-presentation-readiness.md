# ADR-104: Per-View Flow Presentation Readiness

## Status

Accepted. Extends ADR-101's temporal handoff protection to camera and LoD changes
within the same temporal pair. No Scratch, Geo, backend, or frozen Flow Layer change.

## Date

2026-09-05

## Evidence

A delayed-page camera test reproduced an apparent full refresh while the time pair
remained unchanged. The renderer still reported Ready; its explicit reset count,
history-clear flag and reveal-refill count remained zero. The requested sample level
changed before its pages arrived. Missing or coarse-zero samples then retired
particles and rejected existing history pixels. Disabling only history support
rejection in an isolated browser preserved the old ink, identifying the destructive
path rather than a Surface recreation or explicit reset.

The new browser regression fails on the old implementation because it reports Ready
while the current LoD's requests are blocked.

## Decision

Presentation readiness is evaluated for every encoded frame, not remembered merely
because a temporal pair was once presented. All three conditions must hold:

- Delayed cover/demand feedback belongs to the current camera snapshot.
- The prepared temporal sampler's requested level matches the resulting demand.
- Both endpoints' requested pages are resident in the publication encoded before
  dependent work. An empty demand is accepted only after current-view feedback.

One result controls particle simulation, reveal refill, inspector drawing, contour
drawing and velocity-masked history composition. The duplicate refill readiness test
and sticky pair-generation flag are removed.

While the gate waits, the renderer uses the existing temporal-independent retained
history path. It does not advance or retire particles, consume deferred visual resets,
or sample unready flow to clear old ink. History does not decay while the camera is
stationary and is reprojected when the camera moves. Explicit presentation-mode
changes retain their intentional invalidation behavior.

Publication, demand reconciliation, native observation and delayed feedback continue
outside the presentation gate. Residency completion and the existing bounded view/
level follow-ups recover without another user input, including with playback paused.
The UI reports Loading and retains its last observed presented time until a complete
new image is observed. The model clock and requested-time policy are unchanged.

## Consequences

Fast continuous camera movement can keep exact-camera feedback pending, temporarily
pausing advection while the old image follows the map. Once feedback and pages agree,
normal simulation and targeted reveal refill resume automatically. The optional
contour is Surface-only, so it is hidden during waits and returns when ready.

This does not weaken zero-speed or invalid-domain death rules for available data.
It distinguishes presentation that is not ready from a valid sample that says zero.
No new texture, decoded-data owner, CPU readback, source format, or cache is introduced.

## Verification

`flow-field-spatial-handoff.mjs` holds new pages during a pitched same-pair LoD
transition. It checks Loading, frozen particle/reset/refill counts and presented
time, identical retained image hashes at a stationary camera, reprojection during
a subsequent pan, and automatic recovery after releasing data with playback paused.

Renderer wiring tests guard the shared per-frame predicate. Existing temporal
handoff, camera, pitched color/particle, reveal population, and high-DPR motion
tests cover the adjacent paths.

A separate low-zoom, out-of-source pan reaches a pre-existing zero-patch cover
validation failure before empty demand can be delivered. It also reproduces with
the previous presentation gate and is recorded in
[the empty-cover observation](../review/flow-empty-cover-observation.md), not
silently treated as valid empty feedback by this repair.
