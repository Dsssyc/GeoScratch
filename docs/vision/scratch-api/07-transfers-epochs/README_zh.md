# 传输与 Epoch

状态: Vision draft
日期: 2026-07-23

## 决策

`Submission` 是核心提交单元。CPU/GPU 数据移动不是 `Resource` 方法; 它应表达为显式 transfer operation 与 command。

`Resource` 是逻辑身份加状态，不是 host transfer 句柄。upload、readback、copy、render 写入和 compute 写入都进入同一套 epoch 模型，使 runtime 能校验读取的是哪份内容、绑定的是哪个物理 GPU 对象。

这取代早先的"资源即 readback 句柄"模型。它解决异步 readback、提交单元、GPU 计时/查询缺口，同时不把 `buffer.toArray()` 或 `buffer.write()` 纳入核心资源契约。

## Submission 是提交单元

`SubmissionBuilder` 记录 passes 与 commands 并提交。Presentation 只是其中一种模式，而不是它的定义:

- 带 surface 输出 -> 使用 presentation-submission-scoped surface texture view 的 presentation submission
- 不带 surface -> compute 或 offscreen submission

`.submit()` 同步返回 `SubmittedWork`，这是可 inspect 且 non-thenable 的
handle。始终 resolve 的 `nativeOutcome` 报告 native observation；当存在物理
queue action 时，`done` Promise 会把该 observation 与
`queue.onSubmittedWorkDone()` 联合起来。Effect-free work 报告
`no-native-work`，且不等待无关 queue work。Completion 与 data transfer 仍然
分离：`done` 不负责 map staging、访问 mapped range、复制 host bytes 或
materialize readback result。

```ts
const submitted = runtime.createSubmission()  // no surface -> compute submission
    .compute(simulationPass, [simulate])
    .submit()

const nativeOutcome = await submitted.nativeOutcome
await submitted.done                    // observed submission, not host readback
```

因此 `Submission` 是唯一核心提交概念。scratch core model 中不额外引入 `Frame` 或 `Batch` 类型。

## Epoch 模型

每个 Resource 都追踪稳定 identity、allocation lifecycle 与 disposal。
BufferResource 与 TextureResource 还会追踪:

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

`allocationVersion` 是 BindSet preparation snapshot 与 current-allocation validation 比较的事实。单纯内容写入绝不会触发 preparation，除非它也改变 physical binding target。SamplerResource 没有 content state；QuerySetResource 按 indexed slot 追踪 state 与 epoch，而不是使用这些 scalar fields。

Resource identity、lifecycle、readiness、`allocationVersion` 与 `contentEpoch` 都是由 ECMAScript-private slots 支撑的只读公开事实。Package consumer 不能通过字段、上转型到 `Resource`、object-level transition method 或任一公开 package entrypoint 改写 provenance。内部 command 与 submission modules 通过不属于 entrypoint 的 module functions 提交 transition。

`contentEpoch` 在 bytes 或 texels 变化时递增:

- `UploadCommand`
- `CopyCommand` 的目标写入
- 非空 `ClearBufferCommand` 的目标写入
- `DrawCommand` 的 render attachment 写入
- `DispatchCommand` 的 storage buffer 或 storage texture 写入
- 持久 render-pass resolve target 写入
- 如果未来进入 API，显式 mipmap generation command 也属于内容写入

`contentEpoch` 属于 parent BufferResource 或 TextureResource。BufferRegion 与 TextureViewSpec 不拥有独立 epoch。Readback 与 dependency validation 讨论 parent content epoch；binding invalidation 讨论 allocation version。

### Exact 与 Current-At-Step Command Read

DrawCommand 与 DispatchCommand read descriptor 在两种语义中选择一种。非负整数指定一个精确 parent-resource epoch。`'current-at-step'` 指定最终选中 command 在显式 submission 位置可读的 parent-resource 内容。解析会观察有序前序 producer，发生在同一 command 的 declared writes 之前，并且绝不向后查看。

这是 command dependency policy，不是新的 Resource state。它不改变 Resource epoch、不创建 subresource epoch、不检查 bytes、不调度 producer，也不修复 empty/indeterminate resource。empty state 仍遵循 `whenMissing`；indeterminate state 在所有 validation mode 下都硬失败。Copy、Readback 与 query-slot source epoch 继续要求 exact，避免 transfer/query provenance 漂移。

最终 read ledger 在 `declaredContentEpoch` 中保存 authored policy，并在 `contentEpochBefore`/`contentEpochAfter` 中保存 resolved numeric fact。后续 submission 或 resource change 不能改写任何历史事实。

### 迟到 Failure 后的 Indeterminate Content

Submission effect 在 native action issue 时乐观推进 epoch。若 native
observation 后续失败、observation 无法 settle，或 queue completion reject，
Scratch 不回滚已经发布的 epoch。它会把每个仍为 current 的持久 potential
write 标为 `indeterminate`：allocation 或 query slot 仍存在，但其 bytes、
texels 或 query values 已无法证明与记录的 epoch 一致。

Allocation version 与 content epoch guard 会阻止迟到 failure 污染 replacement
或后续 producer。任何 current indeterminate content read 都会在 native work
前硬失败，包括 copy、direct readback、ordered readback、bind-backed
draw/dispatch、attachment `load` 与 query resolve。missing-resource policy 与
validation mode 都不能压制它。后续显式 producer 推进新 epoch 并恢复
`ready`；历史 submission ledger 与 outcome 保持不变。

### Texture Allocation Replacement

`TextureResource.resize()` 会在一个稳定逻辑 texture 后方显式替换 physical allocation。它是返回 Promise 的 scoped allocation transaction，不是 transfer 或 submission work：resize 不创建 encoder、不调用 queue method、不注册 `onSubmittedWorkDone()`，也不会在销毁旧 texture 前等待先前 queue completion。candidate 的 validation 与 out-of-memory scope settle 期间，旧 allocation 保持 installed；只有确认成功才推进 allocation facts。

normalized same-size resize 返回 resolved Promise 且不改变任何事实。成功的 size-changing resize 只有以下效果:

```text
allocationVersion = previous allocationVersion + 1
contentEpoch = previous contentEpoch
state = empty
```

下一次成功 texture upload、external-image upload、copy target write、render attachment write 或 storage write 会从保留的 epoch 继续递增，并让 replacement ready。Transfer command 在执行时解析 current physical allocation，并在任何 encoder 或 queue effect 前重新校验当前 mip、origin、extent 与 layer range。

`SubmittedWork` 保持历史事实：之后的 resize 不能改变早先 submission 的 allocation-version 或 producer facts。`ReadbackOperation` 会捕获 source allocation version。当前已实现的 readback source 是 buffer，因此 captured buffer 在 materialization 前被替换时，会以 `SCRATCH_READBACK_SOURCE_ALLOCATION_STALE` 拒绝。Texture 数据通过显式 texture-to-buffer `CopyCommand` 到达 host memory；之后替换 texture 不会改写已捕获的 destination-buffer provenance。未来直接 texture-readback 路径必须遵守同一个 allocation-stale 规则。

## Upload

CPU-to-GPU 写入是显式 transfer command:

```ts
const positionRegion = positions.region()
const uploadPositions = runtime.createUploadCommand({
    label: 'upload positions',
    target: positionRegion,
    data: positionsArray,
})

runtime.createSubmission()
    .upload(uploadPositions)
    .submit()
```

核心层没有 `positions.write(...)` 方法。未来可以在核心之上添加 convenience helper，但它必须降低为显式 upload operation，并暴露 target、range、readiness 和 epoch effects。

Upload 会推进目标写入范围的 `contentEpoch`，并记录 producing submission。如果 upload 分配路径需要替换物理 GPU 对象，则还会推进 `allocationVersion`。

`UploadCommand` 按 identity 保留 authored byte source。应用可以在两次 submission
之间修改持久 typed array，并复用同一个 command；每次成功执行都会读取当时的 bytes，
并且只推进一次 target epoch。这允许 CPU-produced indirect argument record 在不重建
command 的情况下工作。它仍然是单向 CPU-to-GPU upload，不是 readback 或 roundtrip。

Buffer upload path 会降低到 `GPUQueue.writeBuffer()`。其 target
`BufferRegion` offset 与所选 byte length 都必须满足 4-byte alignment。Scratch
会在直接 queue call 或 submission timeline 获得任何 effect 前校验这条原生规则。

三种 immediate upload variant 都只能在其所属的 `ScratchRuntime.queue` 上执行。
foreign queue 会在 `writeBuffer()`、`writeTexture()`、`copyExternalImageToTexture()`
或任何逻辑 content-epoch effect 前以 `SCRATCH_COMMAND_WRONG_RUNTIME` 和
`actual.queueOwnedByRuntime: false` 被拒绝。这样即使 command 脱离
`SubmissionBuilder` 直接执行，也仍保留 WebGPU 的 same-device object-validity rule。

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

### External Image Upload

`ExternalImageUploadCommand` 是显式 external-source upload variant:

```ts
commandKind: 'upload'
uploadKind: 'external-image'
```

它直接降低到 `GPUQueue.copyExternalImageToTexture()`。command 按身份保留由应用拥有的 source object，browser 在原生 queue call 发生时捕获其当前 pixels。Scratch 不执行 CPU pixel extraction，不创建中间 byte snapshot，也不提供 `writeTexture()` fallback。external source 不是 Scratch resource，因此不会获得虚构的 allocation version、content epoch、readiness state、access entry 或 producer fact。

非空原生调用成功返回后，Scratch 恰好推进一次 target texture 的 `contentEpoch`，把 target 标为 ready，并记录一次 target write 与 producer epoch。physical texture 没有改变，所以 target 的 `allocationVersion` 不变。直接执行与 submission replay 使用同一套 effect rule。

zero-width or zero-height command 仍是 ordered queue action，并且仍调用 `GPUQueue.copyExternalImageToTexture()`，使原生 source usability 与 argument validation 保持可观察。它 does not advance `contentEpoch`，也不让 target ready、不创建 resource access 或 producer fact、不伪造 command buffer。如果原生调用抛错，failed action 不提交上述任何 effect；先前成功 actions 保持已提交，后续 actions 不 replay。见 ADR-030。

## Readback

GPU-to-CPU 读取创建显式 `ReadbackOperation`:

```ts
const particlePositions = particles.region({
    offset: positionsOffset,
    size: positionsByteLength,
    layout: positionLayout,
})
const submitted = runtime.createSubmission()
    .compute(simulationPass, [simulate])
    .submit()

const readback = runtime.createReadback({
    source: particlePositions,
    after: submitted,
})

const values = await readback.toArray(Float32Array)
```

`toArray()` 与 `toBytes()` 属于 readback operation，不属于 `BufferResource` 或 `TextureResource`。该 operation 捕获一个 BufferRegion、其 parent allocation/content facts、可选 layout witness 与 producer submission。

性质:

- **显式等待点。** Host access 是 transfer result 上的 `await`，绝不是藏在 resource getter 里的透明 stall。
- **Epoch 捕获。** readback 读取 readback request 或声明的 `after` submission 捕获的 content epoch。它不能静默漂移到 resource 的最新内容。
- **可确认的自动 staging。** runtime 持有 `MAP_READ` staging resources，并在使用前确认原生 validation/OOM outcome。常见 readback 下用户 buffer 不需要 map usage，但 source 需要合适的 copy usage 或显式 resolve 路径。
- **Buffer-specific mapping barrier。** Host materialization 等待 staging buffer 自身的 `mapAsync()`，不会额外插入一次全 queue completion wait。
- **由 layout 派生视图。** `02-resources` 的 buffer layout 决定结果是 `TypedArray`、bytes，还是 layout-derived structured view。AoS 字段是 strided 的，除非显式 deinterleave，否则不承诺为一个连续 typed array。

Direct 与 ordered buffer readback 都通过 `copyBufferToBuffer()` 降低。Source
`BufferRegion` offset 与 size 都必须在 Scratch 分配或 claim staging storage
之前满足 4-byte alignment。因此，无论 readback 被安排在哪个位置，都使用同一
alignment rule。

## Staging Allocation 与 Mapping Transaction

Direct 与 ordered 路径共享一个 staging allocator 和一个 mapping
transaction，但在两个不同的显式边界确认 allocation:

- direct `ReadbackOperation` 在第一次 materialization 时分配一个 ephemeral
  slot，之后在 copy encoding 前重新检查 source allocation/content epochs；
- ordered `ReadbackCommand` 在 Promise-only factory resolve 前持有一个已确认
  的可复用 slot，因此同步 submission 不会分配它；
- direct operation 在创建时预留 `maxPendingOperations` capacity，在
  materialization 分配 staging 前预留 `maxStagingBytes` capacity；
- ordered factory 在分配可复用 slot 前预留 `maxStagingBytes` capacity；每次同步
  submission 则在 encoder 或 queue effect 前 claim slot 时预留
  `maxPendingOperations` capacity；
- 每个成功取得的 reservation 都会在 success、failure、cancellation、
  disposal、runtime loss 与 device loss 路径中精确释放一次。

Mapping 在 validation、internal 与 out-of-memory error scope 下只调用一次
`mapAsync(GPUMapMode.READ, 0, byteLength)`。所有已 push scope 都在第一次
await 前完成 pop。map Promise、每个 scope Promise、device loss 与 operation
lifecycle 是固定 transaction 顺序中的独立 outcome；native message 文本与
Promise settlement 顺序都不决定 stable code。

Mapping transaction 区分 `mapping`、`mapped-range`、`host-copy`、
`cleanup` 与 `lifecycle-recheck`。`unmap` 和 staging `destroy` failure 在同一
`SCRATCH_READBACK_CLEANUP_FAILED` incident 下使用不同 outcome code。若 host
bytes 已完成复制，cleanup failure 不会丢弃 owned bytes，也不会虚构 native
destruction 成功。

### Native Copy Observation 与 Byte Trust

direct readback 与 ordered readback 保留两个相互独立的 native boundary。

direct readback 先确认 ephemeral staging allocation。随后 materialization 按
runtime `submissionScopes` policy，在 readback target 下观察 encoder creation、
copy encoding、encoder finish 与 queue submit。Copy observation 与 buffer
mapping 独立 settle；只有两项适用 outcome 都成功后才暴露 bytes。使用
`submissionScopes: 'off'` 时，copy provenance 明确为 `unobserved`；成功 map
不会被描述成 validation acknowledgement。当前为 `indeterminate` 的 source
content 会以 `SCRATCH_READBACK_SOURCE_CONTENT_INDETERMINATE` 在 staging
allocation 或 encoder work 前失败；即使 operation 在迟到 submission failure
settle 前捕获了相同 epoch，也不能继续读取。

ordered readback 不创建第二次 copy 或 observation。暴露 mapped bytes 前，它
await 关联的 `SubmittedWork.nativeOutcome`。`observed-failed` 或
`observation-failed` 的 staging-copy family 会让 bytes 不可信，并使
materialization reject。显式 `unobserved` outcome 允许返回 mapped bytes，同时
保留该 provenance。Queue-completion rejection 仍是独立事实：它可以 reject
`SubmittedWork.done` 并记录 enclosing-family incident，但不会虚构 mapping
failure，也不会丢弃已独立取得的 owned bytes。

Direct copy observation 与 submission observation 共享
`maxPendingNativeObservations`。Budget 耗尽发生在 encoder work 前；有限
`nativeSubmissionDetail: 'step'` capture 记录四个 direct stage，不会为
readback target 虚构 submission ID。

每个 readback 只有一个 materialization owner。并发
`retain: 'until-dispose'` readers 共享一次 allocation/copy/map，并分别获得
独立 clone。竞争的 `retain: 'consume-on-read'` reader 以
`SCRATCH_READBACK_IN_PROGRESS` 失败，不能发起第二次 native transaction。

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
const readback = runtime.createReadback({
    source: particlePositions,
    retain: 'consume-on-read',
})
const result = await readback.toArray()  // returns an owned copy
// operation transitions to consumed; staging can be freed
```

如果需要重复读取，调用方应显式选择 retention:

```ts
const readback = runtime.createReadback({
    source: particlePositions,
    after: submitted,
    retain: 'until-dispose',
})
```

对 host-copy retention 路径，第一次成功读取会 materialize 并存储 operation-owned host bytes，释放 GPU staging，并返回 owned copy。之后的 `toBytes()`、`toArray()` 和 layout-view 读取从 retained bytes 克隆结果，不会重新 staging GPU work。即使 source resource 后续推进 epoch，retained result 仍代表已 materialize 的那份 epoch。

Mapped-view lease 是 follow-up boundary，本契约尚未实现。未来 zero-copy 或
mapped view 必须以 lease 表达，因为 mapped range 在 unmap 后失效:

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
const readParticles = await runtime.createReadbackCommand({
    label: 'read particle positions',
    source: {
        region: particlePositions,
        contentEpoch: particles.contentEpoch + 1,
    },
    whenMissing: 'throw',
})

const submitted = runtime.createSubmission()
    .compute(simulationPass, [simulate])
    .readback(readParticles)
    .submit()

const values = await readParticles.result({ after: submitted }).toArray(Float32Array)
```

buffer-only `ReadbackCommand` ordered-staging 路径现已实现。它的 Promise-only factory 会在返回前确认可复用 staging slot。它验证显式 source epoch，记录 read-only submission ledger entry，并在声明的 step 把数据复制到 runtime-owned staging。`result({ after })` 返回与该次 submitted work 精确关联的 operation；materialization 只映射已有 staging buffer，不会再次提交 copy。它仍是逃生口，不是默认 readback 路径。直接 texture readback 与 mapped lease 仍属于未来工作；有限 staging budget 已是 runtime policy。

Command disposal 会阻止新的 submission 与 reuse，但在 runtime 仍 active 时不会
抹掉 historical result lookup。已经关联到 `SubmittedWork` 的 operation 仍可通过
`result({ after })` 取得，并沿正常 cleanup 路径释放或销毁 busy slot。

Queue timeline segmentation 会跨 queue-side upload 保留该声明 staging point。upload 前的 readback 会先 submit staging-copy segment，再执行 queue write; readback 前的 upload 会先执行 queue write，再 submit staging-copy segment。由 upload 分隔的多个 ordered readback 各自保留不同 staging buffer、captured epoch 与 producer provenance，同时共享一个 aggregate `SubmittedWork` completion handle。

## Copy

GPU-to-GPU copy 是显式 command。`CopyCommand` 应表达 WebGPU command encoder 原生提供的同一组 copy 方向:

- buffer 到 buffer
- texture 到 texture
- buffer 到 texture
- texture 到 buffer

CPU upload 与 CPU readback 是独立的 transfer 概念。`TextureUploadCommand` 表达通过 queue 写入 CPU bytes; `ReadbackOperation` 表达通过 staging 与 mapping 进行 host materialization。二者都不能替代 GPU-side `CopyCommand`。

WebGPU 要求 buffer-to-buffer copy 的两个 endpoint 是不同的 `GPUBuffer` object。因此，只要 source 与 target region 共享同一个 parent buffer，Scratch 就会拒绝该 copy，即使两个 byte range 完全不相交。Overlapping 或 disjoint `BufferRegion` 仍是合法 interpretation unit；它们只是不能用来绕过这条 native copy rule。

```ts
const copyHistory = runtime.createCopyCommand({
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

Copy extent 以 texel 表达，而 linear buffer layout 以 texel block 表达。Scratch
为全部 95 个非 depth/stencil `GPUTextureFormat` 解析原生 block width、block
height 与 copy footprint，校验 origin 和 extent 的 block alignment，以 block row
计算所需 buffer bytes，并把 `rowsPerImage` 解释为 texel-block rows。Encoder copy
仍要求 `bytesPerRow` 是 256 的倍数。两个 row field 都使用原生 `GPUSize32`
数值域，因此 Scratch 会在 Web IDL conversion 前拒绝大于 `0xffffffff` 的值；
texture-upload row layout 使用相同的 `GPUSize32` 上界，但不继承仅属于 encoder
copy 的 256-byte row alignment rule。这些路径直接发出
`copyBufferToTexture()` 或 `copyTextureToBuffer()`，no CPU round trip。

Depth/stencil buffer-texture copy 必须精确指向一个可用 aspect。只有格式本身仅有
一个 aspect 时才可使用 `all`；combined format 必须使用 `depth-only` 或
`stencil-only`。Buffer offset 按 4 bytes 对齐，copy 必须覆盖完整 physical
subresource。原生方向与 footprint 矩阵如下:

| Format 与 aspect | Bytes per block | Texture 到 buffer | Buffer 到 texture |
| --- | ---: | --- | --- |
| `stencil8` stencil | 1 | 是 | 是 |
| `depth16unorm` depth | 2 | 是 | 是 |
| `depth24plus` depth | N/A | 否 | 否 |
| `depth24plus-stencil8` depth | N/A | 否 | 否 |
| `depth24plus-stencil8` stencil | 1 | 是 | 是 |
| `depth32float` depth | 4 | 是 | 否 |
| `depth32float-stencil8` depth | 4 | 是 | 否 |
| `depth32float-stencil8` stencil | 1 | 是 | 是 |

Compressed copy 使用其原生 4x4 或 ASTC block dimensions，以及 8-byte 或
16-byte footprint。对于缺少 `core-features-and-limits` 的 compatibility device，
compressed buffer-to-texture copy 仍然合法，而 compressed texture-to-buffer 与
texture-to-texture copy 会被拒绝。Core device 在遵守相同 physical block 规则时
允许后两种方向。

```ts
const uploadPreparedPixels = runtime.createCopyCommand({
    label: 'copy prepared pixels into texture',
    source: {
        region: preparedPixelBuffer.region(),
        contentEpoch: preparedPixelBuffer.contentEpoch,
    },
    sourceLayout: {
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
const copyTileStats = runtime.createCopyCommand({
    label: 'copy texture tile into staging buffer',
    source: {
        resource: tileTexture,
        contentEpoch: tileTexture.contentEpoch,
    },
    sourceOrigin: [0, 0],
    sourceMipLevel: 0,
    sourceAspect: 'all',
    target: tileStagingBuffer.region(),
    targetLayout: {
        bytesPerRow: 256,
        rowsPerImage: 32,
    },
    size: { width: 32, height: 32 },
    whenMissing: 'throw',
})
```

Copy 读取 source `contentEpoch`，并推进 target `contentEpoch`。如果 copy target 需要新的物理资源，则 allocation replacement 通过独立的 `allocationVersion` 表达。

## Clear

`ClearBufferCommand` 是显式有序 GPU 写入。它的 target 是一个不可变
`BufferRegion`；非空 region 会直接 lower 到 `GPUCommandEncoder.clearBuffer()`，
而不是 CPU upload 或 compute emulation:

```ts
const clearCounters = runtime.createClearBufferCommand({
    label: 'clear counters',
    target: counters.region({ offset: 0, size: 256 }),
})

const submitted = runtime.createSubmission()
    .clear(clearCounters)
    .submit()
```

当前 target allocation 必须带有 `COPY_DST` usage。Offset 与 size 必须按四字节
对齐，并在 command 到达其声明 submission step 时仍位于当前 allocation 范围内。
非空 clear 会贡献一次 parent-buffer write，推进一个 content epoch，参与 dependency
validation 与 potential-write tracking；如果延后的 native observation 使这一仍为
current 的写入失效，其内容会进入 indeterminate。零长度 region 不贡献 resource
access、epoch、potential write 或 native command。

确定性的 target、usage、alignment 与 range failure 使用
`SCRATCH_COMMAND_CLEAR_BUFFER_INVALID`。Native validation、internal、
out-of-memory、device-loss 与 observation failure 仍通过共享 native error model
成为 submission outcome。

## 渲染资源

同一模型覆盖图形资源:

- 非空 writable render attachment 是声明式写入，并且每个 pass 至多推进一次
  parent resource 的 `contentEpoch`。Null color slot 没有 resource fact。
- 持久 resolve target 是独立声明式写入，并且无论 multisampled source 被 store
  还是 discard，都推进一次 parent resource 的 `contentEpoch`。Surface resolve
  target 只有 lease 与 native-observation facts，不虚构持久 epoch。
- 后续 pass 采样该 texture 时，声明读取已产生的 `contentEpoch`。
- Read-only depth 或 stencil aspect 是声明式读取，并且必须已经 ready；writable
  aspect 是声明式写入。内部 conflict validation 感知 subresource/aspect，而公开
  epoch 仍是 whole-resource fact。
- surface current texture 是借来的 presentation-submission-scoped target，不是持久 `TextureResource`。它不能在获取它的 presentation submission 之外保留。
- `TextureResource.resize()` 会推进 `allocationVersion`，并把 replacement 标为 empty。Dependent BindSet 变为 stale，且要求显式 acknowledged `prepare()`；PassSpec attachment 保留逻辑 TextureViewSpec，并创建受观察的 submission-scoped native view。Submission 不执行隐藏 binding repair。
- TAA history、trails、迭代仿真纹理这类 temporal resources 都是普通资源; 它们的 previous-frame contents 由 content epochs 表达，而不是内核里的特殊一等特性。

## Timing 与 Query

GPU timing 与 visibility query 复用同一套 transfer 模型。`QuerySetResource` 名称沿用 WebGPU `GPUQuerySet`; 它是 indexed slot resource，不是无序集合。

核心 query-set contract:

```ts
type QuerySetType = 'timestamp' | 'occlusion'
const timingQueries = await runtime.createQuerySet({
    label: 'simulation timing',
    type: 'timestamp',
    count: 2,
})
```

- `count` 是 indexed query slots 的数量。
- Query slot 通过显式 index 或 index range 访问。
- `timestamp` 需要 `timestamp-query` feature，可用于 render 或 compute pass 的 `timestampWrites`。
- `occlusion` 通过 `occlusionQuerySet` 和 begin/end occlusion query brackets 属于 render pass。
- query write 会推进 query slot 的 content epoch。resolve query results 会推进 destination buffer 的 `contentEpoch`。
- resolve command 会在构造时深度冻结唯一一份归一化 `source` 与 slot array。Readiness、epoch validation、`firstQuery`、`queryCount` 与 native encoding 都消费这同一份 snapshot。
- 不支持的 feature 通过结构化 diagnostic 失败。可选 profiling policy 属于 Scratch core 之上的层。

Timestamp writes 是 pass-level instrumentation:

```ts
const simulationPass = runtime.createComputePass({
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
const visibilityQueries = await runtime.createQuerySet({
    label: 'tile visibility',
    type: 'occlusion',
    count: tileCapacity,
})

const scenePass = runtime.createRenderPass({
    label: 'scene',
    color: [
        {
            target: sceneColor.view(),
            load: 'load',
            store: 'store',
        },
    ],
    depth: {
        target: depth.view(),
        depthLoad: 'load',
        depthStore: 'store',
    },
    occlusionQuerySet: visibilityQueries,
})

const drawTileWithVisibility = [
    runtime.createBeginOcclusionQueryCommand({ querySet: visibilityQueries, index: tileIndex }),
    drawTile,
    runtime.createEndOcclusionQueryCommand(),
]
```

Query result 只有显式 resolve 并 read back 后才 CPU-visible:

```ts
const timingRegion = timingBuffer.region({ size: 16 })
const resolveTiming = runtime.createResolveQuerySetCommand({
    source: {
        querySet: timingQueries,
        slots: [
            { index: 0, contentEpoch: 1 },
            { index: 1, contentEpoch: 1 },
        ],
    },
    destination: timingRegion,
    whenMissing: 'throw',
})

const submitted = runtime.createSubmission()
    .compute(simulationPass, [simulateParticles])
    .resolve(resolveTiming)
    .submit()

const timingReadback = runtime.createReadback({
    source: timingRegion,
    after: submitted,
})

const timingValues = await timingReadback.toArray(BigUint64Array)
```

Pipeline statistics 不是当前 WebGPU core contract 的一部分; 除非未来 WebGPU target 或显式 extension 支持，否则必须留在 scratch core 之外。

使用 `09-diagnostics-validation` 共享 envelope 的当前 query-path diagnostic codes:

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
```

Query diagnostic 应携带 query-set id、type、requested range、pass 或 command id、相关 feature name、resolve 失败时的 destination buffer id，以及 query slot 被写入时的 producer submission id。这些细节应进入 `subject`、`related`、`expected`、`actual` 或 compact evidence fields，而不是只写在 prose 里。

## Retention、预算与诊断

Readback retention 是显式 ownership，不是隐藏 garbage collection。已实现的
runtime policy 有限且保守:

- operation 保留到 consumed、cancelled、disposed 或 failed
- pending-operation 或 staging-byte capacity 超限时，在 native allocation 前失败
- retained host bytes 与 GPU staging bytes 分开计数
- 绝不静默淘汰 readback result
- operation/incident history 与 current facts 分别保持有界

配置形状示例:

```ts
const runtime = await ScratchRuntime.create({
    readback: {
        maxPendingOperations: 16,
        maxStagingBytes: 64 * 1024 * 1024,
    },
})
```

Stale-operation warning、automatic eviction 与 mapped-view lease budget 是
follow-up policy，不是已实现 budget contract 上的 alias 或 optional flag。

使用 `09-diagnostics-validation` 共享 envelope 的稳定 readback provenance
codes 包括:

```ts
type ReadbackDiagnosticCode =
    | 'SCRATCH_READBACK_STAGING_BUDGET_EXCEEDED'
    | 'SCRATCH_READBACK_STAGING_VALIDATION_FAILED'
    | 'SCRATCH_READBACK_STAGING_OUT_OF_MEMORY'
    | 'SCRATCH_READBACK_STAGING_SCOPE_FAILED'
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
    | 'SCRATCH_READBACK_SOURCE_CONTENT_INDETERMINATE'
    | 'SCRATCH_READBACK_SOURCE_ALLOCATION_STALE'
    | 'SCRATCH_READBACK_SOURCE_EPOCH_STALE'
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
