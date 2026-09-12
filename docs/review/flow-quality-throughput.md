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

## Bounded Frame Pipeline

ADR-138 permits two stable submitted frames with one construction, separates
source acknowledgement from native observation, and retains independent frame
leases and observed spatial provenance. Resource changes use explicit barriers;
already-issued work remains observable through stop and failure.

Eight native lifecycle scenarios pass, including reversed completion, paused
resize, camera and temporal changes, contour serialization, ordinary disposal,
disposal during blocked construction and injected native failure. The added
construction-disposal case caught and now guards cancellation after async waits:
the application lifetime signal prevents both extra submission and history resize,
while all already queued work is still drained and its leases released.

Native one/two/two/one admission comparison at 3520x1760 on the verified 144 Hz
secondary display measured 42.99/61.28/51.00/46.71 updates/s (one-slot mean 44.85,
two-slot mean 56.14, approximately 25% higher in this batch). Native submissions
matched admitted frames exactly in all four windows, and the in-flight peak never
exceeded the selected bound. Accepted simulation time stayed 59.93-59.99 reference
steps/s. No new spatial builds, spawn-content comparisons or active workers
occurred during measurement.

These absolute rates are shared-machine observations under possible contention,
not an isolated-machine target or a comparison against earlier phases: the third window's rAF cadence
also fell to 129 Hz. Two slots trade additional queued latency for throughput:
queue-completion medians were 15.7-17.9 ms with one and 28.3-35.9 ms with two;
P95 reached 45.6 ms in the slowest two-slot window. Camera/control transitions
drain this bounded backlog before encoding changed state. Do not increase the
bound on this evidence. Full measurements and placement/cleanup facts are saved
by `tests/browser/flow-field-frame-throughput.mjs`.

Final verification: documentation generation, translation revision checks,
`npm run typecheck`, `npm test -- --timeout 10000 --reporter dot` (1,814 passing,
two opt-in gates pending), and `npm run build` passed. The first default-timeout
run exceeded the API reflection test's 30-second limit and the repository-name
scan's two-second limit. Reflection passed in isolation; the complete rerun raised
only Mocha's default waiting limit to ten seconds, with no assertion/test-source
change for either documentation check.

Passed native browser proofs: frame pipeline, trail quality, retained history,
visual time, center-cache coherence, inspector handoff, prefetch failure, lookahead,
normal/delayed/warm startup and all five DPR 2 camera-continuity gestures. Every
camera gesture encoded one particle update per admitted frame, with zero resets,
zero history clears and complete cleanup. Seven ordinary forward/reverse temporal
handoffs had no buffering or gaps over 100 ms. Quality and speculative-failure
fixtures now explicitly await visible foreground readiness instead of assuming
that queued readiness or background failure also means a completed foreground
frame. The existing pixel, no-retry and paused-simulation assertions are retained.

## Drag Follow-Up: Candidate CPU Work

The user subsequently reported stutter and map/overlay skew in both Native and
Balanced. Previous camera-continuity checks proved simulation admission and cleanup,
not actual camera freshness. A controlled 40 ms delay of completion notification
(without extra GPU work) made captured camera age reach 60-74 ms and projected pan
skew reach roughly 6-9 reference pixels. The renderer parked an already captured
camera behind full spatial observation; that requires a separate presentation fix.

Native CPU profiling also found an independent drag bottleneck: candidate selection
and cell materialization, packing, and equality comparison consumed about 73% of
the renderer's CPU samples. Camera priority invalidated immutable cell geometry even
when selected pages were unchanged. ADR-139 separates that geometry from fresh
priority/provenance metadata. The same 120-input drag's capture-to-submit median
fell from 17.5 to 2.7 ms and P95 from 38.6 to 9.0 ms. The three redundant paths no
longer appeared among hot functions. These are two profiling observations, not an
isolated-GPU frame-rate guarantee or proof that camera waiting was fixed.

Verified: 36 focused demand/packing/spawn tests, typecheck, 1,818 full tests (two
opt-in gates pending, ten-second Mocha default limit), production build, and the
real drag with clean browser/disposal outcomes. Raw CPU profiles and capture records
are retained under ignored `output/playwright/flow-camera-lag/`.

## Drag Follow-Up: Camera Presentation

ADR-140 adds camera-only submissions through the existing controller. Pending
content observations retain their resources while visible history and optional
contour segments are reprojected from the current host capture. The next full
update consumes elapsed visual time; camera presentation does not reset that clock.

The new pixel proof holds one completed GPU frame's observation and then pans by
80 reference pixels. Native/Balanced, with and without contour, match the translated
image at about 0.73 mean channel error out of 255, versus 27-28 for the unshifted
control. No paused particle step, reset, resize, spatial rebuild or extra temporal
lease occurs. Releasing the hold converges even when paused. Disabling the camera
path fails at the new-presentation gate, as intended.

In matched headless drag scenarios, a 40 ms observation delay previously produced
72-74 ms P95 capture-to-submit age and roughly 6 reference pixels of skew **at
submission**. The repaired scenarios measured 3.5-3.7 ms P95 and numerical-zero
submission skew. This is distinct from compositor/display latency. The timing
harness verifies that every measured submission has its actual capture timestamp.

The physical secondary screen was verified as 3840x2160, 144 Hz, backing scale 2.
The completed DPR 2 native run measured 4.0/4.6 ms P95 capture-to-submit age for
Native/Balanced without injected delay, with approximately 72/88 presentations/s
under that run's shared-machine conditions. It did not reach 144 presentations/s.
A DPR 1 control reached approximately 143 presentations/s, but is not the actual
4K-quality result. A later DPR 2 rerun could not establish the required non-main
high-refresh display and did not launch a browser. Both completed native runs
verified background placement and closed their owned Chrome instance.

Final source verification passed documentation generation/translation/check,
typecheck, 1,818 Node tests (two opt-in gates pending, ten-second default Mocha
timeout), and production build. The fixed-source DPR 2 camera-continuity proof
measured 59.97-60.02 accepted reference steps/s across all five gestures, one
particle update per content frame, zero resets and zero history clears. Pure
presentations are counted separately so they cannot disguise simulation starvation.
Final browser gates also passed camera pixel latency, eight frame-pipeline scenarios,
trail quality, retained history, visual time, inspector handoff, speculative failure,
forward/reverse lookahead and normal/delayed/warm startup. All owned browser sessions
completed their cleanup. An earlier camera-continuity run was interrupted by Vite HMR;
the final run used unchanged source and completed all five gestures.
