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

During a time-pair handoff or camera/LoD change, presentation retains the previous
complete image until current-view feedback and requested pages are ready. Loading
and the old presented time remain visible. Particle advancement pauses during this
wait, while retained history follows the map; completion resumes automatically even
when model playback is paused. The optional contour is hidden during the wait.
Fallback is always reported relative to the original sampling request, including
when a coarser page contains zero velocity. Changing the inspection mode explicitly
invalidates the old image rather than relabeling it.

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
node tests/browser/flow-field-temporal-status.mjs
node tests/browser/flow-field-inspector-handoff.mjs
node tests/browser/flow-field-motion-performance.mjs
node tests/browser/flow-field-reveal-index.mjs
node tests/browser/flow-field-camera-reveal.mjs
node tests/browser/flow-field-spatial-handoff.mjs
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

The per-view readiness gate also prevents loading-time samples from erasing old
trails within an already admitted time pair; see
[ADR-104](../../docs/decisions/ADR-104-flow-spatial-presentation-readiness.md).

`node tests/browser/flow-field-pitch.mjs` checks tilted particle and Speed views at
model time 6.93, including screenshot colors against COG U/V samples.
`node tests/browser/flow-field-pitch-projection.mjs` checks real MapLibre camera
unprojection on GPU at 0/60/75/85 degrees and DPR 1/2.
