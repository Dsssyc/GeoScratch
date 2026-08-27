# Geo Virtual Raster Flow Readiness

## Review Status

The reusable coordinate and virtual-raster foundation remains executable after the
ADR-056 Worker, demand, cache, ownership, and WebMercator enhancements. A headed
WebGPU proof advances 262,144 canonical dynamic positions while sampling a three-LoD,
multi-page virtual vector field through the same public Geo and Scratch APIs used by
DEM. This review does not modify or migrate the visible `examples/flowLayer` page.

The visible-migration matrix below was revised on 2026-08-27 by ADR-090. `Flow Layer`
remains frozen reference code; the independent `Flow Field` example owns a velocity-only
Virtual Raster path. The normal payload has no support/mask plane. Non-advectable support is
lowered conservatively to exact zero U/V by the example-owned builder, while presentation
extent remains an application policy.

## Executable Proof Facts

`tests/fixtures/geo-virtual-raster-dynamic-flow.ts` establishes this data path:

```text
cell-local-f32 canonical position
    -> explicit simulation sampling LoD
    -> immutable VirtualRasterSnapshot
    -> compute-stage logical bilinear sample with parent fallback
    -> local vector displacement
    -> carry/borrow normalization into the next canonical position
    -> bounded publication acknowledgement and staging release
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
| Residency/staging accounting | 98,304 resident GPU bytes; 163,840-byte staging budget; zero staging bytes after acknowledgement |
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
- ADR-056 ownership changes do not narrow 1D/2D/3D virtual addressing or force a
  WebMercator identity onto non-map simulation fields.

It does not establish final Flow visual parity, production field tiling, temporal
streaming, prediction feedback, camera-driven render LoD, Flow Worker scheduling, or
Flow cache policy. Those are the bounded scope of the next clean-cut goal.

The future source must use the generic `WorkerSystem` rather than retain a Flow-only
pool. Immutable time slices may use revisioned cache keys; live or editable slices
must keep dirty working state outside cache. Source coverage and the accepted
`FLOW_DISPLAY_EXTENT` remain independent facts at every requested and fallback LoD.

## Next Flow Clean-Cut Matrix

| Current path | Complete target model | Behavior that must remain | Exact replacement/deletion | Required gate |
| --- | --- | --- | --- | --- |
| `flow-layer.ts` builds D3 station triangulation, expands station velocities, and runs `flowVoronoi.wgsl` into viewport-sized velocity/mask textures every frame. | Keep that page frozen. The separate `Flow Field` source builder creates one typed inferred Delaunay topology, directly samples every WebMercatorQuad level, and publishes only immutable RG32F U/V pages. | Exact zero is non-advectable presentation support; inferred topology is recorded rather than claimed as physical mesh connectivity. | Do not delete or import `Flow Layer`. Flow Field independently composes the public Virtual Raster runtime and example-owned temporal/particle products. | Source/page hashes, complete page-set identity, duplicate policy, cross-page support filtering, all-level reconstruction QA, and zero Flow Layer source changes. |
| `flow-worker.ts` fetches 27 whole `uv_N.bin` arrays; `flow-layer.ts` keeps two expanded arrays and changes them every 300 frames. | Represent all 27 slices as a temporal auxiliary axis in a `VirtualRasterStack`. Keep two time-plane residency views plus a bounded prefetch window. Sample both logical planes at the same canonical position and interpolate with the existing `progressRate`. | Exactly 27 slices, initial 0/1 load, prefetch/rotation order, 300-frame phase duration, interpolation progress, monotonic maximum speed, and deterministic failure propagation. | Delete whole-field Worker transfers and `expandStationVelocities()` after the tile source owns temporal pages. If decode remains asynchronous work, run it through public `WorkerSystem` with bounded page payloads, explicit revisioned cache policy, and no Flow-only pool. | Two complete 27-slice cycles with exact indices/progress, bounded resident temporal pages, no whole-field transfer, cache/revision facts, and no cadence regression. |
| Current simulation, drawing, and requests share camera/map bounds and have no field LoD hierarchy. | Keep simulation, render-demand, and resolved-residency levels observable and distinct in Flow Field. Camera changes request priority but not canonical particle truth. | Particle count, absorbing zero-speed death, bounded spawning, display extent, and frame scheduling. | Flow Field uses explicit sampling intent and Geo snapshot facts without changing the frozen reference. | Camera pan/zoom and fallback runs retain canonical positions, expose requested/resolved levels, and compare each level with the recorded source reconstruction facts. |
| Current requests know only camera-visible field state; dynamic particle movement has no tile prediction. | Bin particles transiently by logical page/cohort on GPU. Per workgroup, reduce current bounds, velocity extrema, and predicted displacement over a finite horizon. Compact unique page-plus-halo requests into a bounded feedback buffer; read it back at a throttled submission boundary or consume it in a GPU-driven request planner when available. Halo width derives from filter footprint plus `ceil(maxSpeed * horizon / pageWorldExtent)` and includes both active temporal planes and parent fallback. | No per-frame CPU particle mirror and no per-particle global atomic request. Misses must fall back without holes while later snapshots converge. | Add bounded Geo request-feedback plumbing only if required by measured Flow behavior. Never persist full virtual addresses or materialize one address per particle by default. | High-speed page-crossing run with measured miss/fallback convergence, bounded unique requests/history/readback cadence, workgroup deduplication, and no unbounded queue. |
| Particle state is six global f32 values: current lon/lat, previous lon/lat, and velocity. Spatial grouping is implicit and camera-bound. | Store current and previous positions as canonical `cell-local-f32` (or `wide-fixed` where its range/quantum contract is required) plus basis/unit-aware local velocity. Tile split/merge changes only transient cohort/bin membership and dispatch ranges. Rebase/normalize uses integer carry/borrow; page identity is reconstructed only while sampling. | 262,144 particles, rebirth/drop semantics, previous/current segment rendering, velocity color, optional arrows, and deterministic proof seed. | Delete the six-float global-coordinate ABI in `simulation.compute.wgsl`, `particles.wgsl`, and `arrow.wgsl`; replace it with a documented canonical position layout shared by compute and vertex accessors. Delete any CPU initialization that fills world positions as normalized/global f32 after the new GPU initialization path passes. | Repeated cell/page crossings, cohort split/merge, eviction, camera rebase, and LoD changes preserve canonical position within codec error bounds and never add CPU mirroring. |
| `swap.wgsl` reprojects two viewport history textures from previous/current high-low camera facts. | Flow Field independently retains viewport history, reverse-gather reprojection, decay/cutoff, camera facts, and single-frame backpressure. History clears when sampled U/V is unavailable or non-advectable; no virtual mask is introduced. | `off`/`clear`/`reproject`, camera move/settle behavior, resize behavior, and cadence remain presentation concerns. | Do not alter the frozen Flow Layer history path. Flow Field owns its own history composition over the velocity-only sample. | Flow Field history lifecycle, reprojection, resize, and terminal cleanup tests. |
| The complete station resource reaches offshore, while `FLOW_DISPLAY_EXTENT` stops earlier. | Keep source coverage, inferred topology support, dynamic advectable support, and business presentation coverage as separate facts. The backend never bakes the application display extent into source pages. | Full source coverage is retained without claiming it is the desired visible business extent. | Flow Field applies presentation exclusion at runtime; no display-mask payload is added. | Source coverage tests plus independent presentation-extent tests at requested and fallback levels. |
| Current lifecycle owns Worker, MapLibre, runtime, frame scheduling, and pending SubmittedWork; diagnostics are bounded. | Extend the same authority to virtual source requests, residency settlement, feedback readbacks, and temporal-plane prefetch. Stop request production first, abort/debounce loaders, drain issued submissions/readbacks, dispose residency/GPU state, then release runtime/map. | At-most-once disposal, primary failure preservation, bounded diagnostics, zero uncaptured errors/device loss, and process/port cleanup. | Delete old whole-field pending-map bookkeeping only when page request lifecycle supplies equivalent cancellation and failure facts. Do not add a second runtime or scheduler. | Normal, loader failure, invalid WGSL, stale page response, page-service loss, and disposal-during-load scenarios all converge with zero retained work. |

## Completion Boundary For The Next Goal

The next Flow goal applies to the independent `Flow Field` example. It does not migrate or
delete the frozen `Flow Layer` path. Completion requires velocity-only temporal Virtual Raster
sampling, conservative support behavior, explicit source and presentation extents, all-level
numerical evidence, and bounded page/diagnostic/lifecycle facts in Flow Field itself.

This document is the stopping point for the current goal. It does not authorize the
visible migration here.
