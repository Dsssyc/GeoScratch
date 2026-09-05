# ADR-098: Flow Field Reference Presentation

## Status

Accepted and implemented in `examples/flowField/`. The frozen `examples/flowLayer/`
defines the visual reference. No Scratch or Geo public API changes.

## Date

2026-09-05

## Context

The first tiled prototype changed more than its velocity source: it used a different
color ramp and alpha, a synchronized age limit, and drew an activity contour into
particle history. It also added north-positive velocity to south-positive tile
coordinates. The standard address helper narrows a displacement to signed 32-bit
quanta; this is not sufficient for amplified steps at 52-bit coordinate precision.
These differences obscured whether the new data representation was correct.

## Decision

The default presentation follows Flow Layer: 262144 canonical particles, native thin
line-list segments, the eight-color `3288bd` through `d53e4f` speed ramp, alpha 0.5,
depth32float overlap with less/write, random retirement probability
`0.003 + 0.001 * speed / maximumSpeed`, and rgba8unorm history with decay 0.996,
8-bit floor quantization, and cutoff 1/255. The global manifest maximum supplies a
stable color scale. A long age cap and stagnant-step limit remain cleanup guards.

One admitted visual simulation tick advances the field by U/V times 50 using a
single Euler step. The factor is a visual scale inherited from Flow Layer, not a
claim about the model-time unit or physically timed trajectories. The explicit
model timeline selects the velocity endpoints independently. This slice does not
replace the reference with a wall-clock particle integrator.

Particle coordinates stay wide-fixed. U/V east/north is converted to east/south
canonical displacement with local Mercator latitude scale and the reference sphere
radius. A shared example-local two-limb displacement function handles steps beyond
the signed-i32 range. The northward Mercator displacement is a first-order local
approximation, not a bitwise copy of the reference's geographic-coordinate update.
Births use the GPU compacted support index, cell-internal jitter, and current-view
screening. Zero velocity, unsupported samples, and offscreen positions retire
immediately, including when the configured kill threshold is zero.

Only particles enter the history textures. The optional activity contour is a
current-frame Surface overlay and is off by default. It is a velocity threshold
contour, not a model-supplied physical boundary. History cleanup directly samples
the same temporal Virtual Raster at the current screen-to-ground position; it
clears missing or non-advectable pixels without a separate boundary texture.
Camera reprojection operates on relative coordinates and the difference of camera
high/low components, with pixel-center image sampling.

Normal adjacent time-pair changes preserve particles and history. Explicit seeks,
reverse-direction changes, loop wraps, gaps, and presentation-mode changes invalidate
the appropriate visual state. At a newly selected pair, particle presentation waits
for that view's requested pages to be resident in the encoded publication. Uploads
and demand feedback continue during this wait; safety-only coarse zero values must
not erase trajectories before the new detail pages arrive. This is a renderer
presentation rule, separate from the window's safety-ready factory and timeline
readiness. A failed requested page surfaces an error rather than waiting forever.

The page exposes a small pushed control snapshot containing the timeline, last
observed presentation, dataset range, and presentation choices. UI controls call the
application directly, not the proof global. The time slider previews locally and
commits one seek on change. Ordinary pause remains reversible; `pauseAndDrain` is
only a terminal proof operation. Gap and failed views hide the obsolete canvas.

The inspector samples the same temporal bindings in a fullscreen fragment pass.
It offers speed, direction, U, V, and status views, with lower, upper, interpolated,
and delta values evaluated at a common resolved LoD. It adds no persistent velocity
or boundary raster plane. The default remains particle trails.

## Verification

- Native GPU numerical checks cover 32/40/52-bit wide displacement, screen rays,
  north/south direction, latitude scaling, zero-threshold death, offscreen death,
  random retirement, reference color bands, and alpha.
- Native history pixel checks cover finite decay, support removal, fallback,
  unavailable values, low-component camera motion, and actual temporal shader
  pipeline compilation.
- Real controls are exercised at 320, 768, 1024, and 1440 pixels with keyboard,
  scrub, loading, error, and cleanup behavior.
- The full browser proof isolates colored particle pixels before switching through
  the visible time control and inspector. It separately checks z10 requests,
  presented sample identity, publication epochs, and cleanup order.
- A read-only appearance runner opens both examples at the same default camera
  and saves particle-only screenshots. It is a visual comparison, not a pixel-equality
  gate: the COG precision/support, temporal progression, random sequences, and
  point reconstruction differ from the original screen-space field.

## References

- [ADR-095](./ADR-095-bounded-flow-runtime-manifest.md)
- [ADR-096](./ADR-096-flow-model-time-authority.md)
- [ADR-097](./ADR-097-flow-selection-runtime-window.md)
