---
docId: geo.terrain-rendering
canonical: true
apiSources:
  - packages/geoscratch/src/geo/web-mercator-terrain-renderer.ts
  - packages/geoscratch/src/geo/web-mercator-terrain-wgsl.ts
  - packages/geoscratch/src/geo/web-mercator-virtual-raster-wgsl.ts
---
# Terrain Rendering

[简体中文](./terrain-rendering_zh.md) | [Geo overview](./README.md)

`createWebMercatorTerrainRenderer` is Geo's OGC `WebMercatorQuad` terrain
orchestrator. It composes one `MapFieldLayer`, prepared Virtual Raster runtime,
`WebMercatorQuadCover`, `WebMercatorQuadDemandProjection`,
`WebMercatorQuadCoverUpload`, generated terrain WGSL, capture-sized attachments
and explicit disposal. Its only geometry authority is the CPU selector. The GPU
implementation remains a frozen consistency reference and an explicit API for
existing GPU consumers; production terrain has no execution-location switch.

The frame order is:

```text
CPU complete cover selection -> CPU source-demand projection
    -> optional Virtual Raster publication uploads
    -> camera / patch / adjacency-lookup uploads
    -> indexed patch-draw argument upload
    -> terrain drawIndexedIndirect
```

`contractFacts().stageOrder` names `cpu-cover-selection`, `cpu-source-demand`,
`cover-upload`, `patch-draw-upload`, and `terrain`. The first two are synchronous
CPU work; only `terrain` is a GPU pass. `selectionPath` is
`cpu-camera-inverse-webmercatorquad-cover` and `countPath` is
`cpu-produced-indirect-arguments`. `passIds` contains the terrain pass;
`commandIds` contains persistent terrain draw commands. `coverUpload` reports
upload ownership and receipts; `patchDraw` reports the renderer's two buffers,
20-byte argument ABI and element count. No GPU selection/demand compute objects
or cover-feedback readback buffers are allocated by the renderer.

These stages have separate ownership. The cover chooses standard geometry patches
and adjacency. Demand projection maps those patches to source coverage while
preserving desired precision. Terrain owns the mesh and uploads
`[elementCount, patchCount, 0, 0, 0]` to its indexed indirect buffer. After the exact
geometry upload receipt is accepted, `ViewDemandProducer` applies the existing
explicit demand budget and Virtual Raster schedules the selected pages. Residency
never changes geometry topology. Selection or projection failure admits neither
partial geometry nor resource intent.

The built-in terrain consumer uses a 128-cell standard patch, a five-reference-pixel
maximum singular projected-cell stretch, and 0.005 numerical tolerance. Every pitch
uses the same adaptive selector. There is no 60-degree boundary, mode feedback, renderer
override, or example environment variable. Physical presentation size and DPR do not
participate in the quality metric.

`elevationRangeMeters` and optional `WebMercatorTerrainElevationBounds` remain terrain
source facts. The renderer applies exaggeration and converts them to generalized
`WebMercatorTileVerticalBounds` before creating the cover. Source ranges describe
individual raster levels, so the renderer unions descendant ranges into every
available ancestor before validating the enclosing geometry hierarchy. It snapshots
these derived bounds without changing source metadata or backend data, and validates
them before allocating renderer GPU resources. This conversion is independent of
residency and request state (ADR-126). A hierarchy must completely
match source coverage; omitted metadata uses the global range. Cache hits, atlas pages,
and request completion cannot supply or mutate bounds.

The immutable CPU source product preserves desired geometry precision separately from source ceiling
and executable request tile. `VirtualRasterRuntime.reconcileViewDemands()` schedules
only those explicit requests. Exact-resident pages do not consume request budget.
Missing exact pages render through page-table ancestor fallback while the same geometry
cut remains active.

`webMercatorTerrainWgslModule` owns the complete vertex path. It reconstructs wide-
fixed standard-tile positions, subtracts the camera before f32 conversion, resolves
cover neighbors, snaps mixed-LoD edges, samples height by global field coordinate, and
projects the result. Terrain uses indexed indirect drawing so one logical grid vertex is
shaded once per patch instead of once per triangle corner. The renderer owns equal-length
triangle-list and line-list index buffers; the latter contains each cell's bottom, left,
and actual diagonal edges. The built-in wireframe fragment colors those native post-stitch
lines with stable tile colors instead of inferring topology in the fragment. Application
presentation WGSL supplies fragment shading only.

`render(capture)` consumes one `GeoViewSourceCapture<ViewInput>`, resizes physical
attachments from `presentationSize`, and returns
`GeoFrameResult<WebMercatorTerrainFrameValue>`. Each frame synchronously selects a
complete immutable cut, projects source intent and submits uploads before drawing.
`value.frame.uploadReceipt` records the exact queued geometry product and producer
epochs; it is absent if receipt validation fails. It does not certify native success
or raster readiness. The four provenance chains are CPU map metadata, patches,
lookup and indexed arguments, each from its actual upload to the terrain draw.

`WebMercatorTerrainFrameSettlement.coverSelection` and `.projectedDemands` replace
the former GPU feedback fields. The settlement normally immediately exposes the current
selection, reconciliation, actual active request count (new and retained), and its
real `residencySettlement` promise, joined with any pending publication acknowledgement. It has no obsolete-geometry `superseded` flag.
Renderer state uses the same new field names and has no GPU readback capacity or
stale-feedback counters. `convergenceState: 'converged'` means the current CPU
selection and demand were accepted; resources may still be loading. It is not an
exact-resource-ready certificate. Every admitted decision receives fresh product
identity and original view/frame/residency provenance, even when its spatial cut
matches an earlier view. Native or resource completion cannot install an old cut.

Frame `observation` separately waits for native success and applicable raster
publication acknowledgement. Once `submit()` returns, receipt, reconciliation or
provenance-observer errors reject this observation while retaining the returned
`SubmittedWork`; the controller can account for work already issued. Receipt failure
starts no source requests. Such post-submit errors and native failures are terminal
for this renderer. A pre-queue construction failure remains retryable; a potentially
partially issued transaction is terminal. Selection facts from a failed attempted
view never certify it as converged.

A newly returned Virtual Raster publication is recorded before later preparation
can fail. Pre-submit retry reuses that exact pending update. Later frames reuse an
already-issued publication and its acknowledgement promise; they do not publish or
encode it again. Only successful acknowledgement clears the pending publication
and advances the renderer's `virtualSnapshotEpoch`. `initialize()` shares concurrent attempts. Failure of the borrowed one-shot raster
initialization is terminal; subsequent local pre-queue failure permits retry using
the same publication.
Native failure remains separately observable and blocks further rendering.

There is no cover readback, capture waiter or readback polling loop. Retained active
requests carry completion into every newer settlement, so the latest frame can wake
resource publication without another camera event. When pages are staged while a prior publication is pending, settlement waits for
that acknowledgement before requesting bounded follow-up. The generic
frame controller still owns latest-frame admission and follow-up bounds;
Underwater Terrain retains the measured two-frame in-flight limit.

The renderer owns its CPU selector/projector/uploader, two geometry upload parity
sets, two 20-byte indirect buffers, immutable mesh/index buffers, configuration,
depth attachment and supporting Scratch objects. Construction failure unwinds every
successfully acquired owned object; `dispose()` is idempotent and releases them all,
including commands and pipelines. Disposal does not dispose the borrowed runtime,
Surface or Virtual Raster. The Virtual Raster owner settles or abandons a pending
publication and cancels its requests. Late callbacks cannot revive renderer state.
`persistentFacts()` reports only live renderer-owned resources, bind layouts, bind
sets, pipelines and logical GPU footprint, excluding borrowed raster/Surface objects,
CPU workspace and transient upload bytes. Unrelated runtime allocations do not
invalidate the renderer's persistent identity/count checks. Logical texture bytes
reflect the current depth attachment size, not physical driver memory.

The renderer does not own a map host, frame controller, source manifest, URL policy,
Worker system, decoder or persistent-cache choice. Those responsibilities and the
existing resource-ready/ancestor-fallback contracts are unchanged.

Future feature-to-surface conformance is not implemented by this renderer. A separate
Geo preprocess product may consume its surface geometry or matching field sampler, but
feature identity and source tiling must not become terrain-tile render-to-texture state.

Related decisions: ADR-074 assigns terrain WGSL ownership; ADR-083 defines inverse
cover and passive Virtual Raster; ADR-084 defines reference pixels; ADR-086 unifies the
selector and separates geometry, source demand, and draw-count ownership; ADR-087 and
ADR-088 define sparse parent refinement and maximum projected stretch; ADR-089 defines
indexed terrain execution. ADR-128 remains the frozen GPU feedback model; ADR-129 moves production terrain
selection/source intent to the CPU while preserving resource progress and native
acknowledgement as separate contracts.
