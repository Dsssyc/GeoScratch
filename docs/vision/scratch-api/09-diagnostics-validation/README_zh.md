# Diagnostics 与 Validation

状态: Vision draft
日期: 2026-07-23

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

内部 `ScratchDiagnosticError` classification 使用 module-private `WeakSet` closed
brand，而不是 public `instanceof`。替换 `Symbol.hasInstance`，或通过
`Object.create(ScratchDiagnosticError.prototype)` 构造对象，都不能让任意 error 进入
diagnostic-only recovery、attribution 或 report-preservation path。

## Subjects 与 Related Objects

diagnostic 必须定位到最小有用 subject。上下文放进 `related`，不要藏在 prose 里。

```ts
type DiagnosticSubject =
    | { kind: 'ScratchRuntime', id: string, label?: string }
    | { kind: 'Surface', id: string, label?: string }
    | { kind: 'Resource', id: string, label?: string, resourceKind?: string }
    | {
        kind: 'LayoutArtifact',
        abiHash?: string,
        schemaHash?: string,
        hash?: 'unresolved',
        label?: string,
      }
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

示例:

- bind-layout mismatch: subject 是 `BindLayoutEntry`; related 包含 `Program` 与 `ShaderBinding`。
- read-before-write: subject 是读取的 `Command`; related 包含 resource 和最后已知 writer。
- readback pending-operation budget exceeded: subject 是受影响的 `ReadbackOperation`；staging-allocation budget failure 保留精确的 GPU operation 与 command/readback target。两者都以结构化字段标识 runtime policy 与 source provenance。

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

## Runtime GPU Operation Evidence

Native GPU error 可能在 issue operation 的 JavaScript 调用之后才 settle。因此 Scratch 区分四种 retention model:

- 始终开启的 **Runtime Fact Graph** 只包含当前 live resource、已安装 allocation、被覆盖的 pending operation、pending replacement，以及 Scratch-owned logical footprint 的 current/peak 值。它随当前状态增长，而不随 runtime 年龄增长。
- 默认 **Incident Flight Recorder** 在有限 serialized-evidence budget 下，将紧凑 allocation、replacement、disposal 与 incident record 保存在有限 ring 中。它不保存成功 operation stack、mutable handle、resource content、shader source、command payload 或 `SubmittedWork` 对象。
- **Incident Report** 是 deeply frozen JSON causal slice，包含已知的 trigger operation、subjects、native category 与 serializable facts、有界近期 operation、logical pressure evidence、evidence completeness 和 attribution confidence。
- **Deep Capture Session** 是显式、有限、临时的。它可以增加 call-site stack 与 normalized descriptor，但会在 operation、duration 或 retained-evidence 的首个边界处自动停止。停止后会冻结 report，并解除 controller 与工作存储的引用。它不是 thenable，也不等待 queue work。

只读 `runtime.diagnostics` facade 暴露 `snapshot()`、`operations(query?)`、`incidents(query?)`、`operation(id)`、`incident(id)`、`capture(options)` 与 `exportEvidence()`。query 覆盖 ID、kind、resource、status 与 sequence facts。`exportEvidence()` 冻结同一份 serializable snapshot 以及当前 retained 的有界 operation 和 incident arrays。导出 evidence 永远不包含 live device、resource、buffer、texture、command、pass、submission 或 mutable runtime collection。

默认 retention 为 256 条 operation record、32 条 incident 和 256 KiB serialized evidence；它们全部有限且可配置。将 operation capacity 设为 0 可以关闭 successful-operation history，但不会关闭 current facts 或 failure handling。当前 runtime/resource label、紧凑 native-label evidence、incident evidence，以及任意嵌套深度的 capture descriptor label 都有界；native `GPUBuffer`/`GPUTexture` descriptor 仍保留完整 user label 与稳定 Scratch-ID suffix。retained-byte counter 衡量 deterministic JSON evidence，不是 JavaScript heap size。

被覆盖的 initial buffer/texture allocation 与 texture replacement 使用精确 synchronous issue boundary: push OOM、push validation、只 issue 一次 native allocation、pop validation、pop OOM，之后才 await 两个 pop promise。await 后会在 logical construction 或 replacement commit 前立即重新检查 runtime/device/resource lifecycle。matching scope 提供 `exact-operation` attribution。除非存在更强 native evidence，uncaptured error 与 device loss 只能是 `temporal-correlation` 或 `unknown`。Scratch 绝不通过解析 native message prose 派生稳定字段。

OOM evidence 将精确 `triggerOperation`、有界 `pressureContributors` 与近期 create/replace/dispose churn 分开。Descriptor byte size 与按 texture format/block/mip/layer/sample 计算的大小是 logical footprint，不是 physical residency、free VRAM、driver padding、compression、eviction state 或 process/system total memory。texture array layer 在各 mip 保持不变；3D depth 按 mip 缩小。非 Scratch allocation 始终未知。

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
    cause?: unknown
}
```

## Phase Sources

### Runtime

Runtime diagnostics 覆盖 device、adapter、feature、limit、ownership、lifecycle 与 device-loss 问题。

候选 codes:

```ts
type RuntimeDiagnosticCode =
    | 'SCRATCH_RUNTIME_CONSTRUCTOR_PRIVATE'
    | 'SCRATCH_RUNTIME_DEVICE_UNAVAILABLE'
    | 'SCRATCH_RUNTIME_FEATURE_UNAVAILABLE'
    | 'SCRATCH_RUNTIME_DISPOSED'
    | 'SCRATCH_RUNTIME_DEVICE_LOST'
    | 'SCRATCH_RUNTIME_LIFECYCLE_CHANGED'
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

Resource diagnostics 覆盖 ownership、readiness、lifetime、usage、allocation version 与 content epoch state。

候选 codes:

```ts
type ResourceDiagnosticCode =
    | 'SCRATCH_RESOURCE_WRONG_RUNTIME'
    | 'SCRATCH_RESOURCE_DISPOSED'
    | 'SCRATCH_RESOURCE_USAGE_MISSING'
    | 'SCRATCH_RESOURCE_DESCRIPTOR_INVALID'
    | 'SCRATCH_BUFFER_ALLOCATION_VALIDATION_FAILED'
    | 'SCRATCH_BUFFER_ALLOCATION_OUT_OF_MEMORY'
    | 'SCRATCH_BUFFER_ALLOCATION_NATIVE_FAILED'
    | 'SCRATCH_BUFFER_MAPPING_USE_EXPLICIT_FACTORY'
    | 'SCRATCH_BUFFER_MAPPING_DESCRIPTOR_INVALID'
    | 'SCRATCH_BUFFER_MAPPING_REGION_INVALID'
    | 'SCRATCH_BUFFER_MAPPING_RUNTIME_MISMATCH'
    | 'SCRATCH_BUFFER_MAPPING_MODE_INVALID'
    | 'SCRATCH_BUFFER_MAPPING_RANGE_INVALID'
    | 'SCRATCH_BUFFER_MAPPING_SIGNAL_INVALID'
    | 'SCRATCH_BUFFER_MAPPING_USAGE_INVALID'
    | 'SCRATCH_BUFFER_MAPPING_CONFLICT'
    | 'SCRATCH_BUFFER_MAPPING_GPU_USE_CONFLICT'
    | 'SCRATCH_BUFFER_MAPPING_LEASE_INACTIVE'
    | 'SCRATCH_BUFFER_MAPPING_ABORTED'
    | 'SCRATCH_BUFFER_MAPPING_DEVICE_LOST'
    | 'SCRATCH_BUFFER_MAPPING_RUNTIME_DISPOSED'
    | 'SCRATCH_BUFFER_MAPPING_RESOURCE_DISPOSED'
    | 'SCRATCH_BUFFER_MAPPING_VALIDATION_FAILED'
    | 'SCRATCH_BUFFER_MAPPING_INTERNAL_FAILED'
    | 'SCRATCH_BUFFER_MAPPING_OUT_OF_MEMORY'
    | 'SCRATCH_BUFFER_MAPPING_SCOPE_FAILED'
    | 'SCRATCH_BUFFER_MAPPING_NATIVE_FAILED'
    | 'SCRATCH_BUFFER_MAPPING_REJECTED'
    | 'SCRATCH_BUFFER_MAPPING_MAPPED_RANGE_FAILED'
    | 'SCRATCH_BUFFER_MAPPING_RELEASE_FAILED'
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

`TextureResource.resize()` 对 native issue 前检测出的确定性 size grammar、integer-domain、limit、mip、sample、transient-attachment、format-block、lifecycle 与 native-capability failure 使用 `SCRATCH_RESOURCE_DESCRIPTOR_INVALID`。Native validation、OOM、同步 exception 与 scope failure 使用各自 operation-specific code 并链接 immutable incident；`ScratchDiagnosticError.cause` 可以保留原始 native error。

Promise 只有在 validation 与 OOM scope 确认 candidate 后才 resolve。commit 前的 failure 会保持旧 texture、descriptor、views、`allocationVersion`、`contentEpoch` 与 readiness state 不变。

### Layout Codec

Layout codec diagnostics 覆盖 layout lowering、CPU writer、upload byte range、readback view 与 WGSL accessor compatibility。

不安全的 array-size multiplication、field-end addition 或 alignment rounding 使用
`SCRATCH_LAYOUT_UNSUPPORTED_FORMAT`；`actual.reason` 与 `actual.operation` 标识失败的
arithmetic step。`actual.safeIntegerMax` 与 `actual.wgslU32Max` 区分 JavaScript 和
generated-WGSL numeric bound；不会发布 `LayoutArtifact`。Recursive type、
member attribute、runtime tail、runtime extent、usage 与 buffer-view failure
保留可用的最小 `LayoutField` path。已注册 artifact subject 同时携带 `abiHash`
与 `schemaHash`；尚未解析的 descriptor 只使用有界的
`hash: 'unresolved'` sentinel。

候选 codes:

```ts
type LayoutCodecDiagnosticCode =
    | 'SCRATCH_LAYOUT_UNSUPPORTED_FORMAT'
    | 'SCRATCH_LAYOUT_TYPE_UNSUPPORTED'
    | 'SCRATCH_LAYOUT_MEMBER_ATTRIBUTE_INVALID'
    | 'SCRATCH_LAYOUT_RUNTIME_ARRAY_INVALID'
    | 'SCRATCH_LAYOUT_RUNTIME_EXTENT_INVALID'
    | 'SCRATCH_LAYOUT_USAGE_INCOMPATIBLE'
    | 'SCRATCH_LAYOUT_BUFFER_VIEW_INVALID'
    | 'SCRATCH_LAYOUT_ABI_MISMATCH'
    | 'SCRATCH_CODEC_BYTE_LENGTH_MISMATCH'
    | 'SCRATCH_CODEC_SCHEMA_MISMATCH'
    | 'SCRATCH_CODEC_READBACK_VIEW_UNSAFE'
```

### Program

ShaderModule diagnostics 覆盖 source composition、原生 acknowledgement、
compilation information 与 module lifecycle。Program diagnostics 覆盖不可变
stage、entry point、required capability、reflection cross-check 与 shader/layout
contract。

候选 codes:

```ts
type ProgramDiagnosticCode =
    | 'SCRATCH_PROGRAM_DESCRIPTOR_INVALID'
    | 'SCRATCH_PROGRAM_ENTRY_POINT_INVALID'
    | 'SCRATCH_PROGRAM_FEATURE_UNAVAILABLE'
    | 'SCRATCH_PROGRAM_LANGUAGE_FEATURE_UNAVAILABLE'
    | 'SCRATCH_PROGRAM_LIMIT_UNAVAILABLE'
    | 'SCRATCH_PROGRAM_ACCESSOR_LAYOUT_MISMATCH'
    | 'SCRATCH_PROGRAM_STAGE_INVALID'
    | 'SCRATCH_PROGRAM_STAGE_MISSING'
    | 'SCRATCH_PROGRAM_WRONG_RUNTIME'
    | 'SCRATCH_PROGRAM_DISPOSED'
    | 'SCRATCH_PROGRAM_LIFECYCLE_CHANGED'
    | 'SCRATCH_PROGRAM_SHADER_REFLECTION_INCONCLUSIVE'
    | 'SCRATCH_SHADER_INSPECTION_INPUT_INVALID'
    | 'SCRATCH_SHADER_MODULE_COMPILATION_FAILED'
    | 'SCRATCH_SHADER_MODULE_COMPILATION_INFO_FAILED'
    | 'SCRATCH_SHADER_MODULE_CONSTRUCTOR_PRIVATE'
    | 'SCRATCH_SHADER_MODULE_CREATION_INTERNAL_FAILED'
    | 'SCRATCH_SHADER_MODULE_CREATION_NATIVE_FAILED'
    | 'SCRATCH_SHADER_MODULE_CREATION_OUT_OF_MEMORY'
    | 'SCRATCH_SHADER_MODULE_CREATION_VALIDATION_FAILED'
    | 'SCRATCH_SHADER_MODULE_DESCRIPTOR_INVALID'
    | 'SCRATCH_SHADER_MODULE_DISPOSED'
    | 'SCRATCH_SHADER_MODULE_WRONG_RUNTIME'
```

Reflection 仍然是 guard，不是 source of truth。一个无法理解新版 WGSL 的 reflection parser 通常应产出 warn-level inconclusive diagnostic，而不是阻断合法的显式 layout。

### Binding

Binding diagnostics 覆盖显式 `BindLayout`、`BindSet`、shader cross-check、resource compatibility 与 dynamic offsets。

候选 codes:

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
    | 'SCRATCH_PIPELINE_CONSTRUCTOR_PRIVATE'
    | 'SCRATCH_PIPELINE_CREATION_BIND_LAYOUT_DISPOSED'
    | 'SCRATCH_PIPELINE_CREATION_DEVICE_LOST'
    | 'SCRATCH_PIPELINE_CREATION_MULTIPLE_FAILURES'
    | 'SCRATCH_PIPELINE_CREATION_PROGRAM_DISPOSED'
    | 'SCRATCH_PIPELINE_CREATION_PROGRAM_LIFECYCLE_CHANGED'
    | 'SCRATCH_PIPELINE_CREATION_RUNTIME_DISPOSED'
    | 'SCRATCH_PIPELINE_CREATION_RUNTIME_LIFECYCLE_CHANGED'
    | 'SCRATCH_PIPELINE_CREATION_SHADER_MODULE_DISPOSED'
    | 'SCRATCH_PIPELINE_COMPUTE_STAGE_MISSING'
    | 'SCRATCH_PIPELINE_DISPOSED'
    | 'SCRATCH_PIPELINE_CONSTANTS_INVALID'
    | 'SCRATCH_PIPELINE_FRAGMENT_FIELDS_FORBIDDEN'
    | 'SCRATCH_PIPELINE_IMMEDIATE_SIZE_INVALID'
    | 'SCRATCH_PIPELINE_LAYOUT_DERIVATION_DESCRIPTOR_MISMATCH'
    | 'SCRATCH_PIPELINE_LAYOUT_DERIVATION_FORBIDDEN'
    | 'SCRATCH_PIPELINE_LAYOUT_MODE_INVALID'
    | 'SCRATCH_PIPELINE_PROGRAM_INVALID'
    | 'SCRATCH_PIPELINE_WRONG_RUNTIME'
    | 'SCRATCH_PIPELINE_TARGETS_INVALID'
    | 'SCRATCH_PIPELINE_TARGET_STATE_INVALID'
    | 'SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH'
    | 'SCRATCH_PIPELINE_DEPTH_STENCIL_MISMATCH'
    | 'SCRATCH_PIPELINE_SAMPLE_COUNT_MISMATCH'
    | 'SCRATCH_PIPELINE_VERTEX_LAYOUT_MISMATCH'
    | 'SCRATCH_PIPELINE_VERTEX_STAGE_MISSING'
    | 'SCRATCH_PIPELINE_BIND_LAYOUT_INCOMPATIBLE'
```

`SCRATCH_PIPELINE_SAMPLE_COUNT_MISMATCH` 用于在 encoder 创建前识别 attachment
sample count 不一致的 render pipeline/pass layout。

### Command

Command diagnostics 覆盖 executable state、counts、readiness policy、declared resource access 与 pass compatibility。

候选 codes:

```ts
type CommandDiagnosticCode =
    | 'SCRATCH_COMMAND_COPY_RANGE_INVALID'
    | 'SCRATCH_COMMAND_COPY_SOURCE_INVALID'
    | 'SCRATCH_COMMAND_DISPOSED'
    | 'SCRATCH_COMMAND_PASS_KIND_MISMATCH'
    | 'SCRATCH_COMMAND_COUNT_INVALID'
    | 'SCRATCH_COMMAND_CLEAR_BUFFER_INVALID'
    | 'SCRATCH_COMMAND_VERTEX_BUFFER_INVALID'
    | 'SCRATCH_COMMAND_INDEX_BUFFER_INVALID'
    | 'SCRATCH_COMMAND_INDIRECT_BUFFER_INVALID'
    | 'SCRATCH_COMMAND_IMMEDIATE_DATA_INVALID'
    | 'SCRATCH_COMMAND_READINESS_POLICY_MISSING'
    | 'SCRATCH_COMMAND_FALLBACK_INVALID'
    | 'SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE'
    | 'SCRATCH_COMMAND_RESOURCE_NOT_READY'
    | 'SCRATCH_COMMAND_RENDER_STATE_INVALID'
    | 'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID'
    | 'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_FAILED'
    | 'SCRATCH_COMMAND_TEXTURE_UPLOAD_INVALID'
    | 'SCRATCH_COMMAND_UPLOAD_RANGE_INVALID'
    | 'SCRATCH_COMMAND_WRONG_RUNTIME'

type PassDiagnosticCode =
    | 'SCRATCH_PASS_COLOR_ATTACHMENT_INVALID'
    | 'SCRATCH_PASS_DEPTH_STENCIL_ATTACHMENT_INVALID'
    | 'SCRATCH_PASS_DISPOSED'
    | 'SCRATCH_PASS_MAX_DRAW_COUNT_INVALID'
    | 'SCRATCH_PASS_RESOLVE_ATTACHMENT_INVALID'
    | 'SCRATCH_PASS_WRONG_RUNTIME'
```

Render-stage override constants 与 nullable pipeline slots 仍是 pipeline
construction facts。非法 constants 使用 `SCRATCH_PIPELINE_CONSTANTS_INVALID`；
hole、`undefined` 或非法 non-null target state 使用
`SCRATCH_PIPELINE_TARGET_STATE_INVALID`。Pipeline/pass null-slot 不兼容继续使用
`SCRATCH_PIPELINE_TARGET_FORMAT_MISMATCH`。

Pass validation 会区分非法 non-null color source
（`SCRATCH_PASS_COLOR_ATTACHMENT_INVALID`）、resolve 不兼容
（`SCRATCH_PASS_RESOLVE_ATTACHMENT_INVALID`）与非法 draw-count hint
（`SCRATCH_PASS_MAX_DRAW_COUNT_INVALID`）。结构化 facts 会按需标识 attachment
slot、source/target resources 与 views、formats、sample counts、extents、usages、
read-only aspects 和 authored value。

`SCRATCH_COMMAND_RENDER_STATE_INVALID` 同时覆盖非法不可变 authored value，以及
相对当前 pass extent 变为非法的 full-attachment viewport/scissor。其 facts 会区分
authored state 与 submission-time resolved state。
`SCRATCH_COMMAND_CLEAR_BUFFER_INVALID` 覆盖确定性的 target lifecycle、usage、
alignment 与 current-allocation range failure。同步 native encoder exception 或延后
native validation/internal/OOM/device-loss outcome 使用既有 submission-native
diagnostic path；它不会被改写为 prose，也不会被错误归类为确定性 clear validation。

预期的 Draw/Dispatch `skip-command`、`skip-pass` 与成功 `use-fallback` 决策不是 diagnostics，而是不可变的 `SubmittedWork.executionOutcomes`。`SCRATCH_COMMAND_FALLBACK_INVALID` 只用于 missing/forbidden fallback shape、伪造的非 command 节点、kind/runtime/lifecycle/write-set 不兼容，以及重复 object 或 command ID。最终选中的 fallback 无法进入当前 pass 时使用 `SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE`。

对 Draw/Dispatch `contentEpoch`，`SCRATCH_COMMAND_DECLARED_ACCESS_INCOMPLETE` 只接受非负整数或精确 sentinel `'current-at-step'`。结构化 `expected` 与 `actual` 会区分非法 alias/callback/object 和被接受的封闭 union。不存在 prose-only fallback 或 coercion。

Fallback readiness 或 dependency failure 以最终选中的 fallback 作为 `subject`。`related` 包含 requested command、attempted chain、pass、resources 与 submission。结构化 `actual` facts 包含 step/pass IDs、requested command ID、attempted command IDs、携带每个可用 missing-resource state/epoch fact 的完整 `attempts` 数组、当前 command/resource state 与 epochs，以及 validation mode。构造后变为不可用的 selected fallback dependency 使用 `SCRATCH_COMMAND_FALLBACK_INVALID`，并在 `actual.cause` 中保留底层 lifecycle diagnostic。针对 selected fallback 生成的 render attachment resource-conflict diagnostic 也保留相同的 requested/attempted provenance。

当 readiness 或 indeterminate-content diagnostic 涉及 `'current-at-step'` declaration 时，`requiredContentEpoch` 保留 authored sentinel，simulated/current numeric epoch 仍是独立字段。成功的 `SubmittedWork.resourceAccesses` 同样把 `declaredContentEpoch` 与 numeric `contentEpochBefore`/`contentEpochAfter` 分开保存。这样 authored intent 与 resolved history 都保持 machine-readable，而无需改写 command state。

`ExternalImageUploadCommand` diagnostic 在结构化 command facts 中使用 `commandKind: 'upload'` 与 `uploadKind: 'external-image'`。`SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID` 覆盖确定性的 descriptor、platform brand、live source-range、target、lifecycle 与 queue-capability failure。context-specific canvas dimensions 没有无副作用的 JavaScript query，因此原生权威 range check 同步抛出的 `OperationError` 也使用这个 invalid code。它的 `expected` 和 `actual` 字段携带 machine-readable validation facts，不要求解析 message。

三种 immediate upload variant 都会在任何原生 queue call 或 content-epoch effect 前，
以 `SCRATCH_COMMAND_WRONG_RUNTIME` 和 `actual.queueOwnedByRuntime: false` 拒绝 foreign
`GPUQueue`。

`SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_FAILED` 专用于 `GPUQueue.copyExternalImageToTexture()` 同步抛出的其他 exception。diagnostic 的 `actual.nativeError` 只包含可序列化 exception facts，而 `ScratchDiagnosticError.cause` 保留原始 thrown value，供程序化检查。失败的原生调用不提交 target epoch、readiness transition、access entry 或 producer fact。

### Submission

Submission diagnostics 覆盖 explicit order validation、resource dependency validation、pass-command compatibility、borrowed surface texture lifetime 与 submitted-work state。

候选 codes:

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

`skipped-empty` 是 execution outcome，不是 diagnostic code。Validation mode 只控制 optional dependency findings; 它不会关闭 readiness resolution，也不会删除 execution-outcome facts。

Indeterminate content 是 required safety validation，不是 optional readiness
finding。Resource、query-slot 与 persistent attachment read 在任意 validation
mode 下都会于 native effect 前分别使用
`SCRATCH_COMMAND_RESOURCE_CONTENT_INDETERMINATE`、
`SCRATCH_QUERY_SLOT_CONTENT_INDETERMINATE` 与
`SCRATCH_PASS_ATTACHMENT_CONTENT_INDETERMINATE`。

### Query 与 Readback

Query 与 readback diagnostics 使用同一个 envelope。`07-transfers-epochs` 中当前 query/readback codes 使用本模块定义的共享外层形状。

示例:

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
    | 'SCRATCH_READBACK_LAYOUT_INVALID'
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
    | 'SCRATCH_READBACK_MAPPED_LEASE_INACTIVE'
    | 'SCRATCH_READBACK_MAPPED_RANGE_FAILED'
    | 'SCRATCH_READBACK_HOST_COPY_FAILED'
    | 'SCRATCH_READBACK_CLEANUP_FAILED'
    | 'SCRATCH_READBACK_UNMAP_FAILED'
    | 'SCRATCH_READBACK_STAGING_DESTROY_FAILED'
    | 'SCRATCH_READBACK_IN_PROGRESS'
    | 'SCRATCH_READBACK_CANCELLED'
    | 'SCRATCH_READBACK_OPERATION_DISPOSED'
    | 'SCRATCH_READBACK_TEXTURE_SOURCE_INVALID'
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

## GPU Operation、Pipeline 与 Readback Evidence

GPU operation、incident、snapshot、capture 与 exported-evidence schema 使用
version 5。`0.x.x` 期间不输出或转换 version 2 到 version 4。operation 与 pending fact
显式选择一种宏观 target:

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
    | { kind: 'shader-module'; shaderModuleId: string; sourceHash: string; sourcePartCount: number; compilationHintCount: number }
    | { kind: 'pipeline'; pipelineId: string; pipelineKind: 'render' | 'compute'; programId: string; programContractHash: string }
    | { kind: 'command'; commandId: string; commandKind: 'readback' }
    | {
        kind: 'readback'
        readbackId: string
        path: 'direct' | 'ordered'
        sourceKind?: 'buffer' | 'texture'
        sourceResourceId: string
        allocationVersion: number
        contentEpoch: number
        byteLength: number
        stagingByteLength?: number
        textureSubresource?: {
            format: GPUTextureFormat
            mipLevel: number
            origin: { x: number; y: number; z: number }
            size: { width: number; height: number; depthOrArrayLayers: number }
            aspect: GPUTextureAspect
        }
        commandId?: string
        submissionId?: string
        stepIndex?: number
    }
    | { kind: 'submission'; submissionId: string }
```

Schema v5 新增 `sampler-allocation`、`query-set-allocation`、
`bind-layout-allocation`、`bind-set-preparation` 与
`shader-module-creation`。Sampler target 绝不获得
content/readiness/footprint field。QuerySet target 报告有界 indexed slot fact，
没有 scalar epoch。BindLayout 报告 ABI shape 与 acknowledgement；BindSet 报告
preparation state、generation、snapshot 与 stage，不伪装成 Resource。
BufferRegion 与 TextureViewSpec 只作为 subject 或 related evidence，绝不重复计算
resource pressure。

Query 通过 `targetKind` 加上对应 discriminator 的 identifier 选择，而不是猜
optional field。Resource allocation incident 保留 ADR-032 的 pressure 与
attribution 语义。Pipeline 与 supporting-object incident 只包含真实的
creation/preparation evidence，不获得虚构 allocation pressure。Readback target
不伪装成 persistent resource。

BindSet preparation evidence 区分 descriptor validation、native issue、
synchronous native throw、per-view acknowledgement、bind-group acknowledgement、
lifecycle recheck、snapshot recheck、commit、cancellation 与 explicit retry。
成功的 steady-state BindSet use 不创建 preparation operation，也不会把完整 binding
snapshot 复制进每条 submission record。Supporting object 与 native view 不获得
虚构 byte footprint；OOM incident 可以包含有界 current Buffer/Texture pressure
context，但不能声称 candidate 单独导致 aggregate exhaustion。

Readback target 会区分 buffer 与 texture source，但不保留 native handle 或
bytes。Texture target 只保留有界 format、aspect、mip、origin、extent、
logical-byte 与 padded-staging-byte facts。

Supporting-object factory 会先 settle candidate 周围已经 issue 的全部 scope，再
选择 causal primary。固定优先级是同步 native exception、结构性 scope failure、
validation、internal、OOM、runtime disposal、device loss。Lifecycle notification
不能 short-circuit scope settlement，也不能抹除更早的 fact；如果其他 failure
是 primary，lifecycle recheck 会作为 secondary incident evidence 保留。Settlement
timing 与 native prose 都不能改变该顺序。若 device loss 是 primary，runtime-wide
`device-loss` incident 与关联到 `cancelled` operation 的 `exact-operation`
`supporting-object-failure` incident 仍彼此独立。被 reject 的 Promise 暴露操作级
incident，ledger 则保留这两份有界 report。

Submission issue provenance 使用 `submission-native-observation` operation 与
`submission-failure` incident。其 version 5 outcome 记录 summary、detailed 或
off mode、一个稳定 status、有界 discriminated locations、固定顺序的 native
outcome facts，以及显式 omission counts。Native stage 区分 encoder creation、
pass begin/end、command encoding、encoder finish、queue action/submit、scope
settlement、queue completion 与 lifecycle recheck。

默认 `submissionScopes: 'summary'` 为完整 submission family 使用一个常数
规模的 scope bundle。因此即使 issued-location index 缩小了调查范围，failure
仍是 `enclosing-operation-family` attribution。临时
`nativeSubmissionDetail: 'step'` capture 可以把 `exact-operation` attribution
指向一个 scoped location，但不能证明该 location 内部哪次 native call 导致
错误。Queue completion 同样只是 family evidence。OOM scope 证明其
submission/readback family 捕获了 OOM，不证明某一个 command 或 resource 独自
耗尽 physical memory。Device loss 与 runtime disposal 是 runtime-wide
lifecycle fact：`lifecycle-recheck` outcome 即使在 detailed capture 中也保持
`temporal-correlation`。Native prose 绝不提升 attribution。

Always-current `submissionNative` fact 报告 `submissionScopes`、
`maxPendingNativeObservations`、`currentPendingNativeObservations`、
`peakPendingNativeObservations` 与 `currentEffectfulSubmittedWork`。即使
successful operation-history capacity 为零，这些事实与 budget enforcement
仍保持开启。`off` 是显式 `unobserved` provenance，绝不推断为 success。

一般 buffer host mapping 使用 `buffer-mapping` operation 与
`buffer-mapping-failure` incident，target 如实指向 BufferResource，选中的
BufferRegion 作为 related evidence。固定 failure stage 区分 mapping、
mapped-range access、release 与 lifecycle recheck。独立 native map Promise、
validation、internal、OOM 与 scope outcome 会先全部 settle，再选择 causal
primary；abort 与 lifecycle cancellation 保持为不同的结构化事实，不从 native
prose 推断。

每次 cancellation 都会产生不虚构 native exception 的 lifecycle outcome。并发
scope 或 map failure 仍作为有序 outcome 保留在同一 incident 中；只有由 Scratch
自身 `unmap()` 导致的标准 `AbortError` 属于重复证据并被抑制。Incident 始终同时
关联 BufferResource 与选中的 BufferRegion。Runtime disposal 会先于 resource
destruction 发布，从而保留其因果 terminal code。

Always-current graph 只包含 pending 或 active `bufferMappings`。每个 fact 只保留
mapping id、resource id、所选 offset/size、mode、state、allocation version、
mapping 建立时的 content epoch 与 operation id。独立 `bufferMapping` summary
报告 current/peak mapping count 与 selected bytes。Terminal mapping 会从 current
facts 移除的前提是原生 ownership 已确认终止；有界 operation/incident history
保存其 outcome。默认不保留 mapped bytes、native handle、完整 descriptor 或
无界调用栈。

抛出异常的原生 `unmap()` 不是 terminal ownership evidence。其 failed lease
会保留一个 current mapped fact 和 per-buffer authority 作为 quarantine，直到
Buffer、Runtime 或 device termination；这份有界 fact 防止 diagnostics 错误声称
GPU use 已可用。

这是 schema v5 的 additive extension：现有 target 仍是 Resource target，新增
operation/incident discriminator 与 snapshot field 不重新解释任何旧字段。一般
host mapping 绝不增加 allocation aggregate 或
`readbackMemory.activeMappings`。

Readback provenance 使用 `readback-staging-allocation`、`readback-mapping` 与
`readback-staging-release` operation，以及 `readback-failure` incident。Direct
copy issue 另外使用 `readback-native-observation`；它保留 readback target，
绝不虚构 submission ID。Ordered readback 信任关联 submission
`nativeOutcome`，而不是创建另一份 copy observation。
`readback-staging-release` 是瞬时 operation，不能出现在 pending fact 中。
Failure stage 是结构化事实:

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

map Promise、validation、internal、OOM、scope settlement、device loss 与
lifecycle outcome 按固定 transaction 顺序独立保留。Native message 是有界
evidence，绝不是 classifier。Cleanup outcome 区分 `unmap` 与 staging
`destroy`；`destroyRequested` 不会声称一次抛错的 native destroy 已完成。

被 reject 的 `SubmittedWork.done` 会为每个 immutable readback link 记录一个
command-targeted、位于 `queue-completion` 阶段的 readback incident。它的归因是
`enclosing-operation-family`，因为一个 queue completion Promise 无法证明是哪一个
linked command 导致 rejection；它也不会改写 linked operation 独立的 mapping
result。

Always-current fact graph 报告 readback commands、active/retained operations、
current/peak staging bytes、current/peak retained host bytes 与 active
mappings。有界 history 不保留 GPUBuffer、mapped ArrayBuffer、source bytes、
command payload、mutable operation 或 SubmittedWork。`operationCapacity: 0`
可以省略 operation history，但不能关闭 current facts、incidents、budgets 或
cleanup。

每个已确认的 ShaderModule 都暴露不可变、source-free 的 compilation report。
它最多保留 64 条 native message，每条最多 4096 个 UTF-16 code unit，全部
serialized compilation evidence 最多 64 KiB。即使 evidence 被截断，计数与
omission field 仍然存在。Native order 保持不变；不解析 native prose；值为零
的未知位置与 separator location 不会被赋予虚构的 source-part coordinate。
保留前会替换至少三个 UTF-16 code unit 的精确 ShaderModule
identifier/numeric literal，以及至少八个 UTF-16 code unit 的连续 source
span。Tokenization 对齐 WGSL Unicode-XID identifier 以及完整
decimal/hexadecimal integer/float lexical forms，包括 leading-dot float。
`sourceExcerptRedacted` 用于区分这种清洗与 `messageTruncated`。保留的
ShaderModule、pipeline supporting-scope、structural 与 lifecycle native-error
string 使用相同 source sanitizer；原始 native object 只允许作为瞬时
diagnostic cause。每个 report 或 native-error settlement 只惰性建立一个不超过
32 KiB 的 Bloom workspace；collision 只能导致保守地多清洗。全局 device-loss
没有唯一 ShaderModule context，因此 Scratch 永久省略其 native message：
`runtime.deviceLostInfo` 与 runtime incident 只保留 structural reason、固定
omission marker 和 `nativeMessageOmitted: true`。in-flight ShaderModule 或
pipeline 只能通过临时 lifecycle subscription 与 diagnostic cause 使用原始
native info。

Pipeline creation 另行暴露不可变、source-free 的 creation report。它标识
Program contract、选中的 stage、ShaderModule ID、entry point、override value
以及 explicit 或 auto layout mode；它不复制 ShaderModule compilation message，
也不保留 WGSL source。
当 ShaderModule acknowledgement 因 compilation error message 而拒绝时，同一份
有界 report 会作为该 exact supporting-object incident 的
`shaderModuleCompilationReport` 保留，不会复制进无关 operation history。

稳定 ShaderModule acknowledgement failure code 为
`SCRATCH_SHADER_MODULE_CREATION_VALIDATION_FAILED`、
`SCRATCH_SHADER_MODULE_CREATION_INTERNAL_FAILED`、
`SCRATCH_SHADER_MODULE_CREATION_OUT_OF_MEMORY`、
`SCRATCH_SHADER_MODULE_CREATION_NATIVE_FAILED`、
`SCRATCH_SHADER_MODULE_COMPILATION_INFO_FAILED` 与
`SCRATCH_SHADER_MODULE_COMPILATION_FAILED`。稳定 pipeline creation failure
code 为
`SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED`、
`SCRATCH_PIPELINE_CREATION_INTERNAL_FAILED`、
`SCRATCH_PIPELINE_SUPPORT_OBJECT_FAILED`、
`SCRATCH_PIPELINE_CREATION_NATIVE_FAILED` 与
`SCRATCH_PIPELINE_CREATION_SCOPE_FAILED`。`GPUPipelineError.reason` 与 scope
category 是结构化事实。独立 Promise outcome 在 join 时不把 settlement order
或 localized text 当作因果。

## Runtime Request 与 Attempt-Local Texture Diagnostics

Runtime request validation 使用 `SCRATCH_RUNTIME_REQUEST_INVALID`，在 native
request 开始前拒绝 malformed adapter/device/queue option。

Attempt-local binding authority 按边界使用稳定结构化 code：

- `SCRATCH_EXTERNAL_TEXTURE_SOURCE_INVALID`、
  `SCRATCH_EXTERNAL_TEXTURE_SOURCE_EXPIRED` 与
  `SCRATCH_EXTERNAL_TEXTURE_WRONG_RUNTIME` 分别描述非法、已过期或跨 Runtime 的
  external import intent；
- `SCRATCH_EXTERNAL_TEXTURE_IMPORT_FAILED` 将同步 native import failure 保留在
  被选中 command 的 provenance 下；
- `SCRATCH_BIND_EXTERNAL_TEXTURE_VIEW_MISMATCH` 报告无法合法占用
  external-texture slot 的普通 texture、texture view 或 Surface view；
- `SCRATCH_BIND_SET_ATTEMPT_LOCAL` 与
  `SCRATCH_ATTEMPT_AUTHORITY_REQUIRED` 防止 attempt-local binding 被误当成持久
  prepared state，或在 submission 外进行 encoding；
- `SCRATCH_BIND_SET_ATTEMPT_REALIZATION_FAILED` 将同步 native bind-group
  realization failure 归属于被选中的 command；
- `SCRATCH_SURFACE_TEXTURE_LEASE_INVALID`、
  `SCRATCH_SURFACE_TEXTURE_LEASE_STALE`、
  `SCRATCH_SURFACE_TEXTURE_LEASE_WRONG_SUBMISSION`、
  `SCRATCH_SURFACE_TEXTURE_WRONG_RUNTIME` 与
  `SCRATCH_SURFACE_TEXTURE_USAGE_MISSING` 分别描述 lease identity、lifetime、
  ownership、Runtime 与 configured usage 违规；以及
- `SCRATCH_SURFACE_TEXTURE_VIEW_INVALID`、
  `SCRATCH_SURFACE_TEXTURE_ACQUISITION_FAILED` 与
  `SCRATCH_SURFACE_TEXTURE_VIEW_FAILED` 将确定性的 view-contract 拒绝，与同步
  current-texture acquisition 和 view-creation failure 分开。

延迟 validation、internal、OOM、device-loss 与 queue-completion outcome 继续进入
既有 submission native-observation model。这些 immediate code 不声称可以同步
获知异步 native outcome。

## Immediate Data Diagnostics 与 Retention

Immediate-data validation 使用三种稳定结构化 code：

- `SCRATCH_PROGRAM_LANGUAGE_FEATURE_UNAVAILABLE`：WGSL language requirement
  malformed 或 unavailable；
- `SCRATCH_PIPELINE_IMMEDIATE_SIZE_INVALID`：range、limit 或 Program coupling
  非法；
- `SCRATCH_COMMAND_IMMEDIATE_DATA_INVALID`：command source 缺失、禁止、长度错误、
  detached、resized、forged、不可读或 layout-incompatible。

显式不兼容的 LayoutCodec usage 继续使用 codec 的结构化 unsupported-format
diagnostic。由于 native issue 无法修复这些问题，它们在 `throw`、`warn` 与 `off`
mode 中都是 hard failure。

同步 `setImmediates()` exception 与延迟 validation/internal/OOM/device loss
继续归属于既有 submission native-observation owner。Pass-command location 包含
step index、command index、pass identity 与最终选中 command identity。默认
diagnostics、capture、export 与 SubmittedWork 可以保留 source kind、可见/预期
length、layout hash、identity、feature name 与 native stage；绝不保留 bytes、
typed value、payload hash、WGSL source 或 native handle。

## 非目标

- 不把 prose error message 做成稳定 API。
- 不要求 agent 或 test 解析 `message` 或 `hint`。
- 不通过 diagnostics 让 shader reflection 变成权威。
- 不用 diagnostics 自动修复隐藏状态。
- 不为 readback、query、shader 和 submission errors 创建互不相干的 diagnostic shapes。
- 当 runtime 无法安全继续时，不把 `warn` mode 当作忽略 state corruption 或 device loss 的许可。
