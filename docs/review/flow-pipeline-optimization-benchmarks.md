# Flow Pipeline Optimization Benchmarks

Date: 2026-09-08. Baseline: `8d44021`.

Approved order: spatial decision reuse, particle sampling deduplication,
presentation/SDF fast paths, then measured cache-transition and scheduling costs.
Each accepted phase has a separate verified commit. Frozen Flow Layer and backend
data are not implementation targets.

## Measurement Contract

Use `node tests/browser/flow-field-gpu-benchmark.mjs` from the repository root with
Vite on 5173 and Flow COG service on 8788. `FLOW_GPU_BENCH_VARIANTS=field-C` isolates
the current field; the default also measures frozen Layer at matching source time.
Run alone, not alongside native GPU regression tests or package builds.

The dedicated headless Chrome page uses timestamp-query pass boundaries, 1512x861
reference pixels, DPR 2, zoom 9, 262,144 particles, source pair t00/t01 at alpha
approximately .277 and a proof background without basemap network traffic. The
small positive timeline rate keeps animation enabled without changing the pair.
After warm-up and resident workers settling, collect seven seconds of playback.

The benchmark samples native encoders with a bounded deterministic pseudorandom
selector. A fixed interval divisible by encoders/frame would alias one stage;
the earlier diagnostic's stride of seven avoided its four-encoder baseline alias.
Record native submissions, phase build/reuse facts and per-pass distributions.
Do not call the mean sampled encoder duration a frame cost, add render-pass
durations (which can overlap), add phase savings as if independent, or interpret
these timings as system utilization/power. Queries
and concurrent desktop activity perturb timing; the real basemap/compositor is
outside the measured WebGPU passes. Raw logical load counts are not DRAM traffic.

## Phase 1: Observed Spatial Decision Reuse

Decision: [ADR-120](../decisions/ADR-120-flow-spatial-decision-reuse.md).

| Steady scene fact | Before | After |
|---|---:|---:|
| Updates/s | 59.855 | 59.991 |
| Cover mean ms | 4.102 | not encoded |
| Demand projection mean ms | 0.273 | not encoded |
| Particle simulation mean ms | 6.585 | 6.548 |
| Native submissions/frame | 4 | 2 |
| Spatial build count during measured window | one each frame | 1 to 1 |
| Center-distance cache build count | 1 to 1 | 1 to 1 |

Type checks, production build and 1,667 Node tests passed (two existing pending).
The existing shared-runtime bundle-size warning is unchanged. Focused adapter and
demand tests passed 32 cases, including preserved projection-overflow fallback.

The result is less work at approximately the same display cadence, not a claim
that FPS measures the saved GPU budget. The unmodified particle timing is a useful
control. The real-page proof observed 120 stationary animation updates with no
spatial rebuild; t00-to-t01 ownership changed without changing spatial identities.
Pan/pitch/resize rebuilt and settled, and the final camera reused again on resume.
The five continuous-camera proofs (stationary, pan, pitch, wheel, wheel with time
handoff) passed with no frozen rendered frames, particle-pool resets or history
clears. The 30/60 Hz real-page visual clock and paused C-D-C image checks passed.

Reproduction gates:

```sh
npx mocha tests/flow-field-view-demand.test.js tests/flow-field-demand.test.js
node tests/browser/flow-field-spatial-reuse.mjs
FLOW_GPU_BENCH_VARIANTS=field-C node tests/browser/flow-field-gpu-benchmark.mjs
node tests/browser/flow-field-camera-continuity.mjs
node tests/browser/flow-field-visual-time.mjs
npm run typecheck
npm test -- --reporter dot
npm run build
```

## Phase 2: Loaded Footprint Reuse

Decision: [ADR-121](../decisions/ADR-121-flow-loaded-footprint-reuse.md).
Fresh pre-change baseline: `8e38f5f` (clean tracked tree).

| Steady scene fact | Before | After |
|---|---:|---:|
| Updates/s | 59.852 | 59.995 |
| Particle simulation mean ms | 6.523 | 4.347 |
| Particle simulation p50 ms | 6.527 | 4.290 |
| Native submissions/frame | 2 | 2 |
| Spatial build count during window | 1 to 1 | 1 to 1 |

The approximately 33% reduction is for this simulation pass, not the entire app.
Other full-screen timings varied and are not attributed as savings to this phase.

The native sampler oracle shares the real generated three-level Geo samplers and
compares the old registration preflight path with the new loaded-footprint path.
47 fixtures, 282 cases and 6,204 compared samples had zero observed difference in
velocity/speed, status, resolved level and advectability. Cases include independent
endpoint status changes, repeated common-level fallback, transitions, page/source
edges, canonical-quantum offsets, owner-zero and temporal cancellation. The test
retains a bounded floating-point tolerance rather than claiming all devices must
produce bit-identical floating-point arithmetic.

Logical helper counts for one C/D temporal query:

| Scene | Previous resolution + load calls | New resolution + load calls | UV loads before / after |
|---|---:|---:|---:|
| Fine | 16 + 8 | 0 + 8 | 8 / 8 |
| Mixed fallback | 28 + 12 | 0 + 16 | 12 / 16 |
| Edge transition | 32 + 12 | 4 + 16 | 12 / 16 |

The additional UV reads in fallback are explicit and subsequently discarded when
the footprint moves to a coarser registered level. They do not replace readiness
checks. Counts use invocation-private diagnostics, separately from timing shaders.

A counter-free 32,768-query ABBA microbenchmark (four warm-up and 24 timed passes
per scene) measured mean milliseconds on the root verification run: fine 0.3442
to 0.1816, mixed fallback 0.2446 to 0.1323, transition 0.1760 to 0.1127. Mixed
fallback p50 was 0.1625 to 0.0989, illustrating why a short timing mean should not
be treated as a device-independent constant. These controlled kernels establish that
extra discarded loads did not outweigh parsing savings in these cases; they are
not an end-to-end performance ratio.

Additional gates:

Type checks, production build and all 1,667 Node tests passed (two existing
pending). The native zero-footprint proof passed 178 samples per variant; raw
history/retained-visible regression tests also passed. No uncaptured GPU errors.
The real z14 A/B/C/D inspection proof passed (approximately 60 updates/s for all
four tested views), including paused state preservation, camera/resize, time-pair
handoff and cleanup. The 30/60 Hz visual-time and paused image checks passed.

```sh
npx mocha tests/flow-field-pixel-center-registration.test.js tests/flow-field-temporal-raster.test.js
node tests/browser/flow-field-sampler-reuse.mjs --benchmark
node tests/browser/flow-field-zero-footprint.mjs
node tests/browser/flow-field-history.mjs
node tests/browser/flow-field-history-retained.mjs
```

Later phases append their fresh before/after evidence here only after verification.

## Phase 3: Presentation Work

Decision: [ADR-122](../decisions/ADR-122-flow-paired-visible-presentation.md).
Fresh baseline: `9b3a4e1` (clean tracked tree). The C visible A/B pass means were
2.074/2.139 ms, Surface copy 1.771 ms, particle simulation 4.331 ms, and two native
submissions per frame.

Isolating only delayed center-distance decoding produced visible A/B means
1.944/1.922 ms, with Surface copy still 1.770 ms and simulation 4.316 ms. This is a
small local effect, not the main expected saving from pairing presentation. The
108,490 native coverage probes remained identical.

Before adopting paired output, the 595,200-sample quantization preflight showed
pack/unpack-alpha exact for visible and Surface on all three tested formats.
Unquantized/round controls failed equivalence, validating the need for the explicit
intermediate quantization. Do not infer cross-device format equivalence or final
Canvas-compositor equivalence from that render-target proof.

| Steady C display work | Before | Paired output |
|---|---:|---:|
| Visible A/B mean ms | 2.074 / 2.139 | 2.389 / 2.458, including Surface |
| Separate Surface copy mean ms | 1.771 | not encoded |
| Sum of individual pass means (not an interval) | about 3.87 | about 2.43 |
| Particle simulation mean ms | 4.331 | 4.256 |
| Native submissions/frame | 2 | 2 |
| Updates/s | 59.997 | 59.989 |

The initial 37% interpretation of the sum above is withdrawn. Individual render
passes overlap; this sum is not display-work elapsed time. The corrected contiguous
visible-begin to Surface-end ABBA means were 2.308 / 2.320 / 2.230 / 2.306 ms for
separate / MRT / MRT / separate. No stable material improvement was established,
so MRT is not adopted. The complete tested experiment is committed separately on
`socu/flow-mrt-evaluated-9b3a4e1`; mainline retains delayed SDF decoding and the
measurement correction. Native ownership regression exercised 186 submissions:
the original history golden values and retained A-B-A image remained unchanged;
all four boundary modes selected scaled-copy for mismatched extents and MRT after
matching resize. Changing only Surface size correctly switched pipeline families
without changing the prepared temporal binding. Resource and pending counts ended
at zero.

Type checks, production build and 1,669 Node tests passed (two existing pending).
The root reran the production quantization helper proof: all three formats had
zero differing visible or Surface bytes. Source-cache coverage again matched the
direct oracle across 108,490 probes. The shared-runtime size warning remains.

The MRT-only helper and extended graph tests are available on experimental commit
`5b2b063`, not mainline. Mainline verification continues to use
`flow-field-center-cache.mjs`, `flow-field-history-retained.mjs`, the existing
history tests, and the GPU benchmark. `FLOW_GPU_BENCH_VARIANTS=field-C-original,field-C`
compares the original center decoder from `9b3a4e1` with delayed decoding in
isolated pages, using the continuous `displaySpanMs` metric.

After removing MRT, a decoder-only ABBA rerun reported original display spans
3.962/2.061 ms and delayed-decoder spans 3.110/2.837 ms. The unchanged particle
control simultaneously varied from 7.113 to 4.902 ms, so this run is not used to
assign a net decoder speedup. The retained change avoids unnecessary interior
distance arithmetic and preserves numerical results; no stable end-to-end
percentage is claimed. The benchmark also directly observed overlapping adjacent
pass intervals, and no longer publishes a misleading sum of pass durations.
The final mainline decoder-only state passed type checks, production build and
1,667 Node tests (two existing pending). The MRT-only files were removed from
mainline after verifying their exact saved blobs in experimental commit `5b2b063`.

## Phase 4A: Center-Cache Endpoint Reuse

Decision: [ADR-123](../decisions/ADR-123-flow-center-endpoint-reuse.md).
Baseline: `2f3f65f`. With C at zoom 9, controlled seeks to 1.277, 2.277 and 1.277
produced three cache builds of 30 pages each, mean 7.469 ms, median 6.422 ms,
maximum observed 10.204 ms. Builds advanced from one to four; the spatial build
count stayed one. These three samples are a transition witness, not a stable
percentile distribution. The 429/466/784 ms seek-settle intervals also include
source loading and 16 animation frames and are not interpreted as cache time.

Use `FLOW_GPU_BENCH_TRANSITIONS=1 FLOW_GPU_BENCH_VARIANTS=field-C node tests/browser/flow-field-gpu-benchmark.mjs`
for this witness. It samples all transition encoders within the same bounded
record/query limits. Clear-only passes can produce unwritten/invalid timestamps
on the tested backend; the tool reports them under `invalidTimestampPasses` rather
than publishing a negative duration or silently treating their work as zero.

The same three real transitions after endpoint reuse selected `[2,0]`, `[2,0]`,
then `[0,1]` (old upper to new lower, then old lower to new upper on reverse).
Each still produced a complete target cache, but only one endpoint was rebuilt.
Including initialization, rebuilt lanes ended at five instead of eight; three
lanes were copied. Valid native cache-build timings had mean 3.841 ms, median
3.417 ms and maximum 6.156 ms. This small transition sample supports the expected
reduction but is not a general percentile or universal speedup claim.

The Node lifecycle/planner gate passed 21 cases. A partial build pins its input
record epoch so encode-to-submit clobbers cannot be hidden by a later successful
producer epoch. The real-page run also validated those dependencies against real
Scratch receipts, not only orchestration fixtures.

The root native verification compared 1,254,931 full packed records against the
frozen/full builders with zero differences. A reused endpoint performed zero U/V
source loads; both-copy swaps and aliases performed none for either endpoint.
Counter-free ABBA microbenchmarks (12 samples per variant) measured mean ms:
lower-only update 0.3577 to 0.1576, forward pair 0.1775 to 0.1041, both-copy swap
0.2182 to 0.0121, both-fresh control 0.1632 to 0.1629. Median values and individual
invalid timestamp counts remain in the runner output; these short microbenchmarks
are not whole-frame speedup claims.

Real Scratch validation rejected both same-builder preceding writes and external
encode-to-submit clobbers with `SCRATCH_SUBMISSION_STALE_READ` before issuing the
copying build. The equivalent fresh-only preceding write remained legal.

The final type checks, production build and 1,679 Node tests passed (two existing
pending). Owned cache buffer bytes remain unchanged; endpoint selectors occupy
previously reserved job words, not another network or texture payload.

```sh
node tests/browser/flow-field-center-cache-reuse.mjs --benchmark
node tests/browser/flow-field-center-cache-coherence.mjs
node tests/browser/flow-field-center-cache.mjs
npx mocha tests/flow-field-center-cache-context.test.js tests/flow-field-center-cache-plan.test.js
```

## Phase 4B: Upload And Content Ordering

Decision: [ADR-124](../decisions/ADR-124-flow-content-upload-order.md).
Clean baseline `c1423d5` encoded 648 native submissions for 324 animation updates,
exactly two per update, with no spatial or center-cache rebuild during the window.
This run measured only 46.28 updates/s and simulation/display intervals of
7.85/3.70 ms, substantially above earlier unchanged-shader observations. Therefore
those absolute times are not treated as a stable control or used to claim a
percentage speedup. The primary structural gate is native submissions per actual
update, with numerical/interaction regressions checked separately.

After moving history uniforms before synchronous content preparation, the same
steady scene encoded 322 native submissions for 322 animation updates: exactly
one per update. Spatial/cache build counts remained one and worker count zero.
The run reported 45.99 updates/s, simulation mean 6.841 ms and continuous display
span mean 3.617 ms. This establishes the submission reduction, not a material
whole-frame speedup: the observed update rate did not improve in this run. Adjacent
pass intervals still overlap and must not be summed.

The native history graph exercised 186 submissions and retained its original
golden values. Eight cases (A/B/C/D boundaries at two current-frame values) compared
the array path's two native submissions with the producer path's one submission;
all Surface bytes were identical. Current values, not stale previous values,
reached drawing. Throwing, asynchronous, non-array, submitted-builder and reentrant
content preserved history facts; retained presentation remained exact. Native
errors, live resources and pending operations ended at zero. The focused Node
ownership/history/renderer gate passed 22 tests.

Final type checks, production build and 1,686 Node tests passed (two existing
pending). All five camera-continuity witnesses had zero frozen rendered frames,
particle resets and history clears, including wheel-driven time handoff. The
visual clock maintained 59.94/59.92 reference ticks per second under native and
30 Hz admission; paused C-D-C screenshots remained exact. All four boundary modes
passed the real z14 camera/resize/time-handoff proof. Cache coherence again rejected
both clobber cases and all 1,254,931 packed-record comparisons remained exact.

The added real contour-order smoke test passed particle playback/pause and paused
Status/Speed inspectors with 122,880 visible contour candidates and matching
temporal pair/endpoint epochs. Overflow observation completed with each frame.
Paused controls left particle steps/reference time unchanged; contour on/off/on
contributed visible GPU pixels and restored the exact frozen screenshot. Cleanup
ended with zero pending observations and no errors. This closes the previous
control-panel-only contour coverage gap.

## Final Reference Comparison

After the accepted changes, the same harness ran Layer / Field C / Field C / Layer
in separate sequential pages. No baseline-example production source was changed.

| Metric | Layer first | Field C first | Field C second | Layer second |
|---|---:|---:|---:|---:|
| Updates/s | 60.14 | 58.57 | 45.00 | 59.99 |
| Particle simulation mean ms | 0.477 | 6.514 | 7.795 | 0.515 |
| Layer field-construction mean ms | 0.873 | not applicable | not applicable | 0.981 |
| Field continuous display span mean ms | not measured | 3.593 | 3.914 | not measured |
| Native submissions in window | 420 | 410 | 315 | 420 |

Field used one native submission per actual animation update in both windows,
with no spatial/cache rebuilds and no active workers at either measurement edge.
The first Layer observed-frame delta was 421 while 420 queue submissions occurred
inside the measurement window: its completion counter can straddle the window
boundary. Do not infer an additional frame's submission from that difference.

This final comparison does **not** establish parity with frozen Flow Layer.
Particle simulation remains the largest measured Field compute pass: direct tiled
temporal queries and particle policies do substantially more work than sampling
Layer's prebuilt screen field. The two Field windows also differ materially in
cadence. Preserve these observations rather than replacing them with the faster
earlier runs. No system GPU-utilization reduction, universal FPS gain or sum of
the phase-local savings is claimed. MRT remains an unadopted measured experiment.

```sh
FLOW_GPU_BENCH_VARIANTS=layer,field-C,field-C,layer node tests/browser/flow-field-gpu-benchmark.mjs
node tests/browser/flow-field-history-retained.mjs
node tests/browser/flow-field-camera-continuity.mjs
node tests/browser/flow-field-visual-time.mjs
node tests/browser/flow-field-center-ab.mjs
node tests/browser/flow-field-contour-order.mjs
```
