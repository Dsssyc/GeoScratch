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

All implementation stages and final integration gates are verified. The resource
production, temporal readiness and frame-admission authorities remain unchanged.

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
| Outcome boundary | `0b3381c`; empty feedback, failed-cut revocation and GPU consumer guards | Verified |
| Candidates and clipping | `9346313`; conservative domains and relative-world clipping | Verified |
| Parallel execution | Final implementation checkpoint; indexed closure and ownership cleanup | Verified |


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


## Candidate Domain Derivation

For a clipped sample, the Jacobian column is `h * s_i / w * (M_ij - ndc_i * M_wj)`.
Clamping numerical NDC to the exact clipping domain gives the Frobenius bound
`h * ||B||F / w`, where `B_ij = s_i * (abs(M_ij) + abs(M_wj))`. The minimum-cell-w
refinement guard supplies a second depth cap. Their maximum includes every parent
whose implemented metric can exceed the threshold. If `A` approximates `M^-1`,
`p = A*c + (I-A*M)*p`; outward interval arithmetic bounds both terms over the known
geometry prism and clipped depth box. Four intersections only reduce domains already
proved to contain split candidates; this is not convergence-based early stopping.

The numerical contract is explicit: use the uploaded f32 matrix/viewport, include
52-bit-to-relative-f32 coordinate error and cell-width error, keep clipping ratios
within [0,1], and use a midpoint below a 2^-120 denominator. Clipping error has a
separate absolute floor. The computed metric bound follows entrywise Jacobian bounds,
Gram/Cauchy-Schwarz and the trace/Frobenius envelope; it does not apply relative
error to the cancellation in `xx-yy`. Nested-sqrt underflow has an absolute fourth-root
floor. Unsupported ranges fall back to the complete domain, subject to an independent
hard input enumeration budget. A budget failure is not proof that output patches
would overflow, and it never permits a smaller candidate window.

The independent finite-domain checker enumerates every tile without inverse bounds,
search radius or parent pruning. It also probes high-zoom window edges. Its explicit
f32 round-to-nearest execution is one implementation, not an exhaustive enumeration
of all WGSL-permitted floating-point outcomes. Native boundary tests remain required.

A concrete old-radius counterexample uses a top-down view at altitude 100000 m,
16384 x 128 reference pixels and FOV pi/3. At z6, row32/col40 has measured f32
cell stretch 5.4500594 above threshold 5.0250001. The old radius is three and ends
at camera column32+3=35. Its z5 parent at row16/col20 also lies outside the old
window and exceeds the threshold. Every ancestor qualifies; new windows contain
this complete chain. The correction therefore addresses a demonstrated candidate
omission, independently from GPU parallelization or resource readiness.


## Coarse High-Pitch Clipping Correction

An independent native descriptor/point gate found a baseline defect outside the
existing MapLibre camera scenarios. At synthetic world pitch 85 degrees, the old
kernel retained only `0/0/0` with reported span zero, while a visible point in that
leaf measured approximately 434 reference pixels. The same result reproduced on
exact `071d82b`; it was not caused by the candidate-window change.

A dynamic-identity shader probe traced polygon counts `[4,4,4,4,4,0]`. Mixing large
clip-space coordinates lost the near/far depth constant: after near clipping,
`w-z` was approximately 0.00256 instead of approximately one. The far intersection
then collapsed to roughly 2558 metres, and the final upper screen plane rejected
the polygon. Constant-folded probe identities produced different floating-point
expressions, so only the dynamic probe reproduced the production fault.

Clipping now stores camera-relative world xyz, forms the six raw plane equations
from the actual uploaded f32 matrix rows, interpolates xyz with homogeneous w fixed
to one, and projects only final samples. This is the same exact geometric predicate
with a stable numerical expression, not a new pitch mode or threshold. The
candidate numerical envelope separately includes world-coordinate/matrix FTZ
amplification and 256 clipping operation units. Uncertifiable nonnormal plane
coefficients retain the complete domain.

The corrected production gate passed 46 cases at each of DPR 1 and 2. Each DPR
checked 50,596 uniquely covered visible points and 45,789 independent point-quality
samples (maximum 4.9737 reference pixels). It covers actual descriptors, prefix
freedom, all positive-length edge overlaps, A-B-A/raw output order, high zoom to z24,
millimetre motion, height changes, legal empty visibility and real construction
failure. The extreme-wide top-down view must succeed; the separately budgeted
extreme-wide pitched stress accepts only a fully validated result or explicit
capacity failure with revoked patch count. No threshold was relaxed.

These finite samples complement the candidate-domain proof; they do not prove a
continuous whole-volume quality supremum. All native ownership counters converged,
and the proof's browsers/HTTP servers closed. The outcome fixture's eight cases
also passed on this production source. All three Terrain integration gates were rerun after this numerical correction
and passed with frozen production hashes, unchanged backend data, and complete
process cleanup. Nine canvas PNGs and all 86 pitch patch counts still match the
original baseline. These are the current shader acceptance results.


Candidate/clipping stage verification: `npm run typecheck`, `npm test` (1703 passing,
2 pending), `npm run build`, docs generation/translation checks and `git diff --check`
passed. One earlier full-suite run hit the existing 2-second API-document fixture
timeout under concurrent browser work; its isolated rerun and the subsequent full
suite passed without changing that test or its timeout. The emit-parity test now
allows added Geo modules while retaining independent exact comparison of every
emitted JavaScript/declaration file and rejecting missing/stale output.

The committed `tests/benchmarks/webmercator-camera-cover.mjs` reproduces the synthetic
measurement with CPU construction breakdown and source provenance. The final serial
correctness checkpoint measured the following GPU pass times immediately before
parallelization (14 samples per scene; milliseconds):

| Scene | Mean | p50 | p95 | CPU construction p95 |
| --- | ---: | ---: | ---: | ---: |
| flat-z9 | 2.744 | 2.505 | 3.702 | 0.800 |
| pitch70-z10 | 6.283 | 6.226 | 6.488 | 0.700 |
| wide-flat-z13 | 3.283 | 3.213 | 3.490 | 0.600 |

All benchmark native/page errors were empty and its runtime, timestamp mappings,
browser and Vite port closed. This is a checkpoint for controlled comparison,
not a general frame-rate claim.


## Parallel Execution and Order-Independent Closure

The graph uses two persistent dispatch commands per parity within its existing
compute pass. An indirect candidate dispatch (64 invocations/workgroup) consumes
CPU-known window counts from the same view upload. Its separate binding layout
reads only selection inputs and writes candidate workspace; it does not fabricate
writes/content epochs for public patches or state. A following 64-invocation
workgroup coordinates deterministic topology in one lane, then uses all lanes for
final quality evaluation and workgroup integer min/max reduction. Group-local
barriers do not stand in for a cross-workgroup barrier.

The topology coordinator remains serial; this implementation does not claim to
parallelize every instruction. It avoids global sorting/scan storage and repeated
level dispatches while parallelizing the expensive geometric predicates. Actual
measurements below, not workgroup size alone, determine the benefit.

Fine-side full-identity neighbor queries replace all-pairs GPU adjacency. Every
round marks its unchanged input before splitting and visibility compaction. A
minimal old-order counterexample starts with `3/6/4`, `2/3/1`, `5/27/20`; visibility
is `east + south > 47.5` in z5 integer coordinates. The new cut is `2/3/1`,
`4/13/9`, `5/27/20`. The old scan unnecessarily replaces `2/3/1` with visible child
`3/7/3` after temporarily invisible children of another split trigger it. All six
input permutations now produce the same identity set. The CPU oracle uses independent
pairwise marking, and persistent tests include 120 randomized cuts, holes,
minimum levels 0/3/20, z24, corner-only contacts and finite world boundaries.

Creation review also found the existing two `Promise.all` joins could clean up
while a sibling native allocation/BindSet preparation was still pending. Cover now
waits for every sibling to settle before cleanup. Three injected tests prove late
resource/binding ownership and multiple-failure aggregation; restoring the old
join in an isolated compiled copy makes all three tests fail.

For `maximumPatches=512` and the default `maximumCandidates=32768`, both workspace
buffers total 256 KiB. Existing patch/lookup buffers and upload/compiler costs are
separate. Indirect dimensions cover the actual candidates; the two-dimensional
mapping guards extra groups before multiplying to a u32 element index.


## Final Acceptance (2026-09-09)

- `npm run typecheck`: passed, including examples and WebGPU declarations.
- `npm test`: 1713 passing, 2 pending optional gates. No failing tests.
- `npm run build`: passed. The existing large Vite chunk warning remains.
- Canonical API generation, reviewed Chinese translation digests, and `docs:check`:
  828 symbols, 20 canonical pages and 20 translations verified.
- Native cover outcome: eight cases passed. Independent native camera cover: 46
  cases at each of DPR 1 and 2 passed, including descriptor-level topology and
  finite point coverage/quality checks, real failure revocation and legal emptiness.
- Terrain main, wireframe and streaming gates all passed on the final production
  hashes. The wireframe graph assertion now requires three unique command IDs per
  parity and six across both parities (`evaluate`, `generate`, feedback); it no
  longer assumes the removed single-dispatch graph.
- Flow camera continuity, spatial reuse, spatial handoff, inspector handoff,
  prefetch failure and the old empty-pan/reverse-recovery reproduction all passed.
  Five camera gestures admitted one particle step per submitted frame without
  resets/history clears. The empty-pan sequence observed demand pages 1 -> 0 -> 1.
- DEM and all 27 Flow COGs and their metadata retained their hashes. No backend
  build/data regeneration ran in browser validation. All owned browser/server
  processes closed and resource/readback/staging/mapping/capture cleanup passed.

The old spatial-handoff test required a refill while paused, contradicting ADR-119.
It failed unchanged on exact `071d82b` and `9346313`, as well as the new graph.
The corrected test passed on both baselines and the final implementation. It first
drains a zero-time observed frame, then requires resource recovery without changing
particle steps or refill count. Playback resume must consume the deferred refill.
For a paused seek, `resetCount` counts the call to `reset()`, not GPU execution:
one request is recorded while `resetPending` stays true and steps stay unchanged;
resume clears pending and advances without requesting a second reset. Production
Flow code, timeout limits and resource budgets were not changed to satisfy this test.

### Final Paired Performance Check

The committed benchmark ran exact `9346313` from an isolated archive immediately
before the final parallel source, with the same three synthetic inputs and native
Apple Metal 3 adapter. Each row has 14 GPU timestamp samples. Times below include
both parallel dispatches in the cover pass; no intermediate host readback was added.
They are not measurements of Flow's total frame cost or GPU utilization.

| Scene | Serial GPU p50 | Parallel GPU p50 | Serial CPU construction p95 | Parallel CPU construction p95 |
| --- | ---: | ---: | ---: | ---: |
| flat-z9 | 2.510 ms | 2.137 ms | 0.700 ms | 0.800 ms |
| pitch70-z10 | 6.194 ms | 2.048 ms | 0.600 ms | 0.600 ms |
| wide-flat-z13 | 3.215 ms | 1.181 ms | 0.500 ms | 0.600 ms |

Two additional final-source runs observed GPU p50 values of 1.943/2.681/1.135 ms
and 1.853/2.627/1.129 ms in the same scene order. An earlier run was faster. These
variations are retained rather than choosing the best sample: small cuts can be
sensitive to dispatch/driver/system costs, and no fixed speedup is promised. The
pitched and wide cases consistently improved in these measurements. Topology
coordination is still serial and remains a possible future bottleneck at large
capacities; further parallel compaction must earn its additional dispatch/storage
cost in measured cases.

### Rollback

Revert later dependent commits first. Reverting the parallel implementation restores
`9346313`'s verified serial geometry construction while retaining the candidate and
clipping repairs. Reverting that earlier stage also requires removing its dependent
parallel implementation; `0b3381c` retains only valid-empty/failed-cut protection.
The design checkpoint `635016b` has no runtime effect. No backend migration or data
rollback is involved, and frozen Flow Layer has no changes in this branch.

## Review Repairs: Vertical Metadata and Feedback

The post-implementation review found two pre-existing height issues. This first
repair addresses metadata lookup/enclosure; continuous height-interval projection
remains a separate subsequent repair. ADR-126 records the distinction.

- Cover and CPU reference resolve the nearest declared ancestor outside narrower
  finer limits, reject incomplete or non-enclosing declared records before GPU
  allocation, and reject missing huge hierarchies by count without enumeration.
- Native terrain exposed source-level extrema that were not ancestor envelopes.
  Terrain now derives the conservative envelope from immutable source metadata
  before allocating its resources. No DEM/Worker/backend data was rebuilt or edited.
- Cover/demand feedback use stable Geo diagnostic codes and reason fields. Empty
  results, failed-cut revocation, epochs and downstream ownership are preserved.
- Candidate fixtures explicitly exercise both 40-bit and 52-bit positions.
  Canonical English/Chinese docs clarify relative tolerance and metadata conversion.

Verification: focused tests, typecheck, docs generation/translations/check, production
build and the full suite (1719 passing, 2 opt-in pending) passed. Native outcome
checks and 49 camera scenarios at each of DPR 1/2 passed, including narrower metadata
coverage and A-B-A. All three existing terrain browser suites passed: wide top-down,
continuous pitch/zoom, DPR, 90-frame shaded/wireframe, rapid transitions, source
demand, feedback convergence, streaming/failure/cancellation and cleanup. Owned
browser/service processes closed. The user's frontend/backend remained running.

Evidence is under `/tmp/geoscratch-cover-fixes/metadata/`. Earlier failed runs are
retained: a 2-second documentation scan timeout passed in isolation and on full
rerun; a development-server stale module-resolution cache was refreshed; stricter
enclosure validation exposed the source-to-geometry conversion defect fixed above.
One source-parity run overlapped a local edit and was superseded by the frozen-source
full run. The successful logs are `test-verified.log`, `build-verified.log`,
`wireframe-final.json`, `terrain.json`, `streaming.json`, `camera.json`, and
`outcome.json`. The default backend-building commands in browser scripts were
bypassed only in temporary runner copies, reusing the existing immutable COG.

Rollback: revert later dependent commits first, then this metadata/feedback repair.
It requires no backend migration or resource-state rollback.

## Review Repairs: Continuous Height Volume

ADR-127 records the metric/candidate proofs. The GPU now bounds the affine
Jacobian numerator over the projected height prism and obtains positive depth
from box and inverse-row coordinate-slab certificates. Flat patches clip once
and separately bound numerator/depth over the polygon. Scaled singular arithmetic
and absolute rounding allowances replace the former endpoint maximum. Candidate
windows include projected box radii for the non-flat predicate; coarse seeds,
independent parent decisions and the two-dispatch graph remain intact.

The map upload grows by 96 bytes to 656 bytes. Candidate workspaces and the 44-byte
feedback ABI are unchanged. An uncertified final footprint uses a reserved span
marker and revokes the complete cut before demand/draw; finite bounds at the
explicit geometry ceiling are reported even when above the target.

Native red/green evidence is in `/tmp/geoscratch-cover-fixes/volume/`: archived
`8f6e93c` fails `height-volume-A`, retaining z20 with reported 1.58984375 pixels
versus an independently measured 20.68637864-pixel visible cell. The repair emits
a mixed z22–24 cut; its sampled actual surface satisfies the point-quality gate.
Reported conservative bounds can be higher than these sampled values, as expected.
`camera-verified.json` passes 74 cases per DPR (1 and 2), including multiple allowed
surface heights, camera transitions, A-B-A, true quality failure/recovery, and
complete-enumeration controls with identical ordered final cuts. The earlier
`camera-final.json` failure was a test flag that did not actually install its
singular matrix; the verified fixture sets that matrix explicitly.

Focused checks (60 passing), full tests (1722 passing, 2 opt-in pending), typecheck,
docs generation/translations/check and production build passed. Native outcome
injection, all three terrain suites and their construction/native-observation,
wide/pitch/zoom/DPR/2:1/90-frame/streaming/cleanup gates passed. The independent
inverse-point test checks 3072 coordinate-slab certificates. Finite tests support
the algebraic argument; they do not establish universal hardware performance or
replace its numerical assumptions.

`benchmark.json` records the measured volume-repair baseline for the following
semantics-preserving cleanup. It has 14 GPU timestamp samples per scenario and
explicit source provenance/cleanup. No performance comparison should substitute
FPS for these GPU timings. Backend data and frozen Flow Layer remain unchanged.

Rollback: revert dependent cleanup first, then this height-volume commit; the
separately committed metadata/diagnostic repair `8f6e93c` remains available.
