# Geo Virtual Raster Flow Readiness

## Review Status

The reusable coordinate and virtual-raster foundation is executable for a future
large-area Flow clean cut. A headed WebGPU proof advances 262,144 canonical dynamic
positions while sampling a three-LoD, multi-page virtual vector field through the same
public Geo and Scratch APIs used by DEM. This review does not modify or migrate the
visible `examples/flowLayer` page.

## Executable Proof Facts

`tests/fixtures/geo-virtual-raster-dynamic-flow.ts` establishes this data path:

```text
cell-local-f32 canonical position
    -> explicit simulation sampling LoD
    -> immutable VirtualRasterSnapshot
    -> compute-stage logical bilinear sample with parent fallback
    -> local vector displacement
    -> carry/borrow normalization into the next canonical position
```

The latest successful `node tests/browser/geo-virtual-raster-dynamic-flow.mjs` run
reported:

| Fact | Observed value |
| --- | --- |
| Particle count | 262,144 |
| Position encoding and footprint | `cell-local-f32`, 16 bytes per position, 4,194,304 bytes total |
| Simulation steps and LoDs | Six steps: `[2, 2, 1, 1, 0, 0]` |
| Requested/resolved LoD range | `[0, 2]` / `[0, 2]` |
| Snapshot epochs | `[2, 2, 2, 2, 3, 3]` |
| Canonical position epochs | `[2, 3, 4, 5, 6, 7]` |
| Samples | 710,065 resident plus 862,799 fallback = 1,572,864 total |
| Spatial transitions | 1,572,864 cell transitions and 4,723 page transitions |
| Requests/residency | Three page requests, three residents, one pinned parent, zero pending/failed/stale responses |
| CPU residency budget | 98,304 bytes used of 163,840 bytes |
| GPU snapshot | Epoch 3, five physical slots, 192 by 128 atlas, 21 page-table entries / 672 bytes |
| Persistent virtual address payload | Zero bytes |
| Address materialization pass | None |
| CPU particle mirror per step | Zero bytes |
| Readback | One bounded terminal readback only |
| Coordinate error bound | `1.4551915228366852e-11`; max local ULP `2.9103830456733704e-11` |
| Persistent graph | 12 stable identities, one compute pipeline, one dispatch command, two buffers |
| Diagnostics | 23 of 96 operation records retained; zero incident, pending native observation, uncaptured error, or device loss |

Camera/request LoD changes preserved canonical position content epochs in both tested
transitions (`1 -> 1` and `5 -> 5`). Sampling counters are reduced in workgroup memory
before four global atomics per workgroup; there is no per-particle global atomic
feedback storm. Atlas upload commands are snapshot-scoped and released after
acknowledgement, preventing streaming command-wrapper growth.

## What The Proof Establishes

- Canonical dynamic position does not contain tile, page, texel, subtexel, LoD, or
  physical-atlas identity.
- Position updates do not reconstruct a whole-world f32 coordinate.
- Simulation LoD can change independently of camera request LoD and residency can
  resolve a coarser parent without changing the position buffer.
- One submission step sees one immutable page-table epoch.
- A vector field uses the same generic page table, atlas, logical filtering, and
  fallback machinery as scalar DEM in the compute stage.
- The required throughput shape does not require a CPU particle mirror, per-step
  readback, persistent seven-part address buffer, or default address prepass.

It does not establish final Flow visual parity, production field tiling, temporal
streaming, prediction feedback, or camera-driven render LoD. Those are the bounded
scope of the next clean-cut goal.

## Next Flow Clean-Cut Matrix

| Current path | Complete target model | Behavior that must remain | Exact replacement/deletion | Required gate |
| --- | --- | --- | --- | --- |
| `flow-layer.ts` builds D3 station triangulation, expands station velocities, and runs `flowVoronoi.wgsl` into viewport-sized `rg32float` velocity and `r8unorm` mask textures every frame. Simulation samples those screen UV textures. | Build a georeferenced vector `VirtualRasterPlane` (two velocity channels plus an explicit support/mask plane) whose logical coordinates are independent of viewport. The source adapter tiles each temporal plane; `VirtualRasterResidency` publishes one immutable snapshot; simulation and optional field display call the generated Geo accessor with logical coordinates. | Delaunay/IDW field semantics, maximum-edge domain support, maximum-speed normalization, and the accepted display mask must be preserved by offline/source construction or equivalent tested preprocessing. | Delete the `Flow Voronoi field stage`, `flowVoronoi.wgsl`, station vertex/domain-support buffers, expanded `fieldFrom`/`fieldTo` vertex buffers, viewport velocity/mask targets, Voronoi pipeline/pass/command, and `voronoi-to-simulation` provenance path after parity is proven. Replace their consumers with virtual vector/mask snapshots. | Fixed-camera field sample parity at stations, triangle interiors, support boundary, river mouth, and offshore exclusion; zero screen-size-dependent field regeneration. |
| `flow-worker.ts` fetches 27 whole `uv_N.bin` arrays; `flow-layer.ts` keeps two expanded arrays and changes them every 300 frames. | Represent all 27 slices as a temporal auxiliary axis in a `VirtualRasterStack`. Keep two time-plane residency views plus a bounded prefetch window. Sample both logical planes at the same canonical position and interpolate with the existing `progressRate`. | Exactly 27 slices, initial 0/1 load, prefetch/rotation order, 300-frame phase duration, interpolation progress, monotonic maximum speed, and deterministic failure propagation. | Delete whole-field Worker transfers and `expandStationVelocities()` after the tile source owns temporal pages. Keep a worker only if measured decode work requires it; it must return bounded page payloads, not complete fields. | Two complete 27-slice cycles with exact indices/progress, bounded resident temporal pages, no whole-field transfer, and no cadence regression. |
| Current simulation, drawing, and requests share camera/map bounds and have no field LoD hierarchy. | Keep three explicit policies: `simulationLod` is chosen from integration error and velocity variation; `renderLod` is chosen from projected particle/trail density; `residencyLod` is the actually resolved page level. Camera changes request priority/render LoD but do not mutate simulation state. Fallback is reported separately from requested LoD. | Current speed factor, drop/drop-bump behavior, mask behavior, particle count, display extent, and frame scheduling. | Replace screen-UV sampling and implicit viewport resolution with explicit sampling intent uniforms and Geo snapshot facts. Do not use zoom as canonical position or silently bind all three LoDs together. | Camera pan/zoom while simulation is paused and running: canonical content epochs change only on simulation, requested/resolved LoDs are observable, and trajectories remain within an error budget against a finest-resident reference. |
| Current requests know only camera-visible field state; dynamic particle movement has no tile prediction. | Bin particles transiently by logical page/cohort on GPU. Per workgroup, reduce current bounds, velocity extrema, and predicted displacement over a finite horizon. Compact unique page-plus-halo requests into a bounded feedback buffer; read it back at a throttled submission boundary or consume it in a GPU-driven request planner when available. Halo width derives from filter footprint plus `ceil(maxSpeed * horizon / pageWorldExtent)` and includes both active temporal planes and parent fallback. | No per-frame CPU particle mirror and no per-particle global atomic request. Misses must fall back without holes while later snapshots converge. | Add bounded Geo request-feedback plumbing only if required by measured Flow behavior. Never persist full virtual addresses or materialize one address per particle by default. | High-speed page-crossing run with measured miss/fallback convergence, bounded unique requests/history/readback cadence, workgroup deduplication, and no unbounded queue. |
| Particle state is six global f32 values: current lon/lat, previous lon/lat, and velocity. Spatial grouping is implicit and camera-bound. | Store current and previous positions as canonical `cell-local-f32` (or `wide-fixed` where its range/quantum contract is required) plus basis/unit-aware local velocity. Tile split/merge changes only transient cohort/bin membership and dispatch ranges. Rebase/normalize uses integer carry/borrow; page identity is reconstructed only while sampling. | 262,144 particles, rebirth/drop semantics, previous/current segment rendering, velocity color, optional arrows, and deterministic proof seed. | Delete the six-float global-coordinate ABI in `simulation.compute.wgsl`, `particles.wgsl`, and `arrow.wgsl`; replace it with a documented canonical position layout shared by compute and vertex accessors. Delete any CPU initialization that fills world positions as normalized/global f32 after the new GPU initialization path passes. | Repeated cell/page crossings, cohort split/merge, eviction, camera rebase, and LoD changes preserve canonical position within codec error bounds and never add CPU mirroring. |
| `swap.wgsl` reprojects two viewport history textures from previous/current high-low camera facts; normal rendering is display-paced by one `requestAnimationFrame` after SubmittedWork observation. | Retain the two history textures, direction ping-pong, reverse-gather reprojection, trail decay/cutoff, previous/current camera facts, and single-frame backpressure. Only the particle source and field mask binding lower to virtual-raster-aware data. A newly exposed virtual mask must match the existing display extent before history composition. | `off`/`clear`/`reproject`, camera move/settle behavior, no old-viewport brightness rectangle, 100 ms/500 ms recovery appearance, resize behavior, and cadence. | Do not delete `swap.wgsl`, history textures, history direction sets, or presentation passes as part of field migration. Replace only its old viewport mask dependency after a virtual mask parity gate. | Existing motion-parity screenshots, 660+ frame regression, history reprojection counters, stable graph identities, resize, and zero pending work after drain. |
| The complete station resource reaches offshore, while `FLOW_DISPLAY_EXTENT` intentionally stops at the Yangtze estuary. | Keep source coverage and business display coverage as different facts. Virtual source bounds may include every station, but sampling support and presentation mask must enforce the accepted display extent independently at every LoD and fallback level. | Exact `FLOW_DISPLAY_EXTENT`, visible west-of-boundary field, no sampled near-sea leakage east of the estuary boundary, and no accidental crop of source data. | Never use virtual source bounds as display bounds. Remove old display-mask code only after the virtual support/mask plane proves exact parity. | Existing `flow-estuary-boundary.png` machine sampling plus multi-LoD/fallback boundary tests. |
| Current lifecycle owns Worker, MapLibre, runtime, frame scheduling, and pending SubmittedWork; diagnostics are bounded. | Extend the same authority to virtual source requests, residency settlement, feedback readbacks, and temporal-plane prefetch. Stop request production first, abort/debounce loaders, drain issued submissions/readbacks, dispose residency/GPU state, then release runtime/map. | At-most-once disposal, primary failure preservation, bounded diagnostics, zero uncaptured errors/device loss, and process/port cleanup. | Delete old whole-field pending-map bookkeeping only when page request lifecycle supplies equivalent cancellation and failure facts. Do not add a second runtime or scheduler. | Normal, loader failure, invalid WGSL, stale page response, page-service loss, and disposal-during-load scenarios all converge with zero retained work. |

## Completion Boundary For The Next Goal

The next Flow goal is complete only when the visible `flowLayer` page uses canonical
high-precision particle state and a temporal virtual vector raster end to end, every
old viewport Voronoi/whole-field path listed above is deleted, the estuary boundary and
history motion parity gates pass, and long-run page/diagnostic/lifecycle facts remain
bounded. Keeping both old and new field paths behind flags is not an acceptable 0.x
target state.

This document is the stopping point for the current goal. It does not authorize the
visible migration here.
