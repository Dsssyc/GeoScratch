# Diagnostics 与 Validation

状态: Vision draft
日期: 2026-07-12

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

Resource diagnostics 覆盖 ownership、readiness、lifetime、usage、allocation version 与 content epoch state。

候选 codes:

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

`TextureResource.resize()` 对 native issue 前检测出的确定性 size grammar、integer-domain、limit、mip、sample、transient-attachment、format-block、lifecycle 与 native-capability failure 使用 `SCRATCH_RESOURCE_DESCRIPTOR_INVALID`。Native validation、OOM、同步 exception 与 scope failure 使用各自 operation-specific code 并链接 immutable incident；`ScratchDiagnosticError.cause` 可以保留原始 native error。

Promise 只有在 validation 与 OOM scope 确认 candidate 后才 resolve。commit 前的 failure 会保持旧 texture、descriptor、views、`allocationVersion`、`contentEpoch` 与 readiness state 不变。

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
    | 'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID'
    | 'SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_FAILED'
```

预期的 Draw/Dispatch `skip-command`、`skip-pass` 与成功 `use-fallback` 决策不是 diagnostics，而是不可变的 `SubmittedWork.executionOutcomes`。`SCRATCH_COMMAND_FALLBACK_INVALID` 只用于 missing/forbidden fallback shape、伪造的非 command 节点、kind/runtime/lifecycle/write-set 不兼容，以及重复 object 或 command ID。最终选中的 fallback 无法进入当前 pass 时使用 `SCRATCH_SUBMISSION_PASS_COMMAND_INCOMPATIBLE`。

Fallback readiness 或 dependency failure 以最终选中的 fallback 作为 `subject`。`related` 包含 requested command、attempted chain、pass、resources 与 submission。结构化 `actual` facts 包含 step/pass IDs、requested command ID、attempted command IDs、携带每个可用 missing-resource state/epoch fact 的完整 `attempts` 数组、当前 command/resource state 与 epochs，以及 validation mode。构造后变为不可用的 selected fallback dependency 使用 `SCRATCH_COMMAND_FALLBACK_INVALID`，并在 `actual.cause` 中保留底层 lifecycle diagnostic。针对 selected fallback 生成的 render attachment resource-conflict diagnostic 也保留相同的 requested/attempted provenance。

`ExternalImageUploadCommand` diagnostic 在结构化 command facts 中使用 `commandKind: 'upload'` 与 `uploadKind: 'external-image'`。`SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID` 覆盖确定性的 descriptor、platform brand、live source-range、target、queue ownership、lifecycle 与 queue-capability failure。context-specific canvas dimensions 没有无副作用的 JavaScript query，因此原生权威 range check 同步抛出的 `OperationError` 也使用这个 invalid code。它的 `expected` 和 `actual` 字段携带 machine-readable validation facts，不要求解析 message。

`SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_FAILED` 专用于 `GPUQueue.copyExternalImageToTexture()` 同步抛出的其他 exception。diagnostic 的 `actual.nativeError` 只包含可序列化 exception facts，而 `ScratchDiagnosticError.cause` 保留原始 thrown value，供程序化检查。失败的原生调用不提交 target epoch、readiness transition、access entry 或 producer fact。

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
    | 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED'
    | 'SCRATCH_READBACK_STAGING_VALIDATION_FAILED'
    | 'SCRATCH_READBACK_STAGING_OUT_OF_MEMORY'
    | 'SCRATCH_READBACK_COPY_ISSUE_FAILED'
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
version 4。`0.x.x` 期间不输出或转换 version 2 或 version 3。operation 与 pending fact
显式选择一种宏观 target:

```ts
type ScratchGpuOperationTarget =
    | { kind: 'resource'; resourceId: string; resourceKind: string; allocationVersion: number; contentEpoch: number; logicalFootprintBytes: number }
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

Query 通过 `targetKind`、`resourceId`、`pipelineId`、`commandId` 或
`readbackId`、`submissionId` 选择，而不是猜 optional field。Resource allocation incident
保留 ADR-032 的 pressure 与 attribution 语义。Pipeline incident 只包含
compilation 与 creation evidence，不获得虚构的 allocation pressure。
Readback target 不伪装成 persistent resource。

Readback provenance 使用 `readback-staging-allocation`、`readback-mapping` 与
`readback-staging-release` operation，以及 `readback-failure` incident。
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

每个成功 pipeline 都暴露不可变、source-free 的 compilation report。它最多
保留 64 条 native message，每条最多 4096 个 UTF-16 code unit，全部 serialized
compilation evidence 最多 64 KiB。即使 evidence 被截断，计数与 omission field
仍然存在。Native order 保持不变；不解析 native prose；值为零的未知位置与
separator location 不会被赋予虚构的 module coordinate。保留前会替换至少
三个 UTF-16 code unit 的精确 Program identifier/numeric literal，以及至少
八个 UTF-16 code unit 的连续 Program source span。Tokenization 对齐 WGSL
Unicode-XID identifier 以及完整 decimal/hexadecimal integer/float lexical
forms，包括 leading-dot float。`sourceExcerptRedacted`
用于区分这种清洗与 `messageTruncated`。保留的 pipeline、supporting-scope、
structural 与 lifecycle native-error string 使用相同 source sanitizer；原始
native object 只允许作为瞬时 diagnostic cause。每个 report 或 native-error
settlement 只惰性建立一个不超过 32 KiB 的 Bloom workspace；collision 只能
导致保守地多清洗。全局 device-loss 没有唯一 Program context，因此 Scratch
永久省略其 native message：`runtime.deviceLostInfo` 与 runtime incident 只保留
structural reason、固定 omission marker 和 `nativeMessageOmitted: true`。
in-flight pipeline 只能通过临时 lifecycle subscription 与 diagnostic cause
使用原始 info。

稳定 pipeline creation failure code 为
`SCRATCH_PIPELINE_SHADER_COMPILATION_FAILED`、
`SCRATCH_PIPELINE_CREATION_VALIDATION_FAILED`、
`SCRATCH_PIPELINE_CREATION_INTERNAL_FAILED`、
`SCRATCH_PIPELINE_SUPPORT_OBJECT_FAILED`、
`SCRATCH_PIPELINE_CREATION_NATIVE_FAILED` 与
`SCRATCH_PIPELINE_CREATION_SCOPE_FAILED`。`GPUPipelineError.reason` 与 scope
category 是结构化事实。独立 Promise outcome 在 join 时不把 settlement order
或 localized text 当作因果。

## 非目标

- 不把 prose error message 做成稳定 API。
- 不要求 agent 或 test 解析 `message` 或 `hint`。
- 不通过 diagnostics 让 shader reflection 变成权威。
- 不用 diagnostics 自动修复隐藏状态。
- 不为 readback、query、shader 和 submission errors 创建互不相干的 diagnostic shapes。
- 当 runtime 无法安全继续时，不把 `warn` mode 当作忽略 state corruption 或 device loss 的许可。
