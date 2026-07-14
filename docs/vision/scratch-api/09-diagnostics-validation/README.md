# Diagnostics And Validation

Status: Vision draft
Date: 2026-07-12

## Decision

Diagnostics are part of the scratch API contract. They are not logs and not prose-only exceptions.

The intelligent-friendly contract is:

```text
diagnostics should make repair local and mechanical;
repairs must remain explicit user or tooling actions.
```

Every validation surface should emit machine-readable diagnostics with stable codes, structured subjects, structured expected/actual payloads where useful, and optional human-readable hints. Error messages can improve over time, but tools and AI agents must not need to parse prose to identify the failure.

## Diagnostic Envelope

All diagnostic families should fit one envelope:

```ts
type DiagnosticSeverity = 'info' | 'warn' | 'error'

type DiagnosticPhase =
    | 'runtime'
    | 'resource'
    | 'layout-codec'
    | 'program'
    | 'binding'
    | 'pipeline'
    | 'command'
    | 'submission'
    | 'query'
    | 'readback'

type ScratchDiagnosticCode = string

type DiagnosticEvidence = {
    kind: string
    value?: unknown
    note?: string
}

type ScratchDiagnostic = {
    version: 1
    code: ScratchDiagnosticCode
    severity: DiagnosticSeverity
    phase: DiagnosticPhase
    message: string
    subject: DiagnosticSubject
    related?: DiagnosticSubject[]
    expected?: unknown
    actual?: unknown
    hint?: string
    suggestions?: DiagnosticSuggestion[]
    evidence?: DiagnosticEvidence[]
}
```

Stable machine contract:

- `version`
- `code`
- `severity`
- `phase`
- `subject.kind`
- `subject` identifiers
- `expected` / `actual` shape for a specific code, once documented
- `suggestions.kind`, if suggestions are emitted

Human-readable, not a stable parsing target:

- `message`
- `hint`

Diagnostics may be thrown, returned in a report, attached to `SubmittedWork`, attached to `ReadbackOperation`, or delivered to a runtime diagnostic sink. The shape stays the same.

## Subjects And Related Objects

A diagnostic must identify the smallest useful subject. Use `related` for context instead of hiding references inside prose.

```ts
type DiagnosticSubject =
    | { kind: 'ScratchRuntime', id: string, label?: string }
    | { kind: 'Surface', id: string, label?: string }
    | { kind: 'Resource', id: string, label?: string, resourceKind?: string }
    | { kind: 'LayoutArtifact', hash: string, label?: string }
    | { kind: 'LayoutField', path: string, label?: string }
    | { kind: 'Program', id: string, label?: string }
    | { kind: 'ShaderEntryPoint', programId?: string, name: string, stage: string }
    | { kind: 'ShaderBinding', group: number, binding: number, name?: string }
    | { kind: 'BindLayout', id: string, label?: string }
    | { kind: 'BindLayoutEntry', group: number, binding: number, name?: string }
    | { kind: 'BindSet', id: string, label?: string }
    | { kind: 'Pipeline', id: string, label?: string, pipelineKind?: string }
    | { kind: 'Command', id: string, label?: string, commandKind?: string }
    | { kind: 'PassSpec', id: string, label?: string, passKind?: string }
    | { kind: 'Submission', id: string, label?: string }
    | { kind: 'QuerySet', id: string, label?: string, queryType?: string }
    | { kind: 'ReadbackOperation', id: string, label?: string }
    | { kind: 'GpuOperation', id: string, operationKind?: string }
    | { kind: 'Incident', id: string, incidentKind?: string }
```

Examples:

- bind-layout mismatch: subject is the `BindLayoutEntry`; related includes the `Program` and `ShaderBinding`.
- read-before-write: subject is the reading `Command`; related includes the resource and last known writer.
- readback pending-operation budget exceeded: subject is the affected `ReadbackOperation`; staging-allocation budget failures retain the exact GPU operation and command/readback target. Both identify the runtime policy and source provenance structurally.

## Diagnostic Reports

Batch validation should return a report object rather than a bare array:

```ts
type ScratchDiagnosticReport = {
    version: 1
    diagnostics: ScratchDiagnostic[]
    hasErrors: boolean
    errorCount: number
    warningCount: number
}
```

Potential report sources:

- `runtime.validate()`
- `layoutCodec.report`
- `program.diagnostics`
- `scratch.inspectShader(shader).compareBindLayouts(...)`
- `submission.validate()`
- `submitted.diagnostics`
- `readback.diagnostics`

Reports should be deterministic for the same inspected state. If diagnostics depend on validation mode, the diagnostic `code` and structured payload remain stable; only the action changes.

## Runtime GPU Operation Evidence

Native GPU errors can settle after the JavaScript call that issued an operation. Scratch therefore distinguishes four retention models:

- The always-on **Runtime Fact Graph** contains only current live resources, installed allocations, pending covered operations, pending replacements, and current/peak Scratch-owned logical footprints. It scales with current state, not runtime age.
- The default **Incident Flight Recorder** stores compact allocation, replacement, disposal, and incident records in finite rings under a finite serialized-evidence budget. It omits successful-operation stacks, mutable handles, contents, shader source, command payloads, and retained `SubmittedWork` objects.
- An **Incident Report** is a deeply frozen JSON causal slice containing the triggering operation where known, subjects, native category and serializable facts, bounded recent operations, logical pressure evidence, evidence completeness, and attribution confidence.
- A **Deep Capture Session** is explicit, finite, and temporary. It can add call-site stacks and normalized descriptors, but automatically stops at its first operation, duration, or retained-evidence limit. A stopped capture freezes its report and detaches its controller and working storage. It is not thenable and does not wait for queue work.

The read-only `runtime.diagnostics` facade exposes `snapshot()`, `operations(query?)`, `incidents(query?)`, `operation(id)`, `incident(id)`, `capture(options)`, and `exportEvidence()`. Queries cover ID, kind, resource, status, and sequence facts. `exportEvidence()` freezes one serializable snapshot plus the currently retained bounded operation and incident arrays. Exported evidence never contains a live device, resource, buffer, texture, command, pass, submission, or mutable runtime collection.

Default retention is 256 operation records, 32 incidents, and 256 KiB of serialized evidence; all are finite and configurable. An operation capacity of zero disables successful-operation history without disabling current facts or failure handling. Current runtime/resource labels, compact native-label evidence, incident evidence, and captured descriptor labels at every nesting depth are bounded; native `GPUBuffer`/`GPUTexture` descriptors still preserve the complete user label and stable Scratch-ID suffix. The retained-byte counter measures deterministic JSON evidence, not JavaScript heap size.

Covered initial buffer/texture allocation and texture replacement use an exact synchronous issue boundary: push OOM, push validation, issue exactly one native allocation, pop validation, pop OOM, and only then await both pop promises. After the await, runtime/device/resource lifecycle is rechecked immediately before logical construction or replacement commit. A matching scope gives `exact-operation` attribution. Uncaptured errors and device loss remain `temporal-correlation` or `unknown` unless stronger native evidence exists. Scratch never derives stable fields by parsing native message prose.

OOM evidence separates the exact `triggerOperation` from bounded `pressureContributors` and bounded recent create/replace/dispose churn. Descriptor byte size and calculated texture format/block/mip/layer/sample size are logical footprints, not physical residency, free VRAM, driver padding, compression, eviction state, or total process/system memory. Texture array layers remain constant across mips; 3D depth shrinks per mip. Non-Scratch allocations remain unknown.

## Validation Modes And Actions

Validation mode controls disposition, not the diagnostic identity.

```ts
type ValidationMode = 'off' | 'warn' | 'throw'
```

- `throw`: error diagnostics throw a structured `ScratchDiagnosticError`.
- `warn`: diagnostics are reported to the diagnostic sink and attached to the relevant report/work object.
- `off`: optional validation may be skipped, but required platform safety checks still run when the runtime cannot proceed correctly.

`severity` is the finding's severity. The mode decides whether that severity throws, warns, or is skipped. Do not encode mode into diagnostic codes.

```ts
type ScratchDiagnosticError = Error & {
    diagnostic: ScratchDiagnostic
    report?: ScratchDiagnosticReport
    cause?: unknown
}
```

## Phase Sources

### Runtime

Runtime diagnostics cover device, adapter, feature, limit, ownership, lifecycle, and device-loss problems.

Candidate codes:

```ts
type RuntimeDiagnosticCode =
    | 'SCRATCH_RUNTIME_CONSTRUCTOR_PRIVATE'
    | 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE'
    | 'SCRATCH_RUNTIME_FEATURE_UNAVAILABLE'
    | 'SCRATCH_RUNTIME_DISPOSED'
    | 'SCRATCH_RUNTIME_DEVICE_LOST'
    | 'SCRATCH_RUNTIME_UNCAPTURED_GPU_ERROR'
    | 'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION'
    | 'SCRATCH_GPU_ERROR_SCOPE_FAILED'
    | 'SCRATCH_DIAGNOSTIC_CAPTURE_DEGRADED'
    | 'SCRATCH_DIAGNOSTIC_CAPTURE_LIMIT_EXCEEDED'
    | 'SCRATCH_SURFACE_CONFIGURATION_FAILED'
    | 'SCRATCH_SURFACE_CONFIGURATION_STALE'
    | 'SCRATCH_SURFACE_CONTEXT_IN_USE'
    | 'SCRATCH_SURFACE_CONTEXT_NOT_OWNED'
    | 'SCRATCH_SURFACE_CONTEXT_UNAVAILABLE'
    | 'SCRATCH_SURFACE_DISPOSED'
    | 'SCRATCH_SURFACE_UNCONFIGURE_FAILED'
```

### Resource

Resource diagnostics cover ownership, readiness, lifetime, usage, allocation version, and content epoch state.

Candidate codes:

```ts
type ResourceDiagnosticCode =
    | 'SCRATCH_RESOURCE_WRONG_RUNTIME'
    | 'SCRATCH_RESOURCE_DISPOSED'
    | 'SCRATCH_RESOURCE_USAGE_MISSING'
    | 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
    | 'SCRATCH_BUFFER_ALLOCATION_VALIDATION_FAILED'
    | 'SCRATCH_BUFFER_ALLOCATION_OUT_OF_MEMORY'
    | 'SCRATCH_BUFFER_ALLOCATION_NATIVE_FAILED'
    | 'SCRATCH_TEXTURE_ALLOCATION_VALIDATION_FAILED'
    | 'SCRATCH_TEXTURE_ALLOCATION_OUT_OF_MEMORY'
    | 'SCRATCH_TEXTURE_ALLOCATION_NATIVE_FAILED'
    | 'SCRATCH_TEXTURE_REPLACEMENT_PENDING'
    | 'SCRATCH_TEXTURE_REPLACEMENT_VALIDATION_FAILED'
    | 'SCRATCH_TEXTURE_REPLACEMENT_OUT_OF_MEMORY'
    | 'SCRATCH_TEXTURE_REPLACEMENT_NATIVE_FAILED'
    | 'SCRATCH_SAMPLER_ALLOCATION_VALIDATION_FAILED'
    | 'SCRATCH_SAMPLER_ALLOCATION_INTERNAL_FAILED'
    | 'SCRATCH_SAMPLER_ALLOCATION_OUT_OF_MEMORY'
    | 'SCRATCH_SAMPLER_ALLOCATION_NATIVE_FAILED'
    | 'SCRATCH_BUFFER_REGION_RANGE_INVALID'
    | 'SCRATCH_BUFFER_REGION_LAYOUT_INVALID'
    | 'SCRATCH_COMMAND_RESOURCE_NOT_READY'
    | 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE'
    | 'SCRATCH_SUBMISSION_STALE_READ'
    | 'SCRATCH_READBACK_SOURCE_ALLOCATION_STALE'
    | 'SCRATCH_READBACK_SOURCE_EPOCH_STALE'
```

`TextureResource.resize()` uses `SCRATCH_RESOURCE_DESCRIPTOR_INVALID` for deterministic size grammar, integer-domain, limit, mip, sample, transient-attachment, format-block, lifecycle, and native-capability failures detected before native issue. Native validation, OOM, synchronous exceptions, and scope failures use their operation-specific codes and link an immutable incident; `ScratchDiagnosticError.cause` may retain the original native error.

The Promise resolves only after validation and OOM scopes acknowledge the candidate. Failure before commit leaves the previous texture, descriptor, views, `allocationVersion`, `contentEpoch`, and readiness state unchanged.

### Layout Codec

Layout codec diagnostics cover layout lowering, CPU writer, upload byte ranges, readback views, and WGSL accessor compatibility.

Candidate codes:

```ts
type LayoutCodecDiagnosticCode =
    | 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT'
    | 'SCRATCH_LAYOUT_ABI_MISMATCH'
    | 'SCRATCH_CODEC_BYTE_LENGTH_MISMATCH'
    | 'SCRATCH_CODEC_SCHEMA_MISMATCH'
    | 'SCRATCH_CODEC_READBACK_VIEW_UNSAFE'
```

### Program

Program diagnostics cover WGSL modules, generated accessors, entry points, required features, reflection cross-checks, and shader/layout contracts.

Candidate codes:

```ts
type ProgramDiagnosticCode =
    | 'SCRATCH_PROGRAM_ENTRY_POINT_MISSING'
    | 'SCRATCH_PROGRAM_FEATURE_UNAVAILABLE'
    | 'SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH'
    | 'SCRATCH_PROGRAM_MODULES_INVALID'
    | 'SCRATCH_PROGRAM_WRONG_RUNTIME'
    | 'SCRATCH_PROGRAM_DISPOSED'
    | 'SCRATCH_PROGRAM_SHADER_REFLECTION_INCONCLUSIVE'
```

Reflection is still a guard, not the source of truth. A reflection parser that cannot understand newer WGSL should usually produce a warn-level inconclusive diagnostic, not block valid explicit layouts.

### Binding

Binding diagnostics cover explicit `BindLayout`, `BindSet`, shader cross-checks, resource compatibility, and dynamic offsets.

Candidate codes:

```ts
type BindingDiagnosticCode =
    | 'SCRATCH_BIND_DISPOSED'
    | 'SCRATCH_BIND_DYNAMIC_OFFSET_INVALID'
    | 'SCRATCH_BIND_DYNAMIC_OFFSET_MISSING'
    | 'SCRATCH_BIND_DYNAMIC_OFFSET_OUT_OF_BOUNDS'
    | 'SCRATCH_BIND_LAYOUT_ALLOCATION_INTERNAL_FAILED'
    | 'SCRATCH_BIND_LAYOUT_ALLOCATION_NATIVE_FAILED'
    | 'SCRATCH_BIND_LAYOUT_ALLOCATION_OUT_OF_MEMORY'
    | 'SCRATCH_BIND_LAYOUT_ALLOCATION_VALIDATION_FAILED'
    | 'SCRATCH_BIND_LAYOUT_DESCRIPTOR_INVALID'
    | 'SCRATCH_BIND_LAYOUT_LIMIT_EXCEEDED'
    | 'SCRATCH_BIND_MIN_BINDING_SIZE_INVALID'
    | 'SCRATCH_BIND_MIN_BINDING_SIZE_UNSATISFIED'
    | 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING'
    | 'SCRATCH_BIND_RESOURCE_OFFSET_UNALIGNED'
    | 'SCRATCH_BIND_RESOURCE_RANGE_INVALID'
    | 'SCRATCH_BIND_RESOURCE_SIZE_LIMIT_EXCEEDED'
    | 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH'
    | 'SCRATCH_BIND_RESOURCE_USAGE_MISSING'
    | 'SCRATCH_BIND_SAMPLER_TYPE_MISMATCH'
    | 'SCRATCH_BIND_SET_DESCRIPTOR_INVALID'
    | 'SCRATCH_BIND_SET_PREPARATION_CONFLICT'
    | 'SCRATCH_BIND_SET_PREPARATION_INTERNAL_FAILED'
    | 'SCRATCH_BIND_SET_PREPARATION_NATIVE_FAILED'
    | 'SCRATCH_BIND_SET_PREPARATION_OUT_OF_MEMORY'
    | 'SCRATCH_BIND_SET_PREPARATION_SCOPE_FAILED'
    | 'SCRATCH_BIND_SET_PREPARATION_SNAPSHOT_DRIFT'
    | 'SCRATCH_BIND_SET_PREPARATION_VALIDATION_FAILED'
    | 'SCRATCH_BIND_SET_PREPARING'
    | 'SCRATCH_BIND_SET_STALE'
    | 'SCRATCH_BIND_STORAGE_TEXTURE_FORMAT_UNSUPPORTED'
    | 'SCRATCH_BIND_STORAGE_TEXTURE_VIEW_MISMATCH'
    | 'SCRATCH_BIND_TEXTURE_COMPATIBILITY_MODE_MISMATCH'
    | 'SCRATCH_BIND_TEXTURE_SAMPLE_TYPE_MISMATCH'
    | 'SCRATCH_BIND_DYNAMIC_OFFSET_UNALIGNED'
    | 'SCRATCH_BIND_SHADER_TYPE_MISMATCH'
    | 'SCRATCH_BIND_SHADER_INDEX_MISMATCH'
    | 'SCRATCH_BIND_UNKNOWN_ENTRY'
    | 'SCRATCH_BIND_WRONG_RUNTIME'
```

Example:

```ts
{
    version: 1,
    code: 'SCRATCH_BIND_SHADER_TYPE_MISMATCH',
    severity: 'warn',
    phase: 'binding',
    message: 'BindLayout entry does not match the shader binding type.',
    subject: { kind: 'BindLayoutEntry', group: 0, binding: 2, name: 'dem' },
    related: [
        { kind: 'Program', id: 'terrainProgram', label: 'terrain program' },
        { kind: 'ShaderBinding', group: 0, binding: 2, name: 'dem' },
    ],
    expected: { source: 'BindLayout', type: 'texture' },
    actual: { source: 'WGSLReflection', type: 'sampler' },
    hint: 'Make WGSL binding 2 a texture, or update the explicit BindLayout if the shader is correct.',
}
```

### Pipeline

Pipeline diagnostics cover static render/compute state and compatibility with programs, pass specs, vertex layouts, targets, features, and limits.

Candidate codes:

```ts
type PipelineDiagnosticCode =
    | 'SCRATCH_PIPELINE_CONSTRUCTOR_PRIVATE'
    | 'SCRATCH_PIPELINE_CREATION_BIND_LAYOUT_DISPOSED'
    | 'SCRATCH_PIPELINE_CREATION_DEVICE_LOST'
    | 'SCRATCH_PIPELINE_CREATION_MULTIPLE_FAILURES'
    | 'SCRATCH_PIPELINE_CREATION_PROGRAM_DISPOSED'
    | 'SCRATCH_PIPELINE_CREATION_RUNTIME_DISPOSED'
    | 'SCRATCH_PIPELINE_DISPOSED'
    | 'SCRATCH_PIPELINE_PROGRAM_INVALID'
    | 'SCRATCH_PIPELINE_WRONG_RUNTIME'
    | 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH'
    | 'SCRATCH_PIPELINE_DEPTH_STENCIL_MISMATCH'
    | 'SCRATCH_PIPELINE_VERTEX_LAYOUT_MISMATCH'
    | 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE'
```

### Command

Command diagnostics cover executable state, counts, readiness policy, declared resource access, and pass compatibility.

Candidate codes:

```ts
type CommandDiagnosticCode =
    | 'SCRATCH_COMMAND_COPY_RANGE_INVALID'
    | 'SCRATCH_COMMAND_COPY_SOURCE_INVALID'
    | 'SCRATCH_COMMAND_DISPOSED'
    | 'SCRATCH_COMMAND_PASS_KIND_MISMATCH'
    | 'SCRATCH_COMMAND_COUNT_INVALID'
    | 'SCRATCH_COMMAND_VERTEX_BUFFER_INVALID'
    | 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID'
    | 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID'
    | 'SCRATCH_COMMAND_READINESS_POLICY_MISSING'
    | 'SCRATCH_COMMAND_FALLBACK_INVALID'
    | 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE'
    | 'SCRATCH_COMMAND_RESOURCE_NOT_READY'
    | 'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID'
    | 'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_FAILED'
    | 'SCRATCH_COMMAND_TEXTURE_UPLOAD_INVALID'
    | 'SCRATCH_COMMAND_UPLOAD_RANGE_INVALID'
    | 'SCRATCH_COMMAND_WRONG_RUNTIME'

type PassDiagnosticCode =
    | 'SCRATCH_PASS_DEPTH_STENCIL_ATTACHMENT_INVALID'
    | 'SCRATCH_PASS_DISPOSED'
    | 'SCRATCH_PASS_WRONG_RUNTIME'
```

Expected Draw/Dispatch `skip-command`, `skip-pass`, and successful `use-fallback` decisions are not diagnostics. They are immutable `SubmittedWork.executionOutcomes`. `SCRATCH_COMMAND_FALLBACK_INVALID` is reserved for missing/forbidden fallback shapes, forged non-command nodes, kind/runtime/lifecycle/write-set incompatibility, and repeated objects or command IDs. A selected fallback that cannot enter the current pass uses `SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE`.

Fallback readiness or dependency failures use the selected fallback as `subject`. `related` includes the requested command, attempted chain, pass, resources, and submission. Structured `actual` facts include step/pass IDs, requested command ID, attempted command IDs, a complete `attempts` array with every available missing-resource state/epoch fact, current command/resource state and epochs, plus validation mode. A selected fallback dependency that becomes unusable after construction uses `SCRATCH_COMMAND_FALLBACK_INVALID` and retains the underlying lifecycle diagnostic in `actual.cause`. Render attachment resource-conflict diagnostics generated for a selected fallback retain the same requested/attempted provenance.

`ExternalImageUploadCommand` diagnostics use `commandKind: 'upload'` and `uploadKind: 'external-image'` in their structured command facts. `SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID` covers deterministic descriptor, platform brand, live source-range, target, queue ownership, lifecycle, and queue-capability failures. Context-specific canvas dimensions are not exposed through a side-effect-free JavaScript query, so a synchronous native `OperationError` from that authoritative range check uses the same invalid code. Its `expected` and `actual` fields contain machine-readable validation facts rather than requiring message parsing.

`SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_FAILED` is reserved for other synchronous exceptions thrown by `GPUQueue.copyExternalImageToTexture()`. The diagnostic's `actual.nativeError` contains only serializable exception facts, while `ScratchDiagnosticError.cause` preserves the original thrown value for programmatic inspection. A failed native call does not commit a target epoch, readiness transition, access entry, or producer fact.

### Submission

Submission diagnostics cover explicit order validation, resource dependency validation, pass-command compatibility, borrowed surface texture lifetime, and submitted-work state.

Candidate codes:

```ts
type SubmissionDiagnosticCode =
    | 'SCRATCH_SUBMITTED_WORK_CONSTRUCTOR_PRIVATE'
    | 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE'
    | 'SCRATCH_SUBMISSION_STALE_READ'
    | 'SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT'
    | 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE'
    | 'SCRATCH_SUBMISSION_SURFACE_VIEW_OUT_OF_SCOPE'
    | 'SCRATCH_SUBMISSION_WORK_ALREADY_SUBMITTED'
    | 'SCRATCH_SUBMISSION_NATIVE_POLICY_INVALID'
    | 'SCRATCH_SUBMISSION_NATIVE_OBSERVATION_BUDGET_EXCEEDED'
    | 'SCRATCH_SUBMISSION_NATIVE_VALIDATION_FAILED'
    | 'SCRATCH_SUBMISSION_NATIVE_INTERNAL_FAILED'
    | 'SCRATCH_SUBMISSION_NATIVE_OUT_OF_MEMORY'
    | 'SCRATCH_SUBMISSION_NATIVE_EXCEPTION'
    | 'SCRATCH_SUBMISSION_NATIVE_SCOPE_FAILED'
    | 'SCRATCH_SUBMISSION_NATIVE_OBSERVATION_FAILED'
    | 'SCRATCH_SUBMISSION_QUEUE_COMPLETION_FAILED'
```

`skipped-empty` is an execution outcome rather than a diagnostic code. Validation mode controls optional dependency findings; it never disables readiness resolution or removes execution-outcome facts.

Indeterminate content is required safety validation rather than an optional
readiness finding. Resource, query-slot, and persistent attachment reads use
`SCRATCH_COMMAND_RESOURCE_CONTENT_INDETERMINATE`,
`SCRATCH_QUERY_SLOT_CONTENT_INDETERMINATE`, and
`SCRATCH_PASS_ATTACHMENT_CONTENT_INDETERMINATE` before native effects in every
validation mode.

### Query And Readback

Query and readback diagnostics use the same envelope. The current query and readback codes from `07-transfers-epochs` use the shared outer shape defined here.

Examples:

```ts
type QueryDiagnosticCode =
    | 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
    | 'SCRATCH_RUNTIME_FEATURE_UNAVAILABLE'
    | 'SCRATCH_QUERY_SLOT_INDEX_INVALID'
    | 'SCRATCH_QUERY_SET_ALLOCATION_VALIDATION_FAILED'
    | 'SCRATCH_QUERY_SET_ALLOCATION_INTERNAL_FAILED'
    | 'SCRATCH_QUERY_SET_ALLOCATION_OUT_OF_MEMORY'
    | 'SCRATCH_QUERY_SET_ALLOCATION_NATIVE_FAILED'
    | 'SCRATCH_PASS_TIMESTAMP_WRITES_INVALID'
    | 'SCRATCH_PASS_OCCLUSION_QUERY_SET_INVALID'
    | 'SCRATCH_COMMAND_OCCLUSION_QUERY_INVALID'
    | 'SCRATCH_SUBMISSION_OCCLUSION_QUERY_STATE_INVALID'
    | 'SCRATCH_QUERY_RESOLVE_UNWRITTEN_RANGE'
    | 'SCRATCH_COMMAND_RESOLVE_QUERY_SET_INVALID'
    | 'SCRATCH_QUERY_SLOT_CONTENT_INDETERMINATE'

type ReadbackDiagnosticCode =
    | 'SCRATCH_READBACK_AFTER_INVALID'
    | 'SCRATCH_READBACK_ALREADY_CONSUMED'
    | 'SCRATCH_READBACK_COMMAND_AFTER_INVALID'
    | 'SCRATCH_READBACK_COMMAND_BUSY'
    | 'SCRATCH_READBACK_COMMAND_CONSTRUCTOR_PRIVATE'
    | 'SCRATCH_READBACK_COMMAND_DUPLICATE_IN_SUBMISSION'
    | 'SCRATCH_READBACK_COMMAND_RESULT_UNAVAILABLE'
    | 'SCRATCH_READBACK_FAILED'
    | 'SCRATCH_READBACK_LAYOUT_MISSING'
    | 'SCRATCH_READBACK_MAPPING_NATIVE_FAILED'
    | 'SCRATCH_READBACK_OPERATION_CONSTRUCTOR_PRIVATE'
    | 'SCRATCH_READBACK_POLICY_INVALID'
    | 'SCRATCH_READBACK_RETAIN_INVALID'
    | 'SCRATCH_READBACK_SOURCE_INVALID'
    | 'SCRATCH_READBACK_STAGING_NATIVE_FAILED'
    | 'SCRATCH_READBACK_VIEW_INVALID'
    | 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED'
    | 'SCRATCH_READBACK_STAGING_VALIDATION_FAILED'
    | 'SCRATCH_READBACK_STAGING_OUT_OF_MEMORY'
    | 'SCRATCH_READBACK_COPY_ISSUE_FAILED'
    | 'SCRATCH_READBACK_NATIVE_OBSERVATION_BUDGET_EXCEEDED'
    | 'SCRATCH_READBACK_NATIVE_VALIDATION_FAILED'
    | 'SCRATCH_READBACK_NATIVE_INTERNAL_FAILED'
    | 'SCRATCH_READBACK_NATIVE_OUT_OF_MEMORY'
    | 'SCRATCH_READBACK_NATIVE_EXCEPTION'
    | 'SCRATCH_READBACK_NATIVE_SCOPE_FAILED'
    | 'SCRATCH_READBACK_NATIVE_OBSERVATION_FAILED'
    | 'SCRATCH_READBACK_ORDERED_COPY_UNTRUSTED'
    | 'SCRATCH_READBACK_MAPPING_VALIDATION_FAILED'
    | 'SCRATCH_READBACK_MAPPING_INTERNAL_FAILED'
    | 'SCRATCH_READBACK_MAPPING_OUT_OF_MEMORY'
    | 'SCRATCH_READBACK_MAPPING_SCOPE_FAILED'
    | 'SCRATCH_READBACK_MAPPING_REJECTED'
    | 'SCRATCH_READBACK_MAPPED_RANGE_FAILED'
    | 'SCRATCH_READBACK_HOST_COPY_FAILED'
    | 'SCRATCH_READBACK_CLEANUP_FAILED'
    | 'SCRATCH_READBACK_UNMAP_FAILED'
    | 'SCRATCH_READBACK_STAGING_DESTROY_FAILED'
    | 'SCRATCH_READBACK_IN_PROGRESS'
    | 'SCRATCH_READBACK_CANCELLED'
    | 'SCRATCH_READBACK_OPERATION_DISPOSED'
```

## Code Naming And Stability

Diagnostic codes should use:

```text
SCRATCH_<DOMAIN>_<CONDITION>
```

Rules:

- Use `UPPER_SNAKE_CASE`.
- Domain names should align with phases where possible: `RESOURCE`, `LAYOUT`, `CODEC`, `PROGRAM`, `BIND`, `PIPELINE`, `COMMAND`, `SUBMISSION`, `QUERY`, `READBACK`.
- Do not put dynamic values in the code. Use `subject`, `expected`, and `actual`.
- Do not change a code because `message` or `hint` changed.
- Do not encode severity or validation mode in the code.
- Prefer adding a new optional field over changing an existing field's meaning.
- During `0.x.x`, code changes are allowed but must be reflected in these vision docs or a later ADR. At `1.x.x`, diagnostic codes become public compatibility surface unless explicitly versioned.

## Expected And Actual Payloads

`expected` and `actual` should be structured for common errors:

```ts
expected: {
    source: 'BindLayout',
    type: 'texture',
    visibility: ['fragment'],
}

actual: {
    source: 'WGSLReflection',
    type: 'sampler',
    visibility: ['fragment'],
}
```

Do not use `expected` / `actual` for large objects or opaque GPU handles. Reference those through `subject`, `related`, or compact summaries.

## Repair Suggestions

Suggestions are optional and advisory. They should help tooling produce a local edit, but scratch must not silently apply them.

```ts
type DiagnosticSuggestion = {
    kind: string
    confidence: 'low' | 'medium' | 'high'
    target: DiagnosticSubject
    action?: 'edit' | 'add' | 'remove' | 'reorder' | 'declare' | 'dispose'
    set?: unknown
    note?: string
}
```

Guidelines:

- Suggestions must be local. Prefer "edit this bind entry" over "rewrite the pipeline".
- Suggestions must not hide ambiguity. If there are two valid fixes, emit two suggestions with confidence.
- Suggestions are repair hints, not automatic behavior.
- Runtime must not reorder submissions, infer bind layouts, change resource usage, or mutate shader code merely because a suggestion exists.

Example:

```ts
suggestions: [
    {
        kind: 'edit-bind-layout-entry',
        confidence: 'high',
        target: { kind: 'BindLayoutEntry', group: 0, binding: 2, name: 'dem' },
        action: 'edit',
        set: { type: 'sampler' },
    },
    {
        kind: 'edit-wgsl-binding',
        confidence: 'medium',
        target: { kind: 'ShaderBinding', group: 0, binding: 2, name: 'dem' },
        action: 'edit',
        set: { type: 'texture_2d<f32>' },
    },
]
```

## GPU Operation, Pipeline, And Readback Evidence

GPU operation, incident, snapshot, capture, and exported-evidence schemas use
version 5. Versions 2 through 4 are not emitted or converted during `0.x.x`. Operations and
pending facts select one explicit macro target:

```ts
type ScratchGpuResourceOperationTarget =
    | {
        kind: 'resource'
        resourceKind: 'BufferResource' | 'TextureResource'
        resourceId: string
        allocationVersion: number
        contentEpoch: number
        logicalFootprintBytes: number
    }
    | {
        kind: 'resource'
        resourceKind: 'SamplerResource'
        resourceId: string
        allocationVersion: number
    }
    | {
        kind: 'resource'
        resourceKind: 'QuerySetResource'
        resourceId: string
        allocationVersion: number
        queryType: 'timestamp' | 'occlusion'
        count: number
        slots: readonly { index: number; state: string; contentEpoch: number }[]
    }

type ScratchGpuOperationTarget =
    | ScratchGpuResourceOperationTarget
    | { kind: 'bind-layout'; bindLayoutId: string; group: number; entries: readonly unknown[]; acknowledgementState: 'pending' }
    | { kind: 'bind-set'; bindSetId: string; bindLayoutId: string; preparationState: string; generation: number; snapshotHash: string; preparationStage: string }
    | { kind: 'pipeline'; pipelineId: string; pipelineKind: 'render' | 'compute'; programId: string; programSourceHash: string }
    | { kind: 'command'; commandId: string; commandKind: 'readback' }
    | {
        kind: 'readback'
        readbackId: string
        path: 'direct' | 'ordered'
        sourceResourceId: string
        allocationVersion: number
        contentEpoch: number
        byteLength: number
        commandId?: string
        submissionId?: string
        stepIndex?: number
    }
    | { kind: 'submission'; submissionId: string }
```

Schema v5 adds `sampler-allocation`, `query-set-allocation`,
`bind-layout-allocation`, and `bind-set-preparation`. Sampler targets never gain
content/readiness/footprint fields. QuerySet targets report bounded indexed slot
facts and no scalar epoch. BindLayout reports ABI shape and acknowledgement;
BindSet reports preparation state, generation, snapshot, and stage without
pretending to be a Resource. BufferRegion and TextureViewSpec are subjects or
related evidence and never double-count resource pressure.

Queries select `targetKind` plus the identifier appropriate to that discriminator
rather than guessing from optional fields. Resource allocation incidents retain
ADR-032 pressure and attribution semantics. Pipeline and supporting-object
incidents contain their actual creation/preparation evidence and never receive
fabricated allocation pressure. Readback targets never masquerade as persistent
resources.

BindSet preparation evidence distinguishes descriptor validation, native issue,
synchronous native throw, per-view acknowledgement, bind-group acknowledgement,
lifecycle recheck, snapshot recheck, commit, cancellation, and explicit retry.
Successful steady-state BindSet use creates no preparation operation and does
not copy a complete binding snapshot into each submission record. Supporting
objects and native views receive no invented byte footprint; an OOM incident
may include bounded current Buffer/Texture pressure context without claiming
that the candidate alone caused aggregate exhaustion.

Supporting-object factories settle every scope issued around a candidate before
choosing a causal primary. Fixed priority is synchronous native exception,
structural scope failure, validation, internal, OOM, runtime disposal, then
device loss. A lifecycle notification cannot short-circuit scope settlement or
erase an earlier fact; the lifecycle recheck is retained as secondary incident
evidence when another failure is primary. Settlement timing and native prose do
not alter that order.

Submission issue provenance uses a `submission-native-observation` operation
and `submission-failure` incidents. Its version 5 outcome records one of the
summary, detailed, or off modes; one stable status; bounded discriminated
locations; fixed-order native outcome facts; and explicit omission counts.
Native stages distinguish encoder creation, pass begin/end, command encoding,
encoder finish, queue action/submit, scope settlement, queue completion, and
lifecycle recheck.

Default `submissionScopes: 'summary'` uses one constant-size scope bundle for
the complete submission family. A failure therefore has
`enclosing-operation-family` attribution even when the issued-location index
narrows the search. Temporary `nativeSubmissionDetail: 'step'` capture can
provide `exact-operation` attribution to one scoped location, but cannot prove
which native call inside that location caused the error. Queue completion is
also family evidence. An OOM scope proves that its submission/readback family
captured OOM; it does not prove one command or one resource alone exhausted
physical memory. Device loss and runtime disposal are runtime-wide lifecycle
facts: a `lifecycle-recheck` outcome remains `temporal-correlation` even during
detailed capture. Native prose never upgrades attribution.

The always-current `submissionNative` fact reports `submissionScopes`,
`maxPendingNativeObservations`, `currentPendingNativeObservations`,
`peakPendingNativeObservations`, and `currentEffectfulSubmittedWork`. These
facts and budget enforcement remain active when successful operation-history
capacity is zero. `off` is explicit `unobserved` provenance, never inferred
success.

Readback provenance uses `readback-staging-allocation`, `readback-mapping`, and
`readback-staging-release` operations plus `readback-failure` incidents. Direct
copy issue additionally uses `readback-native-observation`; it retains a
readback target and never fabricates a submission ID. Ordered readback trusts
the associated submission `nativeOutcome` instead of creating another copy
observation.
`readback-staging-release` is instantaneous and cannot appear in pending facts.
Failure stages are structural and include:

```ts
type ScratchReadbackFailureStage =
    | 'staging-allocation'
    | 'copy-issue'
    | 'queue-completion'
    | 'mapping'
    | 'mapped-range'
    | 'host-copy'
    | 'cleanup'
    | 'budget'
    | 'lifecycle-recheck'
```

Independent map-Promise, validation, internal, OOM, scope-settlement, device
loss, and lifecycle outcomes are retained in fixed transaction order. A native
message is bounded evidence, never the classifier. Cleanup outcomes distinguish
`unmap` from staging `destroy`; `destroyRequested` does not claim that a native
destroy call which threw actually completed.

A rejected `SubmittedWork.done` records one command-targeted readback incident
per immutable readback link at `queue-completion`. Its attribution is
`enclosing-operation-family`, because one queue completion Promise cannot prove
which linked command caused the rejection. It does not rewrite a linked
operation's independent mapping result.

The always-current fact graph reports readback commands, active/retained
operations, current/peak staging bytes, current/peak retained host bytes, and
active mappings. Bounded history retains no GPUBuffer, mapped ArrayBuffer,
source bytes, command payload, mutable operation, or SubmittedWork. Setting
`operationCapacity: 0` may omit operation history, but it does not disable
current facts, incidents, budgets, or cleanup.

Each successful pipeline exposes an immutable source-free compilation report.
It retains at most 64 native messages, at most 4096 UTF-16 code units per
message, and at most 64 KiB of serialized compilation evidence. Counts and
omission fields remain even when evidence is truncated. Native order is
preserved; native prose is not parsed; zero-valued unknown locations and
separator locations are not assigned invented module coordinates. Before
retention, exact Program identifiers/numeric literals of at least three UTF-16
code units and exact contiguous Program spans of at least eight UTF-16 code
units are replaced. Tokenization follows WGSL Unicode-XID identifiers and its
complete decimal/hexadecimal integer and float lexical forms, including
leading-dot floats. `sourceExcerptRedacted` distinguishes that sanitization
from `messageTruncated`. Retained pipeline, supporting-scope, structural, and
lifecycle native-error strings use the same source sanitizer; the original
native object is allowed only as a transient diagnostic cause. The sanitizer
uses one lazy Bloom workspace capped at 32 KiB per report or native-error
settlement. Collisions can only cause conservative over-redaction. A global
device-loss event has no unique Program context, so Scratch permanently omits
its native message instead: `runtime.deviceLostInfo` and the runtime incident
retain the structural reason, a fixed omission marker, and
`nativeMessageOmitted: true`. An in-flight pipeline may use the original info
only through a temporary lifecycle subscription and diagnostic cause.

Stable pipeline creation failure codes are
`SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED`,
`SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED`,
`SCRATCH_PIPELINE_CREATION_INTERNAL_FAILED`,
`SCRATCH_PIPELINE_SUPPORT_OBJECT_FAILED`,
`SCRATCH_PIPELINE_CREATION_NATIVE_FAILED`, and
`SCRATCH_PIPELINE_CREATION_SCOPE_FAILED`. `GPUPipelineError.reason` and scope
categories are structural facts. Independent Promise outcomes are joined
without treating settlement order or localized text as causality.

## Non-Goals

- Do not make prose error messages the stable API.
- Do not require agents or tests to parse `message` or `hint`.
- Do not make shader reflection authoritative through diagnostics.
- Do not use diagnostics to auto-repair hidden state.
- Do not create unrelated diagnostic shapes for readback, query, shader, and submission errors.
- Do not treat `warn` mode as permission to continue after state corruption or device loss when the runtime cannot proceed safely.
