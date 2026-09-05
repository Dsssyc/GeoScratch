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
node tests/browser/scratch-flow-field.mjs
```

With Vite and the tile service already running,
`node tests/browser/flow-field-reference-appearance.mjs` saves both examples at
the same camera for visual comparison without changing the reference.

`node tests/browser/flow-field-camera.mjs` checks continuous zoom, paused zoom,
retained-history reprojection during delayed time loading, and steady animation
throughput. Large view demands select a coarser complete cover within the existing
page budget; they do not increase the budget or discard arbitrary visible tiles.
