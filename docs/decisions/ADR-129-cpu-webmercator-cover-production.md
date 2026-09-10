# ADR-129: Produce Terrain Cover and Source Intent on the CPU

## Status

Accepted for staged implementation. Supersedes the terrain GPU execution-location
decision in ADR-083/086/125/128; their geometry, resource ownership and native
acknowledgement requirements remain. Until the renderer migration commit, the
canonical terrain API continues to describe its existing GPU producer.

## Date

2026-09-10

## Context

The [integrated comparison](../review/terrain-host-submission-comparison.md) shows
repeated lower selection observation/request latency for CPU cover plus CPU source
intent on the tested workload, including 52-bit addressing and native high refresh.
Both alternatives already use one indexed indirect terrain draw. The experimental
CPU path retains unused GPU objects and temporary source substitutions, so it is
not a production contract. The user approved production CPU selection with the GPU
implementation frozen as an independent consistency reference.

## Decision

### Complete CPU geometry product

`WebMercatorQuadCover` owns bounded reusable CPU workspace and immutable profile,
policy and vertical bounds. `select(view)` synchronously returns one branded,
immutable `WebMercatorQuadCoverSelection`. Standard patches and geometry summary
are public immutable facts; packed metadata/patch/lookup storage stays private to
Geo and is copied out of reusable workspace. A later selection cannot mutate an
earlier product. Disposing the selector releases workspace and prohibits new
selection; already returned immutable products remain readable.
Each product records selector identity, a monotonic selection revision and the
complete immutable view, including decision frame and observed residency epochs.
Projection and upload receipts retain that exact product identity/revision. An
explicit replay preserves its original provenance rather than relabelling it as a
new camera decision. Existing genuine snapshots remain consumable by a live
projector/uploader after selector workspace disposal.

Selection keeps the conservative candidate proof, complete coarse domain, sparse
exact-parent decisions, deterministic materialization, indexed immutable-round
2:1 closure, 52-bit address subtraction and reference-pixel maximum stretch from
ADR-087/088/125/126/127. No root-forward search, radial early stop, pitch mode,
residency dependence, hysteresis or previous-topology authority is introduced.
Every result is a complete certified cut. Capacity, adjacency and uncertifiable
quality failures throw structured Geo diagnostics before demand or draw consumes
the attempted result. Legal empty visibility remains successful. Finite error at
the explicit maximum level is reported without pretending to meet the threshold.

### Separate source intent

`WebMercatorQuadDemandProjection` borrows one cover and immutable source coverage.
It synchronously projects only genuine selections from that cover, deduplicates
standard source identities, and preserves desired geometry/sample level, source
ceiling, request level, priority and original view/frame/residency provenance.
Its capacity is independent from geometry capacity and overflow never returns a
partial request set. It owns no Worker, raster payload, atlas, GPU resource or
request scheduler. Existing `ViewDemandProducer` performs the subsequent explicit
budget selection, including resident pages, before Virtual Raster reconciliation.

### Explicit GPU upload and draw ownership

`WebMercatorQuadCoverUpload` borrows the selector's descriptor and one Scratch
runtime. It owns two parity sets of metadata, patch and full-identity lookup
buffers; there are no candidate buffers, compute pipelines or feedback staging
allocations. `prepare(selection)` snapshots ephemeral upload commands and returns
an owned disposable frame. Revision authority rejects foreign, stale, disposed or
repeated frame encoding. `encode(builder, frame)` appends all geometry uploads in
order and consumes the submission sequence exactly once. Receipt validation
checks the actual upload command IDs, resource allocation versions and produced
epochs; it never fabricates GPU-produced geometry or native-ready evidence.
Each frame owns private independent copies of all three upload payloads. Existing
Scratch opaque submission steps keep these commands/bytes out of the public
builder-step surface. Unsubmitted attempts can be disposed and prepared again.
Queue consumption advances native-use sequence authority; a synchronous
`receipt(frame, submitted)` separately accepts the exact three uploads, allocation
versions and produced epochs, and checks ordering before consumers. A receipt
failure after submission poisons the uploader: already queued writes cannot be
rolled back or silently reused. Receipts remain immutable evidence after disposal.

Terrain owns its immutable mesh and two 20-byte indirect argument buffers. It
uploads `[elementCount, patchCount, 0, 0, 0]` from the complete CPU selection and
draws the existing indexed grid. The cover does not acquire mesh counts or draw
policy. Vertex generation, high-precision subtraction, lookup, stitching, raster
sampling and native line topology remain unchanged.

### Resource progress and failure

After a valid submission receipt, the renderer reconciles the complete current
CPU source intent without waiting for cover/demand readback or another frame.
Selection validity, queued GPU use, native success, request completion and raster
publication acknowledgement remain distinct facts. Actual retained active
requests carry their completion promise into frame settlement; resource completion
wakes publication even when no more camera events occur. There is no polling frame
loop or global `resourceReady` authority. Native failures still reject observation.

One staged Virtual Raster publication remains owned by that runtime. Renderer
preparation failure must retain its pending publication for retry or owner cleanup;
it must not publish again over an unacknowledged update. An older asynchronous
completion cannot overwrite current geometry or certify a newer camera. Disposal
continues to respect the renderer/runtime/Worker ownership order. The existing
two-frame admission bound and generic frame controller remain in place.
The renderer stores a newly returned publication immediately in a pending state.
Pre-submit failure retains that exact update; retry encodes it instead of calling
`publish()` again. Only acknowledgement clears the pending state. Renderer disposal
releases upload frames and prevents its callbacks from reviving geometry, but does
not dispose the borrowed Virtual Raster runtime; that runtime's owner settles or
abandons its publication and cancels requests during disposal.

After `submit()` returns, receipt or reconciliation failures travel through the
returned frame's observation/settlement promises; its `SubmittedWork` remains
accounted for by the frame controller. Failed receipt validation starts no source
requests. Immediate CPU settlement includes the actual unresolved active request
count after reconciliation (new and retained), and its real completion promise.
Only latest-frame completion drives publication follow-up; already resident or
staged pages are not fabricated as pending requests. Current geometry adoption is
bound to the current admitted decision and its accepted receipt, not later native
callback arrival order.

### Frozen reference and scope

The GPU selector, projection, patch-draw kernels and their helper/layout modules
are frozen at `ebb3336` and protected by a source-hash manifest. They remain
available for consistency tests and existing explicit GPU consumers. Native A/B
tools may replay the terrain renderer from that commit; production has one CPU
terrain selector and no automatic CPU/GPU switch. Shared read-only GPU mesh ABI
and accessors may be consumed unchanged by the CPU upload path.

This change migrates the Geo CPU primitives and Underwater Terrain production
composition. Flow Field is not implicitly migrated; frozen Flow Layer and existing
backend data are outside scope. Worker, Cache, Virtual Raster and Scratch GPU do
not acquire a new owner, protocol, readiness authority or geographic policy.

## Verification and Rollback

Land separate verified commits for the frozen reference/decision, CPU products,
GPU upload ownership, and renderer integration. Update English canonical APIs and
their Chinese counterparts with every implemented public slice, regenerate facts
and translation digests, and run docs/type/test/build checks.

Verify bounded/full candidate equivalence, independent parent decisions, complete
coverage, prefix freedom, 2:1, quality/overflow/empty results, 40/52-bit addressing,
wide top-down views, continuous pitch/move/zoom, A-B-A and DPR. Compare native GPU
reference and CPU geometry/demand; record numeric-boundary differences rather than
hiding them with history or relaxed capacity. Test upload supersession, foreign
products, missing/altered producer epochs, failure at every new GPU allocation,
native failure, delayed resource/native completion, final-view convergence and
cleanup. Repeat shaded/wireframe 90-frame and high-refresh performance comparisons.

Revert dependent commits in reverse order; never reset the shared checkout. GPU
reference hashes, original fixtures and existing data make the baseline recoverable.
