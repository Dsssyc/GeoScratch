# ADR-033: Acknowledge Pipeline Creation And Compilation Evidence

## Status

Accepted

## Date

2026-07-11

ADR-050 supersedes this ADR's pipeline-owned ShaderModule, source-composition,
compilation-report, entry-point, and override descriptor details. The Promise-only
pipeline acknowledgement boundary, bounded diagnostics, and no-submission-wait
decision remain accepted.

## Context

Scratch render and compute pipelines previously created one shader module, one
pipeline layout, and one native pipeline in their public constructors. The
runtime factories returned the wrapper immediately. WebGPU immediate pipeline
creation does not mean that native compilation has completed: an invalid
pipeline handle can be returned and compilation can stall later use, encoder
finalization, or submission.

WebGPU provides `createRenderPipelineAsync()` and
`createComputePipelineAsync()` as the native acknowledgement boundary. Their
Promises resolve only when a pipeline is ready for use and reject with a
`GPUPipelineError` whose `reason` is `validation` or `internal`. The rejection
is not dispatched as a `GPUError` to the device. Shader modules separately
expose `getCompilationInfo()`, whose localized message text, order, and source
locations are implementation-defined.

Creating the supporting shader module and pipeline layout remains immediate
WebGPU object creation. Those objects can be invalid through validation,
internal, or out-of-memory failures. Supporting-object error scopes therefore
remain independent evidence from the async pipeline Promise and compilation
information. WebGPU makes no general promise-settlement ordering guarantee.

ADR-032 introduced bounded operation and incident evidence for resource
allocation. Its version-1 records require resource allocation facts. Filling
those fields with pipeline-shaped placeholders would make the evidence model
false. The schema must distinguish resource and pipeline targets explicitly.

## Decision

### Promise-only public pipeline creation

All Scratch runtime pipeline factories return ordinary Promises:

```ts
const renderPipeline = await runtime.createRenderPipeline(renderDescriptor)
const renderAlias = await runtime.renderPipeline(renderDescriptor)
const computePipeline = await runtime.createComputePipeline(computeDescriptor)
const computeAlias = await runtime.computePipeline(computeDescriptor)
```

Scratch uses only `GPUDevice.createRenderPipelineAsync()` and
`GPUDevice.createComputePipelineAsync()` for pipeline creation. It does not
fall back to immediate pipeline creation when the async method is absent. There
is no synchronous overload, compatibility flag, thenable pipeline, lazy first
use, command-side wait, retry, or alternate static factory.

`RenderPipeline` and `ComputePipeline` remain public for typing and
`instanceof`. Package-internal construction tokens close direct construction
and subclass construction. A wrapper is constructed only after all native and
lifecycle evidence has settled successfully.

### Snapshot and local validation boundary

Before the first native call, Scratch:

1. validates the descriptor deterministically;
2. allocates the stable pipeline ID and pending operation ID;
3. snapshots Program module strings, entry points, and normalized layout requirements;
4. snapshots normalized render or compute state;
5. snapshots Program and BindLayout identities and lifecycle state;
6. computes bounded descriptor and source hashes; and
7. computes module spans in the exact combined shader string.

The combined shader string is exactly `modules.join('\n')`: one U+000A UTF-16
code unit is inserted between adjacent modules and no separator is appended
after the final module. Offset spans are zero-based half-open intervals
`[startOffset, endOffset)`. Each inserted separator owns its own one-code-unit
interval and never belongs to either adjacent module. Combined native
`lineNum`/`linePos` and derived module `lineNum`/`linePos` are one-based;
derived offsets are zero-based. CRLF is one line break, while lone CR and LF
are each one line break. Every module, including an empty module, has a
one-based `startLine`, `endLine`, and `lineCount`; an empty module has no
mappable code-unit interval. A native location maps only when its specific
offset falls inside one module interval. Unknown all-zero locations and
separator locations remain explicitly unmapped.

The snapshot prevents mutable descriptor arrays, Program module arrays, or replacement
of `Program.layoutRequirements` from changing the transaction after native work starts.
The successful Pipeline retains the immutable layout-requirement snapshot, and Command
preflight consumes that snapshot instead of the later live Program property. This does
not redesign the Program authoring API. Existing render targets, vertex layouts, primitive,
depth/stencil, multisample, compute constants, entry points, bind layouts,
Program requirements, required features, and limits are lowered one-to-one.

Deterministic validation failure performs no native call and creates no
operation record. Once native work starts, exactly one matching pipeline
operation exists.

Pipeline, shader-module, and pipeline-layout native labels are also fixed
before native work. Each ends with `[scratch:<pipelineId>]`; absent user labels
use `scratch:<pipelineId>`. Native descriptors receive the complete label.
Diagnostic copies retain at most 256 UTF-16 code units while preserving the ID
suffix and expose whether truncation occurred. Labels are correlation evidence,
not an ownership or causality proof.

### One uninterrupted native issue turn

The supporting-object issue boundary is one uninterrupted JavaScript turn:

1. push `out-of-memory`;
2. push `internal`;
3. push `validation`;
4. create exactly one shader module;
5. create exactly one pipeline layout;
6. issue `getCompilationInfo()`;
7. issue exactly one matching async pipeline creation call;
8. pop validation;
9. pop internal;
10. pop out-of-memory; and
11. retain every returned Promise before the first `await`.

A synchronous exception does not skip scope pops. Compilation information, the
pipeline Promise, and all scope promises are observed as independent outcomes.
The implementation does not assume settlement order when joining them. Pipeline rejection is classified
from `GPUPipelineError.reason`; Scratch does not expect it in an error scope.
The scopes describe supporting-object work and do not fabricate pipeline-error
ownership.

### Success and cancellation

Warnings and informational compilation messages do not fail creation. Every
successful pipeline exposes one deeply immutable compilation report, including
an empty report when the native implementation returned no messages.

After all outcomes settle, Scratch rechecks runtime, device, Program, and every
BindLayout. Runtime disposal, device loss, Program disposal, or BindLayout
disposal before commit cancels the transaction. No wrapper or current pipeline
fact is installed. Native pipelines, shader modules, and pipeline layouts have
no destroy transaction; failed or cancelled candidates are dropped without a
fake rollback or destruction claim.

On success Scratch constructs one immutable wrapper, registers one current
pipeline fact, completes one operation, and returns the wrapper. Pipeline
`dispose()` removes its current fact and records bounded disposal evidence; it
does not claim a native destroy operation.

### Schema version 2 and target unions

Operation records, incident reports, runtime snapshots, diagnostic capture
reports, and exported evidence advance to version 2. The schema uses explicit
resource/pipeline target unions; historical operation records use this target:

```ts
type ScratchGpuOperationTarget =
    | {
        kind: 'resource'
        resourceId: string
        resourceKind: 'BufferResource' | 'TextureResource'
        allocationVersion: number
        contentEpoch: number
        logicalFootprintBytes: number
    }
    | {
        kind: 'pipeline'
        pipelineId: string
        pipelineKind: 'render' | 'compute'
        programId: string
        programSourceHash: string
    }
```

Pending facts and queries use the same target discriminator. Resource records
retain their allocation fields under the resource variant. Pipeline records do
not receive fake allocation versions, content epochs, footprints, or pressure
facts. Resource allocation incidents retain ADR-032 attribution and pressure
semantics unchanged.

Pipeline operations use `render-pipeline-creation`,
`compute-pipeline-creation`, and `pipeline-disposal`. Pipeline disposal uses a
pipeline target and does not alter allocation aggregates. A pending pipeline
fact contains `id`, `sequence`, `kind`, `target`, `descriptorHash`, and
`startedAtMs`; its cardinality scales only with in-flight transactions. A
current pipeline fact contains `id`, bounded `label`, `pipelineKind`,
`programId`, `programSourceHash`, `descriptorHash`, `state`,
`lastCreationOperationId`, and compilation error/warning/info counts; its
cardinality scales only with live committed pipelines. Runtime disposal removes
all current pipeline facts through normal wrapper disposal. Neither collection
scales with runtime age.

### Bounded source-free compilation evidence

`PipelineCompilationReport` is deeply immutable and JSON-serializable. Its
public shape is conceptually:

```ts
type PipelineCompilationReport = Readonly<{
    version: 1
    pipelineId: string
    pipelineKind: 'render' | 'compute'
    programId: string
    combinedSourceHash: string
    moduleCount: number
    retainedModuleCount: number
    omittedModuleCount: number
    modules: readonly PipelineCompilationModuleFact[]
    errorCount: number
    warningCount: number
    infoCount: number
    nativeMessageCount: number
    retainedMessageCount: number
    omittedMessageCount: number
    retainedEvidenceBytes: number
    messages: readonly PipelineCompilationMessage[]
}>
```

The report contains:

- schema version, pipeline ID/kind, Program ID, and combined source hash;
- per-module index, hash, UTF-16 offset span, and line span;
- error, warning, information, native, retained, and omitted counts;
- retained serialized-evidence bytes; and
- bounded messages in native order.

Each retained message contains its native index and type, bounded localized
text, `messageTruncated`, `sourceExcerptRedacted`, native combined
offset/length/line/column facts, and module-relative coordinates only when
derivable. Unknown native locations remain explicitly unknown. A location on a
separator inserted between Program modules has no module mapping. Scratch never
invents precision and never parses message prose into a stable code.

Native message prose is implementation-defined and can itself quote WGSL.
Before any message enters the report, Scratch replaces exact Program
identifier/numeric-literal tokens of at least three UTF-16 code units and every
exact contiguous Program-source span of at least eight UTF-16 code units with a
fixed redaction marker. Tokenization follows the WGSL lexical forms, including
Unicode `XID_Start`/`XID_Continue` identifiers and every decimal/hexadecimal
integer and floating-point form, including leading-dot literals.
`sourceExcerptRedacted` makes this loss explicit.
Membership is tracked in a source-size-independent Bloom workspace capped at
32 KiB. Hash collisions may conservatively redact unrelated prose, but cannot
allow an inserted Program token or span to pass through. The workspace is
created lazily, shared across one report or native-error settlement, and is
discarded rather than retained as evidence.
`messageTruncated` remains specific to the 4096-unit bound, including a
post-redaction expansion that reaches that bound. This sanitization is data
minimization against the captured Program snapshot; it does not classify the
message or derive a diagnostic code from prose. Incidental overlaps shorter
than these explicit thresholds are not classified as retained source excerpts.
The same sanitizer covers the retained `name`, `message`, and `reason` strings
inside pipeline, supporting-scope, structural, and lifecycle native-error
facts; those facts expose `sourceExcerptRedacted` when applicable. The original
native object may remain the transient `ScratchDiagnosticError.cause`, but it is
not copied into operation, incident, capture, snapshot, or exported evidence.

A runtime-wide device-loss event has no single Program snapshot against which
native prose can be sanitized. Scratch therefore does not retain that native
message at all: `runtime.deviceLostInfo` and the global `device-loss` incident
retain the structural reason, the fixed
`[native device-loss message omitted]` marker, and
`nativeMessageOmitted: true`. A pipeline transaction already in flight observes
the original `GPUDeviceLostInfo` only through its temporary lifecycle
subscription, applies its own Program-source sanitizer, and may expose the raw
object only as the rejected diagnostic's `cause`. The native
`GPUDevice.lost` Promise remains governed by WebGPU and is outside Scratch's
retained evidence model.

The report-version-1 limits are:

- at most 256 retained module facts;
- at most 64 retained messages;
- at most 4096 UTF-16 code units of text per retained message; and
- at most 64 KiB of serialized compilation evidence.

Module facts and messages share the 64-KiB budget. Module facts are considered
in module-index order and messages in native order; mandatory fixed report
metadata is retained first. `moduleCount`, `retainedModuleCount`,
`omittedModuleCount`, and the equivalent message counts preserve evidence
completeness. A valid Program is never rejected merely because diagnostic
evidence needs truncation. Complete WGSL source and source excerpts are forbidden
in default history, incidents, exported evidence, and deep descriptor capture
under the deterministic definition above. Hashes and bounded module spans
correlate a report with the caller-owned Program snapshot without copying source
into the ledger.

Every successful pipeline wrapper owns the complete bounded report. The
matching successful operation record retains that same frozen report and
therefore participates in ADR-032 recorder and capture byte budgets. Current
pipeline facts retain only hashes and counts, not message text. Failed pipeline
incidents retain the bounded report when compilation information settled
successfully.

Combined and module-relative locations use JavaScript string indexing, which
is UTF-16 code-unit indexing. Mapping explicitly covers LF, CRLF, empty modules,
non-ASCII source, and the inserted separator between modules.

### Failure classification

Pipeline creation rejects with `ScratchDiagnosticError`. Stable classification
uses structural native facts, never localized prose:

- `SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED` for retained or counted native
  shader-compilation errors;
- `SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED` for a pipeline Promise rejected
  with `GPUPipelineError.reason === 'validation'`;
- `SCRATCH_PIPELINE_CREATION_INTERNAL_FAILED` for a pipeline Promise rejected
  with `GPUPipelineError.reason === 'internal'`;
- `SCRATCH_PIPELINE_SUPPORT_OBJECT_FAILED` for validation, internal, or OOM
  evidence captured around shader-module or pipeline-layout creation;
- `SCRATCH_PIPELINE_CREATION_NATIVE_FAILED` for a synchronous native exception
  or a structurally invalid native result; and
- `SCRATCH_PIPELINE_CREATION_SCOPE_FAILED` for a scope-pop or compilation-info
  structural failure;
- `SCRATCH_PIPELINE_CREATION_RUNTIME_DISPOSED` for runtime disposal before
  commit;
- `SCRATCH_PIPELINE_CREATION_DEVICE_LOST` for device loss before commit;
- `SCRATCH_PIPELINE_CREATION_PROGRAM_DISPOSED` for Program disposal before
  commit;
- `SCRATCH_PIPELINE_CREATION_BIND_LAYOUT_DISPOSED` for BindLayout disposal
  before commit; and
- `SCRATCH_PIPELINE_CREATION_MULTIPLE_FAILURES` when more than one independent
  failure outcome is present.

The incident identifies the Pipeline and Program subjects, related BindLayout
subjects, pipeline kind and entry points, descriptor/source hashes, failure
stage, compilation report when available, `GPUPipelineError.reason` when
available, bounded native error facts, attribution confidence, and evidence
completeness. Pipeline incidents do not include allocation pressure evidence.

Single failures select the matching code above by structural category, never
by settlement order. When multiple independent failures are observed, the
single rejected diagnostic uses
`SCRATCH_PIPELINE_CREATION_MULTIPLE_FAILURES`; the incident retains a bounded
`outcomes` array in fixed transaction-stage order so every observed category,
native fact, lifecycle fact, and stage remains inspectable. It reports
causality as ambiguous rather than inventing a temporal primary cause. Device
loss retains temporal or unknown attribution unless an independent exact
operation signal exists.

`ScratchDiagnostic` itself remains envelope version 1. Schema version 2 applies
to GPU operation, incident, runtime snapshot, capture, and exported-evidence
records; it does not silently renumber the shared diagnostic envelope.

### Submission boundary

`SubmissionBuilder.submit()` remains synchronous and non-thenable. This change
adds no error scope, shader-module creation, pipeline-layout creation, pipeline
creation, compilation query, operation record, or hidden wait to command
construction, pass lowering, encoder finalization, queue submission, or
`SubmittedWork` settlement. Commands receive only fully acknowledged pipeline
wrappers.

### Legacy boundary

This decision covers the Scratch runtime API only. Similarly named top-level
legacy renderer APIs and the DEM Layer, Flow Layer, and Hello GAW legacy
examples remain explicitly classified as legacy. They are not silently
rewritten or presented as replaced by this goal.

## Consequences

- Every Scratch pipeline call site must await one ordinary Promise.
- The API break is intentional during `0.x.x`; no compatibility overload is
  retained.
- Pipeline creation can be slower at initialization but cannot move an
  unacknowledged compilation stall into first submission through Scratch.
- Successful pipeline creation has inspectable compilation provenance without
  retaining WGSL.
- Native source locations remain useful where supplied but are never promoted
  beyond the precision WebGPU provides.
- Resource-allocation and pipeline evidence share one bounded recorder while
  preserving different target and pressure semantics.
- Pipeline support-object scopes add work only to pipeline creation, not the
  per-frame submission path.

## Rejected Alternatives

### Promise wrapping immediate pipeline creation

Rejected because `Promise.resolve(createRenderPipeline(...))` does not
acknowledge native pipeline completion and preserves deferred invalidity.

### Immediate fallback when async creation is unavailable

Rejected because a capability-dependent semantic downgrade would make a
returned Scratch pipeline mean different things on different devices.

### Error scopes as the pipeline result

Rejected because async pipeline failures reject with `GPUPipelineError` and do
not dispatch a `GPUError`. Supporting-object scopes are separate evidence.

### Parsing compiler messages

Rejected because message text is localized and implementation-defined. Stable
codes come from WebGPU structural fields and Scratch transaction stages.

### Full WGSL or excerpts in diagnostics

Rejected because long-running diagnostics must remain bounded and source can be
sensitive. The application already owns the Program source.

### Instrumenting submission

Rejected because pipeline readiness has a native async creation boundary and
does not require changing the hot submission path.

## Authoritative References

- https://gpuweb.github.io/gpuweb/#invalid-internal-objects-contagious-invalidity
- https://gpuweb.github.io/gpuweb/#pipelines
- https://gpuweb.github.io/gpuweb/#dom-gpudevice-createrenderpipelineasync
- https://gpuweb.github.io/gpuweb/#dom-gpudevice-createcomputepipelineasync
- https://gpuweb.github.io/gpuweb/#dom-gpushadermodule-getcompilationinfo
- https://gpuweb.github.io/gpuweb/#gpupipelineerror
- https://gpuweb.github.io/gpuweb/#error-scopes
- https://gpuweb.github.io/gpuweb/#promise-ordering
