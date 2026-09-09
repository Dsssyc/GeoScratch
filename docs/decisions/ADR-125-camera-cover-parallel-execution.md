# ADR-125: Parallelize Camera Cover Without Merging Resource Authorities

## Status

Accepted design and implementation boundary. Implementation and measured acceptance
are tracked in [the branch review](../review/camera-cover-implementation.md). An
unchecked stage in that record is not a claim about current runtime behavior.

## Date

2026-09-09

## Context

At baseline `071d82b`, the camera cover probes camera-anchored windows, records exact
parent decisions, materializes their children, compacts visibility and balances
edges. One GPU invocation performs all of this, including pairwise adjacency scans.
ADR-087 requires sparse parent decisions, not serial execution. ADR-088 corrects
the local projected-cell metric, but does not prove that the existing search radius
contains every parent requiring refinement.

Flow's earlier approximately four-millisecond fixed-view cover measurement belongs
to `8d44021` and one machine/scene. ADR-120 already removes repeated spatial work in
unchanged Flow views. New camera decisions and Terrain still require evaluation;
FPS is not a substitute for GPU timing.

The resource audit found an existing complete composition: view demand, bounded
request reconciliation, generic Worker contexts and phase budgets, unique payload
transfer, residency publication, ordered Scratch uploads and native acknowledgement.
Neither request settlement nor CPU resident state is a universal rendering-ready
certificate. ADR-106 specifically removed a shared full-view/particle readiness gate.

## Decision

Keep one `GpuWebMercatorQuadCover` geometry authority and replace only its internal
selection/execution mechanism through verified, revertible stages.

- Keep standard OGC identities and 52-bit canonical addressing, reference-pixel
  maximum projected stretch, exact parent/four-child decisions, stateless selection,
  deterministic output, complete visible coverage, prefix freedom and 2:1 edges.
- Candidate rejection requires conservative visibility or an explicit bound over
  every omitted eligible parent. A tile's local acceptance does not stop searching
  other regions. A failed proof means inspecting more bounded candidates, not an
  unproved center-distance or ring-stop heuristic.
- A candidate rectangle may over-enumerate. Independent refinement decisions must
  never be reduced to one refinement rectangle. Camera-centered order is optional;
  work order cannot define the accepted identity set.
- Preserve the complete coarse domain before local replacement. Do not restore
  world-root discovery, residency-driven geometry, pitch modes, moving grids,
  previous-topology authority or hysteresis.
- Evaluate independent candidates concurrently. Use deterministic compaction and
  explicit parent/child dependencies. Cross-workgroup dependencies use ordered
  dispatches; there is no host readback between levels and no global spin barrier.
- Choose stage count, workgroup size and neighbor indexing from whole-construction
  measurements. A multi-dispatch graph is not inherently faster. Small bounded
  workgroup cooperation and indexed neighbor lookup are valid alternatives to
  repeated global scans/sorts.
- Geometry construction failure must not expose a partial cut to demand or draw
  consumers. Legal empty visibility remains distinct from failed construction.
  Capacity exhaustion remains an explicit failure; no silent quality reduction.

The existing resource composition stays outside this change. Cover output feeds the
existing separate source-demand and patch-draw adapters. Preserve budget-selected
resource sets (including used resident pages), safety reservations, same-page request
retention, terminal failures, fallback, source/time identities, publication ordering,
leases, observation and disposal. Resource budgets cannot truncate geometry.

No new general `resourceReady`, preparation ticket, Worker facade, scheduler or
resource owner is introduced. Flow's local particle progress and full-view
presentation readiness remain separate. Keep Terrain double-flight and Flow
single-flight policies and delayed-feedback convergence. One logical builder need
not equal one native submission; queue uploads retain their existing ordering.

## Verification and Rollback

Each implementation stage updates the relevant English and Chinese canonical API
pages, generated facts, focused tests and the review's measurements. Run focused
checks followed by typecheck, tests and build. Native gates include wide top-down
symmetry, continuous pitch/move/zoom, A-B-A, independent parent decisions, coverage,
2:1 edges, DPR invariance, source-demand identity, overflow/empty results, delayed
feedback, construction/native observation, disposal, and shaded/wireframe 90-frame
pitched benchmarks. Use existing backend data and isolated browsers.

Commit every verified stage separately. Revert dependent commits in reverse order;
never reset a shared checkout. Frozen Flow Layer and backend data are outside scope.

## Alternatives

True outward wavefront remains a measurement/proof comparison. It needs a certificate
for every unexplored region; an empty or low-error current ring is insufficient.
Direct bounded enumeration can parallelize all known members without this discovery
dependency. Parent eligibility still has a depth dependency, but expensive local
projection work need not inherit that dependency when candidates are known.

Merging resource availability into geometry selection is rejected: it would restore
network-dependent topology and conflate desired precision with delayed availability.
Combining all readiness promises is rejected: it would reintroduce the coupling
removed by ADR-106 and may hold publication bytes across unrelated work.


## Selected Execution Structure

The measured implementation uses two ordered dispatches within the existing cover
pass. Independent raw candidates across all levels run in parallel; a bounded
single-workgroup topology coordinator preserves parent decisions and stable output,
then its lanes measure final quality in parallel. Candidate dispatch parameters
travel with the view metadata upload. There are no per-level CPU readbacks, new
queue authority or resource-ready tickets.

Fine-side standard-identity ancestor lookup replaces quadratic adjacency scans.
Each closure round reads an immutable cut, marks all required coarse splits, then
materializes and compacts. The old in-place scan could let temporarily invisible
children trigger unrelated extra refinement later in the same round. The CPU
reference retains independent pairwise edge checks but adopts the same frozen-round
semantics. This is a correction to processing-order propagation, not hysteresis.

The extra workspace is explicitly bounded per parity and reused only after its
previous role is finished. Native tests and resource-access validation keep the
candidate pass from pretending to write public cover products. Creation waits for
all asynchronous parity branches before releasing owned objects after a failure.
