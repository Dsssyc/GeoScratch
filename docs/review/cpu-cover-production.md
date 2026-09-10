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
- `7974b5b`: upload ownership/receipt implemented: six GPU buffers, private opaque uploads,
  exact submitted producer checks, disposal/supersession and poisoned issued failures.
  Fourteen focused tests cover all six allocation sites and queue/receipt failures.
  Native DPR 1/2 comparisons also verify 71 actual camera/patch payloads and effective
  neighbor lookup tables per DPR against the frozen GPU reference. Observation uses
  proof-only uniform/storage mirrors because reference buffers omit COPY_SRC; their
  original usage flags are unchanged. Full checks pass: 1,763 tests, two opt-in
  pending, typecheck, build and bilingual docs (848 public symbols).
- CPU terrain integration implemented: the production renderer selects/project on
  CPU, uploads six parity geometry buffers plus two indexed-argument buffers, and
  runs only its terrain GPU pass. It removes cover/demand readback and compute
  objects, while retaining the frozen terrain shader and existing resource pipeline.
  Thirty focused tests cover current CPU intent, retained request completion,
  A-B-A fresh provenance, pre-queue retry, uncertified cut rejection, native failure,
  partial construction cleanup, borrowed ownership and pending-publication gating.
  The native 52-bit render, lifecycle and 150-ms delayed streaming gates pass.
  DPR 1/2 primitive checks again match 71 ordered cuts, 71 actual uploads and three
  failed cuts per DPR. Full type/test/build checks pass: 1,772 tests, two opt-in
  pending; 848 public symbols and 20 bilingual canonical pages.
- Native submission observation/readback transaction gate passes against the stable
  completed build (`renderer-native-observation-2`). An earlier overlapping build
  replaced served dist modules and invalidated a probe; that run is excluded.
- Pending: native high-refresh production/reference comparison, recorded below when complete.

## Contract review

Independent review required explicit pending-publication ownership before any
pre-submit failure, queued-work observation even after receipt/reconciliation error,
selection revision through every product, retained-request completion wakeups and
disposal ownership. ADR-129 now records these requirements. CPU product review also
corrected foreign-cover constructor attribution and clarified that the selector,
not its immutable returned selections, has a disposal lifecycle.
Renderer review found two additional issues, now covered by regressions: borrowed
Virtual Raster initialization is one-shot, so its own failure is terminal; staged
pages must wait for the prior publication acknowledgement before requesting a
follow-up. The two-slot controller test observes exactly one follow-up after release
and none while acknowledgement is held. A second independent review reports no
remaining blockers.

## Verification and rollback

Evidence is under `/tmp/geoscratch-cpu-production-*`. The native comparison is
reproducible with `GEO_CAMERA_COVER_COMPARE_CPU=1 node tests/browser/geo-webmercator-camera-cover.mjs`.
It compares CPU production primitives with the actual frozen GPU selector and
source projector, while retaining the independent geometric checks. Ordinary GPU
proofs and archived source-root probes retain their original entrypoint.

Production integration evidence:

- `/tmp/geoscratch-cpu-production-renderer-render-1/result.json`: wide top-down,
  continuous pitch/zoom, odd-parity A-B-A, shaded/wireframe 90-frame and DPR gates.
- `/tmp/geoscratch-cpu-production-renderer-lifecycle-1/result.json`: native
  provenance, rapid-camera transitions, initialization failure and teardown.
- `/tmp/geoscratch-cpu-production-renderer-streaming-1/result.json`: real Worker,
  cache reload, constrained-budget, cancellation and terminal failure, with 150-ms
  tile request delay; existing COG/manifest hashes remain unchanged.
- `/tmp/geoscratch-cpu-production-renderer-native-final.json`: CPU products/uploads
  versus frozen GPU, independent coverage/quality/adjacency checks at DPR 1/2.

Each completed slice runs focused checks, typecheck, tests, build and matching
bilingual API/documentation gates before commit. Revert dependent slices in reverse
order. Frozen Flow Layer, Flow Field execution placement and backend data are outside
this terrain migration; reference files are enforced by `camera-cover-gpu-reference.test.js`.
