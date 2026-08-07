# Scratch DEM Layer Migration Audit

## Current Architecture Supersession

As of 2026-08-07, ADR-064 supersedes ADR-063's integer-zoom render selection while
retaining its separation of the `z4..z10` data-page frontier from the `z4..z14`
terrain render-patch frontier. The data frontier remains the only residency, request,
cache, and fallback authority. An example-owned compute stage independently stops each
bounded descendant path when its camera-distance screen-space error reaches two pixels,
then writes one terrain indirect argument and a global logical-patch lookup. Terrain
stitching resolves selected neighbors from `(matrixLevel, tileRow, tileCol)` rather
than a finite source-domain LoD texture. See
[ADR-064](../decisions/ADR-064-dem-screen-space-render-patch-lod.md).

As of 2026-08-06, ADR-061 replaced the CPU selector and CPU-authored indirect-count
path described in the historical source-parity matrix below. The current DEM owns no
`selectTerrainNodes()` production path: Geo's persistent GPU frontier produces visible
instances, demand, and indirect arguments from acknowledged Virtual Raster residency.
The matrix remains a record of the earlier Scratch API migration and must not be read as
the current DEM execution architecture. See
[ADR-061](../decisions/ADR-061-gpu-resident-tile-frontier-dem.md) and the final GPU
frontier audit.

### Current Render-Patch Verification

The 2026-08-07 real Chrome/WebGPU gate holds the camera at pitch 70 and bearing 90.
The converged data frontier remains within levels 9..10 while the wireframe shows
distance-adaptive render patches spanning the same view. Chrome reports zero uncaptured
GPU errors, device losses, diagnostic incidents, console failures, or page errors.

The current example graph publishes 71 stable identities: 21 resources, four uploads,
six BindLayouts, 10 BindSets, five Programs, five pipelines, two passes, and 18
commands. The frame sequence is now:

1. data frontier compute;
2. render-patch lookup clear, SSE selection/culling, and indirect finalization compute;
3. terrain indirect draw from the selected render patches;
4. bounded data-frontier feedback.

## Audit Status

Integrated on `dev-feature` through implementation/gate commit `bceb8a2`. The original
implementation branch was based on accepted Flow commit
`26ed35ffea5114e6968e013be9dca2e302e49ff1` and package version `0.0.22`; its unchanged-
core dynamic-count capability proof is commit `5515b31`. Integration also made package
builds remove stale `dist` output before TypeScript emission, so deleted `LocalTerrain`
JavaScript and declarations cannot survive from an earlier build.

ADR-050 update, 2026-07-24: Shader compilation now belongs to first-class
`ShaderModule` acknowledgement. The terrain failure probe starts its one-operation
capture immediately before terrain ShaderModule creation. The previous headed result
below remains historical; Phase 6 reruns the migrated probe before final acceptance.

## Scope And Method

The fixed source is the complete `26ed35f` state of:

- `examples/m_demLayer/`;
- `examples/shared/scratchMap.js`;
- `packages/geoscratch/src/applications/terrain/`;
- the `LocalTerrain` public export.

The target is `examples/demLayer/`. The audit follows executable behavior and owners,
not old class names. `preserved` means reachable behavior remains; `replaced` means the
same responsibility is expressed by current primitives; `removed` means repository
and shader reachability proved no active consumer; `corrected` means a mechanical
current-contract change is enumerated.

## One-To-One Source Matrix

| Legacy source fact | Reachable in example | Existing owner | Target owner | Result | Code evidence | Browser evidence | Remaining limitation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `m_demLayer/index.html` standalone canvas, MapLibre 4.7.1, title `DEM Layer` | Yes | Legacy page | `demLayer/index.html` | Preserved and neutrally renamed | Same canvas, MapLibre assets, CSS, and visible title; route is `demLayer` | Final headed proof loads this route | CDN still supplies MapLibre itself |
| `m_demLayer/main.js` starts a map and adds `TerrainLayer(14)` | Yes | Legacy page/custom layer | `main.js`, `dem-map.js`, `dem-layer.js` | Replaced | One lifecycle, map, runtime, Surface, selector, and graph are explicit | Initialization and controlled camera proof | No generic custom-layer API retained |
| `terrainLayer.js` MapLibre custom-layer wrapper | Yes | `TerrainLayer` | Page scheduler and CPU selector | Replaced | `readDemCameraState()` plus `selectTerrainNodes()` feed `renderFrame()` | Camera pan/zoom changes selection and pixels | DEM remains a standalone example, not public Geo API |
| Shared CARTO dark style | Yes in normal mode | `ScratchMap` | `dem-map.js` | Preserved | Same four CARTO endpoints and opacity 0.92 | Normal route retains style; proof uses local background | Deterministic proof intentionally does not test CARTO availability |
| Center, zoom 9, Mercator, max zoom 18, antialias | Yes | `ScratchMap` | `DEM_MAP_DEFAULTS` and `createDemMap()` | Preserved | Constants and constructor descriptor | Initial proof selection is zoom-9 baseline | MapLibre internal camera math remains external |
| Underwater far-plane anchor and relative-to-eye matrix | Yes | `ScratchMap.update()` | `readDemCameraState()` | Preserved | Same `-80.06899999999999 * 30`, high/low split, and matrix sequence | Nonblank underwater terrain | Uses current MapLibre transform surface, as before |
| Global `StartDash`, `director`, `screen` | Yes as execution mechanism | Shared legacy runtime | GPURuntime, Surface, SubmissionBuilder | Replaced | No legacy symbol remains; explicit two-stage submission | Stage order and observations published | None |
| Shared legacy depth attachment and implicit pipeline depth defaults | Yes; `createTargetState()` changed undefined `depthTest` to true when the pass supplied depth | Shared map output pass and legacy pipeline wrapper | DEM-owned depth TextureResource, terrain PassSpec, and explicit terrain pipeline state | Preserved and made explicit | `depth32float`, `depthWriteEnabled: true`, `depthCompare: 'less'`; stable logical depth and explicit resize | Native attachment compatibility and resize allocation version | The current API refuses the legacy wrapper's implicit pass-to-pipeline mutation |
| `LocalTerrain` constructor constants | Yes | Library application class | `dem-layer.js` and selector constants | Preserved | max 14, capacity 5000, sector 64, exaggeration 50, elevation and terrain bounds | Facts published in graph/selection | Constants remain example policy |
| Two level-zero roots | Yes | `registerRenderableNode()` | `selectTerrainNodes()` | Preserved | Stack begins with `(0,0)` and `(0,1)` | Unit snapshots at zoom 2/9/10/12 | None |
| Terrain-boundary overlap | Yes | `BoundingBox2D.overlap()` | Pure array overlap | Preserved | Inclusive comparisons match legacy | Selected boxes stay on intersecting region | None |
| Camera-distance subdivision | Yes | `Node2D.isSubdividable()` | Pure selector node records | Preserved | Same center, `ceil`, size, and distance `<= 2` | Selection changes under controlled camera | CPU work remains application-owned |
| maxLevel/current zoom termination | Yes | `registerRenderableNode()` | Selector | Preserved | `node.level >= min(maxLevel, zoomLevel)` | Zoom 9/10 facts differ exactly | None |
| `node.level + 5 >= maxVisibleNodeLevel` | Yes | `registerRenderableNode()` | Selector | Preserved | Same post-traversal filter | Unit parity snapshots | None |
| 5,000-node cap | Yes | `bindingUsed < maxBindingUsedNum` | Selector | Preserved and explained | selected/capped/dropped counts; configurable small-cap test | Published count must stay `0..5000` | No streaming/residency policy added |
| Node levels, boxes, tile box, level range, sector range | Yes | Mutable numeric refs | Frozen serializable plan plus typed upload arrays | Replaced | Four fixed legacy snapshots match exactly | Current plan published as JSON | Typed GPU arrays remain fixed capacity |
| Dynamic LoD count `[4, bindingUsed]` | Yes | Binding range closure | Stable UploadCommand plus indirect DrawCommand | Replaced | `lodArguments`; two-submission capability proof | Exact upload/read epoch chain | No CPU resolver closure |
| Dynamic terrain count `[indexNum, bindingUsed]` with `asLine = 0` | Yes | Binding range closure | Stable UploadCommand plus indirect DrawCommand | Replaced | `terrainArguments = [24576, count, 0, 0]` | Native drawIndirect proof | Storage-indexed shader path intentionally retained |
| Plane geometry at `log2(64)` | Yes | `LocalTerrain.setResource()` | DEM graph initialization | Preserved | 16,388 position scalars and 24,576 index scalars | Terrain renders nonblank | Generator itself remains library utility |
| LoD-map pass before terrain pass | Yes | Global pre-render director stage | GPU render-patch lookup plus one terrain PassSpec | Replaced | `DEM_STAGE_ORDER`; compute-produced descriptor, lookup, and indirect epochs precede terrain reads | Published producer/consumer epochs | No automatic scheduler added |
| Fixed LoD map 512 by 256 | Yes | Legacy Texture | Logical render-patch hash keyed by standard tile identity | Replaced and removed | Two parity lookup buffers avoid source-extent texel aliasing | Pitched global-identity wireframe proof | Hash capacity remains explicitly bounded |
| DEM texture | Yes | Worker-backed image loader | Page-owned ImageBitmap then graph texture/upload | Preserved | PNG payload SHA-256 `aa7a584830f198772d242df1ce1ae47e21b2bdc85bfc1f97101af8be986c57e1` | Initialization upload observed before close | No mip chain added |
| `lodMapShader` | Yes | Library terrain shader module | Render-patch compute and terrain lookup functions | Replaced and removed | No `lod-map.wgsl`, texture, program, pipeline, pass, or command remains | Terrain executes directly after compute | Logical lookup is the only adjacency authority |
| `terrainMeshShader` active path | Yes | Library terrain shader module | `shaders/terrain-mesh.wgsl` | Preserved and strengthened | High-precision position/elevation path remains; neighbor lookup and arbitrary bounded level-delta snapping replace LoD-texture sampling | Terrain pixels are nonblank and pitched wireframe exposes adaptive patches | Active depth and grayscale behavior remain unchanged |
| `lastShader` | No | Export-only dead accumulation | None | Removed | No terrain import or pass referenced it | Not applicable | Hello GAW owns a different example-local shader with the same generic name |
| `terrainMeshLineShader` and line pipeline | No | `LocalTerrain`, gated by constant `asLine = 0` | None | Removed | No setter/control changed `asLine`; reachable getter selected mesh pipeline | Proof exercises only reachable mesh path | Line visualization is not preserved |
| Border image | No | Image loader only | None | Removed | Loaded but absent from every BindSet | Not applicable | None |
| Palette image, sampler/texture declarations, uncalled `colorMap`, and commented palette/debug path | No | Bound image/sampler plus dead WGSL accumulation | None | Removed | Active fragment returns inline grayscale; current shader contains no `lSampler`, `palette`, or `colorMap` token | Active terrain output matches the reachable shader | Palette styling would require a future application feature |
| `LocalTerrain.d.ts` and public export | No independent consumer | Package compatibility surface | None | Removed | Repository-wide consumer scan found only old DEM and export | Package/type gates | This is a 0.x clean cut without alias |
| `shared/scratchMap.js` after DEM migration | No remaining consumer | Shared legacy example helper | None | Removed | Flow and DEM each own current map hosts | Both headed map proofs | Map helpers are intentionally example-local |

Every fixed file and exported fact has a target disposition. No old route, helper,
declaration, asset aggregate, shader aggregate, or compatibility alias remains.

## Capability Gate

The gate ran before DEM implementation against unchanged Scratch core. The test reuses
two UploadCommands and two DrawCommands over two submissions while changing two
Uint32Array instance counts.

Observed facts:

- physical queue order is `writeBuffer`, `writeBuffer`, `submit` twice;
- both native passes call drawIndirect on the same two GPU buffers;
- indirect epochs advance `0 -> 1 -> 2`, once per upload;
- both draws retain immutable `'current-at-step'` declarations;
- resourceAccesses resolve reads to epoch 1 and then 2;
- producerEpochs identify the exact UploadCommand and step;
- no map, readback, raw queue, or resolver closure occurs.

The gate is `tests/scratch-dem-dynamic-count-capability.test.js` and commit `5515b31`.
No file under `packages/geoscratch/src/scratch/` changed for DEM.

## Historical CPU-Migration Persistent Graph Inventory

The graph contains:

- 13 resources: four uniform buffers, six data/argument buffers, DEM texture, LoD-map
  texture, and depth texture;
- five BindLayouts and five prepared BindSets;
- two Programs and two acknowledged render pipelines;
- two persistent PassSpecs;
- eleven persistent UploadCommands;
- two persistent indirect DrawCommands;
- 42 stable Scratch object identities, recomputed as 13 resources, 11 uploads, five
  BindLayouts, five BindSets, two Programs, two pipelines, two PassSpecs, and two
  commands whenever proof facts are published.

Camera changes mutate only codec byte arrays, fixed-capacity node arrays, and the two
indirect records. Resize replaces Surface/depth allocation state while all 42 graph
identities and every resource/layout/BindSet/pipeline count remain stable. The depth
texture is not bound, so the verified resize has zero stale BindSets and zero prepare
calls. The code still checks and prepares a set if an allocation-sensitive binding is
ever made stale.

## Historical CPU-Migration Submission And Provenance Matrix

| Step | Persistent operation | Resource effect | Required consumer fact |
| --- | --- | --- | --- |
| 0 | camera UploadCommand | dynamic uniform epoch +1 | terrain draw current-at-step read |
| 1 | tile UploadCommand | tile uniform epoch +1 | both draws current-at-step read |
| 2 | node-level UploadCommand | level buffer epoch +1 | LoD and terrain current-at-step reads |
| 3 | node-box UploadCommand | box buffer epoch +1 | LoD and terrain current-at-step reads |
| 4 | LoD arguments UploadCommand | indirect epoch +1 | LoD draw current-at-step read |
| 5 | terrain arguments UploadCommand | indirect epoch +1 | terrain draw current-at-step read |
| 6 | LoD-map PassSpec | LoD-map texture epoch +1 | terrain draw current-at-step read |
| 7 | terrain PassSpec | Surface and depth effects | observed SubmittedWork completion |

`verifyFrameProvenance()` hard-fails the frame if node-level, node-box, either indirect
record, or LoD-map producer/read facts do not connect at the same resolved epoch.

## Lifecycle And Failure Audit

The lifecycle object and pagehide registration precede map, runtime, image, pipeline,
and submission acquisition. Runtime and ImageBitmap acquisition have late-settlement
guards. Decoded image ownership ends only after the initialization upload's
nativeOutcome and done both succeed.

Terminal order is:

1. stop the frame scheduler and detach window/MapLibre/pagehide listeners;
2. settle issued observations;
3. close any still-owned external image;
4. remove MapLibre;
5. dispose GPURuntime.

Unit tests prove shared disposal Promise identity, one cleanup invocation, late runtime
and image release, tracked graph-creation/resize settlement before owner release, exact
normal ordering, primary failure de-duplication, and primary failure preservation when
map cleanup also fails. A forced provenance mismatch proves that already-issued native
work is observed before the application error is surfaced.

Exactly two proof faults exist:

| Scenario | Required acquisition boundary | Expected evidence and cleanup |
| --- | --- | --- |
| `after-map-acquisition` | Map count 1, runtime/image count 0 | Injected structured page failure; listeners/map released; no fabricated GPU evidence |
| `invalid-terrain-shader-wgsl` | Map, runtime, and image count 1 | Bounded ShaderModule diagnostic/capture; source text absent; image, map, runtime released; primary ShaderModule compilation failure retained |

## Managed Browser Evidence

`node tests/browser/scratch-dem-layer.mjs` passed in headed Chrome
`150.0.7871.125` on the Apple `metal-3` adapter. The runtime reported 23 features and
`maxTextureDimension2D = 16384`.

The managed normal proof recorded:

| Fact | Initial | Controlled zoom | Resize |
| --- | --- | --- | --- |
| Viewport | 960 by 720 | 960 by 720 | 800 by 600 |
| Selected nodes | 24 | 56 | 56 |
| Level range | 9..9 | 9..10 | 9..10 |
| Observed frame | 1 | 2 | 14 |
| Recomputed Scratch identities | 42 | same 42 and category counts | same 42 and category counts |
| Pixel SHA-256 | `9fcb78476a1dddfa69fe38777a68e38379f6e3b283612b6f8107ead7b1585184` | `49fa9ffe10c5807a51f5b7ae99a6d80016628abf5c8d8d9acfaf6161c98ecc70` | `fde008dfadeb2a9b7ffac7d332313339a57b9a7c9d560b72459b724f68e29abc` |
| Foreground pixels outside attribution | 110,767 | 152,186 | 115,821 |

Zoom 9 to 10 changed 223,316 pixels with mean RGB delta 14.889 while retaining a
visually coherent nonblank terrain surface. The five published chains had exact
producer/read epochs 1, then 2, then 14. Their producer/consumer step order was
`2 -> 6`, `4 -> 6`, `3 -> 7`, `5 -> 7`, and `6 -> 7`, so both indirect records and
the LoD-map dependency preceded their native consumers. The persistent graph remained
13 resources, five BindLayouts, five BindSets, and two pipelines.

Resize produced generation 1, depth allocation version 2, zero stale BindSets, and
zero prepare calls. Final drain reported zero application observations, native
observations, effectful SubmittedWork, and scheduled frame work. Normal execution had
zero diagnostic incidents, uncaptured errors, device losses, console errors, console
warnings, page errors, request failures, and HTTP failures. Double disposal returned
equivalent reports with one cleanup invocation and no retained owner or cleanup error.

Both deterministic failures passed under the pre-ADR-050 pipeline-owned compilation
model. `after-map-acquisition` remains unchanged. The migrated
`invalid-terrain-shader-wgsl` path now localizes the terrain ShaderModule, source hash,
source-part location, and `SCRATCH_SHADER_MODULE_COMPILATION_FAILED` directly. Its
one-operation/65,536-byte/2,000-ms bounds and ordered image, map, and runtime cleanup
remain executable assertions; current numeric browser evidence is deferred to the
Phase 6 rerun rather than copied from the superseded pipeline path.

The script closed headed Chrome, Vite, and its selected port. Screenshots are managed
ephemeral proof artifacts under `/tmp/geoscratch-dem-layer-browser`; they are not
repository assets.

The final combined-tree rerun on headed Chrome `150.0.7871.130` again passed with 24
initial and 56 moved visible nodes, the same 42 persistent identities, both failure
scenarios, and clean browser/server shutdown. The complete repository suite reported
941 passing tests and only the two declared pending gates; production emission reported
100 JavaScript/declaration pairs with no stale, missing, or mismatched output.

## Remaining Limitations

- Render-patch LoD currently follows integer camera zoom and inherits distance
  degradation from the data frontier's source-page level. It does not yet have an
  independent reusable Geo SSE/hysteresis policy.
- GPU patch count, overflow, and selected-level state are bounded internally but are
  not continuously read back to the CPU; visual proof and declared target facts avoid
  a per-frame diagnostic readback cost.
- The proof controls MapLibre camera state but does not validate remote CARTO service
  uptime.
- Scratch records exact logical/native outcomes but does not claim physical VRAM
  reclamation timing, OOM causality, or device-loss recovery.
- No generic application lifecycle, terrain layer, material, scheduler, or public Geo
  API is introduced.
