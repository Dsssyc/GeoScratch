# Flow Field

Run `npm run dev` from the repository root and open `/flowField/index.html`.
Start the COG service with:

```sh
examples/flowField/tile-server/.venv/bin/flow-field-tile-serve --port 8788
```

The default is Flow Layer-style colored particle trails over MapLibre. The bottom
timeline controls play/pause, continuous model-time seeking, signed playback rate,
and loop/clamp. Requested and presented times remain distinct while data loads.
Rate uses the dataset's model-time unit per wall-clock second. The inherited particle
motion scale is visual; it does not reinterpret unconfirmed source units.

Use the inspector for speed, direction, U/V components, or sampling status. Lower,
upper, interpolated, and upper-minus-lower values all use the same tiled temporal
sampler. Status colors are green for resident moving data, amber for fallback,
gray for zero velocity, magenta for unavailable data, and red for invalid sampling.
Activity contour is an optional velocity threshold overlay and does not enter trails.

In **Particles**, the **Boundary** selector compares **A · Hard texture** (default)
with **B · SDF (inward)**. B derives continuous current-time activity from endpoint
and interpolated U/V, then combines the existing binary SDF coverages across those
activity levels. Each basis searches neighboring cells for the nearest finite contour
segment and applies an inward feather (default: 0.25 source texel). Convex pixel corners are
chamfered; diagonal active cells are not connected across a dry gap. This is a local
truncated SDF evaluated in shader registers, not an uploaded SDF texture or a JFA pass.

Activity includes a low-speed display ramp from the unchanged kill threshold to four
times that speed, plus a relative cancellation fade. Thus reversal in the middle of
a time pair can fade before reliable zero kills particles, and recovering activity
can reappear gradually. Sorted activity thresholds give an exact, deterministic
coverage integral; this is **not** interpolation of two endpoint SDFs or a stateful
wall-clock smoothing filter. Uniform activity q produces coverage q; binary activity
preserves the spatial basis. Actual point-speed gain caps the result without multiplying
low-speed attenuation twice. See [ADR-112](../../docs/decisions/ADR-112-flow-temporal-boundary-coverage.md).

With B selected, **Feather** adjusts the inward fade width from **0.05 to 0.35 source
texel**, in 0.01 UI steps. Smaller is sharper; larger makes a wider inward transition.
It does not move the reconstructed zero contour or change the activity threshold.
The numeric readout and keyboard arrows use the same source-texel units, not screen
pixels. Changes apply while dragging and preserve raw history and particle state.
A and inspector views disable the slider but retain its value for the next B view.
Programmatic `sdfFeatherTexels` inputs default to 0.25 when omitted; non-finite or
out-of-range values are rejected rather than silently changing the user's input.

Both choices use exactly the same particles and raw hard-cleaned trail history.
Switching A/B neither resets nor softens that history, changes velocity/death, nor
adds source requests. B cannot extend color into empty hard footprints, round every
concave step, restore missing narrow channels, or increase the z10 source precision.
It is deliberately an **inner-edge display comparison**, not reconstructed true banks.
The distance uses source texels, so DPR/pitch do not redefine its width. At minification
this is not a replacement for screen-space antialiasing.

Four initial logical center loads per endpoint cross tiles through the existing
Virtual Raster sampler. Near mixed boundaries, additional nearby cells contribute
the true nearest contour distance within a 0.35-texel band, with at most nine loaded
source centers per endpoint. Unrelated distant halos are not sampled. Relevant
unknown/missing halo, fallback or an unavailable temporal capture
uses the unmodified A display, not a fabricated dry contour. Current alpha is evaluated
each time: opposite endpoint velocities can cancel, and a zero endpoint can activate.
No endpoint SDF interpolation or alpha-independent spawn-union cache is used. B adds
fragment work and one stable pipeline, but no texture, CPU raster, readback, compute
dispatch, or backend channel. Inspector views and activity contour remain raw; their
disabled Boundary control retains the selection for the next Particles view. See
[ADR-110](../../docs/decisions/ADR-110-flow-boundary-sdf-comparison.md) and the
[continuity correction](../../docs/decisions/ADR-111-flow-continuous-boundary-distance.md).

New v3 COGs store ordinary triangle-linear center velocities without neighborhood
erosion. Their zero-absorbing 2x2 overviews also omit the extra 3x3 erosion. The
manifest explicitly requests `nearest-texel-zero` activity: each zero texel's whole
footprint stays inactive, while nonzero footprints keep ordinary bilinear velocity
and time interpolation. Old v2 data remains readable under its original contract.
See [ADR-107](../../docs/decisions/ADR-107-flow-zero-footprint-cog-support.md).

The bounded spawn index examines every source texel in each group, using a subcell
mask in the existing 32-byte record instead of checking only the group center.
Observed endpoint-union support is reused across alpha changes; page/pair/content
changes rebuild it. Birth still validates the current interpolated velocity, so
future support or opposing endpoint vectors cannot create a stationary zombie.
No candidate-capacity, texture or backend-channel increase is required; see
[ADR-108](../../docs/decisions/ADR-108-flow-subcell-spawn-support.md).

During camera/LoD changes, available flow continues to animate using the current
temporal capture. Missing data suspends only affected particles without redrawing
their previous segment; waiting still consumes their finite lifetime. Missing or
conservative coarse-zero support does not immediately erase trails: those pixels
follow the map and decay normally. Reliable resident zero and source exclusion still
retire particles and clear unsupported ink.

Full-view completeness remains separate from local animation. Loading and the old
presented time remain visible until feedback and requested pages agree. Inspector
views retain their complete image, and the optional contour is hidden during this
wait. A pending explicit seek/loop reset or a loading temporal runtime still uses
the retained-image path; the reset must happen before drawing the new particle pool.
Residency completion resumes automatically even with model playback paused.
Fallback is always reported relative to the original sampling request, including
when a coarser page contains zero velocity. Changing the inspection mode explicitly
invalidates the old image rather than relabeling it.

While playing, one next sample in the playback direction is prepared ahead of the
active pair. The same current-view detail pages are requested with background
priority and uploaded through the existing GPU submission/acknowledgement path.
During camera motion, lookahead may use the latest observed bounded spatial plan;
completion of that plan is not a claim that the newest camera is fully covered.
This stays inside the four-runtime aggregate budget, including captured and retiring
runtimes. Completed unchanged plans incur no repeated prefetch publication work.
Pause cancels speculation; gaps are not silently crossed. Seeks, discontinuous loop
wraps, changed views, high rates or slow sources can still use the retained loading
path. Factory readiness alone does not mean current-view pages are GPU-ready. See
[ADR-105](../../docs/decisions/ADR-105-flow-directional-lookahead.md).

Flow-specific controls, screen projection, particles, and history stay local to this
example. The former `flowLayer` is a frozen rendering reference. See
[ADR-098](../../docs/decisions/ADR-098-flow-field-reference-presentation.md) for the
reference mapping and the numerical differences introduced by tiled sampling.

Focused native proofs:

```sh
node tests/browser/flow-screen-projection.mjs
node tests/browser/flow-field-particle-reference.mjs
node tests/browser/flow-field-history.mjs
node tests/browser/flow-field-controls.mjs
node tests/browser/flow-field-boundary-distance.mjs
node tests/browser/flow-field-boundary-time.mjs
node tests/browser/flow-field-boundary-sdf.mjs
node tests/browser/flow-field-boundary-ab.mjs
node tests/browser/flow-field-normal-startup.mjs
node tests/browser/flow-field-temporal-status.mjs
node tests/browser/flow-field-zero-footprint.mjs
node tests/browser/flow-field-spawn-subcells.mjs
node tests/browser/flow-field-inspector-handoff.mjs
node tests/browser/flow-field-motion-performance.mjs
node tests/browser/flow-field-reveal-index.mjs
node tests/browser/flow-field-camera-reveal.mjs
node tests/browser/flow-field-camera-continuity.mjs
node tests/browser/flow-field-spatial-handoff.mjs
node tests/browser/flow-field-lookahead.mjs
node tests/browser/flow-field-prefetch-failure.mjs
node tests/browser/scratch-flow-field.mjs
```

Run the motion benchmark alone: it compares high-DPR visual step frequency against
frozen Flow Layer and an isolated eager-support counterfactual. Empty or fully faded
history skips temporal-raster support sampling (see
[ADR-102](../../docs/decisions/ADR-102-flow-history-visible-support.md)); visible
history still checks the current flow before presentation.

With Vite and the tile service already running,
`node tests/browser/flow-field-reference-appearance.mjs` saves both examples at
the same camera for visual comparison without changing the reference.

`node tests/browser/flow-field-camera.mjs` checks continuous zoom, paused zoom,
retained-history reprojection during delayed time loading, and steady animation
throughput. Large view demands select a coarser complete cover within the existing
page budget; they do not increase the budget or discard arbitrary visible tiles.

When camera movement reveals new supported flow, a bounded GPU index directs
replacement particles into that region once the current view's pages are ready.
It preserves history and normal stationary retirement, with no extra source data
or texture. The quota uses candidate counts rather than exact projected area; see
[ADR-103](../../docs/decisions/ADR-103-flow-camera-reveal-refill.md).

Per-position uncertainty handling prevents loading-time samples from erasing old
trails without freezing the whole field; see
[ADR-106](../../docs/decisions/ADR-106-flow-local-streaming-motion.md).
Targeted reveal refill still waits for a complete view. During continuous expansion,
newly exposed regions may temporarily be less dense while existing flow keeps moving.

`node tests/browser/flow-field-pitch.mjs` checks tilted particle and Speed views at
model time 6.93, including screenshot colors against COG U/V samples.
`node tests/browser/flow-field-pitch-projection.mjs` checks real MapLibre camera
unprojection on GPU at 0/60/75/85 degrees and DPR 1/2.

`flow-field-boundary-source.mjs` compares separately served v2 and v3 data at the
same fixed camera/time (URLs through `FLOW_BOUNDARY_OLD` / `FLOW_BOUNDARY_NEW`). It
checks restored Speed/particle coverage and actual reuse of the observed spawn index.
It does not treat a basemap shoreline as model truth. A z10 source remains roughly
130 metres per texel here, so subpixel channels/banks still need finer source data.
