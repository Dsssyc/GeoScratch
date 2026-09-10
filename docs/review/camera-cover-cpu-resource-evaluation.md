# Camera cover execution and asynchronous resource observation

Date: 2026-09-09; integrated evaluation and GPU-feedback correction updated 2026-09-10.
Initial production source was `d6e2e9e`; integration experiments started from `e318dc6`.
The first experiments left production unchanged. The subsequent feedback correction is
implemented under ADR-128. Historical measurements below retain their original scopes.

## Recommendation

**Keep the production GPU selector and repair feedback/resource progress first.**
The earlier recommendation of CPU cover plus CPU source intent was too strong: its
largest advantage was measured against a GPU feedback policy which prevented loading
during continuous motion. Correcting that policy also restores GPU-path request progress.
The CPU alternative remains useful for performance comparison, not a proven optimum.

GPU-origin usage, missing-page observations and procedural results can feed bounded
asynchronous CPU reconciliation. CPU-owned allocation and upload decisions need not
make a GPU round trip before the CPU can schedule resources. Geometry execution
location, source-demand execution location and persistent resource storage are
separate choices.

The evidence establishes a useful integrated CPU alternative. It does **not** establish
a universal frame-time winner: the CPU prototype has numerical and integration limits, and its
individual-call timings vary substantially. MapLibre's hot-loop timings cannot be
promised for GeoScratch's stronger geometry contract. Optimizing Scratch's repeated
host bookkeeping is useful independently of the cover placement decision.

## GPU feedback correction, 2026-09-10

The new experiments separate three changes rather than attributing every improvement
to CPU selection:

| GPU strategy | Normal continuous motion | With 40 ms feedback-consumer delay |
| --- | --- | --- |
| Original newer-frame wait + current-view-only resource adoption | 0 new detail requests during motion | original policy |
| Begin mapping after its own submission, retain old adoption rule | 18 requests during motion; first about 36 ms | 0 during motion; first about 1,604 ms |
| Independently accept newer complete resource observations | request progress retained | 18 during motion; first about 66 ms |

The synthetic consumer delay is not a GPU kernel timer. Source/coverage and output
validation remain intact; only complete observations advance the monotonic resource
target. Current geometry and current-view readiness still require matching decisions.
Retained active requests carry their actual completion promise into frame settlement.

The first resource-observation experiment still polled when readback capture capacity
was full. A 1,000 ms delayed-consumer run eventually converged but rendered 40 additional
frames after motion stopped. The production correction replaces that waiting with one
latest-frame settlement, awakened by released capture capacity. Replaced waiters settle
without retaining history; errors/disposal reject or release the current waiter. A
current observation requests one confirmation/publication frame, and resource completion
uses its existing asynchronous wakeup. The same long-delay test then needed four extra
frames, with all 18 requests started during motion and successful final cleanup. No frame
budget was increased and no generic frame-controller or Worker API was introduced.

Rapid motion has a measurable cost: some successfully decoded pages become irrelevant
before publication. An initial lifecycle gate incorrectly treated every increment of
`staleResponseCount` as invalid staging. The existing counter also includes valid staged
retirement, as demonstrated by the existing residency implementation and focused tests.
The native proof now independently observes stage, generation and publication boundaries.
It requires zero rejected stale staging/failure operations, zero uploads outside the
resource target, exact accounting of retired stages, and the real staging-byte budget.
It does not zero the production counter or merely ignore it.

In the final lifecycle run, A-B-A retired one staged page (64 KiB); the following rapid
84-step sequence brought the total to 17 pages (1,114,112 bytes). All retired bytes were
released before publication. Rejected stale operations and unrequired uploads stayed
zero. Earlier runs retired 4 and 20 cumulative pages respectively, showing the timing
dependence of this cancellation cost. The full lifecycle, render and streaming gates
pass with these stronger distinctions.

The accepted behavior and ownership rules are recorded in
[ADR-128](../decisions/ADR-128-terrain-feedback-and-resource-progress.md), the bilingual
terrain API, and AGENTS.md. The generic Virtual Raster documentation clarifies its
existing stale-counter meaning. GPU geometry/quality, source data, atlas ownership,
Worker protocol and frozen Flow Layer are unchanged.

New evidence is under `/tmp/geoscratch-feedback-timing/`: `eager-reveal/`,
`eager-delay40/`, `observed-delay40/`, `observed-streaming/`, `observed-delay1000/`,
`production-delay1000/`, `production-render/`, `production-streaming/`,
`lifecycle-final/`, and the final paired performance runs. The experiment runner can
replay renderer source from `117af0b` as `gpu-original`, `gpu-eager` and `gpu-observed`
to preserve the comparisons after production changes.

Focused regressions cover first-frame mapping, A-B-A provenance, retained work,
invalid feedback, bounded latest waiting and disposal. The native cover proof also
passes at DPR 1/2, including overflow/quality failure and complete-cut checks.
Typecheck, build and the full test suite pass: 1,734 tests, two opt-in pending.

Final paired 90-move traces used the same current scheduling and proof instrumentation
for production GPU versus the CPU experiment:

| Scope, p50 | Corrected GPU | CPU cover + CPU source intent |
| --- | ---: | ---: |
| Shaded CPU construction | 1.8 ms | 2.2 ms |
| Shaded synchronous feedback adoption | 0.1 ms | 0.1 ms |
| Shaded native observation | 7.2 ms | 6.5 ms |
| Wireframe CPU construction | 1.9 ms | 1.9 ms |
| Wireframe synchronous feedback adoption | 0.1 ms | 0.1 ms |
| Wireframe native observation | 8.1 ms | 7.4 ms |

The single cold move issued its first request at about 24 versus 12 ms, but selected
resources were acknowledged at about 148 versus 150 ms, within the 20 ms polling
resolution. These are separate scopes, not additive medians or an FPS prediction.
Feedback adoption timing excludes mapping/decoding/Worker work. CPU retains some
measured latency advantage while GPU avoids additional CPU geometry work; neither
is a universal optimum. The immediate production benefit is the feedback correction,
which does not require replacing the geometry authority or resource infrastructure.

Checkpoints: `295893e` adds the feedback-strategy comparisons, `286097d` adds explicit
retirement auditing, and `610fe13` implements ADR-128. To undo this correction, first
revert the later comparison/review update, then revert `610fe13`, `286097d`, and
`295893e` in that order. Do not reset a shared checkout. The earlier CPU experiment
commits remain independently removable after their review links are reverted.

## Integrated terrain results, 2026-09-10

The [opt-in experiment](../../tests/experiments/terrain-cover-placement/README.md)
now runs the real Underwater Terrain application, MapLibre frame driver, two-frame
admission policy, Scratch uploads and epoch validation, Worker/network/decode phases,
Virtual Raster ownership/publication, terrain sampling, indexed draw and native
acknowledgement. Temporary Vite source substitutions select one experimental producer
per run. CPU observations carry explicit experimental tags, and upload-to-draw
provenance uses actual submitted producer epochs. No production selector switch or
public contract was added.

Three execution variants were measured:

- Current GPU cover and GPU source demand.
- CPU cover with fresh metadata/patch/lookup/state uploads, retaining GPU source
  demand and delayed readback.
- CPU cover plus CPU source intent, using the existing demand producer/scheduler
  immediately after the complete CPU product enters a valid submission. Raster
  publication still waits for native acknowledgement; CPU intent is not GPU-ready
  evidence. The separate GPU patch-draw adapter remains in this experiment.

### Continuous motion reveals the largest practical difference

A fresh instance first settles its initial zoom-9 view. It then enters a pitched
zoom-10.25 view with unloaded fine pages and issues 90 camera moves over about
1.5 seconds. Source requests are recorded at the real request executor boundary.

| Observation | Current GPU path | CPU cover + CPU source intent |
| --- | ---: | ---: |
| New detail requests during motion | 0 | 18 |
| New detail requests after motion | 18 | 0 |
| First executor request from motion start | about 1,529 ms in the final matched-camera run | about 32 ms in that run |
| All selected resources acknowledged while moving | not reached | about 163 ms in that run |
| Remaining readiness wait after motion stops | about 168 ms | about 21 ms including final camera admission |

The zero-versus-18 request result repeats. Earlier probes did not wait for admission
of the final requested camera pose and reported an effectively zero post-motion CPU
wait; the final probe checks the observed camera explicitly. This is not a statement that GPU traversal
inherently cannot stream during motion. The current renderer deliberately waits for
a newer frame before consuming GPU feedback, then rejects feedback whose decision
serial is no longer current. Continuously changing camera facts make each observed
decision obsolete by that point. Geometry still draws correctly through existing
raster fallback; current detail discovery is what waits for the camera to stop.
See `startFeedbackPump`, `drainReadyFeedback` and `settleConsumedFeedback` in the
[terrain renderer](../../packages/geoscratch/src/geo/web-mercator-terrain-renderer.ts).

The CPU-intent experiment can reconcile the current decision before the next camera
update, retaining current resident pages and in-flight requests. It does not remove
stale-source/slot checks or make previous topology authoritative. A future GPU-retaining
alternative would need an explicit policy for useful past-view resource observations;
simply deleting the currentness checks would not be a safe substitute.

### Full-frame costs are a tradeoff

The warm 1280×800, pitch-70, zoom-10.25 traces each report 69 patches at levels 8–12. Each mode
runs shaded and wireframe 90-move traces. CPU/native observation timing is collected
without timestamp queries; separate traces sample GPU passes every seventh frame.

| Variant | CPU construction p50, shaded / wireframe | Native observation p50, shaded / wireframe |
| --- | --- | --- |
| GPU, two baseline observations | 1.5–1.7 / 1.7–1.8 ms | 9.3–9.5 / 8.9–10.3 ms |
| CPU cover only | 2.1 / 2.1 ms | 9.2 / 8.6 ms |
| CPU cover + source intent | 1.9 / 1.8 ms | 7.5 / 9.4 ms |

The original GPU cover pass costs approximately 1.6–2.5 ms in these sampled real
terrain traces; source projection adds approximately 0.25–0.37 ms. CPU substitution
removes those passes, but terrain drawing alone varies around 6–10 ms and CPU
construction can increase. There is no consistent wireframe latency win. These
small sample sets do not establish device-independent speed ratios, and native
observation includes asynchronous scheduling rather than pure GPU execution. The
headless host cadence is approximately 60 Hz, not a new 120 Hz throughput proof.

### Resource completion when the camera stops

For a single move into unloaded detail, representative runs issue the same 18 new
requests:

| Variant | First executor request | Acknowledged selected-resource readiness |
| --- | ---: | ---: |
| GPU | about 28–32 ms | about 190–197 ms |
| CPU cover only | about 33 ms | about 199 ms |
| CPU cover + source intent | about 6 ms | about 153 ms |

With an artificial 80 ms request delay, GPU and CPU-intent readiness are about
1,004 and 997 ms respectively. The readiness poll is 20 ms, so that difference is
not meaningful evidence of a readiness improvement. Earlier discovery does not
remove network/decode cost. The continuous-motion result is stronger because
resource production can overlap the user's motion instead of starting afterward.

### Integrated correctness and cleanup

- The CPU-intent variant passes the existing terrain rendering gate: wide top-down
  symmetry, canonical zoom/approach cases, pitch transitions, native wireframe,
  shaded/wireframe 90-frame tracking, A-B-A, 2:1, DPR invariance and pixel checks.
- It passes the full streaming gate: cold/warm persistent cache, tight atlas budget,
  selected resident retention, terminal missing page, cancellation/late results,
  eviction churn, reload and repeated disposal. Worker phase bounds remain network
  2 / decode 1 and terrain admission remains two frames.
- A 52-bit shadow run keeps the GPU renderer authoritative while checking the CPU
  cut, all state words, effective lookup and source-demand records against same-
  submission GPU observations, including the rendering/DPR gate. It passes. The
  current example itself defaults to 40 bits; the experiment explicitly tests both
  actual configuration and 52-bit support without changing backend identity/data.
- Browser, Vite, tile service, readbacks and owned resources are released. Production
  source, frozen Flow source and existing COG/manifest hashes are unchanged.
- `npm run typecheck`, `npm test` (1,722 passing, two opt-in pending) and
  `npm run build` pass. Build retains the existing large-chunk warning.

Two measurement/prototype defects were found and corrected before accepted results.
The initial CPU helper assumed 52-bit input while terrain supplied 40-bit metadata,
producing an empty cut; the helper now reads the actual profile precision and exact
minimum geometry domain. Also, a first readiness probe latched an earlier successful
cover and could finish during a later publication's transition. It now requires a
currently converged cover and acknowledged selected-resource state. The first
incorrect A-B-A observation from that probe is excluded.

These are finite integration proofs. General floating-point threshold equivalence,
all possible address domains, a finalized typed CPU-product API, CPU-specific failure
injection at every new allocation boundary and a native 120 Hz proof remain necessary
before shipping a replacement. The experiment retains unused original GPU objects
to keep setup and existing consumer interfaces stable, so its startup memory is not
the budget of a finished CPU implementation. It introduces no second live geometry
selector outside the explicitly instrumented shadow comparison.

### Reproduction and rollback

Run the commands in the experiment README serially. Each invocation writes source,
data and experiment hashes, native observations, results and process cleanup facts
to a separate output directory. It never builds backend data. Results used here are
under `/tmp/geoscratch-terrain-placement/`, including `gpu-full-0.json`,
`cpu-cover-full-0.json`, `cpu-all-full-0.json`, the `*-full-80.json` runs,
`repo-run-cpu/`, `repo-streaming/`, `repo-shadow52/` and the `reveal-*` directories.
One early repeated reveal also overlapped Node tests and is used only to confirm
request ordering; the final reveal reruns are isolated from build/test work.

The experiment reference is commit `2a918d3`; the real-application runner and gates
are commit `5241c16`. To roll back, first revert the commit adding this integrated
results section, then `git revert 5241c16`, then `git revert 2a918d3`. This removes
only opt-in tests and their review. Production remains on
the existing GPU renderer. A formal CPU transition must update English/Chinese
canonical cover/terrain APIs, its accepted ADR and ownership/failure tests together.

## Measurement boundaries

All new browser experiments used isolated headless Chrome 152.0.7977.83 on the same
M1 Max host. Native upload and the second feedback run explicitly report Apple
Metal and a non-fallback adapter. Experiments were serialized rather than running
competing benchmark browsers. Timers have finite resolution, and JIT, allocation,
GC, scheduling and power state can influence results.

The earlier approximately 1.294 ms GPU cover pass at pitch70-z10 remains a bounded
historical measurement. It is not a fresh full-render benchmark. Its approximately
0.6 ms host construction scope includes CPU view preparation and Scratch submission.
The later 0.050–0.065 ms raw replay included upload, two encoders, two dispatches,
readback-copy recording, two submits, native error scopes and completion-notification
creation. It was neither a single `submit()` measurement nor a WebGPU cost floor.

CPU hot-batch averages, individual calls separated by tasks, GPU execution duration,
host issue duration and asynchronous observation latency are different measurements.
Do not add medians from these experiments as an observed critical path or infer FPS
from them.

## CPU selection experiment

The experimental port consumes the actual 656-byte GPU metadata upload. It preserves
bounded candidate domains, complete coarse seeding, exact-parent/four-child decisions,
deterministic replacement and visibility compaction, full-identity neighbor indexing,
immutable-round 2:1 closure, failure revocation and final plane/volume quality checks.
It does not substitute MapLibre's distance selector or world-root traversal.

The `prepare-and-gated` measurement also executes the current `mapMetaRecord`
candidate/inverse-residual proof and camera packing, using the existing layout codec.
Prepared metadata is byte-compared with the actual upload. Parent gating skips
expensive predicates for candidates whose exact parent did not refine; it still
enumerates the complete domain and does not stop searching outward regions.

**77/77 cases** match ordered patch identities, all 11 state words including Q8,
occupied flags and every effective lookup entry. Cases include pitch 0–85 degrees,
movement, zoom, height-volume crossings, wide views/FOV, A-B-A, z24 millimetre motion,
empty/overflow/unbounded results and recovery, and bounded-versus-full candidate
enumeration. GPU empty hash slots retain ignored fields, so equality of all backing
bytes is neither required nor claimed. Two initial prototype overflow-counter
discrepancies were corrected before this result; production code was unaffected.

Three scenarios reproduce the earlier benchmark's geometry policy and matrices:
levels 0–14, maximumPatches 512, 128 cells, five reference pixels, tolerance .005,
height interval [-120,30], FOV pi/3 and 52-bit addresses. The proof fixture uses a
larger candidate capacity than production, but these domains fit both capacities
and their uploaded candidate windows are identical.

| Scenario | Patches | Candidate count | CPU preparation + selection, hot-batch median, two runs | Individual-call median, two runs |
| --- | ---: | ---: | ---: | ---: |
| flat-z9 | 8 | 330 | 0.205 / 0.221 ms | 0.540 / 0.345 ms |
| pitch70-z10 | 64 | 500 | 0.294 / 0.300 ms | 1.160 / 0.400 ms |
| wide-flat-z13 | 8 | 482 | 0.224 / 0.234 ms | 0.345 / 0.460 ms |

Hot-batch results are medians of 31 batch means, 64 calls per batch, after 128 warmup
calls. Individual-call results use 128 calls separated by `setTimeout(0)`; waiting is
outside timing. They are not rAF/full-render latency distributions. The variability
is retained rather than selecting the faster run.

At pitch70, prepared selection alone takes a hot-batch median 0.179 ms with parent
gating versus 0.209 ms evaluating all candidates. Visibility tests fall from 584 to
338 and metric evaluations from 137 to 131. Layer dependence can eliminate work on
CPU without an unproved radial stopping condition.

Limitations: the port performs most projection/clipping arithmetic in JS f64 over
f32 inputs, whereas WGSL uses f32. Integer coordinates and differences remain exact
in the tested [0,2^52] domain, but general floating-point threshold equivalence is
unproven. The port uses many temporary arrays/objects. It is neither optimized nor
a CPU lower bound. Only DPR 1 was tested here; arbitrary non-flat hierarchical
metadata and threshold-boundary fuzzing remain. Matching the GPU's independently
checked cuts provides finite evidence, not an independent mathematical proof of
the CPU implementation. Upload-command lifetime, publication authority, rendering
and resource production are outside these CPU timings.

## CPU output upload and existing GPU consumers

The current consumer ABI requires more than the tile list. At 64 patches the four
CPU outputs total **21,948 bytes**: 656 metadata + 768 patch identities + 20,480
lookup bytes + 44 state bytes. The other two scenarios total 21,276 bytes. New
representations might reduce this cost, but have not been assumed in the comparison.

A native experiment uploads those actual CPU-produced buffers and runs the unchanged
repository source-demand WGSL plus the public cover lookup WGSL. Across the three
scenes and source ceilings 5/10/14, including a partial finer source domain requiring
ancestor fallback, **12/12 configurations** produce matching demand records and
valid per-patch GPU lookup results. All 32-byte demand fields are compared, including
desired/source/request levels, wrapped distance priority, frame and residency epochs.

At pitch70, 80 measured calls after 16 warmups give:

| Scope | Completion-paced calls | Calls after an 8 ms timer |
| --- | ---: | ---: |
| Four native writeBuffer calls | 0.020 ms | 0.030 ms |
| Upload plus demand/lookup consumer command issue | 0.030 ms | 0.075 ms |
| Prototype CPU source-demand projection | 0.030 ms | 0.065 ms |

These are host medians. Pipeline creation and verification copies/mapping are outside
issue timing. Native error scopes exist but their push/pop calls are outside this
particular interval, unlike the older raw-cover issue scope. The CPU projection
includes array creation and deduplication, but not `ViewDemandProducer` normalization
or runtime budget reconciliation. No measured total is formed by adding this table
to the CPU selection table.

This establishes a useful compatibility slice: CPU output can feed current GPU
lookup and source projection. It does not exercise terrain sampling/drawing or
manufacture production `GpuWebMercatorQuadCoverFrame` authority. Resource budgets,
Worker execution and full-frame latency remain outside this experiment.

## MapLibre comparison correction

The earlier 0.0x ms results used 31 batches of 256 hot calls. An additional test uses
individual calls after 8 ms admission timers, with 16 warm rounds and 80 measured
rounds. At pitch70 with fixed height bounds, `coveringTiles` medians are approximately
0.105 ms in 4.7.1 and 0.235 ms in 6.8.0. Including `jumpTo` gives approximately
0.175 and 0.535 ms respectively. Empty-map rendering can run between timer callbacks.

This does not establish a regression in MapLibre or make it equivalent to GeoScratch.
It demonstrates that a hot-loop average is not a reliable prediction for an isolated
frame call. The algorithms, actual projection conventions, outputs and quality
constraints still differ. Neither the smallest CPU number nor the smallest WebGPU
issue number should be treated as an architectural constant.

## Which resource facts belong where

The current API/source audit found the following existing ownership:

| Fact | Authority | Additional GPU readback needed? |
| --- | --- | --- |
| Request intent, cancellation, network/decode budgets | Geo scheduler and generic Worker executor | No |
| Cache identity and decoded payload ownership | Cache/source Worker and owned Geo transfer | No |
| Atlas slot allocation, eviction, generation, publication contents | CPU VirtualRasterResidency | No |
| Executable atlas, page and slot tables | GPU copy of ordered publication | Not to rediscover CPU assignments |
| Native execution success/failure | SubmittedWork native observation and publication acknowledgement | Existing mechanism |
| GPU-only usage, misses, dynamic particle demand, generated results | GPU observation | When CPU policy needs these facts |

`resident`, `settled`, queued usability, acknowledged success and exact-detail
readiness cannot be collapsed to a Boolean. An actual-API Node experiment establishes
that `publish()` can report resident assignments with a pending publication even
when no GPU runtime exists. A page can stage/publish while Worker accept/cache work
is pending. A later reconciliation retains known resident pages without requesting
them, and old-generation payloads are discarded before staging. Sixty-four existing
resource/Worker/frame tests pass, including publication/native-failure/disposal races.

The current path is camera -> GPU cover -> GPU source demand -> bounded readback ->
CPU request scheduler -> Worker/cache/decode/owned transfer -> residency publication
-> ordered GPU uploads -> asynchronous acknowledgement. A CPU cover and CPU demand
producer can remove the initial GPU demand-discovery delay without replacing the
downstream resource system. That latency benefit is an inference pending complete
integration measurement.

Important existing protections to preserve:

- Reconcile the complete selected resource intent, including resident pages, so the
  scheduler marks them used. Missing-only feedback used as the whole demand set can
  reintroduce tight-atlas eviction churn.
- Keep source ceilings, terminal missing-page results, fallback, pinned safety pages,
  retained requests, unique decoded ownership and independent network/decode budgets.
- A pending publication is usable by later work only through the exact valid queue
  order. Native success still controls acknowledgement and staging release.
- Immutable snapshots do not automatically lease physical slots. Preserve explicit
  leases or equivalent validated submission/retirement ordering.
- Reuse unchanged spatial decisions only with current consumer provenance. The
  terrain decision key includes residency epoch for feedback refresh; old frame
  receipts cannot be relabeled as newly produced geometry.

Source anchors: [VR runtime](../../packages/geoscratch/src/geo/virtual-raster-runtime.ts),
[scheduler](../../packages/geoscratch/src/geo/virtual-raster-demand.ts),
[residency](../../packages/geoscratch/src/geo/virtual-raster-residency.ts),
[GPU publication](../../packages/geoscratch/src/geo/virtual-raster-gpu.ts),
[Worker executor](../../packages/geoscratch/src/geo/virtual-raster-worker-executor.ts),
[terrain composition](../../packages/geoscratch/src/geo/web-mercator-terrain-renderer.ts).

## Asynchronous observation experiment and protocol

Two native/Scratch transport runs test 44-byte, 1-KiB and 64-KiB complete feedback,
no-readback baselines, every-admission observation and observation every eight
admissions. A small compute kernel produces persistent GPU facts; separate staging
buffers are mapped asynchronously. The admission timer is 8 ms and is not a display
FPS measurement. Every returned word is checked against its producing epoch.

The first run passes all 20 configurations. An artificial 40 ms delay after owned
byte copy/unmap occupies the two CPU adoption slots, suppresses 62/64 intermediate
observations, and reaches the final epoch 96 after two terminal reissues. This tests
host-adoption backpressure, not a long-lived mapped staging buffer. The second run
reverses configuration order and adds explicit byte-length, drained-slot and Scratch
readback-memory cleanup assertions; all 20 configurations pass again. Staging bytes,
retained host bytes and active mappings are zero after profile cleanup. Across its
ordinary observed configurations, feedback-availability medians are about one
millisecond; this latency is outside synchronous host issue and is not a frame stall.

This is a transport experiment, not a new terrain ready protocol. Two observation
slots do not bound all GPU submissions. Final delivery uses explicit timer retries;
it does not prove the existing renderer wakes correctly after stopping. Reported
feedback availability includes GPU work/copy, mapping, scheduling and owned-byte
extraction, rather than pure DMA or pure map latency. Small payload size alone does
not remove these costs.

For a future GPU-only observation producer, prefer a bounded complete snapshot first:

1. CPU owns current source/demand and slot assignments. GPU uses the exact ordered
   publication and produces declared usage/miss/result observations.
2. Readback identifies the producing submission and applicable runtime, source,
   registry, demand, publication and slot generations, plus scope/count/completeness.
3. CPU validates against current authority. Callback arrival order never becomes
   revision order. A-B-A may reuse spatial data, but historical A readiness cannot
   certify a changed source or mapping epoch.
4. Ring saturation retains a latest-observation retry/wakeup. No occupied staging
   buffer is overwritten. Final stationary demand must reach either current complete
   evidence or an explicit terminal failure/budget condition.
5. Delta transport is a later optimization requiring a base, contiguous sequence,
   acknowledgement and full resynchronization on a gap/overflow. Missing-only absence
   is not evidence of readiness. Observed pixel usage is not complete geometric demand.

A separate pure Node model passes 11 focused cases and 160,000 invariant checks
across 1,000 seeded event sequences. It covers A-B-A, source/runtime/registry changes,
out-of-order/duplicate observations, slot ABA, incomplete/overflow data and reader
backpressure. It reproduces false-ready counterexamples for last-callback-wins,
camera-key-only reuse and slot-index-only identity. Model convergence assumes a
stable satisfiable demand, fair producer/reader and nonwrapping generations. Its
two-model-turn quiescent result is not a two-frame performance prediction or a
product/WebGPU correctness proof.

## API implications and remaining acceptance

Existing Scratch ordered uploads/readbacks, content epochs, allocation versions,
submission authority and native observation are sufficient building blocks. Existing
VR explicit demand, Worker executor, ownership transfer and publication remain useful.
The next integration should define a single geometry product and its CPU-to-GPU
lowering/provenance; the current branded GPU frame cannot silently become CPU-produced.
Execution placement is currently a public cover/terrain contract, so an accepted
change requires English/Chinese canonical API updates, an ADR and tests.

A GPU resource-event journal does not currently exist as a general Geo contract.
Only add it for measured GPU-origin facts. Likewise, VR has settlement promises but
no per-page-progress subscription; an event-driven scheduler that sleeps between
incremental arrivals needs an explicit coalesced invalidation/lifetime contract.
Do not create a new universal ready facade or move Geo concepts into Scratch.

The next independent implementation checkpoints would be: CPU numerical/semantic
closure; explicit complete-product lowering and CPU demand; full terrain integration
through existing resource owners; only then optional GPU-only observation. Each
requires a separate verified commit and can be reverted in reverse dependency order.
There is no runtime CPU/GPU selector switch proposed here.

Before production adoption, run matched full-frame CPU/GPU cost and first-request /
fallback-ready / exact-ready timing with warm/cold cache and delayed fetch/decode/
accept/publication. Include tight budgets, current resident intent retention,
continuous pitch/move/zoom, wide symmetry, DPR invariance, A-B-A, complete coverage,
independent parents, 2:1, capacity and quality failure, numerical boundary fuzzing,
general vertical hierarchy, source revisions, native failure/device loss, delayed
final feedback and cleanup. Run all current AGENTS terrain gates, including shaded
and wireframe 90-frame tests. This research does not claim those production gates
passed for a new CPU renderer.

## External evidence

- [Nanite SIGGRAPH 2021](https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf),
  pages 122 and 126–127: resident culling metadata, GPU requests/priorities and
  asynchronous CPU dependency/I/O/eviction/installation. Its residency-dependent
  drawable cut is not GeoScratch's geometry contract.
- [Unreal streaming virtual texturing](https://dev.epicgames.com/documentation/en-us/unreal-engine/streaming-virtual-texturing-in-unreal-engine):
  GPU-observed tile use informs CPU loading; reactive discovery can delay detail and
  cause visible popping. This supports a resource loop, not mandatory GPU cover.
- [WebGPU synchronization](https://gpuweb.github.io/gpuweb/#programming-model-synchronization)
  and [promise ordering](https://gpuweb.github.io/gpuweb/#promise-ordering): queue
  dependencies and mapping authority must be explicit. Use ordered dispatch/copy
  work, not global shader spin barriers or callback-order inference.
- [GPU Geometry Clipmaps](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry):
  persistent GPU terrain data coexist with CPU block culling. Moving grid identity
  and its LoD policy are not adopted here.

## Local evidence inventory

Temporary experiments are intentionally outside public exports and normal example
flows. Their machine-specific results are not API guarantees:

- `/tmp/geoscratch-cover-cpu-prototype/`: CPU port, source preparation, 77-case
  native comparison, two timing runs, upload payloads and source/experiment hashes.
- `/tmp/geoscratch-cover-upload-experiment/`: CPU payload upload, unchanged GPU
  source-demand/lookup consumers and native issue timings.
- `/tmp/geoscratch-cover-feedback-experiment/`: native/Scratch transport, repeated
  configurations, staging/adoption pressure and cleanup facts.
- `/tmp/geoscratch-cover-resource-research/`: source/API audit, actual-API state
  probe, 64-test logs, protocol model, external primary-source study and independent
  experiment reviews.
- `/tmp/geoscratch-cover-cpu-comparison/`: pinned MapLibre artifacts and both hot
  batch and individual-admission runners/results.

The only repository change from this research is this review. Backend data and the
frozen Flow Layer remain outside the experiments.
