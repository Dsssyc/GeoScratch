# ADR-044: Replace Flow Layer With One Long-Lived Scratch Submission Graph

## Status

Accepted

## Date

2026-07-18

## Context

The Flow Layer example is a long-running map-backed workload rather than a small API
sample. It triangulates station data, streams 27 velocity fields through a Worker,
interpolates two fields into two render targets, simulates 262,144 GPU-resident
particles, accumulates two alternating history textures, and reprojects that history
while the MapLibre camera moves.

The old `m_flowLayer` implementation expressed this work through `StartDash`, the
global `director`, `screen`, mutable numeric references, executable flags, and
implicit resource synchronization. Keeping that route beside a current-API variant
would advertise two supported execution models. Moving its scheduling or history
policy into Scratch core would instead turn one example's structure into a kernel
abstraction.

The replacement also needs one authority over partial asynchronous initialization.
The Scratch runtime transitively owns its GPU children, but it does not own a page's
Worker, MapLibre instance, browser listeners, animation scheduling, or decisions about
when pending SubmittedWork observations must settle.

## Decision

`examples/flowLayer` is the only Flow Layer example. The old directory and route are
removed rather than redirected, and the catalog uses the neutral title `Flow Layer`.
`m_demLayer` remains a separate legacy example and continues to use the shared legacy
map helper.

Flow owns one explicit five-stage Scratch graph:

1. generate the interpolated `rg32float` velocity field and `r8unorm` domain mask;
2. simulate the GPU-resident particle state;
3. select one of two persistent history directions, compose prior history, and draw
   current particles;
4. optionally visualize the velocity field and arrows;
5. present the selected history texture over the MapLibre page.

Runtime, Surface, BufferResource, TextureResource, BufferRegion, TextureViewSpec,
LayoutCodec, Program, BindLayout, BindSet, Pipeline, DrawCommand, DispatchCommand,
PassSpec, UploadCommand, SubmissionBuilder, and SubmittedWork are all public current
Scratch API objects. Programs, resources, layouts, BindSets, pipelines, commands,
PassSpecs, uploads, and both history-direction sets remain persistent. Only the
SubmissionBuilder and SubmittedWork are created for each frame.

Later stages declare `'current-at-step'` reads for the velocity field, particle state,
and selected history texture produced earlier in the same submission. Particle state
never returns to CPU memory. Field changes mutate the CPU-owned backing arrays of two
persistent UploadCommand objects; they do not replace GPU resources or commands.

Resize replaces native allocations behind the five stable logical textures, then
prepares only BindSets whose allocation-sensitive view facts became stale. Content
changes alone do not prepare or rebuild bindings.

Flow creates one example-local lifecycle authority before its first initialization
`await`. The pagehide listener is registered under that authority before initialization
starts. Ownership transfers immediately for the Worker and MapLibre map; asynchronous
runtime acquisition is tracked until ownership transfers. Disposal synchronously
signals cancellation, so map readiness and station loading abort, new field requests
fail before posting to the Worker, and a runtime that arrives after shutdown starts is
disposed before the acquisition settles. Cleanup then stops scheduling and listeners,
settles issued work, terminates the Worker, removes the page-owned map, and finally
disposes the runtime. Every disposer receives the same Promise, each action runs at
most once, secondary cleanup failures do not stop later cleanup, and the original
failure stays primary.

MapLibre continues to own a separate WebGL canvas and its normal remote CARTO raster
style. Scratch owns the transparent WebGPU overlay canvas. No device, resource, queue,
or provenance is shared between those systems. Deterministic browser proof uses a
local MapLibre background style so external tile cancellation cannot hide a request
failure; normal page execution still uses the remote style.

Runtime diagnostics use finite operation, incident, evidence, and pending-observation
capacities. The normal proof observes every SubmittedWork and drains pending work to
zero. Two query-only fault modes cover failure after Worker acquisition and invalid
in-memory simulation WGSL. The latter opens one deep capture bounded to one operation,
2,000 ms, and 65,536 evidence bytes, and localizes pipeline, Program, module, and
compilation outcomes without retaining WGSL source.

Six migrated WGSL files remain byte-identical. `arrow.wgsl` is the documented
exception: the legacy shader read a six-float particle record with a four-float
stride. Its four particle reads now use stride six and velocity offsets four and five.
No other shader expression changed.

## Alternatives Considered

### Keep `m_flowLayer` and add a Scratch-named route

Rejected. A completed migration has one neutral example and one supported execution
model.

### Keep the shared legacy `ScratchMap`

Rejected for Flow. It owns `StartDash`, global director stages, legacy screen
resources, and implicit frame ticks. Converting it in place would create a hybrid DEM
runtime and violate the separate-example boundary.

### Introduce ping-pong, flow-layer, scheduler, or render-graph core types

Rejected. Two persistent direction sets plus ordinary submissions express the
workload without an example-shaped public abstraction.

### Rebuild BindSets or commands for every field or frame

Rejected. Field data changes content, not resource identity or allocation. Persistent
uploads and `'current-at-step'` preserve the correct distinction.

### Preserve the broken arrow indexing byte-for-byte

Rejected. Optional arrow visibility is a required behavior, while the old stride read
unrelated particle fields. The four-index correction is narrower and more factual
than emulating a known defect.

### Add raw WebGPU or CPU readback for missing behavior

Rejected. The complete workload is representable through current public Scratch
primitives. No core capability gap was found.

## Consequences

- `m_demLayer` is the only catalog entry still marked `(legacy)`.
- Flow and DEM remain separate examples with separate map ownership decisions.
- The Flow graph is inspectable through explicit stage order, resource accesses,
  producer/read epochs, stable identities, and bounded diagnostics.
- Application cleanup is example-owned rather than presented as a generic Scratch
  lifecycle abstraction.
- The deterministic proof does not depend on remote basemap availability, while the
  normal example retains the original CARTO map.
- Future changes must preserve the five-stage order, 27-field stream, 300-frame
  phases, two explicit history directions, GPU-resident particle state, stale-only
  BindSet preparation, source-free failure evidence, and managed headed-browser proof.
- This decision makes no claim about OOM causality, physical VRAM reclamation,
  device-loss recovery, or MapLibre's internal resource cleanup.
