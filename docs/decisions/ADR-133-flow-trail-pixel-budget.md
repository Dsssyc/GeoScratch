# ADR-133: Give Flow Trails An Independent Pixel Budget

## Status

Accepted

## Date

2026-09-11

## Context

Flow Field's history composition, boundary clipping and overlap depth used the
native Surface dimensions. A 1760x880 reference viewport at DPR 2 therefore
processed 3520x1760 pixels in every history pass. On the measured M1 Max / 144 Hz
display, resident default playback produced about 41 updates/s; reducing the
entire presentation to DPR 1 produced about 70. Reducing the whole canvas also
reduces diagnostic and map precision, which is unnecessary for a trail budget.

## Decision

The example's `trailQuality` presentation choice is `balanced` by default, with
`native` as an explicit alternative. Balanced history is bounded to one texel per
reference pixel and at most 1920x1080 total pixels. One uniform scale preserves
the presentation aspect ratio; dimensions round down and remain at least one.
The policy never upscales beyond the native Surface. Native quality uses the
complete physical presentation dimensions. `?trailQuality=native` selects it at
startup; the existing inspector exposes a Trail quality select.

Only particle-view history A/B and overlap depth receive this budget. All
inspection views retain native-sized attachments. The borrowed Surface, MapLibre
basemap, controls, and optional contour overlay remain native. Camera matrices,
reference viewport, GPU cover policy, raster demand, source sampling precision,
particle count, advection time and boundary choices retain their existing owners.
Flow Field continues to use the GPU cover; Underwater Terrain's CPU cover is not
changed by this policy.

Raw accumulation and clipped-visible retention keep the same two-texture roles.
The existing normalized-UV presentation draw scales the clipped image to the
Surface with its existing nearest load. No extra texture, filter, compute pass or
CPU readback is introduced. Balanced trails are deliberately coarser and can
differ in line thickness, density and boundary detail; this is not byte-equivalent
rendering. Native keeps the preceding dimensions and shaders.

Each captured frame independently resolves Surface size and history size. A
changed history size uses the existing awaited texture resize and explicit stale
binding preparation before submission. It clears finite history but does not
reset the particle pool or invent elapsed visual time. A paused resolution change
can therefore remain empty until playback resumes. Equal resolved dimensions do
not clear history. Time-unavailable presentation uses the same size decision and
retains only the last visible image, with the preceding explicit resize semantics.

Construction uses the initial view source's reference viewport for the first
history allocation, so balanced startup does not temporarily allocate native-sized
trail buffers. Standalone renderer construction may omit that hint and uses the
physical size as its initial reference, still enforcing the total pixel cap; the
first captured frame then supplies the authoritative reference viewport.

The renderer's facts expose `presentationSize` separately from `history.size`.
The frame-in-flight bound remains one; increasing concurrency requires a separate
ownership design and is not implied by a smaller trail texture.

## Verification

Pure tests cover DPR separation, 1080p capacity, aspect ratio, native mode,
fractional reference pixels, and invalid input. DOM tests cover default choice,
preservation through inspection modes, and disposal.

The real-browser quality proof checks native Surface dimensions, history sizes,
unchanged particle resets and GPU cover/demand during quality changes, zero-time
paused resizing, native inspection, all A/B/C/D boundaries, temporal transitions,
viewport resizing and cleanup. Its screenshots wait for equal accepted visual
time after each resolution change. Existing history, visual-time and camera
continuity gates remain applicable. Native 144 Hz timing is recorded separately
from correctness and visual-quality evidence.
