# Program、Layout Codec 与 Shader 组合

状态: Vision draft
日期: 2026-07-06

## 决策

面向 shader 的 API 应拆成显式 artifact:

- `LayoutSpec` 描述逻辑数据形状。
- `LayoutArtifact` 记录算出的 offset、stride、padding、alignment mode、usage lowering 与稳定 structural hash。
- `LayoutCodec` 是由 layout 生成的准备期 artifact: CPU writer、readback view 与 WGSL accessor module。
- `Program` 描述 shader source、生成模块、entry points、所需 bind layouts、所需 features 与 diagnostic metadata。
- `Pipeline` 是某个 `Program` entry point 加 render 或 compute pipeline state 得到的稳定 WebGPU 可执行状态。
- `BindSet` 提供具体资源。
- `Command` 用 bind sets、resource access 声明、readiness policy 和 draw/dispatch/copy 参数调用 pipeline。

scratch core 不能引入 `Material` 抽象。在场景引擎里，material 通常把 program、数据参数、视觉表面语义、光照假设和对象赋值关系打包在一起。这种耦合在 kernel 之上可能有用，但不适合 scratch: scratch 必须让图形与 compute 同级，`geo` 也必须能自由构建地图、地球、笛卡尔、混合空间、瓦片、流式加载和一次性 GPU 工作负载，而不是继承 render-material 心智模型。

## 目标流

```text
LayoutSpec
    -> LayoutArtifact
    -> LayoutCodec
        -> CPU writer / uploader input
        -> readback views
        -> WGSL accessor module

user WGSL + generated accessor modules + bind-layout contract
    -> Program
    -> Pipeline
    -> Command
    -> Submission
```

这样可以把代码生成与 runtime 执行接起来，同时不隐藏行为:

- Layout 与 shader helper 可以在 runtime 之前生成、在 build time 生成，也可以在 runtime 初始化阶段惰性生成。
- Submission-time 执行只消费显式 artifact。它不应依赖临时 string generation 或隐藏 shader mutation。
- 生成 artifact 必须可 inspect、可按 structural hash 缓存，并通过 `09-diagnostics-validation` 中的共享 `ScratchDiagnostic` envelope 诊断。

## LayoutCodec

`LayoutCodec` 不是 resource，也不是 scheduler 特性。它是 typed layout 与 CPU、WGSL、readback 所需字节事实之间的桥。

目标输出:

- `LayoutArtifact`: segment offset、element stride、field offset、padding、alignment mode、total byte length、storage/vertex/readback compatibility 与 structural hash
- CPU writer: 把逻辑值写入 GPU-aligned bytes，并跳过 padding
- upload view: 可由一个 upload command 发送的连续字节范围
- readback view factory: 从返回字节创建 typed、`DataView`、strided 或显式 deinterleaved view
- WGSL accessor module: 用于 shader 侧安全访问字段的生成 struct/function/constant
- diagnostics: 不支持的 field format、不兼容 usage、无法表达的 alignment、byte-length mismatch 或不安全 strided view request，并通过 `ScratchDiagnostic` 报告

高性能 CPU 路径是:

```text
source AoS/SoA data
    -> CPU writer 填充一个 GPU-aligned ArrayBuffer 或 leased staging span
    -> 一个显式 UploadCommand 写入连续范围
```

这避免了每个 structure 一次 CPU-to-GPU 操作，也避免了用 GPU-side repack pass 导致 peak VRAM 接近翻倍。如果外部 schema 已经 GPU-aligned，writer 可以使用 direct view 或 bulk copy; 否则它在 CPU 侧把字段写入 aligned layout，并跳过 padding。

Raw packed bytes 仍然是 escape hatch，但不是默认 authoring model。要求作者在 shader 中手动复刻 WGSL padding 是正确性风险，尤其在 AI 辅助写代码时更容易出错。

## Program

`Program` 是 shader contract。它拥有代码和紧邻代码的 metadata，但不拥有具体资源或场景含义。

它应声明:

- label
- source modules: user WGSL 加 generated WGSL accessor modules
- entry points 与 stages
- 所需 `BindLayout` 对象
- 所需 layout codecs 或 accessor modules
- override constants 或 specialization keys
- required features 与 limits
- shader inspection 和 cross-check diagnostics

示例形状:

```ts
const pointCodec = scratch.layoutCodec(pointLayout, {
    usage: ['storage', 'readback'],
})

const points = scratch.buffer({
    label: 'points',
    usage: ['storage', 'copyDst', 'copySrc'],
    layout: pointCodec.artifact,
})

const simulateProgram = scratch.program({
    label: 'simulate points',
    modules: [
        pointCodec.wgslAccessors({ namespace: 'Point' }),
        scratch.wgsl`
            @group(0) @binding(0)
            var<storage, read_write> points: array<PointStorage>;

            @compute @workgroup_size(64)
            fn main(@builtin(global_invocation_id) id: vec3u) {
                let i = id.x;
                let p = Point_readPosition(points, i);
                Point_writePosition(points, i, p);
            }
        `,
    ],
    entryPoints: { compute: 'main' },
    bindLayouts: [simulationLayout],
})
```

具体调用形状可以演进。稳定不变的是: generated accessors 与 user WGSL 组合成 `Program`; 具体资源通过 `BindSet` 进入; 执行通过 `Command` 进入。

## Program、Pipeline、BindSet、Command

保持这些职责分离:

```text
Program  = shader code contract + generated modules + entry points
Pipeline = Program entry point + WebGPU pipeline static state
BindSet  = concrete resources bound to an explicit BindLayout
Command  = one executable GPU action using Pipeline + BindSet + counts/policy
```

错误的 kernel model:

```text
Material = Program + data values + render semantics + object assignment
```

推荐的 scratch model:

```text
Program 声明代码需要什么。
BindSet 提供绑定哪些资源。
Command 声明何时以及如何执行。
Submission 记录显式顺序。
```

未来 `geo` 层如果需要，可以引入 layer style、symbolizer、renderable layer 或 material-like scene concepts。这些概念必须降低到 scratch primitives; 它们不能成为 scratch primitives。

## Authoring 与 Runtime 边界

Codec 与 shader composition 可以发生在 runtime 之前，但 scratch 仍需要一套连贯契约:

- Build-time path: 提前生成 `LayoutArtifact`、WGSL accessor modules 与可选 CPU writer code。
- Runtime-initialization path: 惰性生成同样的 artifacts，按 structural hash 缓存，并暴露 diagnostics。
- Submission path: 只消费已经构建好的 artifacts。

这避免两个坏极端:

- 不在 `submit()` 里藏 runtime-only magic codegen
- 也不做 runtime 无法校验的割裂式外部 codegen

runtime 应能 inspect artifact metadata，并确认:

- buffer resource 使用的 layout artifact 与 program accessor module 期待的一致
- bind layout 与 shader 声明匹配，reflection 只作为 warn 级 guard
- CPU writer 产出的 byte length 与 range 匹配目标 resource layout
- readback view 使用的是产生数据的同一个 layout version

这些检查的 diagnostic payload 应使用 `LayoutArtifact`、`LayoutField`、`Program`、`ShaderBinding` 与 `BindLayoutEntry` 等结构化 subjects，使 tooling 无需解析 prose 也能修复局部 artifact 或声明。

## 吸收工业经验，但不照搬

成熟引擎常提供 material、shader graph、node material、custom shader chunk、plugin 和 compute shader helper。scratch 要吸收的不是 material 层本身，而是:

- 让 shader code 可组合
- 为常见 layout 错误生成安全 accessor
- 围绕 bind/layout/shader mismatch 提供 diagnostics
- 保留 custom WGSL escape hatch
- 把 compute 当作与图形同级的能力

scratch 应吸收这些机制，而不是引入场景引擎的 `Material` 概念。

## 非目标

- 不向 scratch core API 添加 `Material`、`material`、`NodeMaterial` 或 material-like aliases。
- 不在 scratch 中使用 `Style` 或 layer styling 术语; style 属于 `geo` 或应用。
- 不让 `Program` 拥有具体资源或 per-object values。
- 不让 `BindSet` 拥有 shader source 或 execution counts。
- 不让 `Pipeline` 拥有具体 resource allocation versions。
- 不在 submission hot path 中生成 shader 或 layout code。
- 当 layout-derived writer/accessor 能消除手写 padding 错误时，不把 raw packed buffer 作为默认路径。
