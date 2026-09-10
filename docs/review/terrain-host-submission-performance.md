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
