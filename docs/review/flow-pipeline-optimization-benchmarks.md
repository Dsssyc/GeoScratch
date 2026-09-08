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
Do not call the mean sampled encoder duration a frame cost, add phase savings as
if independent, or interpret these timings as system utilization/power. Queries
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
