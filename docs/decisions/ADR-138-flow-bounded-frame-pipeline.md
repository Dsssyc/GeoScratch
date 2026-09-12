# ADR-138: Pipeline Two Stable Flow Frames

## Status

Accepted. Supersedes the single-frame application discipline mentioned in
ADR-118. Cache builds still require successful observation before reuse. Scratch,
Geo, Virtual Raster publication contracts and the frozen Flow Layer are unchanged.

## Context

At 144 Hz, a host frame lasts 6.94 ms. Waiting for complete native observation
before requesting the next host frame can skip presentation opportunities even
when the GPU can sustain more work. Raising only the frame-controller bound would
violate the renderer's single pending spatial result and source-publication rules.

## Decision

The application and renderer share a bound of two submitted frames. Construction
remains exclusive. Playback requests its next host tick after submission; the
controller keeps the existing admission, coalescing and observation ownership.
Application presentation facts advance only from the newest observed frame, so an
older completion cannot overwrite newer visible time or readiness.

Stable frames reuse observed immutable spatial feedback. Each reused frame owns
its own observation and current view provenance; a reuse completion never replaces
the original successful GPU build's provenance. A spatial rebuild must wait for all
reuse observations. Actual cover, spawn and center-cache builds remain barriers
until their owning frame is fully observed. The optional contour also remains a
barrier because its overflow readback has one staging slot.

Source acknowledgement is separate from full frame observation. Every publication
is still acknowledged exactly once. The next construction waits for the preceding
acknowledgement before publishing again. A no-op publication can acknowledge while
the previous draw runs. Changed publication and spawn/center build writes can
follow stable frames in GPU FIFO; their entire frame becomes a barrier for later
admission. Their fixed GPU allocations are not replaced during those writes.
No pending-publication check or Virtual Raster completion rule is relaxed.

Uniforms, particle buffers and the two history textures remain shared. All mutable
packing and uploads through submission execute synchronously, and actual queue
writes and commands preserve FIFO order. There is no await between final encoding
and submit, no duplicated particle pool and no additional trail texture. Resize,
camera changes, reset and presentation changes drain existing frames before
changing shared state. A new temporal binding may be prepared while old leases
remain alive, but encoding/submitting with that pair first drains the old frames.
Submitted command descriptions can retire after native encoding; they do not
destroy the borrowed resources retained by frame leases.
Each submitted frame keeps its own temporal and optional prefetch lease until all
native, source, spatial, spawn, history and contour observations settle. Successful
prefetch readiness cannot be downgraded by an older completion.

The renderer borrows the application's lifetime signal for admission. After async
preparation or draining, it rechecks cancellation before modifying or submitting
resources. A prepared ready capture is registered for release before that check.
Normal stop propagates the original lifetime reason without becoming a terminal
render failure. Cancellation never skips observation of already queued work.
Native or other real frame failures latch, stop further admission and leave all
issued work observable. Disposal drains construction and every submitted frame
before releasing owned resources.

## Verification

The native frame-pipeline proof delays queue completion observation in the actual
example. It checks two leases with no third submission, reversed completion,
paused quality resize, camera rebuild, temporal-pair change, contour serialization,
two-frame disposal, disposal during blocked construction, and injected native
failure. Stopped construction must neither resize history nor submit more work.
Node adapter tests independently settle reused spatial receipts in reverse order
and verify disposal retains all outstanding views.

The throughput proof changes only the frame bound in an isolated Vite response
and runs one/two/two/one at Native resolution with the same source pair and camera.
It records updates, observations, rAF cadence, queue completion latency, native
submission counts and the in-flight peak. Native display measurement uses only an
isolated background browser on a verified non-main high-refresh display. Shared
GPU model workloads may affect absolute timing, so one slow sample is not a code
regression. Results belong in the living Flow quality/throughput review.

History, trail quality, visual time, camera continuity, source handoff and cleanup
remain required. A future bound change needs new throughput and lifecycle evidence;
two slots do not authorize overlapping resource reconstruction or readback reuse.
