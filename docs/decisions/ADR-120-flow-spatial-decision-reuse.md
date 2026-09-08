# ADR-120: Reuse Observed Flow Spatial Decisions

## Status

Accepted. Changes only Flow Field's invocation policy, not Geo's cover algorithm,
selection rules, Virtual Raster residency, backend data, or frozen Flow Layer.

## Date

2026-09-08

## Context

At the resident zoom-9 reference view, Flow Field spent approximately 4.10 ms in
cover generation and 0.27 ms in demand projection every animation frame. Neither
velocity interpolation nor a new residency publication changes this spatial
decision. Matching Flow Layer's approximately 60 updates/s did not establish equal
GPU cost. The repeated cover, projection, and their three feedback captures are
avoidable when every camera fact and construction policy remains unchanged.

## Decision

The example's `FlowViewDemandAdapter` retains exactly one successfully observed
spatial result. It compares stable view identity, camera matrix/high-low position,
reference viewport, zoom, FOV, latitude and pitch. Frame and residency epochs are
not spatial keys. Source coverage, spatial profile, policy and the flat vertical
range remain fixed for the adapter's lifetime; this is not a multi-view cache.

On a matching view, cover/projection hooks encode no new spatial GPU work or
readbacks. `flowProjectedDemandBatch()` still assigns the current view's frame and
residency provenance to the demand intent. Pages are materialized in the current
temporal runtime's address space, never borrowed from the preceding time slice.
The retained GPU feedback keeps its real original source view and submission
receipt. `latestSettledFrameEpoch` remains the last actual spatial GPU result; it
does not pretend a reuse frame generated new GPU evidence.

The current submission is still observed. A successful native outcome, or a legal
no-native-work receipt on a reuse frame, can settle reuse. Failure invalidates
reuse; new spatial work invalidates it before parity resources can change. Staged
or unobserved results cannot be reused. A-B-A camera motion therefore builds A,
then B, then A, rather than borrowing possibly overwritten GPU parity. Disposal
revokes reuse immediately, and a late observation cannot restore it.

Cover descriptor/lookup overflow retains its existing fatal behavior. Projection
overflow remains a bounded signal for the downstream coordinator's existing
complete-coverage fallback, including on reused batches. It is not converted into
a new fatal error.

`buildCount` and `reuseCount` count encoded adapter batches, not successfully
completed GPU work. Existing Geo view/frame authority remains the only camera
authority; there is no extra MapLibre move/render revision state or scheduler.
Temporal publication, request reconciliation, particle advancement and presentation
continue independently during spatial reuse.

## Verification

Node adapter tests cover original receipt preservation, current batch provenance,
all camera-key fields, A-B-A, unobserved/staged work, live-builder ownership,
failed/no-native receipts, cover versus projection overflow, and disposal races.
The real-page spatial-reuse test verifies stable playback, paused presentation,
new time-pair resource ownership, pan, pitch, reference-viewport resize, resumed
animation and cleanup. Continuous camera and existing visual-time/browser checks
remain regression gates.

The steady zoom-9 benchmark reduced native submissions from four to two per frame.
Cover and projection passes disappeared from the resident steady-state sample;
their build count stayed at one while 420 additional animation frames reused it.
Particle simulation remained approximately 6.55 ms versus the 6.59 ms baseline,
as expected for a change that does not touch particle sampling. See the living
[benchmark record](../review/flow-pipeline-optimization-benchmarks.md).

## Limits And Rollback

Moving cameras still pay the unchanged cover cost. This does not solve the earlier
empty-cover observation, change quality thresholds, relax 2:1 adjacency, or claim
system GPU-utilization savings from FPS alone. No public Scratch/Geo API changes.

Baseline `8d44021` is retained at `socu/flow-before-pipeline-8d44021`. This phase is
committed separately from velocity sampling, presentation and cache optimizations.
Revert its commit after reverting any dependent later phases; do not reset the
shared worktree or regenerate backend data.
