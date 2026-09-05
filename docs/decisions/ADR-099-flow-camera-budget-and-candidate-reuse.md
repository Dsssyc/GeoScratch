# ADR-099: Flow Camera Presentation, Demand Budgets, And Candidate Reuse

## Status

Accepted. Refines ADR-098's presentation waiting behavior. Changes are example-local;
Flow Layer and the Geo/Scratch package APIs remain unchanged.
ADR-100 supersedes this decision's removal of overlapping raster descendants, which
incorrectly applied a geometry-cover constraint to multi-resolution residency.

## Date

2026-09-05

## Evidence

Interactive testing exposed three failures missed by the fixed-camera proof:

- Nine projected z10 requests with the combined filter/displacement halo expanded
  to 49 candidates, exceeding the 47-page view budget and terminating the page.
- While a temporal pair was loading, no Surface presentation occurred, leaving
  the old flow image at its previous screen location when the map zoomed.
- At 960 by 720, a stable z10 view rebuilt and packed 172032 candidate cells on
  every frame. An eight-second CPU profile spent roughly 74% of elapsed time in
  candidate construction and packing. Flow Field advanced about 7.17 frames/s,
  versus Flow Layer's 59.94 frames/s. Both used the same per-frame displacement.

## Decision

Projected demand and executable residency demand have separate bounds. The Flow
adapter expands complete demand with its halo and, if it exceeds either the page or
cell budget, retries at successively coarser published matrix caps. It maps requests
to standard ancestors, recomputes the halo, and removes overlapping descendants.
It preserves desired resolution and source ceiling while setting actual sampling
to the budgeted level. It never keeps an arbitrary prefix of an overflowing set.

If the GPU projection itself reports truncation, the returned subset is not treated
as complete. Flow selects the finest complete source-coverage level that fits the
same budget. Failure remains explicit only if even the minimum published cover
cannot fit. Physical-page and request budgets are not increased.

The coordinator keeps one immutable spatial selection. Its key excludes frame and
residency epochs but includes camera position, source address-space identity, spatial
requests, and budgets. Cache hits still validate current frame provenance and create
new producer demands. The renderer keeps one packed byte array for the current cell
array identity. Per-page canonical arithmetic is computed once per packing operation;
per-cell writes use exact Number offsets with u32 limb carry. Time-varying support
continues to execute on GPU rather than being cached as immutable geometry.

Particle advancement and camera presentation are independent. Waiting for a pair
or for its view pages may defer simulation, but every admitted camera frame can
reproject and present retained history. This retained path binds only history-owned
resources, does not retain the old temporal runtime, and does not consult unavailable
new velocity. It uses decay 1 while no simulation step runs. The normal history path
still clips against the current field and uses reference decay. Requested and
presented model times remain distinct during this wait.

GPU view demand is delayed by one frame. The adapter records the camera decision
that produced its last feedback; the renderer requests a bounded follow-up until
the latest camera feedback and its selected sample level are consumed. A paused
model timeline therefore does not strand the final zoom decision.

## Verification

- A 32768-cell multi-page fixture matches canonical BigInt packing byte for byte,
  including limb carry, mixed requested levels, and malformed input rejection.
- The 172032-cell packing median decreased from about 81.19 ms to 5.58 ms before
  adding the steady-selection reuse.
- Capacity tests reproduce the 49-page case, coarsen it to 30 z9 pages, check full
  source fallback for truncated projection, and preserve hard budgets and provenance.
- A headless 1440 by 900 browser proof performs continuous wheel zoom, paused zoom,
  and zoom during deliberately delayed t10/t11 loading. The latter holds particle
  step count constant and compares flow pixels over a solid proof background.
- The same browser measured approximately 59.9 visual steps/s after the fixes.
  This is machine-specific performance evidence, not a universal frame-rate guarantee.

Run `node tests/browser/flow-field-camera.mjs` with the Vite frontend and COG
service running. The proof rejects page failures, budget violations, stale camera
state, stationary retained imagery, and non-convergent cleanup.
