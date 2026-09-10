---
docId: geo.view-cover
canonical: true
apiSources:
  - packages/geoscratch/src/geo/web-mercator-quad-cover.ts
  - packages/geoscratch/src/geo/web-mercator-quad-demand.ts
  - packages/geoscratch/src/geo/gpu-web-mercator-quad-cover-layout.ts
  - packages/geoscratch/src/geo/gpu-web-mercator-quad-cover.ts
  - packages/geoscratch/src/geo/gpu-web-mercator-quad-demand.ts
  - packages/geoscratch/src/geo/gpu-web-mercator-quad-patch-draw.ts
---
# WebMercatorQuad View Cover

[简体中文](./view-cover_zh.md) | [Geo overview](./README.md)

## CPU geometry and source intent

`new WebMercatorQuadCover(descriptor)` owns bounded CPU workspace, an immutable
WebMercator planar profile, `WebMercatorQuadCoverPolicy` and conservative vertical
bounds. `webMercatorQuadCoverPolicy()` validates and snapshots policy without a GPU
runtime. `select(view)` returns one complete immutable
`WebMercatorQuadCoverSelection`: standard `patches`, an exact validated view snapshot,
selector identity, monotonic selection revision and geometry `facts`. It performs
no upload, readback, resource request or residency query.

The CPU selector preserves the candidate enclosure, independent parent decisions,
deterministic order, prefix freedom, 2:1 closure and quality contract below. It uses
JS f64 arithmetic over the same f32 camera/metric inputs and compensated 40/52-bit
integer address subtraction as the terrain vertex ABI. Finite GPU/CPU consistency
tests do not claim bit-identical decisions at every floating-point threshold.
Candidate preparation and vertical-hierarchy validation reuse the frozen pure
helpers; neither depends on prior topology or resource availability.

The input is copied/validated through `createGeoViewSnapshot`. Each successful
selection copies its private packed metadata, patch and lookup arrays out of the
reusable workspace. Public patches and facts are deeply immutable. Later views
cannot mutate earlier selections; retaining those products is the caller's memory
responsibility. `dispose()` releases workspace and prohibits further `select()`;
existing snapshots remain readable and usable by independent consumers.
`facts().workspaceBytes` counts the persistent typed-array workspace (lookup,
patches, closure marks and numeric state), excluding transient projection objects
and caller-retained immutable selections.

Input/descriptor failures retain the geometry diagnostic codes below. A failed
CPU result throws `GEO_WEB_MERCATOR_COVER_SELECTION_INVALID` with
`actual.reason` such as `descriptor-overflow`, `lookup-overflow`, `adjacency` or
`unbounded-quality`; it never returns partial geometry. The same code rejects
disposed selector use (`disposed`) and forged/foreign products (`foreign-selection`).
Workspace allocation failure is `GEO_WEB_MERCATOR_COVER_WORKSPACE_ALLOCATION_FAILED`
with its original cause. A valid empty cut omits level/span ranges. At the explicit
maximum level, finite error above the requested quality remains reported.

`new WebMercatorQuadDemandProjection({ cover, sourceCoverage, maximumDemands })`
borrows the cover's immutable contract and snapshots validated source limits. Source
levels must be contiguous, start no finer than the minimum geometry level, and fit
the coordinate precision. Capacity is a positive integer no greater than the cover
patch capacity. `project(selection)` accepts only genuine products of that cover
and returns immutable `WebMercatorQuadProjectedDemands`, preserving selection
identity/revision and the original view/frame/residency provenance. It deterministically
deduplicates source identities while keeping desired level, source ceiling, request
level and wrapped camera-distance priority separate. Capacity exhaustion throws
`GEO_WEB_MERCATOR_DEMAND_PROJECTION_INVALID` with reason `demand-capacity`, without
exposing a partial set. The projector owns no scheduler, Worker, payload or GPU state.
It remains usable with retained products after selector disposal; its own disposal
prohibits further projection. `ViewDemandProducer` and Virtual Raster still own
their existing downstream budget selection and resource lifecycle.

ADR-129 records the CPU production migration. The CPU products are independently
usable now; terrain integration is a separate verified slice. The following GPU
APIs are frozen at `ebb3336` as the consistency reference and remain available for
explicit GPU consumers. The current terrain renderer still uses that reference
until its migration slice lands.

## Frozen GPU reference

`GpuWebMercatorQuadCover` is Geo's geometry-LoD authority for planar
`WebMercatorQuad` patch rendering. It consumes one immutable `GeoViewSnapshot` and
emits a bounded standard-tile cut, full-identity neighbor lookup, GPU patch count, and
geometry feedback. It does not own a tiled source, raster demand, atlas residency,
mesh vertex count, or draw arguments.

Every patch is an OGC identity `(tileMatrix, tileRow, tileCol)`. Camera-derived probing
addresses the fixed global matrix and never creates a moving game-style grid. At every
pitch, `writeView()` prepares conservative standard-parent windows from the actual
projection matrix and precise fixed-point camera. The GPU records an exact sparse
parent identity when the conservative bound on maximum singular projected-cell
stretch over that patch exceeds
`maximumCellSpanReferencePixels * (1 + refinementTolerance)`. Pitch and FOV affect the
projection naturally; they never select a uniform/variable algorithm mode.

Candidate membership follows a projected-depth bound, not radial distance or a
pitch/FOV-hint algorithm switch. With cell width `h`, reference pixel scales `s`,
and the actual projection `M`, `B_ij = s_i * (abs(M_ij) + abs(M_wj))` bounds the
clipped Jacobian: `maximumStretch <= h * ||B||F / w`. The inverse projection maps
the resulting depth cap to conservative standard row/column windows. For a non-flat
prism the minimum depth may occur outside the clipped portion, so its full projected
box radii enlarge the inverse domain before tile rounding; restricting this to the
old clipped-point domain would be unsound. Separate f32
coordinate/clipping/metric error bounds and inverse residual intervals enlarge the
window. Clipping retains camera-relative world vertices and evaluates raw plane
equations formed from matrix rows before projection. Flat bounds project the clipped polygon vertices. A non-flat vertical interval uses
an enclosure of its whole height prism; it does not test only its two endpoint planes. This avoids losing near/far depth constants
when mixing or subtracting large clip coordinates on coarse patches; interpolation
retains affine homogeneous `w=1`. The shader clamps clipped NDC and interpolation ratios to their mathematical
domains and avoids division by a subnormal clipping denominator. These constraints
limit roundoff; they do not change the exact projected-cell definition.

Uncertifiable arithmetic uses the complete declared geometry domain. The independent
coarse seed domain is never restricted by a refinement cap. `maximumCandidates` on
the cover descriptor bounds the sum of seed and refinement input candidates; it
defaults to `max(16384, 64 * maximumPatches)`. Invalid budgets fail at construction;
an over-budget view fails synchronously in `writeView()` with
`GEO_WEB_MERCATOR_COVER_CANDIDATE_CAPACITY_EXCEEDED`, before an upload/token is created.
The selector never shrinks the domain to fit. This input budget does not count
materialized children or subsequent adjacency work. `facts().candidateCapacity`
reports it separately from output patch and lookup capacity.

The projected metric uses `GeoViewSnapshot.referenceViewport`, a rotation-invariant
local projective Jacobian, perspective, foreshortening, and immutable vertical bounds.
Its largest singular value constrains the longest screen direction instead of hiding a
long, thin cell behind small projected area. Physical presentation size and DPR never
change cover identities. A cell that cannot certify positive footprint depth refines conservatively.

Writing `J = N(q) / w`, the spectral norm of the affine numerator `N(q)` is convex.
For flat bounds, its maximum over clipped polygon vertices divided by minimum depth
bounds the polygon. For non-flat bounds, a conservative projected XY rectangle bounds
`N(q)` for all admissible heights. A positive-depth box uses its projected corners;
a box crossing the camera plane uses the frustum rectangle. Depth comes from the
strongest box or inverse-projection coordinate-slab bound, including an outward
residual certificate for each inverse row. Thus a frustum lying inside the height
interval cannot disappear merely because neither endpoint plane is visible.

The metric uses scaled singular-value arithmetic and absolute numerator/coordinate
roundoff allowances. Feedback spans report these conservative bounds, not endpoint
samples. A finite bound may exceed the target at the explicitly configured
`maximumMatrixLevel`; it is reported rather than presented as meeting the target.
An uncertified final footprint uses reserved `maximumCellSpanQ8 = 0xffffffff`, revokes
all patches/lookup entries, and fails decoding with `actual.reason: 'unbounded-quality'`.
Demand and draw reject that state before any CPU feedback arrives. The ordinary
44-byte cover-state ABI and finite Q8 span encoding remain unchanged (ADR-127).

`GpuWebMercatorQuadCoverPolicy` declares ordered geometry levels, hard patch capacity,
`cellsPerPatchEdge`, `maximumCellSpanReferencePixels`, and numerical tolerance. Invalid
facts fail before resource creation. The built-in terrain consumer uses 128 cells and
a calibrated five-reference-pixel threshold. The public cover policy contains no
source ceiling or pitch boundary.

The kernel seeds the declared minimum geometry window, probes bounded parents, preserves
each exact ancestor decision, replaces a selected parent only with its own four standard
children, emits a prefix-free visible cut, and performs local 2:1 closure. Independent
parents are never unioned into a level-wide rectangle. It does not start at world roots,
traverse a root-to-leaf
quadtree, count trial cuts, inspect atlas slots, or retain previous-frame topology as
selection authority. Descriptor, lookup, or patch-capacity overflow is a hard
diagnostic; no path silently coarsens the cut. A successful empty visible cut has
`patchCount: 0` and omits level/span ranges. Overflow or incomplete 2:1 closure
remains failure even when no patches survive; range sentinels are not public values.

`WebMercatorTileVerticalBounds` is a geometry fact rather than terrain identity. A
flat consumer can use `[0, 0]`; terrain can convert source elevation metadata; an
extruded consumer can provide conservative feature heights. A supplied hierarchy must
exactly match every declared tile of the spatial profile, in level/row/column order.
Every descendant range must lie within its nearest declared ancestor range and the
global range; every declared tile must descend from the minimum geometry domain.
Geometry outside a finer metadata limit, or above the highest metadata level, uses
its nearest declared enclosing ancestor. Missing records inside a declared limit,
misordered records, or non-enclosing ranges fail before GPU allocation with
`GEO_WEB_MERCATOR_COVER_VERTICAL_BOUNDS_INVALID`; absent finer spatial coverage is
not missing metadata. Count validation does not enumerate an absent world-sized hierarchy.
An omitted hierarchy uses `verticalRangeMeters`. Cache, request, and residency state
cannot change these bounds.

`GpuWebMercatorQuadCoverTemplate` exposes borrowed parity resources for downstream
GPU components: map metadata, patches, lookup, and full state. `writeView()` owns one
ephemeral upload containing camera facts, conservative windows, and inverse-row depth
certificates; `frame()` selects parity,
`encode()` appends two ordered dispatches in one compute pass, and `capture()` reads
only the final geometry state. `commandsFor()` exposes persistent `evaluate`,
`generate`, and `stateFeedback` commands for the owned frame; consumers use `encode()`
to preserve the complete dependency sequence, not `generate` alone.

The first dispatch evaluates visibility and the projected metric for independent
candidates at every configured level with 64 invocations per workgroup. Its indirect
count is packed into the same view upload and uses only the actual candidate domain;
no intermediate GPU readback or per-level host scheduling is required. The second
dispatch uses one 64-invocation workgroup: one lane preserves exact parent chains,
materializes deterministic output and coordinates indexed adjacency closure. After
workgroup storage synchronization, all lanes measure final patches and reduce their
Q8 span range with workgroup atomics. Only group-local synchronization is used;
cross-group visibility comes from the preceding ordered dispatch.

Topology coordination remains serial deliberately, avoiding a global sort/scan and
many small dispatches for the bounded cut. Expensive candidate and final quality
work is parallel. Each closure round queries an immutable full-identity leaf index
from the fine side of every edge, marks coarse neighbors, then replaces only marked
parents and compacts visibility. Invisible transient children cannot influence
later marks in that round. A successful fixed point publishes the already validated
visible lookup from that construction and adjacency delta; it does not repeat visibility compaction, rebuild
the lookup, or scan every edge again. Failure retains a full final validation. This removes pairwise all-patch neighbor scans and
processing-order propagation. The `maximumPatches * levelCount` round budget must
fit u32; exhaustion with remaining adjacency violations is a failed cut.

Cover owns one u32 candidate workspace per parity. After materialization, its first
`maximumPatches` words may be reused for closure marks. Total persistent workspace
bytes are `8 * max(maximumCandidates, maximumPatches)`, exposed as
`facts().candidateWorkspaceBytes`; this excludes ordinary cover buffers, upload
snapshots and compiler-private shader storage. Allocation does not depend on prior
views. Both parallel construction branches settle before cleanup on failure,
including resources/bindings returned by a late sibling; one underlying failure is
preserved, and multiple failures are aggregated.
Both public feedback decoders reject invalid bytes and failed/stale results with
`GeoDiagnosticError`: codes `GEO_WEB_MERCATOR_COVER_FEEDBACK_INVALID` and
`GEO_WEB_MERCATOR_DEMAND_FEEDBACK_INVALID`. `diagnostic.actual.reason` distinguishes
`byte-length`, `frame-epoch`, cover `patch-capacity`/`descriptor-overflow`/
`lookup-overflow`/`adjacency`/`range`/`unbounded-quality`, or demand `demand-capacity`/`overflow`/
`source-ceiling`/`record`. State/record facts accompany the reason. Callers inspect
the diagnostic instead of parsing exception prose or testing RangeError/TypeError.
Feedback reports candidate/patch counts, level range, adjacency, projected-cell span,
and overflow facts. It contains no demand records or selection mode.

`gpuWebMercatorQuadCoverReadWgslModule()` exposes full-identity lookup,
covering-neighbor resolution, and edge-coordinate snapping for patch consumers.
Entries store complete level, row, and column facts rather than a compact z14 key.

`GpuWebMercatorQuadDemandProjection` is the separate source-lowering stage. It borrows
a cover frame, owns one source coverage and its own parity resources, deduplicates
executable source tiles, and preserves `desiredSampleLevel`, `sourceLevelCeiling`,
request identity, wrapped camera-distance priority, frame epoch, and residency epoch as
separate facts. Its bounded feedback can be converted to `ViewTileDemandSet`; Virtual
Raster remains downstream and passive. Before reading patches, projection rejects
a failed cover or mismatched frame: it emits no demands and sets its existing
`overflowCount` failure marker. Nonzero overflow therefore also includes an invalid
upstream cover, and feedback decoding rejects it instead of reporting a valid empty demand.

`GpuWebMercatorQuadPatchDraw` is the separate draw-count adapter. It borrows cover
state, owns one consumer element count plus parity draw-indirect buffers, and uses one
persistent compute dispatch to write `[elementCount, patchCount, 0, 0, 0]`. The 20-byte
record is valid for indexed draw and its first 16 bytes remain valid for non-indexed draw.
A failed cover produces zero instances, so partial geometry is never drawn while
CPU feedback is pending. The cover owns neither those buffers nor the consumer mesh.

Related decisions: ADR-083 establishes inverse-cover and passive Virtual Raster;
ADR-084 establishes reference-pixel quality; ADR-086 supersedes their pitch-gated
parts and separates cover, source demand, and patch draw ownership; ADR-087 preserves
sparse parent decisions; ADR-088 defines maximum projected stretch; ADR-089 defines the
consumer-neutral indexed/non-indexed indirect ABI. ADR-125 records candidate
completeness, failed-cut revocation and the bounded execution work.

ADR-126 clarifies complete vertical metadata and nearest-ancestor enclosure.

The map-metadata layout is now 656 bytes (previously 560): two vec4 depth-support
vectors and four residual vec4 rows add 96 bytes per parity and view upload. Candidate
workspace capacities, dispatch count, and feedback cadence are unchanged. ADR-127
records the volume and candidate-domain proofs and their finite native comparisons.
