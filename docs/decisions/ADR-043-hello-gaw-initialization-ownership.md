# ADR-043: Give Hello GAW One Page Initialization Lifetime Authority

## Status

Accepted

## Date

2026-07-17

ADR-050 supersedes only the invalid-WGSL proof's pipeline-owned compilation
attribution. The page lifetime decision remains accepted; the migrated proof captures
the Bloom-combine ShaderModule acknowledgement directly.

## Context

ADR-042 replaced Hello GAW with one explicit Scratch command graph, but the page still
established teardown only after the complete graph and initial upload had succeeded.
An earlier asynchronous failure could therefore strand the page-owned runtime or a
decoded `ImageBitmap`. A failure after initial submission could also dispose the
runtime without first settling the already-issued `SubmittedWork` observation.

Scratch already owns its resources transitively through `ScratchRuntime`. The missing
authority is application-level: decoded external image sources, browser listeners,
scheduled frame work, and the ordering between pending observations and final runtime
disposal. Moving that policy into Scratch core would mix page lifecycle with the GPU
kernel and would duplicate resource ownership.

## Decision

Hello GAW creates one example-local page lifetime authority before its first
initialization `await`. Acquisition transfers ownership immediately:

- the resolved `ScratchRuntime` registers one release action before any Surface or
  child creation;
- each decoded `ImageBitmap` registers one release action before texture or upload
  creation;
- each issued `SubmittedWork` observation registers before the page awaits it;
- listeners and frame work register stop actions when steady-state rendering begins.

Disposal has three ordered phases. It first runs stop actions in reverse registration
order, then settles the observations that were pending when disposal began, then runs
release actions in reverse registration order. Runtime disposal therefore follows
external-image closure, and no runtime disposal can race an observation already known
to the page authority.

Every disposer receives the same Promise. Each cleanup action executes at most once,
all remaining actions continue after a cleanup failure, and action/observation
references are cleared at terminal settlement. The first page failure remains the
primary failure; cleanup failures are retained only as structured secondary facts.
Scratch-owned resources are not registered separately because runtime disposal
already owns that graph.

Five immutable, query-only fault modes exercise acquisition boundaries. They have no
UI and do not change normal execution when absent. Each publishes one recursively
frozen JSON proof after diagnostics are captured and cleanup settles. The proof uses
public `isDisposed` facts, explicit acquisition/cleanup counts, pending-observation
counts, and bounded runtime evidence rather than a self-reported success boolean.

The invalid Bloom-combine WGSL mode changes only an in-memory Program module. It starts
one finite deep capture immediately before compute-pipeline creation and stops it
before exporting runtime evidence. Chrome reports three independent native outcomes
for this invalid module: supporting-object validation, the stable
`SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED` compilation outcome, and pipeline
validation. Scratch correctly preserves them in a multiple-failure envelope rather
than selecting one by settlement order. Localization therefore follows the structured
outcomes and compilation report, not the top-level code or native message prose.

## Alternatives Considered

### Register teardown after graph initialization

Rejected. This repeats the defect because no authority exists while partial resources
are being acquired.

### Register every Scratch child in an application resource graph

Rejected. Runtime disposal is already the transitive ownership boundary. A second
graph would create duplicate disposal and disagreement risks.

### Add a generic disposable stack or automatic policy to Scratch core

Rejected. Page listeners, animation scheduling, and external image sources are not
Scratch-owned, and this repair does not establish a general kernel abstraction.

### Replace the original pipeline failure with one preferred diagnostic code

Rejected. Native shader-module, compilation, and pipeline outcomes are independent.
Rewriting the primary error would discard evidence and contradict the acknowledged
pipeline error model.

## Consequences

- Partial initialization has an authority from the first acquired runtime onward.
- External image sources close exactly once on both success and failure paths.
- Issued submission observations settle before external release and runtime disposal.
- Cleanup failures cannot hide the original initialization failure.
- Agents can localize the invalid pipeline to a pipeline ID, Program ID, module fact,
  compilation stage, and stable diagnostic code without retaining WGSL source.
- The normal five-stage graph, shaders, assets, pacing, resize transaction, and
  persistent identities remain unchanged.
- This ADR makes no OOM, device-loss, general scheduler, or Scratch core lifecycle
  claim.
