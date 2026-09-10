# Terrain cover placement experiment

This opt-in experiment runs the real Underwater Terrain application, Worker source,
Virtual Raster publication, indexed terrain shader and frame controller. It serves
temporary Vite source substitutions. It changes no production files or public API,
and is not a supported alternative renderer. The original GPU objects remain
allocated in CPU variants to hold setup/consumer interfaces constant; startup memory
is therefore not a measurement of a finished CPU design.

Run from the repository root, with dependencies, existing Worker artifacts and
`examples/underwaterTerrain/tile-server/cache/{manifest.json,dem.cog.tif}` available:

```sh
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
```

Run benchmark processes serially. `TERRAIN_PLACEMENT_OUTPUT` optionally selects an
output directory; otherwise each run creates a separate temporary directory.
Pinned MapLibre 4.7.1 assets are fetched from the example's existing CDN and hashed.
An owned headless Chrome, Vite and read-only existing-data tile service are closed
after each run. The runner never builds backend data or touches an existing browser.
It verifies production/Flow source and backend data hashes before/after execution.

Modes:

- `gpu`: current production selection and demand execution.
- `gpu-original`: replay renderer source from `117af0b` to retain the original
  comparison after production scheduling changes. This requires that Git object.
- `gpu-eager`: against the same pinned renderer, keep all currentness checks but start
  asynchronous feedback consumption without waiting for a newer frame submission.
- `gpu-observed`: against that renderer, additionally reconcile monotonically newer complete source-demand
  observations with their original view provenance. Old observations cannot update
  current geometry/readiness, and active retained requests participate in settlement.
- `cpu-cover`: CPU cover plus fresh Scratch uploads; existing GPU source demand and
  delayed feedback remain. Actual upload-to-draw epochs are validated.
- `cpu-all`: CPU cover and CPU source intent. Geometry is uploaded through Scratch,
  and request reconciliation consumes current CPU intent without a GPU readback.
  Native rendering/publication acknowledgement remain asynchronous and separate.
- `shadow`: render the original GPU result while comparing CPU output against ordered
  same-submission patch, lookup, state and source-demand readbacks. This is a
  correctness workload and has additional CPU/readback costs.

`performance` runs shaded and wireframe 90-frame camera traces, first without query
instrumentation and then with GPU pass timestamps on every seventh frame. CPU
construction, asynchronous native observation, GPU pass duration, first executor
request and acknowledged selected-resource readiness are separate measurements.
`feedbackAdoptionCpuMs` times synchronous reconciliation/state adoption separately;
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
for each trace, including its final settlement frames. Parent/child scopes overlap
and must not be summed. Native timings measure synchronous API calls, not GPU work
or transfer completion. Timer resolution produces zero-duration samples; use the
aggregate attribution and verify improvements with both host probes disabled.

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
Formal adoption still needs a single geometry-product/lowering contract, complete
construction/failure ownership tests and bilingual API/ADR updates. Geometry never
depends on raster residency; complete selected resource intent includes resident pages.

Revert the experiment commit to remove this harness. The production renderer remains
the GPU implementation before and after running it.
