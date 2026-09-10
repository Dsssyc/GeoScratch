# Terrain cover placement experiment

This opt-in harness runs the real Underwater Terrain application, Worker source,
Virtual Raster publication, indexed terrain shader and frame controller. The default
`cpu-production` mode uses the production CPU renderer directly, with no selector
substitution or unused GPU compute allocations. `gpu` replays the frozen historical
renderer and proof from the commit in `tests/fixtures/camera-cover-gpu-reference.json`.
The served renderer hash is recorded separately from current checkout provenance.
The pre-rebase audited history is retained on
`socu/camera-cover-before-rebase-b9f25bd`. A shallow/single-branch checkout may need
`git fetch origin socu/camera-cover-before-rebase-b9f25bd` before replaying historical
commit IDs. The frozen implementation hashes are unchanged by rebase.
Older CPU variants remain explicitly experimental historical comparisons; their
original GPU objects stay allocated and their startup memory is not a production
CPU measurement. No execution mode is added to the production application/API.

Run from the repository root, with dependencies, existing Worker artifacts and
`examples/underwaterTerrain/tile-server/cache/{manifest.json,dem.cog.tif}` available:

```sh
node tests/experiments/terrain-cover-placement/run.mjs cpu-production performance
node tests/experiments/terrain-cover-placement/run.mjs cpu-production render
node tests/experiments/terrain-cover-placement/run.mjs cpu-production streaming
node tests/experiments/terrain-cover-placement/run.mjs cpu-production lifecycle
TERRAIN_PLACEMENT_SECONDARY_DISPLAY=1 TERRAIN_PLACEMENT_BITS=52 node tests/experiments/terrain-cover-placement/run.mjs cpu-production performance
node tests/experiments/terrain-cover-placement/run.mjs gpu performance
node tests/experiments/terrain-cover-placement/run.mjs gpu-eager reveal
node tests/experiments/terrain-cover-placement/run.mjs cpu-cover performance
node tests/experiments/terrain-cover-placement/run.mjs cpu-all performance
node tests/experiments/terrain-cover-placement/run.mjs cpu-all render
node tests/experiments/terrain-cover-placement/run.mjs cpu-all streaming
node tests/experiments/terrain-cover-placement/run.mjs gpu lifecycle
node tests/experiments/terrain-cover-placement/run.mjs gpu reveal
node tests/experiments/terrain-cover-placement/run.mjs cpu-all reveal
TERRAIN_PLACEMENT_BITS=52 node tests/experiments/terrain-cover-placement/run.mjs shadow render
TERRAIN_PLACEMENT_TILE_DELAY_MS=80 node tests/experiments/terrain-cover-placement/run.mjs cpu-all performance
TERRAIN_PLACEMENT_FEEDBACK_DELAY_MS=40 node tests/experiments/terrain-cover-placement/run.mjs gpu-eager reveal
TERRAIN_PLACEMENT_HOST_PROFILE=1 node tests/experiments/terrain-cover-placement/run.mjs gpu performance
TERRAIN_PLACEMENT_HOST_TIMING=1 node tests/experiments/terrain-cover-placement/run.mjs gpu performance
TERRAIN_PLACEMENT_SECONDARY_DISPLAY=1 TERRAIN_PLACEMENT_BITS=52 node tests/experiments/terrain-cover-placement/run.mjs gpu performance
TERRAIN_PLACEMENT_SUBMISSION_BASELINE=006c7d2 TERRAIN_PLACEMENT_BITS=52 node tests/experiments/terrain-cover-placement/run.mjs gpu performance
```

Run benchmark processes serially. `TERRAIN_PLACEMENT_OUTPUT` optionally selects an
output directory; otherwise each run creates a separate temporary directory.
Pinned MapLibre 4.7.1 assets are fetched from the example's existing CDN and hashed.
An owned headless Chrome, Vite and read-only existing-data tile service are closed
after each run. The runner never builds backend data or touches an existing browser.
It verifies production/Flow source and backend data hashes before/after execution.

Modes:

- `cpu-production` (default): current certified CPU cover, CPU source intent and
  revisioned uploads/receipts. Indexed arguments are CPU-produced; only the terrain
  draw is a GPU pass. Resource/native readiness remain asynchronous.
- `gpu`: frozen `ebb3336` GPU renderer with its matching historical proof and gate
  assertions. It uses the unchanged reference kernels in the current checkout.
- `gpu-original`: replay renderer source from `117af0b` to retain the original
  comparison after production scheduling changes. This requires that Git object.
- `gpu-eager`: against the same pinned renderer, keep all currentness checks but start
  asynchronous feedback consumption without waiting for a newer frame submission.
- `gpu-observed`: against that renderer, additionally reconcile monotonically newer complete source-demand
  observations with their original view provenance. Old observations cannot update
  current geometry/readiness, and active retained requests participate in settlement.
- `cpu-cover`: historical experimental CPU cover plus fresh Scratch uploads; existing GPU source demand and
  delayed feedback remain. Actual upload-to-draw epochs are validated.
- `cpu-all`: historical experimental CPU cover and CPU source intent. Geometry is uploaded through Scratch,
  and request reconciliation consumes current CPU intent without a GPU readback.
  Native rendering/publication acknowledgement remain asynchronous and separate.
- `shadow`: render the original GPU result while comparing CPU output against ordered
  same-submission patch, lookup, state and source-demand readbacks. This is a
  correctness workload and has additional CPU/readback costs.

`performance` runs shaded and wireframe 90-frame camera traces, first without query
instrumentation and then with GPU pass timestamps on every seventh frame. CPU
construction, asynchronous native observation, GPU pass duration, first executor
request and acknowledged selected-resource readiness are separate measurements.
`feedbackAdoptionCpuMs` times historical GPU feedback reconciliation/state adoption separately;
production CPU adoption is included in construction and has no separate feedback callback. The historical metric
it excludes GPU waits, mapping/decoding and Worker work, and is not total main-thread CPU.
The readiness poll is every 20 ms. It must observe the **current** converged cover,
selected resident demands, acknowledged publication, and drained scheduling/staging;
previously seeing a converged cover is insufficient. Do not sum cross-scope medians.

`TERRAIN_PLACEMENT_HOST_PROFILE=1` records a DevTools CPU sampling profile at a
requested 100 microsecond interval in `host.cpuprofile`, after initial application
readiness and through the scenario. It includes page-side camera, submission,
feedback and proof work, but not Worker CPU or native GPU execution. Use it to
attribute main-thread work; compare latency using separate runs with profiling
disabled. Sampling and timestamp instrumentation can change scheduling and costs.

`TERRAIN_PLACEMENT_HOST_TIMING=1` adds inclusive function and native-call timers
only in the isolated source transforms. The frame boundary is the synchronous
`graph.render()` call, matching the construction metric; later callbacks and proof
DOM publication are excluded. `hostScopes` reports per-frame sums and call counts
for each trace, including its final settlement frames; production CPU scopes also report selection, demand projection and upload/receipt work. Parent/child scopes overlap
and must not be summed. Native timings measure synchronous API calls, not GPU work
or transfer completion. Timer resolution produces zero-duration samples; use the
aggregate attribution and verify improvements with both host probes disabled.

The performance/reveal suites also record DevTools `TaskDuration` and its script,
layout and style subsets across the complete scenario. These are page-main-thread
task times, including MapLibre, proof publication and asynchronous callbacks; they
exclude Worker CPU and GPU duration. They are not isolated terrain CPU time, and
the subsets must not be added to `TaskDuration`.

`TERRAIN_PLACEMENT_SECONDARY_DISPLAY=1` runs only the performance suite. On macOS it
requires a connected non-main display of at least 100 Hz with room for the whole
window. It launches a dedicated temporary Chrome using `open -g`, verifies window
bounds and foreground preservation, uses its single existing page, then verifies
placement again and closes only that owned process/profile. It never changes
display settings or uses existing Chrome windows. Actual rAF intervals determine
the observed cadence; a display's advertised refresh rate is not an FPS result.
Camera lag is measured from the preceding issued pose to the last submitted pose,
separately from capture-revision lag and the two-frame in-flight bound.

`TERRAIN_PLACEMENT_SUBMISSION_BASELINE=<commit>` substitutes only the three diagnostic
implementation modules changed by the host optimization, from the explicit Git
commit. Served baseline hashes are recorded separately from checkout hashes. This
allows interleaved before/after runs without resetting a shared checkout; the cover,
renderer, scheduling, shaders and proof instrumentation remain identical. It is
intentionally bounded to this diagnostic comparison, not a general version switch.

`render` and `streaming` reuse the repository's existing browser-gate assertions.
`lifecycle` reuses the native terrain construction, provenance, rapid-camera and
failure-cleanup gate. Its residency audit requires exact accounting of retired
staged pages, zero rejected stale staging/failure attempts, and zero unrequired uploads.
`reveal` starts continuous camera motion before new fine resources have loaded and
counts source requests issued during motion versus only after the camera stops.
`TERRAIN_PLACEMENT_FEEDBACK_DELAY_MS` delays GPU feedback consumption before mapping
for a bounded stress test. It is separate from network delay and is not a GPU timer.
Adapters remove their backend build/service startup and change only the expected
producer location, CPU upload count and explicitly selected coordinate bits. The
owning runner independently checks actual process cleanup. GPU stage names or GPU
feedback tags are not fabricated for CPU-origin observations.

The CPU prototype keeps exact standard integer identity, conservative candidate
preparation, independent parents, indexed 2:1 closure and final quality revocation.
It uses JS f64 projection over f32 facts; matching finite scenes does not prove
universal equivalence at floating-point thresholds. It allocates temporary objects
and is not an optimized CPU lower bound. Current terrain defaults to 40-bit
coordinates; `TERRAIN_PLACEMENT_BITS=52` explicitly tests the supported higher
precision without changing backend tile identity or data.

This harness intentionally uses strict source anchors and fails when they drift.
Its integration substitutions are experimental, not a proposed public interface.
ADR-129 and the canonical view-cover/terrain APIs define the production CPU product,
upload ownership, failure handling and disposal contract. Historical substitutions
are retained only for bounded comparisons. Geometry never
depends on raster residency; complete selected resource intent includes resident pages.

The harness never changes production source or backend data. Removing it does not
change the production CPU renderer; frozen GPU reference APIs and standalone native
consistency fixtures remain independently usable.
