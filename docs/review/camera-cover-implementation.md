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

Stage 2 is verified. Stages 3–5 remain pending.

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
| Design | `635016b`; `npm run docs:check` and `git diff --check` | Verified |
| Outcome boundary | Empty feedback, failed-cut revocation and GPU consumer guards | Verified: main, wireframe and streaming native gates passed |


## Baseline Observations (2026-09-09)

The exact `071d82b` source was archived into an isolated temporary checkout, with
existing DEM data reused. Chrome 152.0.7977.83 ran headless on the native Apple
Metal 3 adapter (not a fallback adapter). Original assertions in the three Terrain
browser scripts all passed; only build preparation was skipped in their temporary
runners. COG and manifest hashes were unchanged, and all owned browser/server ports
closed. The wireframe proof includes DPR 1, 1.25, 1.5, 2 and 3, continuous pitch,
wide top-down, zoom, A-B-A, 2:1 and 90-frame shaded/wireframe camera transitions.
Both 90-frame runs submitted all 90 transitions with no stale transition.

A separate public-cover microbenchmark used synthetic projection matrices, no
Surface, no Worker and no backend. Each scenario submitted 112 frames: 14 warmup,
98 timed; one encoder in seven carried timestamps, giving 14 GPU samples. These
numbers are not Flow Field timings or end-to-end frame critical paths.

| Scenario | Patches | Candidate feedback | GPU cover mean |
| --- | ---: | ---: | ---: |
| flat-z9 | 8 | 1028 | 2.904 ms |
| pitch70-z10 | 64 | 1044 | 8.846 ms |
| wide-flat-z13 | 8 | 1092 | 3.622 ms |

Timestamp and native errors were empty. Stage comparisons must reuse these exact
synthetic inputs and measurement conditions, including the observer overhead.

## Outcome Boundary Verification

The focused native outcome fixture injects valid and invalid cover state into the
public downstream adapters. Both parity resources are exercised. Normal and
post-failure recovery produce two demand pages/two draw instances; a valid empty
cut produces neither. Descriptor overflow, lookup overflow and incomplete adjacency
produce zero draw instances and zero demands with a projection failure marker.
Frame mismatch is rejected by projection and feedback; the draw adapter has no
independent frame metadata binding and the fixture does not claim otherwise.

The cover kernel itself revokes its patch count and lookup when construction fails.
CPU feedback still rejects that failed result. This prevents partial geometry use
without converting failure into a successful empty cut. The eight native fixture
cases passed with successful native observation, no uncaptured error and zero final
resource/readback/staging/mapping/pending counts.

Node focused cover tests: 20 passing. Full `npm test`: 1690 passing, 2 pending. `npm run typecheck` and `npm run build` passed; the
existing Vite large-chunk warning remains. Bilingual API generation, translation
digests and read-only docs checks passed.

All three Terrain gates also passed on the outcome-boundary implementation.
Each shaded/wireframe run retained 90 submitted transitions, zero stale transitions,
and the two-frame bound. Backend hashes remained unchanged; all owned ports and
browsers closed. Revert this stage to restore the old outcome handling while
retaining the design record.
