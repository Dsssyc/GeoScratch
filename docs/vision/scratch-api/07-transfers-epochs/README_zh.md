# 传输与 Epoch

状态: Vision draft
日期: 2026-07-06

## 决策

`Submission` 是核心提交单元。CPU/GPU 数据移动不是 `Resource` 方法; 它应表达为显式 transfer operation 与 command。

`Resource` 是逻辑身份加状态，不是 host transfer 句柄。upload、readback、copy、render 写入和 compute 写入都进入同一套 epoch 模型，使 runtime 能校验读取的是哪份内容、绑定的是哪个物理 GPU 对象。

这取代早先的"资源即 readback 句柄"模型。它解决异步 readback、提交单元、GPU 计时/查询缺口，同时不把 `buffer.toArray()` 或 `buffer.write()` 纳入核心资源契约。

## Submission 是提交单元

`SubmissionBuilder` 记录 passes 与 commands 并提交。Presentation 只是其中一种模式，而不是它的定义:

- 带 surface 输出 -> 使用 presentation-submission-scoped surface texture view 的 presentation submission
- 不带 surface -> compute 或 offscreen submission

`.submit()` 返回 `SubmittedWork`，这是带 `done` promise 的可 inspect 句柄; 当 submission 确实入队了物理 queue action 时，底层使用 `queue.onSubmittedWorkDone`。effect-free work 使用已 resolve 的 promise，因此不会等待无关 queue work。完成等待与数据传输是两件事: await `submitted.done` 只说明已提交 GPU 工作完成了，不会自动把数据搬到 CPU，也不会自动从 CPU 搬到 GPU。

```ts
const submitted = scratch.submission()  // no surface -> compute submission
    .compute(simulationPass, [simulate])
    .submit()

await submitted.done                    // GPU completion, not host readback
```

因此 `Submission` 是唯一核心提交概念。scratch core model 中不额外引入 `Frame` 或 `Batch` 类型。

## Epoch 模型

每个 resource 应暴露或内部追踪:

- runtime owner
- logical id
- descriptor shape
- 当前 physical GPU object
- `allocationVersion`
- `contentEpoch`
- readiness state
- last writer 或 producer submission
- pending transfer operations
- disposal state

`allocationVersion` 在 physical binding target 改变时递增:

- buffer 或 texture replacement
- resize
- device-loss rehydration
- 改变 GPU object 或 view compatibility 的 descriptor 变化

`allocationVersion` 是 `BindSet`、view cache、render attachment 和 command cache 在复用前比较的对象。单纯内容写入不应触发 bind group 重建，除非它也改变了物理 binding target。

`contentEpoch` 在 bytes 或 texels 变化时递增:

- `UploadCommand`
- `CopyCommand` 的目标写入
- `DrawCommand` 的 render attachment 写入
- `DispatchCommand` 的 storage buffer 或 storage texture 写入
- render pass clear、resolve、store 操作
- 如果未来进入 API，显式 clear、resolve、mipmap generation command 也属于内容写入

`contentEpoch` 可以先按整个 resource 追踪，之后在有价值时细化到 buffer range 或 texture region。关键契约是: readback 与 dependency validation 讨论 content epoch; binding invalidation 讨论 allocation version。

## Upload

CPU-to-GPU 写入是显式 transfer command:

```ts
const uploadPositions = scratch.command.upload({
    label: 'upload positions',
    target: positions,
    data: positionsArray,
    range: { offset: 0 },
})

scratch.submission()
    .upload(uploadPositions)
    .submit()
```

核心层没有 `positions.write(...)` 方法。未来可以在核心之上添加 convenience helper，但它必须降低为显式 upload operation，并暴露 target、range、readiness 和 epoch effects。

Upload 会推进目标写入范围的 `contentEpoch`，并记录 producing submission。如果 upload 分配路径需要替换物理 GPU 对象，则还会推进 `allocationVersion`。

### Queue-Side Upload 顺序

Buffer 与 texture upload 是有序 submission action，不是 submission 之外的 preparation。queue write 必须相对 copy、ordered readback staging、resolve、compute 与 render work 出现在其声明的 `SubmissionBuilder` 位置。

Queue write 不能记录进同一个 `GPUCommandEncoder`。因此 submission lowering 会准备显式内部 queue timeline，并且只在 upload boundary 分割 encoder-backed work:

```text
GPU work A -> upload B -> GPU work C
```

变成:

```text
queue.submit(commandBufferA)
queue.writeBuffer/writeTexture(B)
queue.submit(commandBufferC)
```

完整 timeline 会在 replay 任一 queue action 前准备完毕。Preparation 会重新校验 live upload data 与 queue capability，基于临时 content-state snapshot 模拟逻辑 effects，捕获相应 ledger facts，再恢复 live state。Replay 先执行 queue write，只在该调用成功后把对应 upload `contentEpoch` 精确提交一次。直接执行 upload command 仍然是一次 validation、一次 queue write 加一次 epoch advance。

replay 一旦开始就不可重试。如果意外同步 queue call 在先前 actions 已入队后失败，只有那些成功的先前 actions 保留逻辑 effects; failed 与 later actions 都不提交。这同时避免伪造 epoch 与重复 retry。

upload-only submission 按顺序执行 writes，不暴露伪造 command buffer，并在最后一次 write 后注册 `done`。连续 uploads 不创建空 queue submission。见 ADR-029。

## Readback

GPU-to-CPU 读取创建显式 `ReadbackOperation`:

```ts
const submitted = scratch.submission()
    .compute(simulationPass, [simulate])
    .submit()

const readback = scratch.readback({
    source: particles.segment('positions'),
    after: submitted,
})

const values = await readback.toArray()
```

`toArray()` 与 `toBytes()` 属于 readback operation，不属于 `BufferResource` 或 `TextureResource`。该 operation 捕获 source resource、range 或 region、layout view、producer submission，以及 source `contentEpoch`。

性质:

- **显式等待点。** Host access 是 transfer result 上的 `await`，绝不是藏在 resource getter 里的透明 stall。
- **Epoch 捕获。** readback 读取 readback request 或声明的 `after` submission 捕获的 content epoch。它不能静默漂移到 resource 的最新内容。
- **自动 staging。** runtime 持有 `MAP_READ` staging resources。常见 readback 下用户 buffer 不需要 map usage，但 source 需要合适的 copy usage 或显式 resolve 路径。
- **由 layout 派生视图。** `02-resources` 的 buffer layout 决定结果是 `TypedArray`、bytes，还是 layout-derived structured view。AoS 字段是 strided 的，除非显式 deinterleave，否则不承诺为一个连续 typed array。

## Readback Operation 生命周期

runtime 应追踪 `ReadbackOperation` 对象，而不是追踪某个 JavaScript `Promise` 是否被 await。Promise 消费在 JavaScript 中不是可靠契约: promise 可以被传到别处、被包装、通过 `.then()` 观察，或被保留但不 await。runtime-owned operation 才是可观察、可诊断的对象。

目标 operation 状态:

```ts
type ReadbackState =
    | 'requested'
    | 'scheduled'
    | 'submitted'
    | 'mapping'
    | 'ready'
    | 'consumed'
    | 'cancelled'
    | 'failed'
    | 'disposed'
```

状态语义:

- `requested` -> 已捕获 source、range 或 region、layout view 与 content epoch。
- `scheduled` -> 已选择 copy、resolve 或 map 路径。
- `submitted` -> GPU work 已在飞行中。它可能无法撤回，但结果仍可标记为不再需要。
- `mapping` -> staging copy 已存在，正在等待 `mapAsync` 或等价 host 可用性。
- `ready` -> retained host bytes 已存在，并可在 cancel 或 dispose 前重复读取。默认 consume-on-read 路径不使用 `ready`。
- `consumed` -> `toArray()` 或 `toBytes()` 已返回 owned copy，runtime staging 可释放。
- `cancelled` -> 调用方声明不再需要结果。已提交的 GPU work 仍可能完成，但 runtime 应丢弃结果并释放 staging。
- `failed` -> device loss、copy 前 source disposal、map failure、validation error 或 budget failure 导致无法得到可用结果。
- `disposed` -> user-facing operation 已关闭。runtime 可以保留内部 cleanup record，直到 in-flight GPU work 和 staging release 结束。之后再读取会以 diagnostic error 失败。

默认 host-copy 读取采用 **consume-on-read**:

```ts
const result = await readback.toArray()  // returns an owned copy
// operation transitions to consumed; staging can be freed
```

如果需要重复读取，调用方应显式选择 retention:

```ts
const readback = scratch.readback({
    source: particles.segment('positions'),
    after: submitted,
    retain: 'until-dispose',
})
```

对 host-copy retention 路径，第一次成功读取会 materialize 并存储 operation-owned host bytes，释放 GPU staging，并返回 owned copy。之后的 `toBytes()`、`toArray()` 和 layout-view 读取从 retained bytes 克隆结果，不会重新 staging GPU work。即使 source resource 后续推进 epoch，retained result 仍代表已 materialize 的那份 epoch。

Zero-copy 或 mapped view 必须以 lease 表达，因为 mapped range 在 unmap 后失效:

```ts
const lease = await readback.map()
try {
    const view = lease.view
    // inspect the mapped data
} finally {
    lease.dispose()
}
```

只有 lease 暴露 mapped view。operation 追踪 active leases; 如果 lease 在 operation 或 runtime dispose 前没有释放，开发期 validation 应告警。

`cancel()` 与 `dispose()` 是显式操作:

```ts
readback.cancel('no longer visible')
readback.dispose()
```

`cancel()` 表示结果不再需要。`dispose()` 释放本地 operation 所有权; 若 operation 仍在飞行中，它等价于 cancel 加 user-facing detachment，同时 runtime 保留足够内部状态以便稍后释放 staging。dispose 后，`toArray()`、`toBytes()` 与 `map()` 都应以结构化 diagnostic reject。

少数情况下，如果 staging copy 点必须放进 command graph 的特定位置，使用 `ReadbackCommand`:

```ts
const readParticles = runtime.readbackCommand({
    label: 'read particle positions',
    source: {
        resource: particlePositions,
        contentEpoch: particlePositions.contentEpoch + 1,
    },
    whenMissing: 'throw',
})

const submitted = runtime.submission()
    .compute(simulationPass, [simulate])
    .readback(readParticles)
    .submit()

const values = await readParticles.result({ after: submitted }).toArray()
```

buffer-only `ReadbackCommand` ordered-staging 路径现已实现。它验证显式 source epoch，记录 read-only submission ledger entry，并在声明的 step 把数据复制到 runtime-owned staging。`result({ after })` 返回与该次 submitted work 精确关联的 operation；materialization 只映射已有 staging buffer，不会再次提交 copy。它仍是逃生口，不是默认 readback 路径。直接 texture readback、mapped lease 与 staging budget policy 仍属于未来工作。

Queue timeline segmentation 会跨 queue-side upload 保留该声明 staging point。upload 前的 readback 会先 submit staging-copy segment，再执行 queue write; readback 前的 upload 会先执行 queue write，再 submit staging-copy segment。由 upload 分隔的多个 ordered readback 各自保留不同 staging buffer、captured epoch 与 producer provenance，同时共享一个 aggregate `SubmittedWork` completion handle。

## Copy

GPU-to-GPU copy 是显式 command。`CopyCommand` 应表达 WebGPU command encoder 原生提供的同一组 copy 方向:

- buffer 到 buffer
- texture 到 texture
- buffer 到 texture
- texture 到 buffer

CPU upload 与 CPU readback 是独立的 transfer 概念。`TextureUploadCommand` 表达通过 queue 写入 CPU bytes; `ReadbackOperation` 表达通过 staging 与 mapping 进行 host materialization。二者都不能替代 GPU-side `CopyCommand`。

```ts
const copyHistory = scratch.command.copy({
    label: 'copy color to history',
    source: {
        resource: sceneColor,
        contentEpoch: sceneColor.contentEpoch,
    },
    sourceOrigin: sceneRegion.origin,
    target: historyColor,
    targetOrigin: [ 0, 0 ],
    size: sceneRegion.size,
    whenMissing: 'throw',
})
```

Buffer-texture copy 使用 WebGPU texel buffer layout，而不是 CPU data:

```ts
const uploadPreparedPixels = scratch.command.copy({
    label: 'copy prepared pixels into texture',
    source: {
        resource: preparedPixelBuffer,
        contentEpoch: preparedPixelBuffer.contentEpoch,
    },
    sourceLayout: {
        offset: 0,
        bytesPerRow: 256,
        rowsPerImage: 64,
    },
    target: albedoTexture,
    targetOrigin: [0, 0],
    targetMipLevel: 0,
    targetAspect: 'all',
    size: { width: 64, height: 64 },
    whenMissing: 'throw',
})
```

Texture-buffer copy 仍然是 GPU-side copy。只有后续 `ReadbackOperation` map 或 materialize destination buffer 时，才进入 CPU 访问:

```ts
const copyTileStats = scratch.command.copy({
    label: 'copy texture tile into staging buffer',
    source: {
        resource: tileTexture,
        contentEpoch: tileTexture.contentEpoch,
    },
    sourceOrigin: [0, 0],
    sourceMipLevel: 0,
    sourceAspect: 'all',
    target: tileStagingBuffer,
    targetLayout: {
        offset: 0,
        bytesPerRow: 256,
        rowsPerImage: 32,
    },
    size: { width: 32, height: 32 },
    whenMissing: 'throw',
})
```

Copy 读取 source `contentEpoch`，并推进 target `contentEpoch`。如果 copy target 需要新的物理资源，则 allocation replacement 通过独立的 `allocationVersion` 表达。

## 渲染资源

同一模型覆盖图形资源:

- render pass attachment 是声明式写入。它的 store、clear、resolve 行为会推进 attachment resource 的 `contentEpoch`。
- 后续 pass 采样该 texture 时，声明读取已产生的 `contentEpoch`。
- depth 与 stencil attachment 使用同一规则。load/store policy 与 read-as-texture 用法必须足够显式，供 dependency validation 判断。
- surface current texture 是借来的 presentation-submission-scoped target，不是持久 `TextureResource`。它不能在获取它的 presentation submission 之外保留。
- render target resize 会推进 `allocationVersion`，并使依赖旧物理对象的 cached views、bind sets、pass attachments 与 commands 失效。
- TAA history、trails、迭代仿真纹理这类 temporal resources 都是普通资源; 它们的 previous-frame contents 由 content epochs 表达，而不是内核里的特殊一等特性。

## Timing 与 Query

GPU timing 与 visibility query 复用同一套 transfer 模型。`QuerySetResource` 名称沿用 WebGPU `GPUQuerySet`; 它是 indexed slot resource，不是无序集合。

核心 query-set contract:

```ts
type QuerySetType = 'timestamp' | 'occlusion'
type QueryUnsupportedPolicy = 'throw' | 'warn-disable' | 'disable'

const timingQueries = scratch.querySet({
    label: 'simulation timing',
    type: 'timestamp',
    count: 2,
    whenUnsupported: 'throw',
})
```

- `count` 是 indexed query slots 的数量。
- Query slot 通过显式 index 或 index range 访问。
- `timestamp` 需要 `timestamp-query` feature，可用于 render 或 compute pass 的 `timestampWrites`。
- `occlusion` 通过 `occlusionQuerySet` 和 begin/end occlusion query brackets 属于 render pass。
- query write 会推进 query slot 的 content epoch。resolve query results 会推进 destination buffer 的 `contentEpoch`。
- `whenUnsupported` 控制 feature-gate failure。开发期应优先用 `throw`; profiling overlays 可在 instrumentation 可选时使用 `warn-disable` 或 `disable`。

Timestamp writes 是 pass-level instrumentation:

```ts
const simulationPass = scratch.pass.compute({
    label: 'simulate',
    timestampWrites: {
        querySet: timingQueries,
        begin: 0,
        end: 1,
    },
})
```

Occlusion queries 是 render-pass-scoped:

```ts
const visibilityQueries = scratch.querySet({
    label: 'tile visibility',
    type: 'occlusion',
    count: tileCapacity,
})

const scenePass = scratch.pass.render({
    label: 'scene',
    color: [
        {
            target: sceneColor,
            load: 'load',
            store: 'store',
        },
    ],
    depth: {
        target: depth,
        depthLoad: 'load',
        depthStore: 'store',
    },
    occlusionQuerySet: visibilityQueries,
})

const drawTileWithVisibility = [
    scratch.command.beginOcclusionQuery({ querySet: visibilityQueries, index: tileIndex }),
    drawTile,
    scratch.command.endOcclusionQuery(),
]
```

Query result 只有显式 resolve 并 read back 后才 CPU-visible:

```ts
const resolveTiming = scratch.command.resolveQuerySet({
    source: {
        querySet: timingQueries,
        slots: [
            { index: 0, contentEpoch: 1 },
            { index: 1, contentEpoch: 1 },
        ],
    },
    destination: timingBuffer,
    destinationOffset: 0,
    whenMissing: 'throw',
})

const submitted = scratch.submission()
    .compute(simulationPass, [simulateParticles])
    .resolve(resolveTiming)
    .submit()

const timingReadback = scratch.readback({
    source: {
        resource: timingBuffer,
        range: { offset: 0, byteLength: 16 },
        view: 'u64',
    },
    after: submitted,
    provenance: {
        querySet: timingQueries,
        slots: [
            { index: 0, contentEpoch: 1 },
            { index: 1, contentEpoch: 1 },
        ],
    },
})

const timingValues = await timingReadback.toBigUint64Array()
```

Pipeline statistics 不是当前 WebGPU core contract 的一部分; 除非未来 WebGPU target 或显式 extension 支持，否则必须留在 scratch core 之外。

使用 `09-diagnostics-validation` 共享 envelope 的候选 query diagnostic codes:

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
```

Query diagnostic 应携带 query-set id、type、requested range、pass 或 command id、相关 feature name、resolve 失败时的 destination buffer id，以及 query slot 被写入时的 producer submission id。这些细节应进入 `subject`、`related`、`expected`、`actual` 或 compact evidence fields，而不是只写在 prose 里。

## Retention、预算与诊断

Readback retention 是 runtime policy，不是隐藏 garbage collection。默认策略应保守:

- operation 保留到 consumed、cancelled、disposed 或 failed
- pending operation 过旧时在开发期告警
- ready operation 长时间未消费时在开发期告警
- staging budget 超限时 fail fast 或发出高严重度诊断
- 除非 operation 显式声明 evictable，否则绝不静默淘汰 readback result

配置形状示例:

```ts
const runtime = await ScratchRuntime.create({
    readback: {
        staleAfterSubmissions: 3,
        staleAfterMs: 250,
        maxPendingOperations: 16,
        maxStagingBytes: 64 * 1024 * 1024,
        onBudgetExceeded: 'throw',
    },
})
```

使用 `09-diagnostics-validation` 共享 envelope 的候选 readback diagnostic codes:

```ts
type ReadbackDiagnosticCode =
    | 'SCRATCH_READBACK_STALE_PENDING'
    | 'SCRATCH_READBACK_READY_UNCONSUMED'
    | 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED'
    | 'SCRATCH_READBACK_CANCELLED'
    | 'SCRATCH_READBACK_SOURCE_DISPOSED_BEFORE_COPY'
    | 'SCRATCH_READBACK_RUNTIME_DISPOSED'
    | 'SCRATCH_READBACK_LEASE_NOT_RELEASED'
```

每条 readback diagnostic 都应携带足够上下文，使 agent 或人无需解析 prose 也能修复问题:

```ts
type ReadbackDiagnostic = ScratchDiagnostic & {
    code: ReadbackDiagnosticCode
    phase: 'readback'
    subject: { kind: 'ReadbackOperation', id: string, label?: string }
    related?: [
        { kind: 'Resource', id: string, label?: string, resourceKind?: string },
        ...DiagnosticSubject[],
    ]
    actual?: {
        state: ReadbackState
        allocationVersion?: number
        contentEpoch?: number
        rangeOrRegion?: unknown
        producerSubmissionId?: string
        ageInSubmissions?: number
        ageInMs?: number
        stagingBytes?: number
    }
}
```

Readback-specific diagnostics 应从一开始就遵循共享 machine-readable pattern。Readback-specific state 应放在 common `ScratchDiagnostic` envelope 内，通常进入 `subject`、`related`、`actual` 与 `evidence`。

## 非目标

- 不暴露核心 `resource.toArray()` 或 `resource.toBytes()` 糖。
- 不暴露核心 `resource.write()` 糖。
- 不隐藏 upload、readback 或 copy submission。
- 不让 `ReadbackCommand` 成为默认路径。
- 当 WebGPU 不提供对应 core query primitive 时，不把 pipeline statistics 暴露成核心 query type。
- 不把自动 render-graph sorting 放进核心 scheduler。
- 不把 ping-pong、history buffer、readback ring 等常见模式做成内核一等特性。
