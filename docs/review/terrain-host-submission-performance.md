# Terrain host submission performance

Date: 2026-09-10. Baseline: `ed0d207`, with ADR-128 feedback correction.

## Scope and measurement

This audit isolates the synchronous renderer/submission cost before deciding whether
to replace GPU camera cover with CPU cover. Both alternatives keep the same indexed
instanced drawing and existing Worker/Virtual Raster resource ownership.

The opt-in [placement harness](../../tests/experiments/terrain-cover-placement/README.md)
records a requested 100-us DevTools sampling profile with
`TERRAIN_PLACEMENT_HOST_PROFILE=1`, or inclusive function/native timers with
`TERRAIN_PLACEMENT_HOST_TIMING=1`. Use separate runs with both probes disabled for
latency comparisons. The timers cover the synchronous `graph.render()` scope;
the profile also sees asynchronous feedback, MapLibre and proof DOM publication.
Nested attribution times overlap and are not additive. Native-call timers are
not GPU duration or completed data-transfer measurements.

The first M1 Max / Chrome 152 baseline uses the existing 1280x800, pitch-70,
zoom-10.25, 40-bit terrain trace. Its instrumented moving-frame averages are:

| Inclusive scope | Shaded | Wireframe |
| --- | ---: | ---: |
| Terrain submission function | 1.93 ms | 1.89 ms |
| Scratch submit | 1.21 ms | 1.18 ms |
| Cover view preparation | 0.35 ms | 0.34 ms |
| Submission preflight resolution | 0.20 ms | 0.20 ms |
| Begin native observation | 0.21 ms | 0.20 ms |
| Observation input validation, within the preceding scope | 0.12 ms | 0.12 ms |
| Resource diagnostic fact updates, 28 per frame | 0.10 ms | 0.11 ms |
| Persistent-count diagnostic snapshot | 0.07 ms | 0.07 ms |
| Graph identity snapshot | 0.06 ms | 0.05 ms |
| Native queue submit calls, two per frame | 0.013 ms | 0.012 ms |

This first attribution includes 89 frames strictly inside each motion interval,
before its trailing settlement. The harness also records complete trace boundaries
for subsequent per-frame summaries. Evidence: `/tmp/geoscratch-host-submit/`,
`baseline-profile/` and `baseline-timing/`. Neither instrumented run establishes a
production speedup or a universal hardware floor.

## Selected optimization boundary

The profile and source agree on avoidable diagnostic construction:

- `assertObservationInput()` validates each internally generated issue by building,
  cloning and deeply freezing an entire hypothetical failed native outcome, then
  discarding it. The actual output still needs validation and immutable ownership;
  input validation does not need a fabricated outcome.
- `resourceFact()` reserializes/hashes immutable allocation descriptors on content
  epoch changes. `updateResource()` also rescans all resource footprints even when
  only an epoch/state changes. Allocation replacement and resource disposal must
  retain their existing accounting and failure semantics.

These are candidates for internal reuse/direct validation, not permission to cache
submission readiness or disable provenance/native error observation. Measure them
before accepting a production change. The current per-frame identity/count checks
remain part of the measured baseline.

Each verified implementation phase is committed separately. Revert later evidence
updates before their implementation commits; never reset the shared checkout.

## Attribution checkpoint

The profile and timing smoke runs passed A-B-A and native cleanup checks. The final
timer harness reports 35 scopes over 91 admitted frames per presentation, including
settlement. Typecheck, the full test suite (1,734 passing, two opt-in pending), docs
validation and production build pass. No production source or public API changed
in this checkpoint. Reverting its commit removes only experiment instrumentation
and this audit.

## Diagnostic work reduction

The implementation now validates planned native stages/locations directly, retaining
cycle and duplicate rejection before observation reservation. Actual public outcomes
still validate, copy and deeply freeze their evidence. Resource diagnostic updates
reuse descriptor hashes and logical footprints only within the same allocation
version; content state/epochs, query slots and allocation-operation IDs remain fresh.
Pressure is recomputed when footprints change and at registration/disposal. There is
no new public symbol, readiness cache, validation switch or submission contract.

The paired instrumented run reduces observation input validation from about 0.12 ms
to 0.04–0.05 ms per moving frame, and resource fact work from 0.08–0.10 ms to
0.03–0.04 ms. These are overlapping/instrumented attribution scopes, not claimed
end-to-end savings. Two uninstrumented 52-bit rounds on each side do **not** yet
establish an overall speedup: GPU construction p50 ranges from 1.4–1.6 ms shaded /
1.5–2.1 ms wireframe before, and 1.6 / 1.8 ms after. CPU construction ranges from
1.6 / 1.4–1.5 ms before to 1.8–2.0 / 1.6–1.8 ms after. Retain this variability
rather than selecting only the favorable attribution run. Evidence directories are
`before-52-*`, `after-52-*` and `optimized-timing/` under the audit directory.

Five new regressions cover immutable old snapshots, current epochs, pending and
committed replacement provenance/footprints, native-plan identity and malformed,
duplicate/cyclic plan rejection without native work. The full suite passes with
1,739 tests and two opt-in pending; typecheck, build and all documentation commands
pass. Generated public facts and translation digests remain unchanged.

Native 52-bit rendering, streaming and lifecycle gates, DPR 1/2 camera-cover checks
(including overflow/quality revocation), and the real native-submission/readback
failure probes pass with owned-process cleanup. Two pre-existing proof assumptions
were corrected independently: the lifecycle experiment now asserts the requested
coordinate precision instead of hardcoded 40 bits, and the native probes use the
current GPU `ScratchDiagnosticError.context.incident` contract instead of the removed
top-level `incident`. The incident identity/attribution/failure-stage assertions are
unchanged. The production geometry selector, shaders and Worker/resource contracts
are unchanged.
