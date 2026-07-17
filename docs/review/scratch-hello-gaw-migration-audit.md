# Scratch Hello GAW Migration Audit

Status: Implementation and acceptance gates complete
Date: 2026-07-17
Fixed implementation baseline: `3dd31815f13c7d67c939902601e2e2552d32b5b3`
Feature branch: `socu/hello-gaw-clean-cut-v1`

## Decision

Every visible and executable behavior in the fixed `x_helloGAW` baseline has a
direct representation in the current Scratch API. No row requires a Scratch core
change, CPU readback of GPU-produced indirect arguments, hidden preparation,
frame-local persistent objects, or a compatibility path. The migration can proceed
as one clean replacement.

This audit is the one-to-one implementation checklist. A row is not complete merely
because a similarly named object exists: final status requires the target object to
participate in the explicit five-stage submission and browser proof.

## Fixed Legacy Browser Evidence

The legacy page was run before migration edits from the fixed baseline with a managed
headed Chrome session and a dedicated Vite port.

- URL: `http://127.0.0.1:4177/x_helloGAW/index.html`
- Browser: Chrome `150.0.7871.125`, headed
- Adapter: Apple Metal 3
- Canvas: `960 x 720`
- First frame: 161,015 non-dark pixels, channel range 239, mean luma 20.0743
- Second frame one second later: 162,841 non-dark pixels, channel range 238,
  mean luma 20.3269
- Changed pixels: 138,366; mean RGB delta 19.1946; maximum RGB delta 571
- Console warnings/errors: 0 / 0
- Page errors: 0
- Request failures and HTTP 4xx/5xx responses: 0 / 0
- Managed port after shutdown: closed
- Evidence: `/tmp/geoscratch-hello-gaw-legacy-baseline/baseline.json` and two PNGs

These facts are a factual visual/error baseline, not a claim that two screenshots
alone prove shader parity. Final proof additionally requires the five-stage graph,
resource epochs, stable identities, resize behavior, and at least 240 observed frames.

## Resource Replacement Matrix

| Legacy resource or state | Fixed-baseline role | Scratch replacement | Lifetime and proof requirement | Status |
| --- | --- | --- | --- | --- |
| `StartDash`, global device, `screen` | Device initialization and presentation | One awaited `ScratchRuntime` plus one owned `Surface` | Page lifetime; no global runtime or second Surface | Verified |
| `timeCount`, radius, link limits, colors, numeric wrappers | Scalar/vector constants and mutable frame values | Plain numbers, typed arrays, and immutable descriptors | No `f32`/`u32`/`aRef`/`as*` wrapper | Verified |
| `viewMatrix`, `projectionMatrix`, `modelMatrix`, `normalMatrix` | Camera/model transforms | Stateless matrix helper output packed by `LayoutCodec` | CPU values may change; GPU buffer and upload identity remain stable | Verified |
| Sphere index vertex buffer | One `u32` index attribute per generated sphere vertex | `BufferResource` with `VERTEX | COPY_DST` plus one `BufferRegion` | Uploaded once; persistent | Verified |
| Sphere positions | Shader-read sphere positions | `BufferResource` with `STORAGE | COPY_DST` plus region | Uploaded once; persistent | Verified |
| Sphere normals | Shader-read sphere normals | `BufferResource` with `STORAGE | COPY_DST` plus region | Uploaded once; persistent | Verified |
| Sphere UVs | Shader-read sphere UVs | `BufferResource` with `STORAGE | COPY_DST` plus region | Uploaded once; persistent | Verified |
| Eight used image textures | Day/night land and cloud color, land mask, cloud alpha, specular, emission | Eight `TextureResource` objects plus persistent `TextureViewSpec` objects | Await image decode, then ordered `ExternalImageUploadCommand` calls; no legacy loader | Verified |
| Particle velocities | Read-only simulation input | Storage `BufferResource` and region | Uploaded once; persistent | Verified |
| Particle positions | Simulation write, indexing/link read, instanced vertex input | One `STORAGE | VERTEX | COPY_DST` `BufferResource` | GPU content remains resident; produced by simulation each frame | Verified |
| Particle colors | Instanced point color | `VERTEX | COPY_DST` `BufferResource` | Uploaded once; persistent | Verified |
| Link indices | Indexing write and link vertex-shader read | `STORAGE | COPY_DST` `BufferResource` | Initialized once, then GPU-produced each frame | Verified |
| Connection counts | Per-frame atomic indexing scratch | `STORAGE | COPY_DST` `BufferResource` | Persistent zero payload and persistent upload command reset it each frame | Verified |
| Link indirect arguments | GPU link count and draw arguments | `STORAGE | INDIRECT | COPY_DST` `BufferResource` | Initial upload plus per-frame count reset; GPU writes instance count; never mapped/read back | Verified |
| Scene, particle, link, simulation, indexing uniform blocks | Static and dynamic shader parameters | Layout-derived uniform buffers, regions, typed payloads, and upload commands | Static blocks upload once; dynamic payload/upload identities remain stable | Verified |
| Bloom threshold/strength/steps and FXAA/output constants | Postprocess parameters | Layout-derived uniform buffers and persistent uploads | Upload once unless a value changes | Verified |
| Gaussian kernel storage | Bloom blur weights | Read-only storage buffer and region | Generated and uploaded once | Verified |
| Linear repeating sampler | Image and final-output sampling | One acknowledged `SamplerResource` | Persistent; no legacy sampler wrapper | Verified |
| Scene color | HDR scene render target and Bloom source | Stable `rgba16float` `TextureResource` plus view spec | Explicit resize transaction; scene pass writes each frame | Verified |
| Scene depth | Depth test/write for globe and overlays | Stable `depth24plus` `TextureResource` plus view spec | Explicit resize transaction | Verified |
| Bloom highlight | Full-resolution threshold output | Stable `rgba16float` sampled/storage texture | Explicit resize and BindSet re-prepare | Verified |
| Five downsample levels | Half through 1/32-resolution highlight chain | Five stable sampled/storage textures | Sizes derive explicitly from surface extent at resize | Verified |
| Five horizontal blur levels | Blur intermediates | Five stable sampled/storage textures | Explicit resize and BindSet re-prepare | Verified |
| Five vertical blur levels | Upsampled accumulated Bloom chain | Five stable sampled/storage textures | Explicit resize and BindSet re-prepare | Verified |
| Bloom output | Scene plus blurred highlights | Stable sampled/storage `rgba16float` texture | Explicit resize and producer epoch | Verified |
| FXAA output | Antialiased Bloom result | Stable sampled/storage `rgba16float` texture | Explicit resize and producer epoch | Verified |

All buffer range consumers use `BufferRegion`. All persistent texture consumers use
`TextureViewSpec`; no public native view is cached by the example.

## Binding Replacement Matrix

| Legacy binding | Shader ABI and concrete inputs | Scratch replacement | Status |
| --- | --- | --- | --- |
| Land/water | Four uniform blocks, sphere storage triplet, sampler, five earth textures, sphere index vertex stream | Explicit groups 0/1/2, acknowledged BindSets, named entries, and command vertex slot | Verified |
| Cloud | Four uniform blocks, sphere storage triplet, sampler, three cloud textures, sphere index vertex stream | Explicit groups 0/1/2 and acknowledged BindSets | Verified |
| Particle simulation | Static uniform, velocity read storage, position read-write storage | Explicit compute BindLayouts/BindSets; position declared read and write | Verified |
| Link indexing | Static uniform, position read storage, three read-write storage buffers | Explicit compute BindLayouts/BindSets; every writable storage binding declared read and write | Verified |
| Particle rendering | Dynamic/static uniforms and two instanced vertex streams | Explicit uniform BindSet plus two command-owned vertex slots | Verified |
| Link rendering | Dynamic/static uniforms, positions/link indices, indirect arguments | Explicit uniform/storage BindSets plus indirect count region | Verified |
| Bloom highlight | Threshold uniform, scene sampled texture, highlight storage texture | Explicit uniform and texture/storage BindSets | Verified |
| Bloom downsample, five variants | Previous level sampled texture and next level storage texture | One layout with five immutable BindSets | Verified |
| Bloom blur X/Y, ten variants | Step uniform, Gaussian storage, highlight/current sampled textures, destination storage texture | Shared layouts with immutable per-level BindSets | Verified |
| Bloom combine | Strength uniform, scene and blur sampled textures, Bloom output storage texture | Explicit BindSets | Verified |
| FXAA | Threshold/search uniform, Bloom sampled texture, FXAA storage texture | Explicit BindSets | Verified |
| Final output | Gamma/density uniform, sampler, FXAA sampled texture | Explicit BindSets | Verified |

Content writes do not stale these BindSets. Texture allocation replacement does; the
resize transaction explicitly calls `prepare()` exactly once per stale set.

## Pipeline And Command Replacement Matrix

| Legacy pipeline | Native behavior to preserve | Scratch Program/Pipeline/Command | Status |
| --- | --- | --- | --- |
| Land render | Triangle list, normal alpha blend, depth write/less | Persistent Program, render Pipeline, DrawCommand | Verified |
| Water render | Triangle list, normal alpha blend, depth write/less | Persistent Program, render Pipeline, DrawCommand | Verified |
| Cloud render | Triangle list, additive blend, depth write/less | Persistent Program, render Pipeline, DrawCommand | Verified |
| Particle render | Triangle strip, instancing, normal alpha blend, depth compare without write | Persistent Program, render Pipeline, DrawCommand | Verified |
| Link render | Line strip, GPU indirect draw, depth compare without write | Persistent Program, render Pipeline, indirect DrawCommand | Verified |
| Particle simulation | `10 x 10 x 1` workgroup dispatch | Persistent Program, compute Pipeline, DispatchCommand | Verified |
| Link indexing | `10 x 10 x 1` workgroup dispatch and GPU indirect-argument write | Persistent Program, compute Pipeline, DispatchCommand | Verified |
| Bloom highlight | Full-resolution compute | Persistent Program/Pipeline; size-dependent DispatchCommand | Verified |
| Bloom downsample | Five compute dispatches | Persistent Program/Pipeline; five size-dependent DispatchCommands | Verified |
| Bloom horizontal blur | Five reverse-order compute dispatches | Persistent Program/Pipeline; five size-dependent DispatchCommands | Verified |
| Bloom vertical blur | Five reverse-order compute dispatches with level accumulation | Persistent Program/Pipeline; five size-dependent DispatchCommands | Verified |
| Bloom combine | Full-resolution compute | Persistent Program/Pipeline; size-dependent DispatchCommand | Verified |
| FXAA | Full-resolution compute | Persistent Program/Pipeline; size-dependent DispatchCommand | Verified |
| Output | Triangle-strip full-screen draw, ACES tone mapping, gamma and stripe modulation | Persistent Program, render Pipeline, DrawCommand | Verified |

The Bloom stage therefore contains 17 ordered dispatch commands: one highlight, five
downsample, five X blur, five Y blur, and one combine. FXAA remains a separate stage.

## Five-Stage Submission Matrix

| Stage | Legacy order | Scratch submission step | Required producer/read facts | Status |
| --- | ---: | --- | --- | --- |
| Simulation/indexing | 1 | One persistent `ComputePassSpec` with simulation then indexing | Uploads produce resets/uniforms; simulation produces positions; indexing reads those positions and produces link indices/indirect arguments | Verified |
| Scene render | 2 | One persistent `RenderPassSpec` with land, links, particles, water, cloud | Link draw reads indexing output; particles read simulation output; attachment write produces scene color | Verified |
| Bloom | 3 | One persistent `ComputePassSpec` with the 17-command graph | Every level reads only earlier scene/Bloom producers and writes one later epoch | Verified |
| FXAA | 4 | One persistent `ComputePassSpec` with one dispatch | Reads current Bloom output and produces FXAA output | Verified |
| Presentation output | 5 | One persistent `RenderPassSpec` targeting the borrowed Surface texture | Reads current FXAA output and writes presentation | Verified |

Uploads precede stage 1 in the same authored submission order. They are transfer steps,
not a sixth rendering stage.

## Resize Matrix

| Legacy resize behavior | Scratch transaction | Stable facts | Rebuilt facts | Status |
| --- | --- | --- | --- | --- |
| Screen follows CSS/device pixels | Explicit `surface.resize()` | Runtime and Surface identity | Surface configuration version only | Verified |
| Scene/depth follow screen | Await each stable texture's `resize(surface.size)` | Texture/ViewSpec/PassSpec identity | Native allocation version | Verified |
| Bloom/FXAA full and pyramid targets follow screen | Await explicit full/derived texture resizes | Texture/ViewSpec identity | Native allocations | Verified |
| Legacy binding callbacks follow replaced textures | Explicitly prepare every stale texture BindSet once | BindSet identity and binding table | Prepared native snapshot/generation | Verified |
| Dispatch closures recalculate dimensions | Recreate only static-count Bloom/FXAA DispatchCommands | Programs, Pipelines, BindSets, PassSpecs and non-size commands | Size-dependent command identities | Verified |

No resize observer, resource scan, automatic preparation, per-frame `prepare()`, or
whole-graph reconstruction is introduced.

## Asset Inventory

All JPEGs except `dark.jpg` are `1920 x 960`; `dark.jpg` is `1024 x 1024`.

| Asset | Legacy use | Final disposition | Status |
| --- | --- | --- | --- |
| `earth.jpg` | Land/water day color | Move beside neutral example and upload explicitly | Required |
| `earth-night.jpg` | Land/water night color | Move and upload explicitly | Required |
| `earth-specular.jpg` | Land specular response | Move and upload explicitly | Required |
| `earth-selfillumination.jpg` | Night emission | Move and upload explicitly | Required |
| `mask-land.jpg` | Land/water split | Move and upload explicitly | Required |
| `cloud.jpg` | Cloud day color | Move and upload explicitly | Required |
| `cloud-night.jpg` | Cloud night color | Move and upload explicitly | Required |
| `cloud-alpha.jpg` | Cloud alpha mask | Move and upload explicitly | Required |
| `cloud-height.jpg` | Not referenced by fixed `main.js` or shaders | Remove with old directory; no visible behavior to preserve | Unused baseline asset |
| `cloud-normal.jpg` | Not referenced | Remove | Unused baseline asset |
| `dark.jpg` | Not referenced | Remove | Unused baseline asset |
| `earth-height.jpg` | Not referenced | Remove | Unused baseline asset |
| `earth-normal.jpg` | Not referenced | Remove | Unused baseline asset |
| `mask-lake.jpg` | Not referenced | Remove | Unused baseline asset |
| `mask-seaice.jpg` | Not referenced | Remove | Unused baseline asset |
| `uvw.jpg` | Not referenced | Remove | Unused baseline asset |

The eight legacy workload shaders move beside the neutral example. Bloom and FXAA
shader code becomes example-owned WGSL instead of importing package legacy effects.

## Visible-Effect Parity Checklist

| Visible behavior | Preserving mechanism | Final proof |
| --- | --- | --- |
| Rotating textured earth | Fixed-step or realtime dynamic transform upload | Changing nonblank pixels across observed frames |
| Day/night land lighting, mask, specular, emission | Same shader inputs and blend/depth contract | Screenshot and stage completion |
| Water separated by inverse land mask | Same shader and draw order | Screenshot |
| Additive moving cloud shell | Same shader, texture set, blend and depth contract | Screenshot and changing pixels |
| Moving particle points | GPU simulation output reused as instanced vertex input | Simulation producer equals particle draw read |
| Dynamic links | GPU indexing and indirect arguments, no host materialization | Indexing producer equals link indirect/read facts |
| Bloom | Explicit 17-command pyramid/blur/combine graph | Bloom stage command count and producer chain |
| FXAA | Explicit compute stage | FXAA producer/read facts |
| Final tone map/stripe | Final output WGSL and Surface render pass | Presentation stage and screenshot |
| Resize | Explicit allocation replacement, BindSet preparation, dispatch rebuild | Another 120 observed frames after browser-driven resize |

## Forbidden Compatibility Boundary

The neutral example must not contain `StartDash`, `director`, `screen`, legacy
`binding`/pass/pipeline/buffer/texture/sampler/image-loader calls, mutable numeric
wrappers, `BloomPass`, or `FXAAPass`. It imports public package APIs from
`geoscratch`, never package source. The old route and directory are removed rather
than redirected.

## Implemented Browser Evidence

The neutral page was run after the clean replacement with
`HELLO_GAW_PROOF_FRAMES=240 node tests/browser/scratch-hello-gaw.mjs`.

- URL: managed dynamic-port `/helloGAW/index.html?proof=1`
- Browser: Chrome `150.0.7871.125`, headed
- Adapter: Apple Metal 3
- Before resize: 121 submitted / 120 observed frames at `960 x 720`
- After resize: 242 submitted / 241 observed frames at `800 x 600`
- Stage order: simulation/indexing, scene, Bloom, FXAA, presentation
- Scene/Bloom command counts: 5 / 17
- Stable identity hash: `205dab3d` before and after resize
- Size-dependent command hash: `0d34a459` before, `584db5b6` after resize
- Exact producer/read chains: 6 / 6 with authored `'current-at-step'` and equal
  resolved epochs
- Diagnostics: 256 / 256 retained operations, 0 incidents, bounded evidence,
  0 uncaptured errors, 0 device losses
- Motion proof: 148,542 changed pixels, mean RGB delta 16.1157, maximum delta 499
- Non-dark pixels: 182,773 motion start; 184,346 before resize; 130,341 after resize
- Console warnings/errors, page errors, request failures, HTTP 4xx/5xx: all zero
- Managed Vite port after shutdown: closed
- Evidence: `/tmp/geoscratch-hello-gaw-browser/` JSON stdout and three PNGs

The catalog now contains one neutral `Hello GAW` route and two entries marked
`(legacy)`. `x_helloGAW` and its eight unused image assets are absent. Package build
output contains `helloGAW/index.html` and no old route.

## Acceptance Gate Evidence

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed; package build, public type contract, and WebGPU type contract exited 0 |
| `npm test` | Passed; 904 passing, 2 intentional pending, 0 failing |
| `npm run build` | Passed; production output contains `helloGAW/index.html` and no old route |
| `git diff --check` | Passed with no whitespace errors |
| `HELLO_GAW_PROOF_FRAMES=240 node tests/browser/scratch-hello-gaw.mjs` | Passed in headed Chrome with 240 required observed-frame intervals, resize, pixels, provenance, diagnostics, error, and managed-port checks |

The bounded code-review results and exact candidate commit are task completion
evidence and are reported after reviewing the fixed commit; they are not written back
into this fact audit, which avoids a self-referential review commit.
