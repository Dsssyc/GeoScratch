# Bindings

状态: Vision draft
日期: 2026-06-20

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
- 使用前比较 resource versions
- 当绑定资源版本变化时惰性重建 bind group
- 向 command validation 暴露已绑定资源的 readiness

## Shader Inspection

Shader reflection 不应进入核心 runtime 路径。

允许的 helper 方向:

```ts
const report = scratch.inspectShader(shader).compareBindLayouts([terrainLayout])

const draft = scratch.inspectShader(shader).suggestBindLayout({ group: 0 })
```

Reflection 是开发期校验或脚手架辅助。它不能成为生产 layout 创建的真相来源。

## 显式声明是核心契约

Shader 和 bind layout 都应由用户有意识地编写。这能保留特殊 WebGPU layout 的表达能力，也避免内核绑定到某个 WGSL parser 或 reflection 实现。

## 非目标

- 不在 `BindSet` 中存储 vertex 或 index input state。
- 不在 `BindSet` 中存储 draw 或 dispatch count。
- 不在 `BindSet` 中存储 command readiness policy。
- 不把 shader reflection 作为主要 runtime layout 机制。
