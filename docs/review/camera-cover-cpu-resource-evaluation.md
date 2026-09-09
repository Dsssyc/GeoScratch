# Camera cover execution and asynchronous resource observation

Date: 2026-09-09. Design review against `camera-cover` at `d6e2e9e`.
The production worktree was clean throughout the experiments. This review records
experimental alternatives; it does not supersede the canonical API or ADR-125.

## Recommendation

Evaluate **one CPU geometry selector plus CPU source-demand projection, with the
existing persistent GPU atlas/page tables and existing Worker/Virtual Raster
publication pipeline**, as the preferred next integration experiment. Retain the
current GPU selector as an isolated comparison, rather than making both authorities
active in a renderer.

GPU-origin usage, missing-page observations and procedural results can feed bounded
asynchronous CPU reconciliation. CPU-owned allocation and upload decisions need not
make a GPU round trip before the CPU can schedule resources. Geometry execution
location, source-demand execution location and persistent resource storage are
separate choices.

The evidence makes this CPU alternative credible. It does **not** establish an
end-to-end winner: the CPU prototype has numerical and integration limits, and its
individual-call timings vary substantially. MapLibre's hot-loop timings cannot be
promised for GeoScratch's stronger geometry contract. Optimizing Scratch's repeated
host bookkeeping is useful independently of the cover placement decision.

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
