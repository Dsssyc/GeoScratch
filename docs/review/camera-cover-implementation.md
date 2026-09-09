# Camera Cover Implementation and Evidence

Branch: `camera-cover`. Baseline: `071d82ba6c990fd824ac7beba40eca6254225387`.
Design authority: [ADR-125](../decisions/ADR-125-camera-cover-parallel-execution.md).

## Scope and Existing Resource Contracts

This work optimizes the geometry cover and its failure boundary. Worker/System/Pool,
Persistent Cache, request scheduling, owned payload transfer, Virtual Raster
publication, temporal runtime windows and frame admission remain existing owners.

The resource audit was checked against current source and canonical API, not the
older Tiles/LoD vision's superseded frontier/residency-driven selector. Its important
constraints are:

- `settled` aggregates request completions; it is not all-pages-success or GPU-ready.
  Worker acceptance may include a cache write after payload staging.
- CPU `resident` can precede encoding/acknowledgement. Consumers must preserve the
  actual publication-to-use order; a cached Boolean cannot prove a later snapshot.
- `ViewDemandProducer` selects within its explicit budget. Geometry coverage and
  exact resource residency are different sets. Keep selected resident pages in
  reconciliation, terminal failure distinct from missing, and safety fallback.
- Snapshots own mappings, not bytes or an indefinite physical-slot lease. Publication
  bytes and upload snapshots have distinct costs; staging budget is not total memory.
- Flow's current capture/publication/readiness sequence and one-frame bound must
  remain; ADR-106 permits local motion without full-view presentation readiness.
- Terrain's same-decision follow-ups must not strand the delayed feedback pump.
- Optional progress notifications, universal consumer/snapshot validation, and
  non-cooperative Worker shutdown escalation need separate designs if requested.
  They are not hidden prerequisites implemented inside cover work.

## Stages

1. Design and baseline: record scope, tests and native measurement conditions.
2. Outcome boundary: legal empty feedback and rejection of failed partial cuts by
   GPU demand/draw consumers, without changing resource scheduling semantics.
3. Candidate completeness: establish conservative eligible-parent enumeration and
   an independent finite-domain reference; preserve the accepted quality metric.
4. Parallel execution: candidate work, deterministic compaction, exact hierarchy
   dependencies and indexed local closure, with measured stage/storage costs.
5. Integration acceptance: all current Terrain gates and Flow spatial/resource
   continuity gates; record timings and limitations without extrapolating old data.

Stages 2–5 are pending. The design commit does not certify their implementation.

## Correctness Obligations

1. Visible coverage is contained in the initial coarse set. Every replacement is
   exactly one parent's four children; only conservative invisibility removes area.
2. Every visible, eligible parent whose current metric exceeds its threshold is
   checked. No unproved radial monotonicity or capacity-derived radius is accepted.
3. Selection flags depend on current immutable inputs. Processing order, parallel
   scheduling, residency and prior topology do not influence final identities.
4. The final cut is prefix-free and its positive-length edge overlaps differ by at
   most one level. Closure reaches a fixed point or fails explicitly.
5. Construction outputs remain unavailable to downstream work until final validation.
   Empty visibility and construction failure are distinct outcomes.
6. Current-view intent epochs and actual GPU-producing receipts remain distinct;
   stale feedback does not become current-view completeness evidence.

## Measurement Plan

Compare serial baseline and accepted implementation with the same camera sequence,
viewport, DPR, vertical bounds, policy, source data, browser and adapter. Record
candidate counts separately from expensive metric evaluations, final/peak patches,
closure rounds, dispatch count, scratch bytes, GPU pass latency and host construction
cost. Include static views (Flow reuse), continuous camera changes and small/large cuts.
Timestamp instrumentation is diagnostic and can perturb execution; compare uninstrumented
frame behavior too. Do not sum sampled pass means as a guaranteed frame critical path.

## Rollback Checkpoints

Record the verified commit for each stage below. Revert later dependent stages first.
Do not reset this checkout, edit frozen Flow Layer or regenerate backend data.

| Stage | Commit / evidence | Status |
| --- | --- | --- |
| Baseline | `071d82b` | Source and resource audit completed before branch creation |
| Design | This document and ADR-125; `npm run docs:check` and `git diff --check` | Verified |
