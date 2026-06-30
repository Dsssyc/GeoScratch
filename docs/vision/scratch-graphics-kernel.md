# Scratch GPU Kernel Vision

## Status

Vision draft

## Date

2026-06-30

## Purpose

This document records the target design philosophy for the `scratch` layer so later ADRs, implementation plans, and living review notes can be checked against the same architectural north star.

`scratch` is the GPU execution kernel of GeoScratch — compute and graphics are co-equal uses. `geo` is the scene, space, layer, and geospatial resource-policy layer built on top of that kernel.

This distinction matters because geographic visualization workloads vary widely:

- ordinary Cartesian world-space rendering
- projected map-space rendering
- globe-space rendering
- mixed-space composition
- single-quadtree tiling
- dual-quadtree tiling
- LoD-driven rendering
- streaming resources
- GPU compute-heavy visualization
- specialized one-off WebGPU tasks

The kernel must reduce low-level WebGPU burden without assuming one geospatial scene model — and without assuming graphics at all, since general-purpose parallel compute is a co-equal use.

## Core Philosophy

`scratch` should abstract stable GPU-kernel responsibilities:

- GPU resource identity, lifetime, and invalidation
- CPU-to-GPU data synchronization
- buffer, texture, sampler, shader, binding, pipeline, pass, and command construction
- bind group layout and bind group lifecycle
- pipeline creation and reuse
- submission scheduling and command completion
- dependency-aware invalidation and skip logic
- escape hatches for direct WebGPU-like control

`scratch` should not encode scene-layer responsibilities:

- map, globe, or Cartesian-space semantics
- projection policy
- terrain, flow, vector, point-cloud, or imagery domain assumptions
- tile residency policy
- LoD selection policy
- resource loading strategy for a specific geospatial data source
- camera-to-resource policy for a specific layer

The goal is not to build a high-level scene graph. The goal is to provide a composable GPU execution kernel that `geo` can use to build many incompatible geospatial scene models.

## Configuration Is Shape, Not Time

Descriptor-style APIs are still useful, but their job is to describe stable shape:

- texture formats and size providers
- buffer usage and backing refs
- shader modules and entry points
- pipeline static state
- binding layout shape
- pass attachment shape

Descriptor-style APIs become weak when they are asked to model time-varying behavior:

- whether a command runs in the current submission
- which resource version is read or written
- when async resource availability changes execution
- when a resize invalidates attachments and bind groups
- when presentation history is preserved, cleared, or reprojected
- when a pipeline, layout, or bind group must be rebuilt
- when a pass should be skipped because its inputs are not ready

Dynamic behavior should be represented by resource state, commands, and scheduling, not by overloading one-time descriptors.

## Kernel Concepts To Grow Toward

### Resource Model

A `scratch` resource should separate logical identity from physical GPU allocation.

Future designs should make room for:

- logical resource handles
- physical GPU resource versions
- dirty CPU refs
- upload ranges
- resize-driven replacement
- resource readiness
- resource lifetime and release
- resource usage declarations such as sample, render target, storage read, storage write, copy source, and copy destination

This is broader than any one rendering technique. For example, alternating between two textures across frames is only one case of resource versioning, not a kernel feature by itself.

### Binding Model

Bindings should describe resource binding instances and layout compatibility.

They should not be the primary home for draw or dispatch semantics. In the current code, `Binding` carries resource binding, layout generation, bind group creation, vertex layout generation, invalidation callbacks, executable state, and draw/dispatch range. That made early examples concise, but it blurs kernel responsibilities.

Long term, binding responsibilities should trend toward:

- declared resource slots
- bind group layout compatibility
- bind group instance creation and invalidation
- resource readiness checks
- minimal rebinding when resources change

Draw count, dispatch count, index usage, and execution policy belong closer to command objects.

### Command Model

Draw, dispatch, copy, and upload should become explicit execution units.

A command should be able to declare:

- which pipeline it uses
- which bindings it uses
- which resources it reads
- which resources it writes
- how its draw or dispatch count is computed
- whether it is ready for the current submission
- whether it can be skipped without side effects

This keeps low-level freedom while giving the scheduler enough information to reduce CPU work and avoid rebuilding WebGPU objects unnecessarily.

### Frame / Submission Scheduler

The scheduler should organize commands and passes for a `Frame`, where `Frame` means a presentation-optional submission builder. A presentation frame is one mode; compute-only and offscreen submissions use the same core model.

It should be responsible for:

- update-list processing
- resource dirty propagation
- command readiness checks
- pass execution ordering
- command submission
- skipping empty work
- invalidating dependent bindings or attachments when resources are replaced

The scheduler may eventually be implemented as a render graph or frame graph, but the important abstraction is dependency-aware submission execution, not a particular graph API shape.

### Escape Hatches

`scratch` should preserve direct access to low-level primitives.

GeoScratch must remain capable of unusual WebGPU-heavy visualization and compute tasks. A higher-level scheduler should not prevent users from constructing explicit buffers, textures, bindings, pipelines, and passes when they need full control.

The recommended API can become more structured, but the raw primitive layer should remain available as an escape hatch.

## What Belongs In `geo`

`geo` should build scene and resource policies from the kernel.

Examples:

- map-space camera uniforms
- globe-space coordinate transforms
- tile traversal
- tile loading and eviction
- LoD policy
- flow-field data streaming
- terrain mesh selection
- layer lifecycle
- geospatial reprojection logic
- domain-specific history handling

These policies can use `scratch` resource state and commands, but they should not force `scratch` to adopt their domain concepts.

## Narrow Patterns Are Validation Cases, Not Kernel Concepts

Specific rendering patterns should not automatically become kernel APIs.

For example, alternating read/write resources across frames is a useful test case. It proves whether the kernel can express resource versions, read/write usage, and frame transitions. But the kernel should not be designed around a narrow `pingPong` feature as a first-class concept.

A pattern is kernel-worthy only if it generalizes to core GPU execution mechanics.

Use this test before adding a `scratch` abstraction:

1. Is this concept independent of map, globe, terrain, flow, or any other scene domain?
2. Does it represent a recurring GPU execution concern rather than one visualization technique?
3. Does it reduce repeated WebGPU boilerplate or prevent a common correctness/performance error?
4. Can it compose with direct low-level WebGPU-style control?
5. Can it help multiple future `geo` scene models without baking in their policies?

If the answer is no, the abstraction likely belongs in `geo`, an application layer, or a helper built on top of `scratch`, not in the kernel.

## Design Direction

The preferred long-term direction is:

```text
scratch = GPU resource model + binding model + command model + submission scheduler
geo     = spatial models + layer policies + geospatial resource loading
```

This preserves GeoScratch's design philosophy:

- keep WebGPU explicit enough for specialized visualization and compute
- remove repetitive low-level mistakes from scene-layer code
- avoid forcing one scene graph or one geospatial world model
- make dynamic GPU behavior explicit through resource and command state
- improve CPU-side performance by letting the kernel understand dependencies and invalidation

## Open Questions For Future ADRs And Living Reviews

- What version-pinned readback or pending-readback handle is needed beyond `await buffer.toArray()`?
- What diagnostic schema should validation expose so humans and agents can repair mistakes without parsing prose?
- How strict should buffer layout typing be across CPU views, vertex attributes, WGSL storage, and readback?
- Should future graph orchestration remain a helper over explicit `Frame` order, or become a separate upper-layer API?
- How should resource replacement notify bindings, pass attachments, commands, and readback requests without broad event coupling?
- What compatibility guarantees should the raw primitive API keep once a recommended command/scheduler API exists?
