# Bindings

状态: Vision draft
日期: 2026-07-06

## 决策

旧 `Binding` 概念应拆成 `BindLayout` 和 `BindSet`。

`BindLayout` 描述稳定 shader binding 形状。`BindSet` 把具体资源绑定到该形状，并拥有 bind group cache invalidation。

Vertex buffer、index buffer、indirect buffer、draw count、dispatch count 和 executable state 不属于 `BindSet`。

## BindLayout

核心 API 中 `BindLayout` 必须显式声明:

```ts
const terrainLayout = scratch.bindLayout({
    label: 'terrain group',
    group: 0,
    entries: [
        { binding: 0, name: 'camera', type: 'uniform', visibility: ['vertex'] },
        { binding: 1, name: 'nodes', type: 'read-storage', visibility: ['vertex'] },
        { binding: 2, name: 'dem', type: 'texture', sampleType: 'float', visibility: ['fragment'] },
        { binding: 3, name: 'linear', type: 'sampler', visibility: ['fragment'] },
    ],
})
```

核心 layout descriptor 应可预测地映射到 WebGPU bind group layout entries。

支持的 entry 家族应包括:

- uniform buffer
- read-only storage buffer
- writable storage buffer
- sampled texture
- storage texture
- sampler
- external texture, when supported

buffer entry(uniform 与 storage)应支持可选的 dynamic-offset 标志，这样可以只绑定一次大 buffer、按 offset 选取每次 dispatch 或 draw 的一段——这是常用的 compute 批处理手法。

## BindSet

`BindSet` 按 layout entry name 绑定资源:

```ts
const terrainSet = scratch.bindSet(terrainLayout, {
    camera: cameraBuffer,
    nodes: nodeBuffer,
    dem: demTexture,
    linear: linearSampler,
})
```

职责:

- 校验所有 required slots 都已提供
- 校验 runtime ownership
- 缓存 `GPUBindGroup`
- 使用前比较已绑定 resource 的 `allocationVersion`
- 当绑定资源 allocation version 变化时惰性重建 bind group
- 向 command validation 暴露已绑定资源的 readiness

完成 `BindSet` 构造后，normalized binding table 及其中的 entries 不可变。Command 因而会针对同一份 slot-to-resource mapping 完成 validation 与 encoding。Resource 本身仍保留显式的 content、allocation 与 lifecycle transition; allocation 变化继续通过 `allocationVersion` 使 cached bind group 失效。

`BindSet` 不会仅因已绑定 resource 的 `contentEpoch` 改变而重建。内容变化影响 dependency validation 与 readback，不代表 physical binding target 变化。

`TextureResource.resize()` 让这一区别成为可观察事实。size-changing resize 后第一次使用时，`BindSet` 会比较新的 `allocationVersion`，从 bind layout 的显式 view dimension 派生 view，针对 current mip/layer extent 完成校验，并创建 exactly one replacement bind group。默认 layout dimension 是 `2d`，因此 array-layer 增长后仍选择单层，而不会静默变成 `2d-array` view。不兼容的 cube、array、mip 或 layer selection 会在 native bind-group creation 前失败。此 allocation 的后续使用会复用该 group。只改变 content 的写入不会重建；normalized same-size resize 不改变任何 version，因此也不重建。

Raw `GPUTextureView` 是 allocation-scoped。Texture allocation 变化时，Scratch 会使自身 view cache 失效；但应用代码独立保留的 raw view 已过期，不能通过 `BindSet` 修复。

`BindSet` 不是 material parameter object。它只为显式 `BindLayout` 提供具体资源; 它不拥有 shader source、生成 accessor module、pipeline state、render style、object assignment、draw count 或 dispatch count。command 才是 pipeline 与 bind sets 为一次可执行动作相遇的位置。

## Shader Inspection 与交叉校验

Shader reflection 不是 source of truth，也不在核心 runtime 路径上。显式 `BindLayout` 仍然权威。但 reflection 应从"仅脚手架"提升为一道 *守卫*，针对最常见的绑定错误: `BindLayout` 与 shader 在 binding index、type 或 visibility 上不一致。

helper 与守卫方向:

```ts
const report = scratch.inspectShader(shader).compareBindLayouts([terrainLayout])

const draft = scratch.inspectShader(shader).suggestBindLayout({ group: 0 })
```

约束该交叉校验，使它绝不挡住正当工作:

- 仅 dev——生产路径不硬依赖某个具体 WGSL parser
- 默认 `warn` 而非 `throw`——否则一个滞后于 WGSL spec 的 parser 会对合法但少见的 layout 报假错
- 可按 entry 关闭——有意构造的 superset layout 可静默某项检查
- 只做交叉校验——它把显式 layout 与 shader 比对; 绝不生成权威 layout

Reflection 不能成为生产 layout 创建的真相来源。

交叉校验 findings 应使用 `09-diagnostics-validation` 中的共享 diagnostic envelope，以 `BindLayoutEntry` 作为 `subject`，并把反射得到的 `ShaderBinding` 与 `Program` 作为 `related` context。

## 显式声明是核心契约

Shader 和 bind layout 都应由用户有意识地编写。这能保留特殊 WebGPU layout 的表达能力，也避免内核绑定到某个 WGSL parser 或 reflection 实现。

## 非目标

- 不在 `BindSet` 中存储 vertex 或 index input state。
- 不在 `BindSet` 中存储 draw 或 dispatch count。
- 不在 `BindSet` 中存储 command readiness policy。
- 不把 `BindSet` 当作 material、style 或 scene-object parameter bundle。
- 不把 bind validation failures 暴露成 prose-only errors。
- 不把 shader reflection 作为主要 runtime layout 机制。
