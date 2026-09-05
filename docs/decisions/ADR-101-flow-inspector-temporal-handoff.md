# ADR-101: Coherent Inspector Images During Temporal Handoff

## Status

Accepted. Example-local repair of temporal fallback provenance and inspector
presentation. The source format, Virtual Raster runtime window, and frozen Flow
Layer are unchanged.
ADR-104 subsequently applies readiness to every current view, not only new pairs.

## Date

2026-09-05

## Evidence

With a stationary camera, Sample status changed from moving pixels to an entirely
gray sampled region at a temporal pair boundary, then recovered after detail pages
arrived. At the default playback rate this repeated at roughly five-second
intervals. Pausing produced eight identical consecutive screenshots.

Two independent presentation defects caused this behavior. The inspector bypassed
the particle view's page readiness condition, so it exposed safety-only coarse
values from a new time. It also rendered only into the Surface after clearing
history. Loading frames presented empty retained history and could therefore erase
the diagnostic image altogether. A delayed-network reproduction observed all
120000 sampled diagnostic pixels disappear while the window was loading.

The sampler additionally lost fallback provenance. Its retry loop selected a
common coarse level, then reported that level's locally resident status without
comparing it with the original request. A zero coarse value was consequently
displayed as precise zero rather than fallback.

## Decision

Successful temporal sampling compares the final common level with the original
requested level. Any coarser result remains fallback, including zero velocity.
Missing, invalid, and unsupported outcomes retain their existing precedence;
the repair does not substitute an available endpoint for an unavailable endpoint.

All presentation modes use the same new-pair readiness gate. The current camera
feedback and requested sample level must agree, and the requested view pages must
be resident in the encoded publication. A settled empty source demand is a valid
empty view; an empty batch before camera feedback arrives is not proof of readiness.
The gate remains renderer presentation policy, not a change to model-clock or
runtime-factory ownership.

Inspector draws replace content in the existing rgba8unorm history targets. They
store straight RGBA without blending, with depth32float compatibility but no depth
writes. The final history presenter applies alpha once when writing the Surface.
Non-accumulating frames clear their target and draw only the supplied content; they
do not apply particle support clipping or trail decay to diagnostic classifications.
No new velocity, boundary, or retained-image texture is introduced.

While a new pair loads, the existing temporal-independent retained-history path
keeps or reprojects the previous complete inspector image. It borrows no old
temporal binding and does not keep retired runtimes alive. The UI keeps the old
presented time and reports Loading until the new complete image is submitted and
observed.

Seek/wrap particle and history resets are deferred until the new presentation is
ready. Separate monotonic visual and presentation revisions prevent a setting change
during asynchronous frame preparation from being accidentally consumed by an older
frame. Explicit inspection-mode changes invalidate retained content even while
loading, so an old status image is not mislabeled as Speed. Ordinary time-pair
handoffs do not invalidate the retained image.

## Verification

- `flow-field-temporal-status.mjs` runs the real temporal WGSL function on native
  WebGPU. The original code fails the single-fallback case; the repaired code passes
  19 cases covering repeated fallback, coarse zero, exact zero, endpoint failures,
  and status precedence.
- `flow-field-inspector-handoff.mjs` deliberately blocks safety and detail requests
  separately. Both loading stages preserve the previous PNG hash and presented
  time. Explicit mode changes invalidate old content. Default-rate playback crosses
  two adjacent handoffs without erasing the diagnostic region or showing coarse zero.
- The existing pitched Speed proof compares 24 final screenshot pixels against
  actual COG U/V interpolation and color mapping, confirming that offscreen retention
  does not apply alpha twice. Camera and retained-history tests continue to cover
  zoom and reprojection while data loads.
