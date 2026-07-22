# ADR-045: Replace DEM Layer With One Current Scratch Submission Graph

## Status

Accepted

## Date

2026-07-18

## Context

`m_demLayer` was the final example using the pre-Scratch execution model. Its
three-file example depended on `LocalTerrain` and the shared `ScratchMap`, which in
turn coupled MapLibre, global director stages, legacy buffers and bindings, image
loading, CPU terrain selection, two render passes, and page scheduling.

Keeping that path after the other examples had moved would make the catalog advertise
two supported GPU models. Renaming the old directory or wrapping `LocalTerrain` in a
compatibility alias would not remove the split. Moving terrain selection, map state,
or a DEM layer primitive into Scratch core would instead make one application shape a
general GPU kernel.

The reachable workload has one CPU-dynamic value: the number of selected terrain
nodes. Direct DrawCommand counts are immutable, and the current API intentionally has
no CPU resolver closure. WebGPU already represents a changing draw count as an
indirect argument buffer, and Scratch already exposes ordered UploadCommand writes,
native drawIndirect, current-at-step reads, content epochs, and producer facts.

## Decision

`examples/demLayer` is the only DEM Layer route. The visible title is `DEM Layer`.
There is no legacy, Scratch-prefixed, deprecated, or redirecting route.

The page has six distinct owners:

1. a page lifecycle authority owns asynchronous initialization, listeners, issued
   observations, decoded images, and terminal cleanup;
2. MapLibre owns its map and WebGL canvas;
3. one ScratchRuntime owns one WebGPU device and queue;
4. one Surface owns the transparent WebGPU overlay context;
5. the CPU terrain selector owns LoD traversal and detached serializable facts;
6. the DEM graph owns Scratch resources, layouts, BindSets, Programs, pipelines,
   PassSpecs, UploadCommands, and DrawCommands.

The CPU selector preserves the two level-zero roots, terrain-overlap test,
camera-distance subdivision, max-level and zoom termination, five-level visibility
window, and 5,000-node capacity. It returns plain frozen data: candidate, selected,
capped, and dropped counts; node levels and boxes; tile bounds; visible level range;
and sector range. It owns no GPU or browser handle.

The graph is created once. It contains 13 logical resources, five BindLayouts, five
prepared BindSets, two Programs, two render pipelines, two PassSpecs, eleven upload
commands, and two indirect DrawCommands. The 24,576 terrain vertices preserve the
legacy storage-indexed mesh path rather than introducing native indexed drawing with
different shader semantics.

Two persistent native indirect records carry the CPU-selected count:

```text
lodArguments     = [4, visibleNodeCount, 0, 0]
terrainArguments = [24576, visibleNodeCount, 0, 0]
```

The application mutates their persistent Uint32Array sources and reuses the same
UploadCommand and DrawCommand identities. This is explicit CPU-to-GPU data flow, not a
resolver closure and not a GPU-to-CPU roundtrip. Each frame creates only a
SubmissionBuilder and SubmittedWork, with this order:

```text
upload camera, tile, node, and indirect bytes
    -> render the fixed 512 by 256 LoD map
    -> render terrain to the Surface
```

Both draw commands declare current-at-step reads for their uploaded inputs. The terrain
draw also declares a current-at-step read of the LoD-map texture written by the prior
pass. SubmittedWork therefore records the exact upload-to-draw and pass-to-draw epoch
chains without reading argument or texture bytes on the CPU.

Surface resize and depth allocation replacement are explicit. The logical depth
TextureResource and PassSpec remain stable. No BindSet references the resized depth
allocation, so normal resize has zero stale BindSets; the resize path still checks and
acknowledges any stale set before returning. `prepare()` is not a per-frame state
transition. The terrain pipeline explicitly uses `depthWriteEnabled: true` and
`depthCompare: 'less'`: the old pipeline wrapper applied those defaults whenever its
output pass exposed a depth attachment, even though the application descriptor left
the `depthTest` line commented out.

The existing DEM PNG is decoded from its data URL without payload change and becomes
`examples/demLayer/assets/dem.png`. The active LoD-map and terrain shaders become
example-local WGSL. Six storage declarations gain explicit `read` access so the shader
contract matches read-only BindLayouts. The unreachable palette sampler/texture
declarations, uncalled color-map function, and commented palette/debug fragment paths
are removed from the terrain shader; they never contributed to reachable output.

The following accumulated paths are unreachable and removed:

- `lastShader`, which had no terrain consumer;
- line rendering, because `asLine` was always zero and the example exposed no switch;
- the border image, which was loaded but never bound;
- the palette image, sampler/texture declarations, uncalled color-map helper, and
  commented palette/debug fragment paths.

The page creates its lifecycle authority and registers pagehide cleanup before the
first acquisition. The finite initialization Promise and every complete asynchronous
render/resize task are tracked; an issued submission observation is registered before
application provenance validation can fail. Cleanup stops scheduling and detaches
listeners, settles those tasks and nativeOutcome/done observations, closes any
still-owned decoded image, removes MapLibre, and disposes ScratchRuntime. Concurrent
dispose calls share one Promise, late runtime or image acquisition is released before
it rejects, all actions run at most once, and cleanup failures do not replace or
duplicate the primary failure.

Normal diagnostics retain finite summaries. Deterministic proof mode uses a local
MapLibre background rather than CARTO tiles. Exactly two initialization faults are
supported: failure immediately after MapLibre acquisition, and invalid terrain WGSL
after runtime and image acquisition. The shader fault uses one bounded deep capture
and source-free exported evidence.

## Alternatives Considered

### Add `demLayer` beside `m_demLayer`

Rejected. A completed migration has one neutral route and one supported execution
model.

### Add a CPU-dynamic DrawCommand closure

Rejected. The existing native indirect ABI expresses the changing count as ordinary
resource data with ordering and provenance. A closure would hide the dependency and
expand core API for one already-solvable case.

### Recreate DrawCommands after every LoD traversal

Rejected. Camera motion changes bytes and epochs, not command identity or graph
topology.

### Draw 5,000 instances and discard excess work in WGSL

Rejected. It hides the actual selected count, performs avoidable work, and weakens
producer/read evidence.

### Add a terrain, tile, layer, material, or render-graph core abstraction

Rejected. CPU LoD and map policy remain application-owned; ordinary Scratch
primitives already express the GPU workload.

### Preserve all legacy shaders and images

Rejected. Dead accumulation is not behavioral parity. Only reachable artifacts are
migrated, with hashes and reachability recorded in the migration audit.

## Consequences

- No example or README contains a legacy label.
- `LocalTerrain`, its handwritten declaration, its public export, the shared legacy
  map helper, and the old terrain shader/asset modules are removed without aliases.
- The catalog now demonstrates that a rendering workload can keep a persistent graph
  while CPU-produced counts change through explicit uploaded indirect data.
- CPU LoD remains inspectable and serializable above Scratch rather than becoming
  opaque GPU-kernel state.
- MapLibre and Scratch remain separate runtimes and canvases; no runtime is shared
  across workers or map internals.
- The decision does not add a scheduler, automatic graph, public Geo API, streaming,
  residency, readback, OOM attribution, or device-loss recovery.
