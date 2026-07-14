# Bindings

状态: Vision draft
日期: 2026-07-13

## 决策

Scratch 将 native binding ABI 与具体资源选择分开:

- `BindLayout` 是权威且不可变的 WebGPU binding ABI。
- `BindSet` 冻结一份 name-to-resource-view 映射，并拥有一个经过确认的 prepared native snapshot。
- `Program.layoutRequirements` 保存 shader 的 typed schema 预期。
- `Command` 为一次可执行动作组合 pipeline、bind-set invocation、dynamic offset 与显式 resource access。

Vertex buffer、index buffer、indirect argument、count、readiness policy、shader source，以及 scene/material 语义都不属于 `BindSet`。

## BindLayout

Bind layout 创建是 Promise-only，因为成功意味着持久 `GPUBindGroupLayout` 已被 native acknowledgement:

```ts
const terrainLayout = await runtime.createBindLayout({
    label: 'terrain group',
    group: 0,
    entries: [
        {
            binding: 0,
            name: 'camera',
            type: 'uniform',
            visibility: [ 'vertex' ],
            minBindingSize: 256,
        },
        {
            binding: 1,
            name: 'nodes',
            type: 'read-storage',
            visibility: [ 'vertex' ],
            hasDynamicOffset: true,
        },
        {
            binding: 2,
            name: 'dem',
            type: 'texture',
            sampleType: 'float',
            viewDimension: '2d',
            visibility: [ 'fragment' ],
        },
        {
            binding: 3,
            name: 'linear',
            type: 'sampler',
            samplerType: 'filtering',
            visibility: [ 'fragment' ],
        },
    ],
})
```

Scratch 会预检 name、binding index、visibility、device feature、limit、buffer type、dynamic-offset contract、`minBindingSize`、sampled-texture shape、storage-texture access/format/dimension 与 sampler type。Acknowledged transaction 只 issue 一次 native layout creation；validation、internal 与 OOM scope settle 且 lifecycle 事实复核通过后才注册对象。

Supporting-object acknowledgement 会先 join 同一次 native issue 周围已经 issue
的全部 scope，再选择结果。并发的 runtime disposal 或 device loss lifecycle fact
不能与该 join 竞速、遮蔽已经观察到的 native/scope failure，也不能仅因更早
settle 就成为 primary。Scratch 对完整证据采用固定顺序：同步 native issue、
结构性 scope failure、validation、internal、OOM、runtime disposal、device loss；
更晚的 lifecycle fact 作为有界 secondary evidence 保留。Sampler、QuerySet、
BindLayout 与 BindSet preparation candidate 都使用同一规则。Runtime disposal
与 device loss 不是互斥事实；两者都被观察到时，会按上述固定顺序同时保留。

当 device loss 是 supporting-object failure 的 primary 时，Scratch 会保留两种
不同范围的证据：runtime-wide `device-loss` incident，以及关联到 `cancelled`
creation/preparation operation 的 `exact-operation` `supporting-object-failure`
incident。抛出的 diagnostic 指向后者并通过 related 关联前者；两者不能互相替代。

Pipeline lowering 把 `BindLayout.group` 视为 native pipeline-layout index，调用方数组顺序没有语义。Sparse group 会产生显式 `null` slot，因此 group `0` 与 `2` 会降低成 `[group0, null, group2]`。当前 WebGPU 把 `bindGroupLayouts` 定义为 nullable sequence，并把缺失 index 初始化为原生 `null` slot；Scratch 不会为这些 gap 合成空 `GPUBindGroupLayout` 对象。WebGPU 定义在完整 `GPUPipelineLayout` 上的 limit，会针对所有 non-null group entry 的拼接结果再次校验。因此，即使两个 layout 各自没有超过 dynamic-buffer 或 per-stage slot limit，组合后仍可能在任何 native pipeline object issue 前被拒绝。

持久 binding matrix 覆盖:

- uniform、read-only storage 与 read-write storage buffer；
- filtering、non-filtering 与 comparison sampler；
- float、unfilterable-float、depth、signed-integer 与 unsigned-integer sampled texture，包括全部 native-valid view dimension 与 multisampled 约束；
- write-only、read-only 与 read-write storage texture，具有显式 format 和 native-valid `1d`、`2d`、`2d-array` 或 `3d` dimension。

在不具备 `core-features-and-limits` 的 device 上，WebGPU bind-group validation
要求每个已绑定 sampled 或 storage texture view 使用 `baseArrayLayer: 0`，且
`arrayLayerCount` 等于 parent texture 的完整 layer count。layer-subset
`TextureViewSpec` 对其他操作仍可作为合法 logical/native view，但 Scratch 会拒绝
将其作为该类 device 上的 persistent binding。

Sampler normalization 保留 WebGPU
`[Clamp] unsigned short maxAnisotropy` 的数值语义：numeric input 会先 clamp 到
`[0, 65535]`，再舍入到最近整数；恰好位于两个整数中间时选择偶数。该结果会用于
descriptor hash 与 native issue，之后 Scratch 再校验 normalized value 至少为 `1`，
且大于 `1` 时 mag、min 与 mipmap filter 均为 linear。Typed Scratch descriptor
仍要求 JavaScript `number`，不会额外引入 string 或 object coercion。

`storage` buffer binding 遵循 WebGPU 的 read-write storage contract。每个绑定它的
command 都必须把 parent buffer 同时声明在 `resources.read` 和
`resources.write` 中。所需 read epoch 必须已经存在，因此新 buffer 必须先经过
显式 upload、copy 或更早的 GPU producer 初始化，之后 command 才能使用该 binding。

`externalTexture` 在拥有独立 frame/task lifetime contract 前明确排除。Shader reflection 可以交叉检查显式 layout，但绝不是生产路径的真相来源。

## BindSet

核心只接受以下持久 binding value:

```ts
Record<string, BufferRegion | TextureViewSpec | SamplerResource>
```

Whole buffer、whole texture、native GPU object 与 legacy wrapper 都会被拒绝。资源选择是显式且 many-to-many 的:

```ts
const terrainSet = await runtime.createBindSet(terrainLayout, {
    camera: cameraBuffer.region({ size: 256, layout: cameraLayout }),
    nodes: sharedBuffer.region({ offset: 4096, size: 16384, layout: nodeLayout }),
    dem: demTexture.view({ dimension: '2d' }),
    linear: linearSampler,
})
```

Binding table 不可变。若要绑定另一组逻辑资源，必须创建另一个 BindSet。内容写入不改变 native binding shape，也绝不会使 preparation 失效。

`await runtime.createBindSet(...)` 只返回 initially prepared 对象。Preparation 私有创建 allocation-scoped texture view 和一个 bind group，并在 native scope acknowledgement 与 lifecycle/snapshot 复核后原子提交。同一 candidate 内可以去重完全相同的 texture view；不存在 runtime-wide 或 cross-BindSet native-view cache。

## Preparation 生命周期

BindSet 暴露:

- `preparationState`: `preparing | prepared | stale | disposed`；
- `prepareGeneration`；
- `preparedSnapshotHash`；
- current/last preparation 与 incident id。

已经绑定的逻辑资源发生 allocation replacement 后，snapshot 变为 stale。Submission 绝不 prepare、等待、重试或修复:

```ts
await colorTexture.resize(nextSize)

// 逻辑 view 与 slot mapping 未变，但 native snapshot 已 stale。
await colorSet.prepare()
```

Stale、preparing、failed 或 disposed set 会在 encoder creation 前结构化失败。成功 re-prepare 只让 generation 增加一次。失败后对象保持 stale，并丢弃全部 candidate native reference；只允许显式 retry。

针对同一 current snapshot 的并发调用共享一个 in-flight Promise。若 pending 期间另一调用观察到不同 snapshot，则以结构化 conflict diagnostic 失败；不会排队，也不会后台重启。Allocation drift、disposal、runtime shutdown 或 device loss 都会阻止 commit。

## Dynamic Offset

Dynamic offset 属于不可变 command invocation，不属于可变 BindSet state:

```ts
const draw = runtime.createDrawCommand({
    pipeline,
    bindSets: [ {
        set: terrainSet,
        dynamicOffsets: {
            nodes: 1024,
        },
    } ],
    count: { vertexCount: 3 },
    resources,
    whenMissing: 'throw',
})
```

每个 dynamic entry 都必须按名给出，包括显式零。Missing、extra、fractional、negative、non-finite 或超出 native range 的值在 command construction 时失败。Scratch 只在构造期按 native binding-index order 归一化一次，并保存不可变 offset sequence。Submission 不执行 name sorting 或 offset-sequence reconstruction。

Buffer binding 的有效范围为:

```text
effectiveOffset = region.offset + dynamicOffset
effectiveSize = region.size
```

Encoder creation 前会针对 current allocation 重新校验 bounds 与 uniform/storage alignment。不同 command 可以用不同 offset 复用同一个 prepared BindSet，而不改变其 snapshot 或 generation。

## Program 兼容性

校验保持分层:

1. Pipeline creation 将 `Program.layoutRequirements` 与 `BindLayout` ABI 事实比较: group/binding、visibility、buffer type、dynamic-offset contract、`minBindingSize`、device feature 与 limit。
2. Command preflight 将实际绑定的 `BufferRegion` 与 Program requirement 比较: runtime/lifecycle、current allocation、usage、range、alignment、canonical ABI compatibility 与 exact canonical schema compatibility。
3. Command 的显式 resource access 必须覆盖 binding 隐含的每个 buffer/texture read/write，包括 storage-texture access。

`abiHash` 与 `schemaHash` 是有界 diagnostic identifier，不是无碰撞证明。兼容性还会比较不可变 canonical signature，并报告有界 structural difference。

## 非目标

- 不提供 mutable rebinding 或 `BindSet.set()`。
- 不做隐藏 resource search、shader-driven auto-binding 或 resource-to-BindSet reverse graph。
- 不在 submission 时创建 native binding，也不自动 preparation。
- 不提供 raw ordered dynamic-offset array overload。
- 不在 `BindSet` 中放 vertex/index state、count、readiness policy、material、style、scene 或 layer 语义。
- 不输出 prose-only binding validation error。
