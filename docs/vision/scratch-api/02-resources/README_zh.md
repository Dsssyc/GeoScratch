# Resources

状态: Vision draft
日期: 2026-07-13

## 决策

Scratch resource 是身份稳定的逻辑容器。解释方式与 subresource selection 属于不可变逻辑值，而不是可变的 resource-global layout state。

真实层级为:

```text
Resource
    BufferResource
    TextureResource
    SamplerResource
    QuerySetResource
```

`Resource` 拥有 runtime identity、label、descriptor、kind、allocation lifecycle 与 disposal。只有 Buffer 和 Texture 拥有 scalar content state、`contentEpoch`、readiness 与已知 logical footprint。Sampler 没有 content/readiness 语义。QuerySet 按 indexed slot 分别追踪 state 与 epoch，而不是伪造一个 object-wide scalar fact。

`BindLayout` 与 `BindSet` 是 acknowledged supporting object，不是 Resource 子类。Presentation current texture 是 submission-scoped borrowed target，不是持久 resource。

原始 resource descriptor 是 canonical Scratch 输入，不是留给隐式 Web IDL
coercion 的值。Buffer `size` 必须已经是精确、非负且位于 JavaScript
safe-integer 范围内的 `GPUSize64`；texture extent、mip count 与 sample count
必须已经是正的 safe-integer `GPUIntegerCoordinate`，并处于原生 32-bit domain。
Buffer 与 texture usage 必须已经是 `[0, 0xffffffff]` 内的整数
`GPUFlagsConstant`。非法 label 与 boolean 会被拒绝，不会被静默省略或转换。
因此 Scratch 保留的逻辑 descriptor 与实际 issue 的 descriptor 完全一致。原生
`1d` texture 不能拥有 mipmap，所以 `mipLevelCount` 必须为 `1`；更大的值会在
native issue 前被 Scratch 拒绝。合法的单 mip `1d` texture 及其 persistent view
仍然可用，并继续遵守原生 extent、sample、format 与 usage 约束。

## Allocation 与 Content

只有逻辑 resource 安装不同 physical native allocation 时，`allocationVersion` 才变化。产生 bytes 或 texels 时，`contentEpoch` 才变化。二者彼此独立:

- upload、copy、render/storage write、clear、resolve 与 mip generation 推进 content；
- texture resize 替换 allocation、保留 content history，并把 replacement 标为 empty；
- content-only write 绝不会使 prepared BindSet 失效；
- allocation replacement 会使每个受影响 BindSet 变成 stale，直到显式 `prepare()` 成功。

Scratch 只报告可推导的 logical footprint，不声称 physical residency，也不把 aggregate OOM 归因于单一 resource。

## BufferResource 与 BufferRegion

`BufferResource` 是裸 physical byte container。它不拥有 global layout、element count 或 typed byte length。

```ts
const storage = await runtime.createBuffer({
    label: 'shared storage',
    size: 1 << 20,
    usage: GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.STORAGE,
})

const whole = storage.region()
const records = storage.region({
    offset: 4096,
    size: 16384,
    layout: recordLayout,
})
```

`BufferRegion` 是只能通过 `BufferResource.region()` 或另一个 region 创建的 frozen、non-extensible 逻辑值。它保存一个 parent buffer、归一化的 absolute `offset`/`size`，以及可选 `LayoutArtifact` witness。它不拥有 memory、identity、epoch、readiness、allocation version 或 disposal state。

```ts
const rawChild = records.subregion({ offset: 256, size: 512 })
const typedChild = rawChild.interpretAs(recordLayout)
```

Subregion offset 相对 source region，并立即归一化到 parent buffer。Layout 不会隐式继承。Region 可以重叠。`interpretAs()` 不搬运 bytes，只创建另一个 frozen view；typed-to-typed reinterpretation 要求 canonical ABI compatibility。若确实需要不同 physical interpretation，必须从 parent buffer 显式创建。

所有 range consumer 都使用 BufferRegion: upload、readback、copy 的所有 buffer 端、vertex/index binding、indirect argument、query resolve destination 与持久 buffer binding。Parent disposal 会使全部用途失效。Allocation replacement 后，会针对 current native allocation 重新校验 bounds、usage 与 alignment。

## LayoutArtifact 与 LayoutCodec

`LayoutCodec` 从同一个不可变 `LayoutArtifact` 同步准备 CPU packing、WGSL accessor 与 readback view:

```ts
const codec = layoutCodec({
    name: 'Particle',
    fields: [
        { name: 'position', type: 'vec3f' },
        { name: 'mass', type: 'f32' },
    ],
}, {
    usage: [ 'storage', 'readback' ],
})

const particleLayout = codec.artifact
```

每个 artifact 暴露两类独立事实:

- `abiHash` 标识归一化 GPU-visible alignment、offset、size、stride 与 physical type；
- `schemaHash` 标识 logical name、field name/order、nesting 与 semantic type。

短 hash 是有界 identifier，不是无碰撞证明。Scratch 还会保留并比较不可变 canonical ABI/schema signature。Typed Program requirement 默认要求 exact schema compatibility；native binding 另行校验 ABI、usage、range 与 alignment。ABI-compatible schema reinterpretation 绝不会自动发生。

只有当每个 array count、byte-size product、field offset/end 与最终 alignment round-up
都保持为非负 JavaScript safe integer 时，layout lowering 才会发布 artifact。overflow
会以 `SCRATCH_LAYOUT_UNSUPPORTED_FORMAT` 和结构化 arithmetic facts fail closed；
Scratch 绝不会发布内部自相矛盾的 `LayoutArtifact`。

## TextureResource 与 TextureViewSpec

`TextureResource` 是身份稳定的逻辑 texture，其 current `GPUTexture` allocation 可以显式替换:

```ts
const color = await runtime.createTexture({
    label: 'scene color',
    size: surface.size,
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
})

const sampled = color.view({
    dimension: '2d',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
})
```

`TextureResource.view()` 是同步的。它物化所有 descriptor default，并返回 frozen `TextureViewSpec`；它不会调用 native `createView()`，也不暴露 `GPUTextureView`。Spec 始终关联逻辑 texture，并针对每个后续 allocation 重新校验。

View usage 会按真实 native contract 校验，而不只是检查 bit subset。Transient attachment 的 view 必须保留 texture 的 exact usage；包含 `RENDER_ATTACHMENT` usage 的 view 必须使用 device-enabled renderable format；包含 `STORAGE_BINDING` usage 的 view 必须使用至少支持一种 device-enabled storage access mode 的 plain color format。Texture allocation preflight 也使用同一组 render/storage format capability facts。Scratch 让这些事实与 storage-texture BindLayout validation 共用一个内部表，因此确定性非法的 usage/format 组合不会一直存活到 native `createView()`。

BindSet preparation 私有拥有 candidate snapshot 的 allocation-scoped native view。Render attachment 在 submission 内把 `TextureViewSpec` 降低成 submission-scoped native view，并通过 `SubmittedWork` 观察 native outcome；不会跨 submission 缓存。直接调用 `texture.gpuTexture.createView()` 是显式逃离 Scratch ownership、versioning、diagnostics 与 repair guarantee。

`TextureResource.resize()` 是返回 Promise 的 create-before-swap transaction。旧 allocation 保持 current，直到 candidate 被 acknowledgement；然后原子安装 replacement、推进一次 `allocationVersion`、保留 `contentEpoch`、把 content 标为 empty，并销毁旧 texture。Failure 或 lifecycle cancellation 会保留旧 allocation。Normalized same-size resize 是真正的 no-op。

若逻辑 view descriptor 与 replacement 不兼容，会确定性 preflight 失败。兼容 view 仍是同一逻辑对象；dependent BindSet 变为 stale 并要求显式 preparation，persistent pass spec 则在每次 submission 降低 current allocation。

## SamplerResource

Sampler 创建是 Promise-only:

```ts
const sampler = await runtime.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
})
```

Scratch 校验完整 native descriptor，在 validation/internal/OOM scope 内 issue 一次 `createSampler()` candidate，并只在 acknowledgement 与 lifecycle 复核后注册。SamplerResource 有 allocation lifecycle 与 disposal，但没有 scalar content state、content epoch、readiness 或 footprint。

## QuerySetResource

Query-set 创建遵循同样的 acknowledged candidate protocol:

```ts
const queries = await runtime.createQuerySet({
    type: 'timestamp',
    count: 2,
})
```

核心 query type 是 `timestamp` 与 `occlusion`。Timestamp 要求 native feature；occlusion 不虚构 feature。`queries.slot(index)` 与 `queries.slots()` 返回包含 `state` 和 `contentEpoch` 的 frozen indexed snapshot。QuerySetResource 没有 scalar content epoch 或含糊的 whole-object readiness。Pipeline statistics 不属于 core WebGPU，也不属于 Scratch core。

## Readiness

Buffer 与 Texture content state 为:

```ts
type ResourceState = 'empty' | 'ready' | 'indeterminate'
```

`indeterminate` 表示迟到的 native 或 queue failure 使 Scratch 无法证明 still-current content 与其历史 epoch 一致。它绝不回滚 epoch。后续显式 producer 会推进新 epoch 并恢复 `ready`。Indexed query slot 独立使用同一套 content-state vocabulary。

Disposal 属于 allocation lifecycle，通过独立的 `resource.isDisposed` 暴露；它不会混入 scalar 或 indexed content state。

Indeterminate read 会根据 subject 分别以
`SCRATCH_COMMAND_RESOURCE_CONTENT_INDETERMINATE`、
`SCRATCH_QUERY_SLOT_CONTENT_INDETERMINATE` 或
`SCRATCH_PASS_ATTACHMENT_CONTENT_INDETERMINATE` 结构化失败。

Readiness policy 属于读取内容的 Command 或 Pass，不属于 container。它不能隐藏 `indeterminate` content，也不能绕过 lifecycle、ownership、usage、range、schema 或 binding validation。

## 非目标

- 不提供 resource-global mutable layout 或隐式 typed buffer interpretation。
- 不提供公共 Scratch-managed native texture-view cache。
- 不做 runtime resource search 或 reverse dependency graph。
- Allocation replacement 后不自动进行 BindSet preparation。
- 不把 physical VRAM estimate 冒充已知事实。
- Scratch core 不引入 scene、material、style、layer、terrain 或 flow policy。
