# Scratch GPU Kernel Vision

## Status

Vision draft

## Date

2026-07-06

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
- CPU/GPU transfer operations and content epochs
- buffer, texture, sampler, layout codec, shader program, binding, pipeline, pass, and command construction
- bind group layout and bind group lifecycle
- pipeline creation and reuse
- submission scheduling and command completion
- dependency-aware invalidation and skip logic
- machine-readable validation diagnostics
- escape hatches for direct WebGPU-like control

`scratch` should not encode scene-layer responsibilities:

- map, globe, or Cartesian-space semantics
- projection policy
- terrain, flow, vector, point-cloud, or imagery domain assumptions
- tile residency policy
- LoD selection policy
- resource loading strategy for a specific geospatial data source
- camera-to-resource policy for a specific layer
- material, style, or symbolizer semantics

The goal is not to build a high-level scene graph. The goal is to provide a composable GPU execution kernel that `geo` can use to build many incompatible geospatial scene models.

`scratch` also should not adopt a `Material` layer as a substitute for shader/program design. A material-style abstraction couples shader code, data values, visual surface meaning, and object assignment. That coupling belongs in `geo`, applications, or optional scene helpers. The kernel keeps `Program`, `BindSet`, `Pipeline`, `Command`, and `Submission` separate.

## Configuration Is Shape, Not Time

Descriptor-style APIs are still useful, but their job is to describe stable shape:

- texture formats and size providers
- buffer usage and backing refs
- layout artifacts and codec output shape
- shader modules and entry points
- diagnostic code and subject shape
- pipeline static state
- binding layout shape
- pass attachment shape

Descriptor-style APIs become weak when they are asked to model time-varying behavior:

- whether a command runs in the current submission
- which allocation version is bound
- which content epoch is read or written
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
- physical GPU allocation versions
- content epochs
- dirty CPU refs that lower into explicit uploads
- upload ranges
- resize-driven replacement
- resource readiness
- resource lifetime and release
- resource usage declarations such as sample, render target, storage read, storage write, copy source, and copy destination

This is broader than any one rendering technique. For example, alternating between two textures across submissions or application frames is only one case of content epoch and resource rotation management, not a kernel feature by itself.

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

### Program And Codec Model

Shader authoring should separate layout/code generation from executable runtime state.

Future designs should make room for:

- `LayoutSpec` as logical data shape
- `LayoutArtifact` as resolved offsets, stride, padding, alignment, usage lowering, and structural hash
- `LayoutCodec` as CPU writer, upload byte view, readback view, and WGSL accessor generation
- `Program` as user WGSL plus generated modules, entry points, bind-layout contract, required features, and diagnostics
- `Pipeline` as stable WebGPU executable state for one program entry point

Generated layout and shader artifacts may be produced before runtime or during runtime initialization, but submission-time work should consume explicit artifacts rather than generating or mutating shader code in the hot path.

The kernel should explicitly reject `Material` as a core abstraction. Material-like scene concepts can exist above scratch, but they must lower into the kernel primitives instead of becoming kernel primitives.

### Command Model

Draw, dispatch, copy, upload, and ordered readback staging should become explicit execution units.

A command should be able to declare:

- which pipeline it uses
- which bindings it uses
- which resources it reads
- which resources it writes
- which writes advance content epochs
- how its draw or dispatch count is computed
- whether it is ready for the current submission
- whether it can be skipped without side effects

This keeps low-level freedom while giving the scheduler enough information to reduce CPU work and avoid rebuilding WebGPU objects unnecessarily.

### Submission Scheduler

The scheduler should organize commands and passes for a `Submission`, where `Submission` means work sent toward the GPU queue. A presentation submission is one mode; compute-only and offscreen submissions use the same core model. `Frame` cadence belongs to `geo`, application, or presentation loops rather than the scratch core.

It should be responsible for:

- update-list processing
- transfer preparation and content epoch propagation
- command readiness checks
- pass execution ordering
- command submission
- skipping empty work
- invalidating dependent bindings or attachments when resources are replaced

The scheduler may eventually be implemented as a render graph or frame graph, but the important abstraction is dependency-aware submission execution, not a particular graph API shape.

### Diagnostics And Validation Model

Validation diagnostics should be a public machine-readable contract, not prose-only logs.

Future designs should make room for:

- one `ScratchDiagnostic` envelope across runtime, resource, layout codec, program, binding, pipeline, command, submission, query, and readback validation
- stable `SCRATCH_<DOMAIN>_<CONDITION>` diagnostic codes
- structured `subject`, `related`, `expected`, and `actual` payloads
- deterministic diagnostic reports for inspected state
- validation modes that control disposition without changing diagnostic identity
- repair suggestions that help tooling make local edits without letting scratch silently auto-fix state

This is part of the intelligent-friendly goal: agents and tests should assert diagnostic codes and subjects, not parse English messages.

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

For example, alternating read/write resources across submissions or application frames is a useful test case. It proves whether the kernel can express allocation versions, content epochs, read/write usage, and temporal transitions. But the kernel should not be designed around a narrow `pingPong` feature as a first-class concept.

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
scratch = GPU resource model + layout/codec model + transfer model + binding model + program/pipeline model + command model + diagnostics model + submission scheduler
geo     = spatial models + layer policies + geospatial resource loading
```

This preserves GeoScratch's design philosophy:

- keep WebGPU explicit enough for specialized visualization and compute
- remove repetitive low-level mistakes from scene-layer code
- avoid forcing one scene graph or one geospatial world model
- make dynamic GPU behavior explicit through resource and command state
- improve CPU-side performance by letting the kernel understand dependencies and invalidation
- keep shader/data composition explicit through `Program`, `BindSet`, and `Command`, not `Material`
- expose validation failures through stable diagnostics, not prose-only exceptions

## Open Questions For Future ADRs And Living Reviews

- How strict should buffer layout typing be across CPU views, vertex attributes, WGSL storage, and readback?
- Should future graph orchestration remain a helper over explicit `Submission` order, or become a separate upper-layer API?
- How should allocation replacement notify bindings, pass attachments, commands, and pending transfer operations without broad event coupling?
- What compatibility guarantees should the raw primitive API keep once a recommended command/scheduler API exists?
