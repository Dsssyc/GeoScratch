# Diagnostics And Validation

Status: Vision draft
Date: 2026-07-11

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
- readback budget exceeded: subject is the `ReadbackOperation`; related includes the runtime budget policy and source resource.

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
- The default **Incident Flight Recorder** stores compact operation and incident records in finite rings under a finite serialized-evidence budget. It omits successful-operation stacks, mutable handles, contents, shader source, command payloads, and retained `SubmittedWork` objects.
- An **Incident Report** is a deeply frozen JSON causal slice containing the triggering operation where known, subjects, native category and serializable facts, bounded recent operations, logical pressure evidence, evidence completeness, and attribution confidence.
- A **Deep Capture Session** is explicit, finite, and temporary. It can add call-site stacks and normalized descriptors, but automatically stops at its first operation, duration, or retained-evidence limit. It is not thenable and does not wait for queue work.

The read-only `runtime.diagnostics` facade exposes current snapshots, bounded operations, bounded incidents, ID/kind/resource/sequence queries, and bounded captures. Exported evidence never contains a live device, resource, buffer, texture, command, pass, submission, or mutable runtime collection.

Covered initial buffer/texture allocation and texture replacement use an exact synchronous issue boundary: push OOM, push validation, issue exactly one native allocation, pop validation, pop OOM, and only then await both pop promises. A matching scope gives `exact-operation` attribution. Uncaptured errors and device loss remain `temporal-correlation` or `unknown` unless stronger native evidence exists. Scratch never derives stable fields by parsing native message prose.

OOM evidence separates the exact `triggerOperation` from bounded `pressureContributors`. Descriptor byte size and calculated texture format/block/mip/layer/sample size are logical footprints, not physical residency, free VRAM, driver padding, compression, eviction state, or total process/system memory. Non-Scratch allocations remain unknown.

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
    | 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE'
    | 'SCRATCH_RUNTIME_FEATURE_UNAVAILABLE'
    | 'SCRATCH_RUNTIME_LIMIT_UNSATISFIED'
    | 'SCRATCH_RUNTIME_DISPOSED'
    | 'SCRATCH_RUNTIME_DEVICE_LOST'
    | 'SCRATCH_RUNTIME_UNCAPTURED_GPU_ERROR'
    | 'SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION'
    | 'SCRATCH_GPU_ERROR_SCOPE_FAILED'
    | 'SCRATCH_DIAGNOSTIC_CAPTURE_DEGRADED'
    | 'SCRATCH_DIAGNOSTIC_CAPTURE_LIMIT_EXCEEDED'
```

### Resource

Resource diagnostics cover ownership, readiness, lifetime, usage, allocation version, and content epoch state.

Candidate codes:

```ts
type ResourceDiagnosticCode =
    | 'SCRATCH_RESOURCE_WRONG_RUNTIME'
    | 'SCRATCH_RESOURCE_DISPOSED'
    | 'SCRATCH_RESOURCE_LOST'
    | 'SCRATCH_RESOURCE_NOT_READY'
    | 'SCRATCH_RESOURCE_USAGE_MISSING'
    | 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
    | 'SCRATCH_RESOURCE_ALLOCATION_REPLACEMENT_FAILED'
    | 'SCRATCH_GPU_ALLOCATION_PENDING_CONFLICT'
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
    | 'SCRATCH_RESOURCE_ALLOCATION_VERSION_STALE'
    | 'SCRATCH_RESOURCE_CONTENT_EPOCH_UNAVAILABLE'
```

`TextureResource.resize()` uses `SCRATCH_RESOURCE_DESCRIPTOR_INVALID` for deterministic size grammar, integer-domain, limit, mip, sample, transient-attachment, format-block, lifecycle, and native-capability failures detected before native issue. Native validation, OOM, synchronous exceptions, and scope failures use their operation-specific codes and link an immutable incident; `ScratchDiagnosticError.cause` may retain the original native error.

The Promise resolves only after validation and OOM scopes acknowledge the candidate. Failure before commit leaves the previous texture, descriptor, views, `allocationVersion`, `contentEpoch`, and readiness state unchanged.

### Layout Codec

Layout codec diagnostics cover layout lowering, CPU writer, upload byte ranges, readback views, and WGSL accessor compatibility.

Candidate codes:

```ts
type LayoutCodecDiagnosticCode =
    | 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT'
    | 'SCRATCH_LAYOUT_UNSUPPORTED_STORAGE_FORMAT'
    | 'SCRATCH_LAYOUT_ALIGNMENT_UNREPRESENTABLE'
    | 'SCRATCH_LAYOUT_DYNAMIC_OFFSET_UNALIGNED'
    | 'SCRATCH_CODEC_BYTE_LENGTH_MISMATCH'
    | 'SCRATCH_CODEC_STRUCTURAL_HASH_MISMATCH'
    | 'SCRATCH_CODEC_READBACK_VIEW_UNSAFE'
```

### Program

Program diagnostics cover WGSL modules, generated accessors, entry points, required features, reflection cross-checks, and shader/layout contracts.

Candidate codes:

```ts
type ProgramDiagnosticCode =
    | 'SCRATCH_PROGRAM_ENTRY_POINT_MISSING'
    | 'SCRATCH_PROGRAM_STAGE_MISMATCH'
    | 'SCRATCH_PROGRAM_FEATURE_UNAVAILABLE'
    | 'SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH'
    | 'SCRATCH_PROGRAM_SHADER_PARSE_UNAVAILABLE'
    | 'SCRATCH_PROGRAM_SHADER_REFLECTION_INCONCLUSIVE'
```

Reflection is still a guard, not the source of truth. A reflection parser that cannot understand newer WGSL should usually produce a warn-level inconclusive diagnostic, not block valid explicit layouts.

### Binding

Binding diagnostics cover explicit `BindLayout`, `BindSet`, shader cross-checks, resource compatibility, and dynamic offsets.

Candidate codes:

```ts
type BindingDiagnosticCode =
    | 'SCRATCH_BIND_REQUIRED_ENTRY_MISSING'
    | 'SCRATCH_BIND_RESOURCE_TYPE_MISMATCH'
    | 'SCRATCH_BIND_RESOURCE_USAGE_MISSING'
    | 'SCRATCH_BIND_DYNAMIC_OFFSET_UNALIGNED'
    | 'SCRATCH_BIND_SHADER_TYPE_MISMATCH'
    | 'SCRATCH_BIND_SHADER_VISIBILITY_MISMATCH'
    | 'SCRATCH_BIND_SHADER_INDEX_MISMATCH'
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
    | 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH'
    | 'SCRATCH_PIPELINE_DEPTH_STENCIL_MISMATCH'
    | 'SCRATCH_PIPELINE_VERTEX_LAYOUT_MISMATCH'
    | 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE'
    | 'SCRATCH_PIPELINE_COMPUTE_LIMIT_UNSATISFIED'
```

### Command

Command diagnostics cover executable state, counts, readiness policy, declared resource access, and pass compatibility.

Candidate codes:

```ts
type CommandDiagnosticCode =
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
    | 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE'
    | 'SCRATCH_SUBMISSION_WRITE_AFTER_READ_UNDECLARED'
    | 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE'
    | 'SCRATCH_SUBMISSION_SURFACE_VIEW_OUT_OF_SCOPE'
    | 'SCRATCH_SUBMISSION_WORK_ALREADY_SUBMITTED'
```

`skipped-empty` is an execution outcome rather than a diagnostic code. Validation mode controls optional dependency findings; it never disables readiness resolution or removes execution-outcome facts.

### Query And Readback

Query and readback diagnostics use the same envelope. Existing query and readback codes from `07-transfers-epochs` remain valid candidate codes; this module defines the shared outer shape.

Examples:

```ts
type QueryDiagnosticCode =
    | 'SCRATCH_QUERY_UNSUPPORTED_TYPE'
    | 'SCRATCH_QUERY_FEATURE_UNAVAILABLE'
    | 'SCRATCH_QUERY_INDEX_OUT_OF_RANGE'
    | 'SCRATCH_QUERY_WRONG_PASS_KIND'
    | 'SCRATCH_QUERY_WRONG_SET_TYPE'
    | 'SCRATCH_QUERY_OCCLUSION_NESTED'
    | 'SCRATCH_QUERY_OCCLUSION_NOT_ACTIVE'
    | 'SCRATCH_QUERY_RESOLVE_UNWRITTEN_RANGE'
    | 'SCRATCH_QUERY_RESOLVE_DESTINATION_INVALID'

type ReadbackDiagnosticCode =
    | 'SCRATCH_READBACK_STALE_PENDING'
    | 'SCRATCH_READBACK_READY_UNCONSUMED'
    | 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED'
    | 'SCRATCH_READBACK_CANCELLED'
    | 'SCRATCH_READBACK_SOURCE_DISPOSED_BEFORE_COPY'
    | 'SCRATCH_READBACK_RUNTIME_DISPOSED'
    | 'SCRATCH_READBACK_LEASE_NOT_RELEASED'
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

## Non-Goals

- Do not make prose error messages the stable API.
- Do not require agents or tests to parse `message` or `hint`.
- Do not make shader reflection authoritative through diagnostics.
- Do not use diagnostics to auto-repair hidden state.
- Do not create unrelated diagnostic shapes for readback, query, shader, and submission errors.
- Do not treat `warn` mode as permission to continue after state corruption or device loss when the runtime cannot proceed safely.
