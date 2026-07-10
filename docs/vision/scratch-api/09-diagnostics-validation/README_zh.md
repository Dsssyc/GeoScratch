# Diagnostics 与 Validation

状态: Vision draft
日期: 2026-07-06

## 决策

Diagnostics 是 scratch API contract 的一部分。它不是日志，也不是纯 prose exception。

intelligent-friendly contract 是:

```text
diagnostics should make repair local and mechanical;
repairs must remain explicit user or tooling actions.
```

每个 validation surface 都应产出 machine-readable diagnostics: 稳定 code、结构化 subject、必要时结构化 expected/actual payload，以及可选的人类可读 hint。错误消息可以持续改善，但工具和 AI agent 不应需要解析 prose 才能识别失败原因。

## Diagnostic Envelope

所有 diagnostic family 都应放进同一个 envelope:

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

稳定的机器契约:

- `version`
- `code`
- `severity`
- `phase`
- `subject.kind`
- `subject` 标识字段
- 某个 code 一旦文档化后的 `expected` / `actual` shape
- 如果产出 suggestions，则 `suggestions.kind`

人类可读、不是稳定解析目标:

- `message`
- `hint`

Diagnostics 可以被 throw、作为 report 返回、挂在 `SubmittedWork` 上、挂在 `ReadbackOperation` 上，或送进 runtime diagnostic sink。形状保持一致。

## Subjects 与 Related Objects

diagnostic 必须定位到最小有用 subject。上下文放进 `related`，不要藏在 prose 里。

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
```

示例:

- bind-layout mismatch: subject 是 `BindLayoutEntry`; related 包含 `Program` 与 `ShaderBinding`。
- read-before-write: subject 是读取的 `Command`; related 包含 resource 和最后已知 writer。
- readback budget exceeded: subject 是 `ReadbackOperation`; related 包含 runtime budget policy 与 source resource。

## Diagnostic Reports

批量 validation 应返回 report object，而不是裸数组:

```ts
type ScratchDiagnosticReport = {
    version: 1
    diagnostics: ScratchDiagnostic[]
    hasErrors: boolean
    errorCount: number
    warningCount: number
}
```

候选 report source:

- `runtime.validate()`
- `layoutCodec.report`
- `program.diagnostics`
- `scratch.inspectShader(shader).compareBindLayouts(...)`
- `submission.validate()`
- `submitted.diagnostics`
- `readback.diagnostics`

同一个 inspected state 应产出确定性的 report。如果 diagnostics 受 validation mode 影响，diagnostic `code` 与结构化 payload 仍保持稳定; 变化的是 action。

## Validation Modes 与 Actions

Validation mode 控制处置方式，不控制 diagnostic identity。

```ts
type ValidationMode = 'off' | 'warn' | 'throw'
```

- `throw`: error diagnostics 抛出结构化 `ScratchDiagnosticError`。
- `warn`: diagnostics 送到 diagnostic sink，并挂在相关 report/work object 上。
- `off`: 可选 validation 可以跳过，但 runtime 无法正确继续时，必要的平台 safety checks 仍必须运行。

`severity` 是 finding 的严重性。mode 决定这个严重性是 throw、warn 还是跳过。不要把 mode 编进 diagnostic code。

```ts
type ScratchDiagnosticError = Error & {
    diagnostic: ScratchDiagnostic
    report?: ScratchDiagnosticReport
}
```

## Phase Sources

### Runtime

Runtime diagnostics 覆盖 device、adapter、feature、limit、ownership、lifecycle 与 device-loss 问题。

候选 codes:

```ts
type RuntimeDiagnosticCode =
    | 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE'
    | 'SCRATCH_RUNTIME_FEATURE_UNAVAILABLE'
    | 'SCRATCH_RUNTIME_LIMIT_UNSATISFIED'
    | 'SCRATCH_RUNTIME_DISPOSED'
    | 'SCRATCH_RUNTIME_DEVICE_LOST'
```

### Resource

Resource diagnostics 覆盖 ownership、readiness、lifetime、usage、allocation version 与 content epoch state。

候选 codes:

```ts
type ResourceDiagnosticCode =
    | 'SCRATCH_RESOURCE_WRONG_RUNTIME'
    | 'SCRATCH_RESOURCE_DISPOSED'
    | 'SCRATCH_RESOURCE_LOST'
    | 'SCRATCH_RESOURCE_NOT_READY'
    | 'SCRATCH_RESOURCE_USAGE_MISSING'
    | 'SCRATCH_RESOURCE_ALLOCATION_VERSION_STALE'
    | 'SCRATCH_RESOURCE_CONTENT_EPOCH_UNAVAILABLE'
```

### Layout Codec

Layout codec diagnostics 覆盖 layout lowering、CPU writer、upload byte range、readback view 与 WGSL accessor compatibility。

候选 codes:

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

Program diagnostics 覆盖 WGSL modules、generated accessors、entry points、required features、reflection cross-check 与 shader/layout contracts。

候选 codes:

```ts
type ProgramDiagnosticCode =
    | 'SCRATCH_PROGRAM_ENTRY_POINT_MISSING'
    | 'SCRATCH_PROGRAM_STAGE_MISMATCH'
    | 'SCRATCH_PROGRAM_FEATURE_UNAVAILABLE'
    | 'SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH'
    | 'SCRATCH_PROGRAM_SHADER_PARSE_UNAVAILABLE'
    | 'SCRATCH_PROGRAM_SHADER_REFLECTION_INCONCLUSIVE'
```

Reflection 仍然是 guard，不是 source of truth。一个无法理解新版 WGSL 的 reflection parser 通常应产出 warn-level inconclusive diagnostic，而不是阻断合法的显式 layout。

### Binding

Binding diagnostics 覆盖显式 `BindLayout`、`BindSet`、shader cross-check、resource compatibility 与 dynamic offsets。

候选 codes:

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

示例:

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

Pipeline diagnostics 覆盖静态 render/compute state，以及与 programs、pass specs、vertex layouts、targets、features、limits 的兼容性。

候选 codes:

```ts
type PipelineDiagnosticCode =
    | 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH'
    | 'SCRATCH_PIPELINE_DEPTH_STENCIL_MISMATCH'
    | 'SCRATCH_PIPELINE_VERTEX_LAYOUT_MISMATCH'
    | 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE'
    | 'SCRATCH_PIPELINE_COMPUTE_LIMIT_UNSATISFIED'
```

### Command

Command diagnostics 覆盖 executable state、counts、readiness policy、declared resource access 与 pass compatibility。

候选 codes:

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
```

预期的 Draw/Dispatch `skip-command`、`skip-pass` 与成功 `use-fallback` 决策不是 diagnostics，而是不可变的 `SubmittedWork.executionOutcomes`。`SCRATCH_COMMAND_FALLBACK_INVALID` 只用于 missing/forbidden fallback shape、伪造的非 command 节点、kind/runtime/lifecycle/write-set 不兼容，以及重复 object 或 command ID。最终选中的 fallback 无法进入当前 pass 时使用 `SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE`。

Fallback readiness 或 dependency failure 以最终选中的 fallback 作为 `subject`。`related` 包含 requested command、attempted chain、pass、resource 与 submission。结构化 `actual` facts 包含 step/pass IDs、requested command ID、attempted command IDs、携带每个可用 missing-resource state/epoch fact 的完整 `attempts` 数组、当前 command/resource state 与 epochs，以及 validation mode。

### Submission

Submission diagnostics 覆盖 explicit order validation、resource dependency validation、pass-command compatibility、borrowed surface texture lifetime 与 submitted-work state。

候选 codes:

```ts
type SubmissionDiagnosticCode =
    | 'SCRATCH_SUBMISSION_READ_BEFORE_WRITE'
    | 'SCRATCH_SUBMISSION_WRITE_AFTER_READ_UNDECLARED'
    | 'SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE'
    | 'SCRATCH_SUBMISSION_SURFACE_VIEW_OUT_OF_SCOPE'
    | 'SCRATCH_SUBMISSION_WORK_ALREADY_SUBMITTED'
```

`skipped-empty` 是 execution outcome，不是 diagnostic code。Validation mode 只控制 optional dependency findings; 它不会关闭 readiness resolution，也不会删除 execution-outcome facts。

### Query 与 Readback

Query 与 readback diagnostics 使用同一个 envelope。`07-transfers-epochs` 中已有 query/readback codes 仍是有效候选 codes; 本模块定义共享外层形状。

示例:

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

## Code Naming 与 Stability

Diagnostic code 应采用:

```text
SCRATCH_<DOMAIN>_<CONDITION>
```

规则:

- 使用 `UPPER_SNAKE_CASE`。
- Domain name 尽量与 phase 对齐: `RESOURCE`、`LAYOUT`、`CODEC`、`PROGRAM`、`BIND`、`PIPELINE`、`COMMAND`、`SUBMISSION`、`QUERY`、`READBACK`。
- 不把动态值放进 code。动态信息放进 `subject`、`expected` 与 `actual`。
- 不因为 `message` 或 `hint` 改写就改变 code。
- 不把 severity 或 validation mode 编进 code。
- 优先添加新的 optional field，而不是改变既有字段含义。
- `0.x.x` 阶段允许 code 变化，但必须同步 vision docs 或后续 ADR。进入 `1.x.x` 后，diagnostic codes 成为公开兼容面，除非显式 versioning。

## Expected 与 Actual Payloads

常见错误应提供结构化 `expected` 与 `actual`:

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

不要把 `expected` / `actual` 用于大对象或 opaque GPU handles。这些应通过 `subject`、`related` 或 compact summaries 引用。

## Repair Suggestions

Suggestions 是可选建议。它们应帮助 tooling 产生局部编辑，但 scratch 不能静默应用它们。

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

准则:

- Suggestions 必须局部。优先给出"编辑这个 bind entry"，而不是"重写 pipeline"。
- Suggestions 不能隐藏歧义。如果存在两个合法修法，给出两个不同 confidence 的 suggestions。
- Suggestions 是 repair hints，不是自动行为。
- Runtime 不能仅因为存在 suggestion 就重排 submission、推断 bind layout、改变 resource usage 或 mutation shader code。

示例:

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

## 非目标

- 不把 prose error message 做成稳定 API。
- 不要求 agent 或 test 解析 `message` 或 `hint`。
- 不通过 diagnostics 让 shader reflection 变成权威。
- 不用 diagnostics 自动修复隐藏状态。
- 不为 readback、query、shader 和 submission errors 创建互不相干的 diagnostic shapes。
- 当 runtime 无法安全继续时，不把 `warn` mode 当作忽略 state corruption 或 device loss 的许可。
