# Flow Quality And Throughput Repair

Baseline: `a5ef873`. Investigation: 2026-09-12. Frozen Flow Layer and backend
datasets remain comparison inputs. The goal is to reduce Native rendering cost,
preserve source semantics, and improve trail quality with explicit frame ownership.

The user reports concurrent local small-model testing in `my-precious-skill`,
which can share this machine's GPU. Treat changing absolute timings as potentially
contended; use interleaved same-input controls and separate correctness from timing.
Do not attribute a slower batch to code without a controlled comparison.

## Complete Source Support

ADR-135 reuses the existing center cache for full-support A pixels. Fixed-input
native replay at 3520x1760 measured 0.949 ms cached versus 2.390 ms direct, with
the complete visible image identical. The 19-fixture GPU oracle compared 142,750
sample positions, including failure, threshold, page/registration and time cases;
all cached/direct A values matched and the existing C/D comparison stayed exact.

Passed: 1,809 Node tests (two opt-in gates pending), type checks, documentation
generation/translation/check, production build, trail-quality, retained-history,
cache-coherence, visual-time and all five DPR 2 camera-continuity cases. No particle
reset or history clear occurred during the camera gestures. Native replay input
identities and output hashes are in the regenerated ignored
`output/flow-field-coverage-replay/report.json`.

A separate native 144 Hz quality run measured Native 57.56/65.40 and Balanced
71.42/72.10 updates/s. There is no same-run unoptimized control in this quality
harness, so these values are not a before/after speedup estimate. They reinforce
the remaining frame-admission work; the fixed-input pass comparison above is the
bounded performance evidence for this slice.

## Loaded Footprint Owners

ADR-136 reuses the already-loaded unregistered owner within each 2x2 footprint.
The 6,204-sample real-sampler comparison has zero differences, including status
and fallback. A separately recorded complete pre-change shader produces the same
262,144-particle output as the new implementation on a restored actual input:
`462b33542850ce8382da05c300e63586f672ebf9c5c4a936047e229489676bad`.
Interleaved simulation means are 2.407 ms old versus 2.152 ms new. The 64-thread
experiment is retained as evidence only; production still uses 256 threads.

Passed: documentation gates, typecheck, 1,809 Node tests, build, temporal-status,
zero-footprint, particle-reference, retained-history and visual-time native gates.
No source data or public library ABI changed. Captured reference and replay data
are retained under ignored `output/flow-sampling-reuse/`.

## Analytic Trail Coverage

ADR-137 makes Native the default, adds clipped screen-space quad coverage and
linear upscaling, and removes the false occlusion/depth allocation from transparent
ink. Forty angle/phase/DPR cases pass; subdividing a segment differs by at most one
rgba8 byte. Same-pass near-zero-halo overlap is exactly invariant under reversed
order, and camera-plane crossing bounds agree with native line clipping within
one pixel. The half-resolution checkerboard has zero error against the CPU linear
oracle, exact ready/retained agreement, unchanged raw decay and exact Native bytes.

Passed: 1,812 Node tests (two opt-in gates pending), typecheck, documentation gates,
build, 54 particle/reference cases, 833 history-time passes, normal/delayed/warm
startup, quality controls, retained history, visual time and all five DPR 2 camera
gestures. Native 144 Hz observations were 90.41/101.41 updates/s; Balanced was
140.27/139.13. These are shared-machine observations without a paired old-raster
control, not a claimed speedup. Stable frames retained one native submission.

## Remaining Work

- Permit a measured bounded frame pipeline with correct uniforms, publications,
  cache builds and temporal leases.
- Maintain controlled Native comparison, source/presentation distinctions and
  cleanup evidence across the final combined behavior.
