# ADR-140: Present The Current Flow Camera During Content Observation

## Status

Accepted. Refines ADR-138's camera and contour waiting policy. The two-submission
bound, one construction, observed spatial reuse, source acknowledgements, native
failure handling and borrowed temporal lifetimes remain unchanged. No Scratch or
Geo public API, MapLibre driver, frozen GPU cover or data source changes.

## Context

ADR-138 improved stationary throughput but captured a camera before waiting for
spatial/native observation. A drag could therefore draw an old camera after the
map had moved. The old continuity proof counted particle updates; it did not check
image alignment. Native and Balanced both exhibited this scheduling problem.

## Decision

The existing frame controller admits a synchronous camera-only presentation when
a full content observation prevents a new spatial frame. The renderer uses the
current immutable host capture and the existing visible history image. Encoding
and submission run before the application's first await. It performs one history
uniform upload and a surface draw. Optional contour presentation uploads the view
and draws the existing segment buffer; it performs no contour compute or readback.

Camera-only frames never publish sources, build spatial/cache/spawn state, simulate
particles, reset visual time, decay ink, flip history direction, replace the history
reference camera, or retire temporal commands. They borrow the renderer's existing
history/contour resources and need no temporal frame lease. A changed viewport,
physical size, presentation or reset revision retains the normal preparation path.

Track all submitted work for the two-slot budget and disposal, and separately track
content observations for spatial/contour rebuild barriers. History and view uniforms
are snapshotted before queue submission; the two history textures, existing contour
segments and their read-only draws follow the same native queue's FIFO ordering.
Camera-only observation does not block a later spatial/contour build. Resize and
presentation/reset changes still drain all frames before changing shared resources.
Actual content builds retain their previous native/feedback observation requirements.

The application reports camera frames as `state: 'presented'`; `lastContentFrame`
and `contentFrameCount` identify real source/particle submissions independently.
Camera-only frames carry zero visual steps and cannot supersede the content
observation that updates the displayed model time. Prefetch uses the latest full
content frame. A settling content frame wakes the same controller when newer camera
presentations ran, so a paused drag converges after observation without polling or
a second animation loop. While playing, the existing on-submission tick continues;
the next content update consumes elapsed visual time since the last content update.

Native failures still latch and stop future admission. Cancellation and disposal
wait for both classes of issued work. Camera presentation creates no new GPU
allocation or unbounded queue. Separate WebGL/WebGPU canvases still have no atomic
presentation guarantee; this decision removes stale-camera waits from the normal
drag path rather than changing browser compositing semantics.

## Verification

The native pixel proof holds a real content frame's completion notification after
its GPU work finished, pans the map by 80 reference pixels and requires a new camera
submission before releasing the hold. Native and Balanced, with and without contour,
must match the translated image, preserve paused simulation/history/geometry, retain
one content lease, stay within two total slots and converge after release. Disabling
the camera path must fail this proof at the new-camera submission gate.

The frame-pipeline proof keeps rebuild/resize/seek, reverse observation, contour
readback serialization, cancellation, failure and cleanup gates. Continuous camera
proofs count particle work per content frame and also bound accepted visual time;
camera-only submissions must not disguise simulation starvation. Real drag traces
record capture-to-submit age and projected camera differences, independently of
stationary FPS. Shared-GPU timing remains an observation, not a fixed frame-rate claim.
