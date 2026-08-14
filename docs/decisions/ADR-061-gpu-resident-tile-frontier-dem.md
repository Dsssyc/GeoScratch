# ADR-061: GPU-Resident Tile Frontier for DEM

## Status

Accepted

## Date

2026-08-06

## Context

The Underwater Terrain example previously traversed an application-owned quadtree on the CPU,
materialized visible node arrays and indirect counts, then uploaded those facts every
frame. That path could render the original finite dataset, but it made camera movement,
LoD budgeting, residency handoff, and draw count authority CPU responsibilities. It
also left the rendering decision disconnected from the Virtual Raster snapshot that
the GPU actually sampled.

WebGPU already provides storage buffers, compute dispatch, indirect dispatch/draw,
ordered submissions, and bounded readback. Scratch exposes those capabilities with
resource epochs, submission authority, provenance, diagnostics, and lifecycle
semantics. The missing abstraction belongs to Geo because frustum visibility, tile
identity, screen-space error, LoD balance, and residency demand are spatial policies.

The accepted design and implementation plan are recorded in
[`2026-08-06-gpu-resident-tile-frontier-dem-design.md`](../superpowers/specs/2026-08-06-gpu-resident-tile-frontier-dem-design.md)
and
[`2026-08-06-gpu-resident-tile-frontier-dem.md`](../superpowers/plans/2026-08-06-gpu-resident-tile-frontier-dem.md).

## Decision

### Ownership

- Scratch owns generic GPU resources, layouts/codecs, transfers, binding, programs,
  pipelines, commands, ordered submission, readback, provenance, and diagnostics. It
  does not own tile, terrain, camera, LoD, or residency policy.
- Geo Virtual Raster owns logical page identity, immutable residency snapshots,
  generation-safe leases, atlas/page-table publication, and a generic physical-slot
  reverse table. The reverse table describes resident virtual pages; it contains no DEM
  elevation, mesh, or shader policy.
- Geo `GpuTileFrontier` owns the persistent A/B active frontier, frustum and
  screen-space-error evaluation, hysteresis, level-difference-one balance, bounded
  transition arbitration, canonical compaction, visible instances, page demands,
  retirements, diagnostics, and indirect dispatch/draw arguments.
- The Underwater Terrain example owns its WebMercator camera adapter, per-level geometric error and
  elevation range, page-to-patch interpretation, terrain shaders, and mesh-stitching.
- The CPU event path continues to own network fetch, Worker execution, optional cache,
  decoded-payload transfer, residency publication, and `SubmittedWork`
  acknowledgement. Compute shaders do not perform network or cache work.

### Address and LoD semantics

`matrixLevel` is the TileMatrixSet coarse-to-fine level. `samplingLevel` is the Virtual
Raster fine-to-coarse internal level. They remain distinct in slot, frontier, visible,
and demand records. Shader code reconstructs camera-relative high-precision positions
before resolving the transient virtual-raster sample address.

### Frontier transaction rules

- The current frontier is finite, prefix-free, canonically ordered, and maintains an
  adjacent matrix-level difference no greater than one.
- A parent remains active and drawable until every covered child required by an
  accepted refine transaction is resident in an acknowledged snapshot.
- An accepted missing-child transaction is sticky while the same parent remains a live
  refine candidate and its requested children are still missing. Fairness priority
  cannot rotate incomplete transactions every frame and cause request cancellation
  loops.
- A camera or policy change that makes the parent no longer a live refine candidate
  removes its demand through normal generation reconciliation.
- A terminal child failure remains distinct in the page table, blocks that parent
  transaction, retains the parent cover, and is not requested repeatedly.
- Coarsening is atomic over a complete canonical sibling group. Invisible siblings use
  a bounded grace interval, after which the resident parent replaces the group only if
  balance remains valid.
- Active, visible, demand, retirement, lookup, decision, scan, diagnostics, and
  feedback capacities are fixed. Capacity pressure preserves a drawable parent cover
  and reports `budget-limited`; it does not create an unbounded queue or CPU fallback.

GPU feedback uses a fixed three-slot readback ring. Feedback is accepted only when its
camera/residency decision key still matches the current frame. Superseded feedback is
consumed and counted but cannot reconcile demand. Because successive accepted frontier
transactions need not repeat every still-missing page, CPU lowering carries an
in-flight demand through exactly one absent feedback generation. The carried demand
is background prefetch and cannot displace current refinement or the safety cover;
two consecutive omissions cancel it. This bounded temporal envelope prevents
alternating feedback from repeatedly aborting the same page without weakening view
change cancellation into an unbounded cache. Only a current feedback demand admitted
after reserving the safety-cover budget can enter the next grace generation, and grace
facts count only demands admitted to the bounded scheduler set.

### Clean cut

`examples/underwaterTerrain/terrain-selection.ts` and the CPU node/box/count upload path are
deleted. During `0.x.x` there is no compatibility flag, alternate route, or hidden CPU
selector. `gpu-tile-frontier-reference.ts` remains a test-only deterministic oracle;
it is not a production fallback.

## Rejected Alternatives

### Keep the CPU quadtree as a fallback

Rejected. Two authorities for visibility, demand, and indirect counts would make
camera and residency races non-auditable and preserve the migration burden.

### Traverse the complete global quadtree on the GPU

Rejected. The active frontier and acknowledged resident metadata are the bounded
working set. Scanning an unbounded global tree would move, rather than solve, the
capacity problem.

### Rotate demand candidates every frame for fairness

Rejected. Under network latency this cancels incomplete sibling transactions before
they can settle. Fairness applies between available transactions, not by invalidating
an already accepted transaction.

### Put tile selection into Scratch

Rejected. Scratch's existing compute, indirect, readback, submission-authority, and
diagnostic primitives are sufficient. Tile and LoD concepts remain Geo policy.

### Retain an unbounded decision ledger

Rejected. Current facts, counters, and recent history are bounded. Browser proofs and
explicit finite captures provide deeper evidence when requested.

## Consequences

- Per frame, the host writes one camera/map metadata upload and submits a fixed GPU
  graph; it does not traverse a tree or upload visible arrays and indirect counts.
- DEM rendering and Virtual Raster demand derive from the same acknowledged residency
  snapshot and GPU decision.
- Slow requests, terminal page failures, tight physical budgets, high pitch, resize,
  and rapid camera replacement converge without holes or unbounded retries.
- Scratch gains no tile-specific public API. Other Geo consumers may reuse the frontier
  and Virtual Raster contracts without adopting DEM shaders or mesh policy.
- Flow LoD, globe traversal, occlusion, editable terrain, and generalized scene
  scheduling remain separate designs.
