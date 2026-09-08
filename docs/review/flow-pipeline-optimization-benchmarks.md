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

Later phases append their fresh before/after evidence here only after verification.
