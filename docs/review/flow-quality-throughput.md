# Flow Quality And Throughput Repair

Baseline: `a5ef873`. Investigation: 2026-09-12. Frozen Flow Layer and backend
datasets remain comparison inputs. The goal is to reduce Native rendering cost,
preserve source semantics, and improve trail quality with explicit frame ownership.

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

## Remaining Work

- Reuse loaded sampling footprint values without weakening new-position checks.
- Add explicit line coverage and filtered presentation while separating source
  precision from history resolution.
- Permit a measured bounded frame pipeline with correct uniforms, publications,
  cache builds and temporal leases.
- Maintain controlled Native comparison, source/presentation distinctions and
  cleanup evidence across the final combined behavior.
