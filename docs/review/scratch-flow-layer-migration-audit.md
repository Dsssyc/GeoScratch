# Scratch Flow Layer Migration Audit

## Audit Status

Integrated on `dev-feature` through implementation/gate commit `bceb8a2`. The fixed
legacy source remains
`d8e4f4d226f1793a7fcb8cde038566dc4a704afa:examples/m_flowLayer`; the migration started
from `dev-feature` commit `26ed35ffea5114e6968e013be9dca2e302e49ff1` and package
version `0.0.22`. The combined DEM/Flow tree passed the complete verification contract
recorded below.

## Scope And Method

The fixed source is `d8e4f4d:examples/m_flowLayer` plus only the portions of
`d8e4f4d:examples/shared/scratchMap.js` used by Flow. The target is
`examples/flowLayer`. DEM, `LocalTerrain`, Scratch core, ignored Flow datasets, and
MapLibre internals are outside the implementation scope.

The audit compares executable facts, not old class names. A row is `preserved` when
the same business behavior is expressed through current primitives, `replaced` when
ownership or execution changes intentionally, and `corrected` when the fixed source
contains a demonstrable defect.

## One-To-One Source File Matrix

| Fixed source file | Target file | Classification | Evidence |
| --- | --- | --- | --- |
| `m_flowLayer/index.html` | `flowLayer/index.html` | Preserved and renamed | Same standalone canvas, MapLibre 4.7.1 assets, shared example CSS, and module startup; neutral title and route. |
| `m_flowLayer/main.js` | `flowLayer/main.js` | Replaced | `startScratchMap()` and MapLibre custom-layer registration become explicit lifecycle, Worker stream, ScratchRuntime, Surface, map host, and frame scheduler ownership. |
| `m_flowLayer/flowJson.worker.js` | `flowLayer/flow-worker.js` | Preserved and narrowed | Loads binary velocity fields, computes maximum speed, transfers the typed-array buffer, returns request/index/url identity, and reports structured failures. Dead JSON/station triangulation code and unused imports are removed. |
| `m_flowLayer/steadyFlowLayer.js` | `flowLayer/flow-layer.js` | Replaced | The legacy custom layer, implicit director graph, numeric refs, executable flags, and implicit updates become persistent current-API objects and explicit submissions. |
| `m_flowLayer/steadyFlowLayer.js` lifecycle portions | `flowLayer/flow-lifecycle.js` | Strengthened | Worker-only `onRemove()` becomes one authority for stop, settle, Worker, map, and runtime ordering, at-most-once cleanup, and primary/secondary failures. |
| `m_flowLayer/steadyFlowLayer.js` map-facing portions | `flowLayer/flow-map.js` | Replaced | Camera facts and map defaults are read from a page-owned MapLibre instance without inheriting the legacy `ScratchMap`. |
| `shaders/flow/flowLayer.wgsl` | Same target path | Byte-identical | SHA-256 `225a94b8fe79c052264a1fcb81f96a7d4ebf36d384bf695645984f551c32382a`. |
| `shaders/flow/flowShow.wgsl` | Same target path | Byte-identical | SHA-256 `9e515dcef0e7cff01e5a9f1828e3dff7561991abc3b54596f33c017b3544733a`. |
| `shaders/flow/flowVoronoi.wgsl` | Same target path | Corrected | SHA-256 `f8fae35c1a5fa35fdbddd8b5cc24f40a53d54877943efa63c7bd8f6e99e7826e`. Carries reconstructed Mercator position to the fragment stage and writes zero velocity/mask outside the legacy estuary display extent. |
| `shaders/flow/particles.wgsl` | Same target path | Preserved with semantic field rename | SHA-256 `315d1f806fe4326b28b524a78b4520a43ba5358a5210ff0aed6ad2291c85b715`; `extent` is renamed `displayExtent` without changing particle behavior. |
| `shaders/flow/simulation.compute.wgsl` | Same target path | Preserved with semantic field rename | SHA-256 `aedf78a69868f2a3df565ee6f6f39851c975570bfb87449bedc9af5dd0a84748`; `extent` is renamed `displayExtent` without changing simulation behavior. |
| `shaders/flow/swap.wgsl` | Same target path | Byte-identical | SHA-256 `a9f08a0a027e059076f11b3f68969241d74d34e56ac464b608bb931aa5220897`. |
| `shaders/flow/arrow.wgsl` | Same target path | Corrected | Legacy SHA-256 `f11b55d300655f5cab0376ffcda67145180e4840db2fef4085f0fa9ef0b8bf7b`; target SHA-256 `ffce4cf43b21f44ed6ff65c21b6d3694a0b98faf33d9ebe961649a26cd988547`. Reads use stride 6 with velocity offsets 4/5, consume current longitude/latitude positions directly, and rename `extent` to `displayExtent`. |

All eleven fixed Flow files have a target disposition. No old route, redirect, or
parallel implementation remains.

## Shared Map Usage Matrix

| Flow-used fixed helper behavior | Target expression | Result |
| --- | --- | --- |
| Resolve `maplibregl`/`mapboxgl` | `flow-map.js` resolves the same page global | Preserved. |
| CARTO dark raster style | `darkMatterStyle` in `flow-map.js` | Preserved for normal execution. |
| Center `120.980697, 31.684162`, zoom 9, Mercator projection, max zoom 18, antialias | `FLOW_MAP_DEFAULTS` plus `createFlowMap()` | Preserved. |
| Separate map container behind `#GPUFrame` | `createFlowMap()` | Preserved with explicit page ownership. |
| `StartDash()` | None | Removed; Flow creates one explicit async ScratchRuntime. |
| `ScratchMap extends MapLibre.Map` | Plain page-owned MapLibre map | Replaced; no hybrid WebGL/WebGPU ownership claim. |
| Legacy dynamic uniform buffer | `FlowCameraUniform` BufferResource and persistent UploadCommand | Replaced with explicit CPU packing and upload. |
| Legacy screen and shared depth texture | Surface plus Flow-owned depth TextureResource | Replaced with explicit Scratch ownership. |
| Global pre-render/render director stages | One ordered SubmissionBuilder per frame | Replaced with visible five-stage order. |
| Camera position, high/low split, bounds, zoom | `readFlowCameraState()` | Preserved. |
| Mercator custom-layer matrix and underwater far-plane anchor | Local matrix helpers in `flow-map.js` | Preserved for Flow without modifying DEM's shared helper. |
| `add2PreProcess()` and `add2RenderPass()` | Persistent PassSpecs and Commands selected in `renderFrame()` | Replaced. |

The deterministic proof style is a local MapLibre background with no network source.
It exists only under `proof=1`; it does not replace the normal remote basemap.

## Behavior Parity Matrix

| Required fact | Fixed implementation | Target implementation | Verdict |
| --- | --- | --- | --- |
| Particle count | `maxParticleNum = 262144` | `PARTICLE_COUNT = 262_144` | Preserved. |
| Compute coverage | block 16; 32 by 32 workgroups | block 16; 32 by 32 workgroups | Preserved. |
| Temporal fields | 27 explicit URLs | `FIELD_COUNT = 27`, indexed stable URL | Preserved. |
| Phase duration | 300 frames | `FRAMES_PER_FIELD = 300` | Preserved. |
| Initial and prefetched fields | Load 0 and 1, then request next | Load 0 and 1 concurrently, prefetch 2, then rotate | Preserved. |
| Maximum speed | Monotonic maximum over loaded fields | Same monotonic maximum | Preserved. |
| Station triangulation | D3 Delaunay over `station.bin` | Same library and source data | Preserved. |
| Station resource coverage | `station.bin` includes offshore stations through approximately `123.0563` east | Same complete resource, published as `resourceExtent` | Preserved; source data is not cropped. |
| Business display extent | Fixed extent ends at `121.96623240116922` east and fixed-source rendering stops at the Yangtze estuary | `FLOW_DISPLAY_EXTENT` is distinct from `resourceExtent`; Voronoi velocity and mask are zeroed outside it | Corrected after the initial migration exposed the full offshore resource domain. |
| Domain support | Maximum triangle edge against `0.04` | Same calculation and default | Preserved. |
| Expanded station velocities | Triangle vertex to station index expansion | Same indexed expansion | Preserved. |
| Velocity interpolation | From/to vertex attributes and progress | Same attributes and progress `0..299 / 299` | Preserved. |
| Velocity target | Screen-dependent `rg32float` | Stable `rg32float` TextureResource | Preserved. |
| Domain mask target | Screen-dependent `r8unorm` | Stable `r8unorm` TextureResource | Preserved. |
| Particle simulation | One compute pass, writable particle storage | Persistent DispatchCommand and compute PassSpec | Preserved. |
| GPU particle residency | Six-float storage state written and drawn on GPU | Same; no readback or CPU mirror | Preserved. |
| History storage | Two screen-dependent RGBA textures | Two stable `rgba8unorm` textures | Preserved. |
| Direction rotation | Executable flags and `swapPointer` | Two immutable direction sets selected per submission | Preserved with explicit selection. |
| Decay/cutoff/mask | Cleanup uniform and `swap.wgsl` | LayoutCodec-backed cleanup uniform and same shader | Preserved. |
| History modes | `off`, `clear`, `reproject` | Same normalized modes | Preserved. |
| Camera invalidation | Map event listeners call `idle()`/`restart()` | Owned listeners call `cameraMoving()`/`cameraSettled()` | Preserved without global flags. |
| Reprojection | Previous/current camera facts and reverse gather | Same shader and explicit uniform upload | Preserved. |
| Resize | Legacy screen-dependent implicit replacement | Explicit Surface/texture resize plus stale-only BindSet preparation | Strengthened and made observable. |
| Frame cadence | `triggerRepaint()` keeps normal rendering display-paced | One next-frame `requestAnimationFrame()` is scheduled after the prior SubmittedWork observation; no second timer throttles the loop | Preserved with explicit single-frame backpressure. |
| Optional Voronoi view | Configured true, then binding disabled every active render | Disabled during normal rendering; `field=1` explicitly enables the diagnostic view | Preserved for the normal presentation while retaining an explicit diagnostic path. |
| Optional arrows | Add call commented out; shader used wrong stride and normalized positions | Query-controlled; six-float stride and current longitude/latitude representation are both corrected and browser-exercised | Corrected intended behavior. |
| Normal blending | Legacy `NormalBlending` | Explicit source-alpha blend state | Preserved. |
| Map defaults | CARTO, center, zoom, Mercator, max zoom, antialias | Same normal defaults | Preserved. |
| Hide/show custom-layer methods | MapLibre custom-layer-only control surface | No replacement public method | Intentionally removed with the old custom-layer API; not used by the standalone example. |

## Persistent Graph Inventory

After initialization the normal graph contains:

- 15 logical resources: ten buffers and five textures;
- 10 BindLayouts and 12 prepared BindSets;
- 7 Programs and 7 acknowledged pipelines;
- 7 persistent PassSpecs;
- 10 persistent UploadCommands;
- 9 persistent Draw/Dispatch commands;
- 2 persistent history-direction selections.

The 77 Scratch object identities remain unchanged across field transitions and resize.
The logical footprint changes when texture allocations resize, but resource, layout,
BindSet, and pipeline counts do not. BindSet preparation occurs only when a texture
allocation replacement marks an allocation-sensitive view stale.

Each frame creates only a SubmissionBuilder and SubmittedWork. The visible order is:

1. `voronoi-field`;
2. `particle-simulation`;
3. `history-particles`;
4. `flow-visualization`;
5. `history-presentation`.

SubmittedWork proves three same-submission producer/read chains with
`'current-at-step'`: velocity to simulation, simulated particle state to particle
drawing, and the selected history target to presentation.

## Streaming And Lifecycle Audit

The lifecycle authority and its pagehide listener are created before `main()` and
before the first initialization `await`. The Worker and MapLibre map transfer ownership
synchronously. Runtime acquisition is a tracked observation: if disposal starts first,
the late runtime is disposed before acquisition settles. The authority abort signal
interrupts map readiness and station fetches, while new field requests fail before a
Worker message or pending entry can be created. Worker listeners, MapLibre listeners,
pagehide handling, and frame scheduling all register explicit stop actions. Each issued
SubmittedWork observation registers before it is awaited.

Terminal order is:

1. stop frame scheduling, detach camera listeners, detach Worker listeners, and detach
   pagehide in reverse registration order;
2. settle observations already issued;
3. terminate the Worker;
4. remove the page-owned MapLibre map;
5. dispose the Scratch runtime.

Concurrent disposal calls share one Promise. Unit tests inject stop, Worker, and map
cleanup failures and prove that later cleanup continues while the original failure
remains primary.

## Diagnostics And Failure Audit

Normal runtime limits are 256 operations, 32 incidents, 262,144 evidence bytes, and 8
pending native observations. Long-run recording reaches finite capacity without
growing past it. Default records retain summaries rather than full descriptors,
command payloads, stacks, or SubmittedWork objects.

Exactly two fault scenarios exist:

| Scenario | Boundary and evidence | Cleanup proof |
| --- | --- | --- |
| `after-worker-acquisition` | One `FLOW_LAYER_INJECTED_FAILURE` immediately after Worker/listener ownership; no runtime evidence is fabricated. | Worker and pagehide listener removal, then Worker termination; zero pending observations and no retained action. |
| `invalid-simulation-pipeline-wgsl` | In-memory module mutation immediately before simulation pipeline creation. One deep capture stops at the one-operation limit. Structured evidence identifies compute pipeline ID, Program ID, one module hash/range, compilation messages, and `SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED`. | Listener, Worker, map, then runtime; original `SCRATCH_PIPELINE_CREATION_MULTIPLE_FAILURES` remains primary. |

The invalid-WGSL evidence contains hashes, ranges, redacted messages, and native labels,
but no WGSL source field or injected source text. Runtime export remains under 512 KiB;
deep capture remains under 65,536 bytes and 2,000 ms.

## Managed Browser Evidence

The first complete run of `node tests/browser/scratch-flow-layer.mjs` on 2026-07-18
reported `passed` in headed Chrome `150.0.7871.125` with an Apple Metal 3 adapter.

- 660 submitted and 660 observed frames;
- 2 completed Worker-fed field transitions at the 300- and 600-frame boundaries, with
  progress and field indices matching the 27-field cycle;
- live graph facts reported the Voronoi MRT targets as `rg32float` velocity and
  `r8unorm` mask attachments;
- camera move, settle, and 20 reprojection frames;
- one explicit resize generation;
- stable 77-object identity set across movement, field changes, and resize;
- all five stage counters equal to 660;
- all three producer/read provenance chains matched exact epochs;
- zero normal diagnostic incidents, uncaptured errors, and device losses;
- zero console warnings/errors, page errors, request failures, and HTTP failures on the
  normal proof page;
- nonblank and changing screenshots before movement, after movement, and after resize;
- zero pending SubmittedWork/native observations and zero active frame work after
  pause-and-drain;
- at-most-once cleanup with no secondary failure;
- both deterministic failure scenarios passed their structured checks;
- Chrome, managed Vite, and the selected port all closed.

The normal proof ran with `arrows=1`, so the corrected optional arrow path compiled,
submitted, and rendered under the same native validation gate.

The 2026-07-22 correction run also reported `passed` in headed Chrome
`150.0.7871.130` on Apple Metal 3. Its fixed-camera `flow-estuary-boundary.png` proof
published the complete station resource extent
`[120.0449447631836, 29.434587478637695, 123.0562973022461, 32.26061248779297]`
separately from the legacy display extent
`[120.04373606134682, 31.173901952209487, 121.96623240116922, 32.08401085804678]`.
Pixel inspection found a visible field west of the projected eastern boundary and no
field leakage in the sampled near-sea region east of it. The same run completed all
660 normal frames, both fault scenarios, browser cleanup, managed Vite cleanup, and
port-closure checks.

A same-day motion-parity follow-up compared the fixed legacy page and target page at
`960 x 720` with the same accumulated history and `1200`-delta zoom-out. It exposed two
migration errors: the target rendered the diagnostic Flow Show command during normal
frames, and a `22 ms` timer followed by `requestAnimationFrame()` reduced a four-second
window from display-paced execution to 112 frames. With the normal diagnostic field
disabled and the redundant timer removed, the same window completed 223 frames and the
100 ms/500 ms recovery images retained only the reprojected particle history, matching
the legacy presentation without the full-field/old-viewport brightness rectangle. The
managed browser gate then passed again with `fieldVisualization=false`,
`frameScheduler=requestAnimationFrame`, more than 660 drained frames, both diagnostic
faults, clean browser/server shutdown, and no normal console or GPU errors.

## Scope Integrity

- No file under `packages/geoscratch/src/scratch/` changed.
- No raw `runtime.device` or queue access was introduced.
- No CPU readback, CPU mirror of GPU-produced particle state, or per-frame persistent
  object reconstruction was introduced.
- No ping-pong, scheduler, layer, material, or render-graph abstraction was added to
  Scratch core.
- `m_demLayer`, `LocalTerrain`, and the shared legacy map helper are unchanged.
- `station.bin` and `uv_0.bin` through `uv_26.bin` remain ignored and uncommitted.
- No missing current Scratch capability was found.

## Verification Contract

The following remain the regression contract for the integrated implementation. They
passed from committed tree `bceb8a2` before `dev-feature` integration:

```bash
npm run typecheck
npm test
npm run build
git diff --check
node tests/browser/scratch-submission-native-provenance.mjs
HELLO_GAW_PROOF_FRAMES=240 node tests/browser/scratch-hello-gaw.mjs
node tests/browser/scratch-hello-gaw-init-failures.mjs
node tests/browser/scratch-flow-layer.mjs
```
