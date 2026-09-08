# ADR-124: Prepare Flow Content After History Uniform Upload

## Status

Accepted. Example-local submission ordering. No public Scratch/Geo queue policy,
frame-in-flight budget, particle physics or history-retention change.

## Date

2026-09-08

## Context

After spatial decision reuse, a resident Flow frame still split into two native
submissions because the history uniform upload followed particle compute. Scratch
correctly closes an encoder before an ordered queue upload. The application can
prepare these independent uniforms earlier without weakening that queue contract.

## Decision

Allow `FlowHistory.encode()` content to be either its existing readonly draw array
or one synchronous content producer receiving the same open SubmissionBuilder and
returning the draw array. History prepares/uploads its own uniform before invoking
the producer exactly once. The renderer's particle-view producer then encodes
particle work and optional contour work in their preceding relative order.
Source-center cache building follows the producer, then history clear/composition,
visible clipping and Surface copy. History does not import or own particles or
contours; the producer is an application-owned composition point, not a new
resource, readiness state machine or preparation ticket.

Before the producer returns successfully, history does not advance its previous
view, direction, retained image, pending-clear state or cache build. Non-array or
asynchronous results, submitted builders and reentry are rejected. Individual draw
command validity remains Scratch's responsibility, as on the existing array path.
A producer's
own side effects cannot be rolled back automatically; the caller must discard a
failed partial builder and follow the existing frame-owner cleanup path.

The array path remains available for existing callers and inspector views.
Zero-time particle presentation returns no old segment and performs no hidden
simulation. Retained-only presentation does not invoke a content producer.
`current-at-step` resource dependencies continue to prove that the same frame's
particle writes precede drawing. No raw native queue or builder-step mutation is
introduced.

## Verification And Limits

Tests must establish one synchronous invocation with the same builder, exact
upload/compute/cache/render order, unchanged array behavior, no history-state
advance on producer failures, and rejection of asynchronous/submitted/reentrant
use. Actual graph, camera, time-pair, contour, cache hit/miss and cleanup checks
remain separate from native submission-count benchmarks.

The native retained-history proof compares both paths across A/B/C/D boundaries
and two current-frame content values: identical Surface bytes, with two native
submissions for arrays and one for producers. The real contour-order proof also
checks playback/pause, Status/Speed, temporal provenance and a frozen on/off/on
overlay image, avoiding reliance on control-panel mocks alone.

Only a settled steady frame without spatial/spawn/cache rebuilds or optional
contour work is expected to reach one native submission. Initialization, source
publication, rebuilding or additional content may legitimately need more. Fewer
native submissions are not a promise of a corresponding GPU-time or utilization
percentage. Use the corrected continuous intervals in the
[benchmark record](../review/flow-pipeline-optimization-benchmarks.md).

## Rollback

This phase follows endpoint-cache commit `c1423d5` and is committed independently.
Revert it to restore the previous upload order while retaining the earlier
spatial, sampler and cache optimizations. No backend migration is required.
