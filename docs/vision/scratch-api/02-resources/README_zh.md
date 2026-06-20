# Resources

状态: Vision draft
日期: 2026-06-20

## 决策

`Resource` 是由 `ScratchRuntime` 拥有的逻辑句柄。它不只是某个 `GPUBuffer` 或 `GPUTexture` 的薄包装。

逻辑资源记录稳定身份和重建信息。物理 GPU 对象可以因为数据变化、尺寸变化或 device loss 被替换。

## 核心概念

每个资源应暴露或内部追踪:

- runtime owner
- logical id
- label
- descriptor shape
- 当前物理 GPU 对象
- version number
- readiness state
- pending dirty ranges 或 replacement
- disposal state

当物理 binding target 变化时，resource version 递增。Bind set 与 pipeline 可以利用 version 做惰性重建。

## 资源类型

目标资源族:

- `BufferResource`
- `TextureResource`
- `SamplerResource`
- `ShaderModuleResource`
- frame-scoped borrowed surface texture views

Surface texture view 不是持久 `TextureResource`。

## BufferResource

Buffer 应支持:

- 显式 usage 声明
- 可选 initial data
- dirty range tracking
- direct write request
- copy source 与 copy destination usage
- storage、vertex、index、uniform、indirect、map 等适用 usage

静态数据不应需要 per-frame callback。动态数据应标记 dirty ranges，并由 frame prepare 步骤批量上传。

示例形状:

```ts
const positions = scratch.buffer({
    label: 'positions',
    usage: ['vertex', 'storage', 'copyDst'],
    data: new Float32Array(...),
    layout: [
        { name: 'position', format: 'float32x3' },
    ],
})

positions.write(nextPositions, { offset: 0 })
```

## TextureResource

Texture 应支持:

- 显式 usage 声明
- 固定 size 或 size provider
- format 与 sample count
- mip policy
- 基于 view descriptor 的 view cache
- resize invalidation
- storage texture read/write 声明

示例形状:

```ts
const sceneColor = scratch.texture({
    label: 'scene color',
    size: () => surface.size,
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

`dirty` 表示资源逻辑上可用，但在记录依赖新数据的 command 前需要 prepare。`empty`、`lost`、`disposed` 不可用。

## 动态值: 句柄优于闭包

喂给资源的值(size、初始或更新数据)有时静态、有时随运行时变化。按它编码的内容来表达:

- 静态值、构造时即可得 → 直接传值; 不要包 thunk。
- 运行时变化的值 → 优先用"身份稳定、内容可变"的句柄(array ref，或 runtime 能追 dirty 的 buffer)，而不是不透明闭包。句柄可 inspect、可追 dirty; 闭包对 validation 是黑箱。

`size: () => surface.size` 这种 provider 是正当的: surface 尺寸在构造时未知、会随 resize 变化——这个闭包编码的是生命周期/时机，不是偷懒。只为延迟一个常量而用的闭包则是开销。该规则可推广到 command count(`04-pipelines-commands`)。

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
