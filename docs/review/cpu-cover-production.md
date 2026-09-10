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
- `028246a`: CPU terrain integration implemented: the production renderer selects/project on
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
- Four interleaved 52-bit headless production/reference performance runs pass at
  `028246a`, in CPU/GPU/CPU/GPU order. The frozen GPU renderer is explicitly replayed
  from `ebb3336`; current CPU source is never labelled as GPU. Results and limits
  appear below. The high-refresh secondary-display attempt was blocked before
  browser launch because no qualifying non-main display was available. It is not
  counted as a performance result; the existing two-frame policy is unchanged.

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

## Production/reference performance

The four accepted runs use Chrome 152.0.7977.83, Apple Metal-3 WebGPU, 52-bit
coordinates, 1280 x 800 reference pixels, DPR 1, existing terrain data and a
headless host cadence of approximately 16.7 ms. They are `headless-cpu-1`,
`headless-gpu-1`, `headless-cpu-2`, `headless-gpu-2` under
`/tmp/geoscratch-cpu-production-`. Each executes 90 shaded and 90 wireframe camera
moves without timers, then repeats with sampled GPU timestamps. The table gives
the two **per-run** statistics as ranges, not pooled percentiles. Construction is
the whole synchronous renderer call in these fixed-size traces; observation runs
from the controller submitted callback to its observed callback, after construction,
and includes native completion plus callback/proof scheduling. Neither is isolated cover arithmetic.

| Scope | CPU production | Frozen GPU reference |
| --- | ---: | ---: |
| Shaded construction p50 | 1.4 ms | 1.3 ms |
| Shaded native observation p50 | 6.6–7.0 ms | 8.5–8.6 ms |
| Shaded native observation p95 | 10.3–10.8 ms | 11.0–11.3 ms |
| Wireframe construction p50 | 1.2–1.9 ms | 1.2 ms |
| Wireframe native observation p50 | 8.3–9.7 ms | 8.7–9.3 ms |
| Wireframe native observation p95 | 11.0–15.3 ms | 11.1–14.1 ms |
| Submitted frames per 90 moves | 90 | 91, including confirmation |
| Submitted-camera lag p95 | 0 moves | 0 moves |
| First executor request after cold move | 10.9–11.4 ms | 20.5–22.7 ms |
| Acknowledged selected-resource readiness, 20-ms polling | 149.8–170.4 ms | 147.2–168.7 ms |

The CPU path removes GPU cover, source-projection and argument-preparation passes;
timestamped traces contain only terrain draw. Those diagnostic traces have different
instrumentation overhead and pass-duration variability; their medians must not be
added to untimed construction or observation values. All traces retain the two-frame
in-flight bound, 89 raw lag samples, current-capture convergence, A-B-A equality and
zero pending controller/query work after draining. Every owned browser, Vite and
existing-data service closes; source, experiment and backend-data hashes are stable.

These results support earlier resource intent and lower shaded observation latency
in this tested setup. They do **not** show lower synchronous construction, consistently
faster wireframe completion, or earlier fully acknowledged resource readiness.
Whole-scenario page-main-thread task time also varies: CPU 1,216.5–1,583.2 ms versus
GPU 1,519.2–1,720.1 ms. It includes MapLibre, proof publication, loading, asynchronous
callbacks and differing frame counts, so it is not isolated terrain CPU cost. No
universal speedup or 144-Hz production result is claimed. The earlier high-refresh
prototype comparison remains historical evidence, not a measurement of this new
production implementation.

At this descriptor (256 patch capacity), production owns 27,936 logical bytes for
six geometry upload buffers and 40 bytes for two indirect argument buffers. Cover
facts separately report 14,380 bytes of persistent typed-array CPU workspace; that
excludes JS objects and temporary products. The renderer owns 13 GPU resources in
total, including mesh/config/depth, with 5,043,584 logical bytes at 1280 x 800.
These scoped values exclude borrowed Virtual Raster and Surface resources and are
not physical driver-memory measurements. The historical renderer's
`persistentFacts()` counted runtime-wide resources, so its total must not be
subtracted directly from this new scoped total.

A separate 150-ms delayed-tile moving-reveal run
(`/tmp/geoscratch-cpu-production-reveal-1/result.json`) issues all 18 new requests
during 90 continuous camera moves and none only after motion stops. The latest
capture and demand generation converge without another user camera event; exact
selected resource readiness is observed 169.2 ms after motion stops. The immediate
readiness snapshot still has one native frame in flight; later cleanup observes
zero pending work and no retained actions or failures. Resource readiness is not
misreported as completion of that last native draw.

## Final rollback

`028246a` is the production integration checkpoint; its full reverse patch passed
`git apply --reverse --check` immediately after verification. To restore the frozen
GPU terrain producer, revert this later report commit first, then `git revert 028246a`.
The independent CPU APIs can remain unused, or be removed by reverting `7974b5b`,
then `b660d22`. Revert `2fd6d8f` only to remove the reference guard itself. Never reset
the shared working tree or regenerate backend data as a rollback method.
