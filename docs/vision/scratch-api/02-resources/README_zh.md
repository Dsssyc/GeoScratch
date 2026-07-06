# Resources

状态: Vision draft
日期: 2026-07-06

## 决策

`Resource` 是由 `ScratchRuntime` 拥有的逻辑句柄。它不只是某个 `GPUBuffer` 或 `GPUTexture` 的薄包装。

逻辑资源记录稳定身份和重建信息。物理 GPU 对象可以因为 descriptor shape 变化、尺寸变化或 device loss 被替换。普通内容变化应推进 content epoch，而不是替换 physical binding target。

## 核心概念

每个资源应暴露或内部追踪:

- runtime owner
- logical id
- label
- descriptor shape
- 当前物理 GPU 对象
- `allocationVersion`
- `contentEpoch`
- readiness state
- pending transfer operations 或 replacement
- disposal state

当 physical binding target 变化时，`allocationVersion` 递增。Bind set、view cache、pass attachment 与 command 可以利用它做惰性重建。

当 bytes 或 texels 变化时，`contentEpoch` 递增。Upload、copy、render attachment 写入、storage 写入、clear、resolve、mip generation 都是 content producer。Readback 与 dependency validation 使用 content epoch; bind-group invalidation 使用 allocation version。

## 资源类型

目标资源族:

- `BufferResource`
- `TextureResource`
- `SamplerResource`
- `ShaderModuleResource`
- `QuerySetResource`(有索引的 timestamp / occlusion query slots，按需 feature-gated)
- presentation-submission-scoped borrowed surface texture views

Surface texture view 不是持久 `TextureResource`。

`QuerySetResource` 沿用 WebGPU 的 `GPUQuerySet` 命名。这里的 `Set` 不表示数学意义上的无序集合。query set 是固定 `count` 的 indexed slot resource; pass instrumentation 和 query command 会写入具体 query index，resolve command 会把显式 index range 拷贝到 buffer。

核心 query type 刻意限制为当前 WebGPU query 原语:

```ts
type QuerySetType = 'timestamp' | 'occlusion'
```

`timestamp` query set 需要 `timestamp-query` feature。`occlusion` query set 属于 render pass。Query set 是用于 ownership、lifetime、usage validation 和 slot epoch tracking 的资源，但不是可被 shader bind 的资源。

## BufferResource

Buffer 应支持:

- 显式 usage 声明
- 可选 initialization source，并降低为显式 upload
- pending transfer preparation 的 dirty range tracking
- copy source 与 copy destination usage
- storage、vertex、index、uniform、indirect、map 等适用 usage

静态数据不应需要 per-submission callback。动态数据应通过显式 upload/copy command 表达，或由 tracked handle 在 submission preparation 时产生 upload command。

示例形状:

```ts
const positions = scratch.buffer({
    label: 'positions',
    usage: ['vertex', 'storage', 'copyDst'],
    struct: [
        { name: 'position', format: 'float32x3' },
    ],
})

const uploadPositions = scratch.command.upload({
    target: positions,
    data: nextPositions,
    range: { offset: 0 },
})
```

## Buffer Layout

buffer 是裸字节; 它的 layout 声明这些字节如何被定型，是 GPU 侧(vertex layout / WGSL struct)与 CPU 侧(readback 视图)字节解释的唯一真相源。

layout 是**可组合的**，不是一组固定模式。buffer 是一串 **segment**; 每个 segment 是某个 **element** 的数组(`count`); element 要么是标量/向量 `format`，要么是带命名字段的嵌套 `struct`——而 struct 的字段本身也是 element，所以 struct 可嵌套。

```ts
const sim = scratch.buffer({
    usage: ['storage', 'copySrc'],
    segments: [
        // 一个 struct 的 segment（AoS 区段）
        { name: 'particles', count: 1000, struct: [
            { name: 'pos', format: 'float32x3' },
            { name: 'vel', format: 'float32x3' },
        ] },
        // 一个标量的 segment（SoA 区段）
        { name: 'flags', count: 1000, format: 'sint8' },
    ],
})
```

那些熟悉的形态只是这一套语法里的点:

- **同质** —— 一个 segment、标量 element。
- **AoS** —— 一个 segment、struct element。
- **SoA** —— 多个 segment、标量 element。
- **SoA of AoS** —— 多个 segment，其中一些是 struct(如上)。

单 segment 的 buffer 可以把 element 内联成糖——顶层 `format` + `count`，或 `struct` + `count`——这恰好就是单 segment 的 layout。

runtime 按目标 usage 从声明 layout 算出 offset、stride、padding 并暴露出来，于是 CPU 视图与 GPU 解释自动对齐，无需手算 padding。两条约束:

- **对齐 / padding。** WGSL storage struct 遵循对齐规则(`vec3<f32>` 对齐到 16、struct size 向上取整到最大成员的对齐)，与更宽松的 vertex 属性规则不同。若把一个 segment 单独作为 storage binding 用 dynamic offset 绑定，其起点须满足 `minStorageBufferOffsetAlignment`(常见 256); runtime 会 pad 并报告真实字节 offset。
- **子 32 位类型。** WGSL 没有 `i8`/`u8` storage 标量。8 位字段作为 vertex 属性(`sint8x4`、`unorm8x4`)或用于 readback 都没问题，但 compute 着色器要按 `u32` 读再 unpack。按消费者选字段类型。

Readback 通过显式 `ReadbackOperation` 遵循同样的组合(见 `07-transfers-epochs`)。segment 按名寻址: 创建 `scratch.readback({ source: buf.segment('flags'), after })` 后，标量 segment 可通过 `await readback.toArray()` 给出 `TypedArray`; struct segment 给出 `ArrayBuffer` 加上按 layout 派生的 `ArrayBufferView`。AoS 字段是 strided 的，所以用 `DataView` 或显式 deinterleaved copy，而不是一个定死的 typed array。核心 resource 不暴露 `buf.toArray()` / `buf.toBytes()` 糖。

### Layout Artifact 与 Codec

layout compiler 应产出可 inspect 的 `LayoutArtifact` 与可选 `LayoutCodec`(见 `08-programs-codecs`):

- `LayoutArtifact` 是数据: 已解析的 byte offset、stride、padding、alignment mode、total byte length、usage lowering 与 structural hash。
- `LayoutCodec` 是准备逻辑: 由同一个 artifact 派生的 CPU writer、upload byte view、readback view factory 与 WGSL accessor module。

这是 CPU array 需要写入 GPU-aligned storage-buffer layout 时的推荐路径:

```text
source array -> CPU writer 填充 GPU-aligned bytes -> 一个显式 UploadCommand
```

writer 在 CPU 侧跳过 padding，并写出一个连续 upload range。它避免每个 structure 一次 CPU/GPU 调用，也避免 GPU repack pass 临时占用第二份完整 VRAM buffer。Raw packed buffer 仍可作为 escape hatch，但默认模型不应迫使 WGSL 作者手动复刻 storage-buffer padding。

外部 AoS feature schema 可以通过产出兼容 `LayoutSpec` 或预计算 `LayoutArtifact` 降低到这套语法。如果它们的内存已经 GPU-aligned，upload 可使用 direct bulk view; 否则 CPU writer 在显式 upload 前执行 alignment step。

## TextureResource

Texture 应支持:

- 显式 usage 声明
- 固定 size 或 size provider
- format 与 sample count
- mip policy
- 基于 view descriptor 的 view cache
- resize invalidation
- storage texture read/write 声明
- attachment write 与 sampled-read 声明

示例形状:

```ts
const sceneColor = scratch.texture({
    label: 'scene color',
    size: derived(() => surface.size, [surface]),
    format: 'rgba16float',
    usage: ['render', 'sample', 'copySrc'],
})

sceneColor.invalidateSize()
```

## Readiness State

资源应有显式状态。具体 enum 可以演进，但模型应区分:

```ts
type ResourceState =
    | 'empty'
    | 'ready'
    | 'dirty'
    | 'resizing'
    | 'lost'
    | 'disposed'
```

`dirty` 表示资源逻辑上可用，但在记录依赖新数据的 command 前，有显式 transfer 或 replacement operation 请求的 pending preparation。`empty`、`lost`、`disposed` 不可用。

## 动态值: 受追踪的值优于闭包

喂给资源的值(size、初始或更新数据)有时静态、有时随运行时变化。按它编码的内容来表达:

- 静态值、构造时即可得 → 直接传值; 不要包 thunk。
- 运行时变化的数据 → 用"身份稳定、内容可变"且可降低成显式 upload command 的句柄，或由前序 command 写入的 GPU resource。
- 由其他受追踪来源算出的运行时变化值(例如 texture size 来自 surface)→ 用 **derived value**: runtime 能 inspect 它的依赖、订阅其 invalidation、并在 validation 时检查它。
- 最后手段 → 裸闭包，仅当没有句柄或 derived value 能表达该情况时。

受追踪的句柄或 derived value 可 inspect、能感知 invalidation; 而裸的 `size: () => surface.size` 闭包是黑箱——runtime 必须每次 submission poll 它，且无从得知它何时、为何变化。该规则可推广到 command count(`04-pipelines-commands`)。

## Missing Resource Policy

缺失或 readiness 策略不属于 resource 自己。它属于使用该资源的 command 或 pass，因为同一个资源在不同上下文中语义不同。

```ts
type ResourceReadinessPolicy =
    | 'throw'
    | 'skip-command'
    | 'skip-pass'
    | 'use-fallback'
```

该策略必须在使用点显式声明。

## 非目标

- 不在 resource 中编码 tile、LoD、terrain、flow 或 projection policy。
- 不让 resource 通过 callback 直接重建 bind group。
- 不强迫所有 dynamic count 或 readiness check 都通过 CPU closure。
- 不把 surface swapchain texture 做成持久 resource。
- 不暴露核心 `resource.write()` 方法; upload 是显式 transfer。
- 不暴露核心 `resource.toArray()` / `resource.toBytes()` 方法; readback 创建显式 operation。
