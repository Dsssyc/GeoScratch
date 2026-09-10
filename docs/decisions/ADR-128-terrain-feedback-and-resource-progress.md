# ADR-128: Consume Terrain Feedback Asynchronously and Preserve Resource Progress

## Status

Accepted. Refines the feedback scheduling in ADR-080/081/125 while retaining the
GPU geometry authority, reference-pixel quality, sparse parent decisions, 2:1 and
the independent Worker/Virtual Raster ownership contracts.

## Date

2026-09-10

## Context

The renderer waited for a newer submitted frame before mapping a captured GPU
result, then rejected resource reconciliation when that observation's camera
decision had been superseded. In the 90-move terrain experiment, no new detail
requests started during approximately 1.5 seconds of continuous motion. The CPU
comparison avoided this delay, but that did not establish that GPU cover itself
was inappropriate.

Removing the artificial frame delay allowed all 18 new requests to begin during
ordinary motion. A 40 ms feedback-consumer delay still made every observation old
before adoption. Reconciling complete source observations independently from
geometry currentness restored request progress. These observations are computed
from the certified cover and immutable source coverage, not from atlas placement.

A longer delay also exposed wasteful waiting: uncaptured frames returned an empty
settlement while requesting another frame. That empty settlement reset the generic
follow-up budget, so occupied readback capacity could produce repeated renders.
Feedback availability needs an actual asynchronous wakeup, not speculative drawing.

## Decision

- Start feedback consumption after its own submission. Preserve Scratch staging,
  native failure, mapping lifetime and producing-epoch validation.
- Retain one GPU camera-cover geometry authority. Only matching camera-decision
  observations update current cover and current source-selection facts.
- Accept each monotonically newer complete source-demand observation for resource
  reconciliation. Source/coverage identity is immutable for the renderer lifetime;
  retain the observation's actual view, frame and residency provenance. An older
  observation cannot overwrite a newer resource target or certify the current view.
- Reconcile the entire budget-selected resource set, including resident pages.
  Keep request retention, cancellation, terminal failure, safety-page reservations,
  unique payload ownership, publication ordering and native acknowledgement intact.
- A superseded frame settlement may report independent resource work. Include
  retained active requests in the work count and carry their real settlement promise.
  No universal ready flag, GPU residency mirror or new Worker scheduler is introduced.
- Treat selection settlement and resource completion separately. Once the current
  geometry/source observation is known, loading completion drives future publication
  through the existing frame settlement contract.
- Do not submit polling frames while feedback is pending. Same-decision frames share
  captured settlement. When both capture slots are occupied, retain one latest-frame
  waiter; replace/release older waiters. Slot release wakes the current waiter with a
  request to capture the current view and any applicable real resource work. It carries
  no old geometry certificate. Current feedback requests one confirmation/publication
  frame; an unchanged settled decision does not capture another result.
- Settle waiting on disposal and reject waiting on feedback failure. Keep the generic
  frame controller and its in-flight/follow-up budgets unchanged.

## Consequences

Resource targets can lag the camera by the actual feedback latency while still
advancing during continuous motion. That is explicitly different from current-view
geometry/readiness certification. Rapid motion can request pages that later become
irrelevant; existing budgets/cancellation constrain this cost, which must be measured.
The existing residency stale counter also counts safe retirement of already-staged
pages. Native audits distinguish those released bytes from rejected late staging or
unrequired uploads; a zero cumulative retirement count is not the correctness invariant
for proactive loading during rapid camera changes.

GPU versus CPU execution remains a performance choice requiring matched contracts
and full application costs. This change repairs GPU resource progress rather than
establishing a universal execution-location winner. CPU prototypes remain opt-in
experiments; production keeps its GPU selector and existing raster infrastructure.

## Verification and Rollback

Regression tests exercise single-frame mapping, old observation/current geometry
separation, retained work, invalid feedback, bounded latest waiting and disposal.
Native gates cover continuous motion, delayed feedback, source streaming/cancellation,
tight capacity, cache, DPR, wide views, pitch, 2:1 and cleanup. The branch review records
bounded timing and request-count results; timing is not a public performance guarantee.

Each experiment and production change is committed separately. Revert later review/
production commits before their experiment dependencies. The frozen Flow Layer and
existing backend data are unchanged.
