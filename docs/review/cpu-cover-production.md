# CPU camera-cover production rollout

Baseline: `ebb3336`. Decision: [ADR-129](../decisions/ADR-129-cpu-webmercator-cover-production.md).

## Checkpoints

- `2fd6d8f`: GPU cover, projection, patch-draw and terrain vertex/lookup shader
  reference hashes frozen. Production GPU algorithms are unchanged.
- `b660d22`: `WebMercatorQuadCover` and `WebMercatorQuadDemandProjection`, immutable
  branded selections and original view provenance, no GPU objects or readback.
  Focused tests and DPR 1/2 native consistency pass: 71 ordered successful cuts and
  three matching failed cuts per DPR, with matching source intents and the existing
  0.02-reference-pixel numeric observation tolerance. Native independent coverage,
  quality, A-B-A, 2:1, extreme views and bounded/full candidate tests are retained.
  Final slice checks pass: 1,749 tests, two opt-in pending, typecheck, build and
  docs validation (841 public symbols and 20 reviewed translation pairs).
- Upload ownership/receipt implemented: six GPU buffers, private opaque uploads,
  exact submitted producer checks, disposal/supersession and poisoned issued failures.
  Fourteen focused tests cover all six allocation sites and queue/receipt failures.
  Native DPR 1/2 comparisons also verify 71 actual camera/patch payloads and effective
  neighbor lookup tables per DPR against the frozen GPU reference. Observation uses
  proof-only uniform/storage mirrors because reference buffers omit COPY_SRC; their
  original usage flags are unchanged. Full checks pass: 1,763 tests, two opt-in
  pending, typecheck, build and bilingual docs (848 public symbols).
- Pending: CPU terrain integration, updated
  production/native lifetime gates and final performance/cleanup evidence.

## Contract review

Independent review required explicit pending-publication ownership before any
pre-submit failure, queued-work observation even after receipt/reconciliation error,
selection revision through every product, retained-request completion wakeups and
disposal ownership. ADR-129 now records these requirements. CPU product review also
corrected foreign-cover constructor attribution and clarified that the selector,
not its immutable returned selections, has a disposal lifecycle.

## Verification and rollback

Evidence is under `/tmp/geoscratch-cpu-production-*`. The native comparison is
reproducible with `GEO_CAMERA_COVER_COMPARE_CPU=1 node tests/browser/geo-webmercator-camera-cover.mjs`.
It compares CPU production primitives with the actual frozen GPU selector and
source projector, while retaining the independent geometric checks. Ordinary GPU
proofs and archived source-root probes retain their original entrypoint.

Each completed slice runs focused checks, typecheck, tests, build and matching
bilingual API/documentation gates before commit. Revert dependent slices in reverse
order. Frozen Flow Layer, Flow Field execution placement and backend data are outside
this terrain migration; reference files are enforced by `camera-cover-gpu-reference.test.js`.
