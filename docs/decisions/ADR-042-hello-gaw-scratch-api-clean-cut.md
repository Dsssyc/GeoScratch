# ADR-042: Replace Hello GAW With One Explicit Scratch Command Graph

## Status

Accepted

## Date

2026-07-17

## Context

The Hello GAW example exercised an animated earth, GPU particle simulation, GPU link
indexing, indirect drawing, HDR scene rendering, Bloom, FXAA, and final presentation,
but it still expressed those behaviors through the old orchestration API. Keeping both
an old example and a separately flagged Scratch variant would make the catalog imply
that two supported paths exist and would prevent the current API from becoming the
single executable specification.

The replacement must preserve the complete workload without introducing an
example-shaped abstraction into Scratch core. It must also keep GPU-produced indirect
arguments on the GPU, preserve explicit queue order, avoid per-frame object churn, and
make resize and delayed GPU failures observable.

## Decision

`examples/helloGAW` is the only Hello GAW example. The old route and directory are
removed rather than redirected, and the catalog uses the neutral name `Hello GAW`.

The example owns one explicit five-stage graph:

1. particle simulation followed by link indexing;
2. land, links, particles, water, and cloud scene rendering;
3. Bloom highlight, pyramid, blur, and combine;
4. FXAA;
5. presentation with ACES tone mapping, gamma correction, and stripe modulation.

Bloom remains example-owned and consists of 17 ordered DispatchCommand objects: one
highlight extraction, five downsample operations, five horizontal blur operations,
five vertical blur operations, and one combine operation. FXAA is a separate compute
stage. Neither effect becomes a public package abstraction.

Runtime, Surface, resources, layout-bearing BufferRegion objects, TextureViewSpec
objects, samplers, BindLayouts, BindSets, Programs, Pipelines, commands, PassSpecs,
SubmissionBuilder, and SubmittedWork are all created through the public Scratch API.
Dynamic uniform payloads and UploadCommand objects are persistent. DrawCommand and
DispatchCommand consumers of earlier per-frame producers declare
`'current-at-step'`; SubmittedWork facts retain the exact resolved producer and read
epochs.

The indirect argument buffer is initialized and reset by ordered uploads, written by
the GPU link-indexing command, and consumed by the indirect DrawCommand. It is never
mapped, read back, decoded, or mirrored from a GPU result on the CPU.

Between resizes, Program, Pipeline, BindSet, DrawCommand, non-size-dependent
DispatchCommand, UploadCommand, and PassSpec identities remain stable. Resize replaces
only native allocations behind stable logical textures, prepares only stale BindSets,
and rebuilds only DispatchCommand objects whose immutable workgroup counts depend on
the target dimensions. SubmissionBuilder, SubmittedWork, and the current presentation
texture remain frame-local.

The runtime uses bounded diagnostic capacities. Every SubmittedWork `done` and
`nativeOutcome` is observed, uncaptured device errors are terminal, and teardown stops
animation before disposing the runtime. A deterministic browser-proof mode uses a
fixed seed and fixed frame step.

## Alternatives Considered

### Keep both examples

Rejected. A migrated workload has one supported example; a Scratch suffix or parallel
old route would preserve ambiguity rather than complete the migration.

### Wrap Bloom and FXAA in new public effect classes

Rejected. The workload is evidence that the current primitives compose; it is not a
reason to place example policy in Scratch core.

### Recreate commands or prepare BindSets every frame

Rejected. Content changes do not change resource allocation or binding identity.
`'current-at-step'` exists specifically so stable commands can consume explicit prior
producers without descriptor churn.

### Read indirect arguments back for validation

Rejected. WebGPU already supports GPU production and indirect consumption in one
ordered submission. SubmittedWork provenance proves the producer/read relationship
without a CPU round trip.

## Consequences

- The example catalog contains two remaining entries marked `(legacy)` and one neutral
  `Hello GAW` entry.
- The example is a direct, inspectable integration proof for the current Scratch API.
- Resize work is explicit and bounded rather than hidden in frame execution.
- The package retains general GPU primitives; Bloom, FXAA, and scene policy remain
  outside Scratch core.
- Future changes to this workload must preserve the five-stage order, the 17-command
  Bloom graph, GPU-only indirect flow, exact SubmittedWork provenance, and managed
  browser evidence.
