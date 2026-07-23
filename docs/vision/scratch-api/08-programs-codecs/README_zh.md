# Program、Layout Codec 与 Shader 组合

状态: Vision draft
日期: 2026-07-06

## 决策

面向 shader 的 API 应拆成显式 artifact:

- `LayoutSpec` 描述逻辑数据形状。
- `LayoutArtifact` 记录算出的 offset、stride、padding、alignment mode、usage lowering、独立 `abiHash` / `schemaHash` identifier 与不可变 canonical signature。
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
- 生成 artifact 必须可 inspect、可按 canonical ABI/schema signature 缓存，并通过 `09-diagnostics-validation` 中的共享 `ScratchDiagnostic` envelope 诊断。短 hash 本身不是 compatibility proof。

`Program` discrimination 使用 exact built-in prototype 与 module-private `WeakMap`
state record 闭合。该 record 是 runtime ownership 与 disposal 的权威事实；公开的
`Program.runtime`、`Program.id` 与 `Program.isDisposed` 只是 immutable observation，
不是可写 authority。公开 `assertRuntime()` 与 `assertUsable()` 只是 convenience
validation method，并非内部 authority dispatch point；pipeline internal 直接读取
私有 state 与 lifecycle epoch，因此实例同名属性遮蔽公开方法也不能跳过 ownership
或 disposal check。`LayoutCodec` 则继续使用 exact prototype 加 module-private
`WeakSet` brand。每条 Pipeline creation path、每个显式 Shader inspection input 或
option，都会先调用 `isProgram()`，再执行内部 ownership validation 或读取 module、
layout requirement。Render/compute Pipeline object 也只有在 exact prototype 与
module-private state-map record 同时匹配后，才能进入 Command construction。Public
`instanceof`、同形方法、替换 `Symbol.hasInstance`、subclassing，以及
`Object.create(Program.prototype)` / `Object.create(LayoutCodec.prototype)` 都不能向
这些路径注入调用方伪造 facts。

这个 ownership/lifecycle boundary 不会冻结 caller-owned shader contract。
`Program.modules`、`entryPoints`、`requiredFeatures` 与 `layoutRequirements` 仍可为
future Pipeline 修改。每次 render/compute Pipeline creation 都会先在不读取这些
facts 的情况下确认 exact Program identity 与 runtime ownership，并捕获一份内部
Program/Runtime lifecycle stamp，再把四组 facts materialize 成一个
candidate-local immutable snapshot。Program fact 与 pipeline descriptor 的内部采样期间允许 caller
getter 与 iterator 执行，因此每个 Program-fact phase 后、完整 descriptor normalization
后、native issue 前以及 async result commit 前，都会按私有 authority 重新校验同一
stamp。若 native issue 前发生 disposal，
必须先报告 `SCRATCH_PROGRAM_DISPOSED`，不能先报告 `requiredFeatures` unavailable，
也不能执行任何 native work，包括创建 shader module、pipeline layout 或 Pipeline。两种 planner 后续只
消费 stable snapshot，不再读取 mutable Program property；existing Pipeline 继续保留
自己的 immutable snapshot。fact mutation 不推进 lifecycle epoch，只影响后续
candidate。stale candidate 不会自动 retry，因为重放 caller getter 或 iterator 并不
具备安全语义。这只是 internal preparation transaction，不增加 public `prepare()`
method、mandatory state machine、跨 caller code 持有的 lock 或 caller-visible
preparation state。

## LayoutCodec

`LayoutCodec` 不是 resource，也不是 scheduler 特性。它是 typed layout 与 CPU、WGSL、readback 所需字节事实之间的桥。

目标输出:

- `LayoutArtifact`: segment offset、element stride、field offset、padding、alignment mode、total byte length、storage/vertex/readback compatibility、`abiHash`、`schemaHash` 与 canonical signature
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

当前 artifact 保持一套通用 host-shareable/storage ABI。其
`usageCompatibility.uniform` flag 表示不启用 `uniform_buffer_standard_layout` 时的
可移植 WGSL 结果：array member 只有在 field offset 与 `arrayStride` 都是 16 的倍数
时才兼容。Codec 会把自然紧密排列的 scalar 与 `vec2` array 报告为不兼容，而不会
声称 4-byte 或 8-byte stride 可作为 core uniform layout 绑定；它也不会静默选择第二
套 ABI。未来 extension-aware layout 必须显式命名该 capability。

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

const pointBuffer = await scratch.buffer({
    label: 'points',
    size: pointCodec.artifact.stride * pointCount,
    usage: ['storage', 'copyDst', 'copySrc'],
})

const points = pointBuffer.region({
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

## Program Snapshot 与 Compilation Provenance

`Program` 仍是调用者拥有的 shader contract。Pipeline 创建在原生 pipeline Promise 发起前
snapshot 它的 module strings、entry points、required layouts 与 identity；
此边界之后的 mutation 不能改变 in-flight transaction。snapshot 按一个显式
separator contract 合并，并使用 JavaScript UTF-16 code-unit offset，使原生
compilation location 在确实已知时能够映射回 Program module。

成功的 Pipeline 会保留创建 transaction 使用的精确 immutable required-layout
snapshot。Draw/dispatch command preflight 只消费该 Pipeline snapshot，绝不读取后续
live `Program.layoutRequirements`。调用方对 Program 的 mutation 可以影响未来
Pipeline，但不能重写已有 Pipeline 的 shader/binding contract。

最终 pipeline compilation report 保留 combined/per-module hash、module span、
计数与有界 native messages。default history、incident、exported evidence 与
deep descriptor capture 都不保留完整 WGSL 或 source excerpt。由于
implementation-defined native prose 可能回显 WGSL，保留前会替换至少三个
UTF-16 code unit 的精确 Program identifier/numeric literal，以及至少八个
UTF-16 code unit 的连续 Program source span。Token recognition 对齐 WGSL
Unicode-XID identifier 与完整 decimal/hexadecimal numeric-literal grammar，
包括 leading-dot float；每条 message 通过
`sourceExcerptRedacted` 明示这种损失。惰性 Bloom workspace 上限为 32 KiB，
因此不会随 Program source size 扩张；hash collision 只允许保守地多清洗，
不能让已插入的 token 或 span 漏出。Native prose 绝不被解析为稳定 code。
相同规则也会清洗保留的 pipeline/scope/lifecycle native-error string；原始
native object 只能作为瞬时 error cause 保留。未知位置或 separator location
保持 unmapped。这些 evidence 不会把 source ownership 从 Program 移到
Pipeline，Program 也不会获得具体 resource 或 submission state。

## Authoring 与 Runtime 边界

Codec 与 shader composition 可以发生在 runtime 之前，但 scratch 仍需要一套连贯契约:

- Build-time path: 提前生成 `LayoutArtifact`、WGSL accessor modules 与可选 CPU writer code。
- Runtime-initialization path: 惰性生成同样的 artifacts，按 canonical ABI/schema signature 缓存，并暴露有界 hash 与 structural diagnostics。
- Submission path: 只消费已经构建好的 artifacts。

这避免两个坏极端:

- 不在 `submit()` 里藏 runtime-only magic codegen
- 也不做 runtime 无法校验的割裂式外部 codegen

runtime 应能 inspect artifact metadata，并确认:

- 绑定到 Program requirement 的 `BufferRegion` 携带 accessor module 期待的 layout artifact
- bind layout 与 shader 声明匹配，reflection 只作为 warn 级 guard
- CPU writer 产出的 byte length 与 range 匹配目标 `BufferRegion` 及其 layout witness
- readback view 解释从 source `BufferRegion` 捕获的 layout witness

这些检查的 diagnostic payload 应使用 `LayoutArtifact`、`LayoutField`、`Program`、`ShaderBinding` 与 `BindLayoutEntry` 等结构化 subjects，使 tooling 无需解析 prose 也能修复局部 artifact 或声明。

## WGSL Language Contract 与 Immediate Layout

`Program.requiredLanguageFeatures` 是显式 WGSL language-extension name iterable，
与 device `requiredFeatures` 分离。Program 创建及每个未来 pipeline transaction
都会针对 Runtime snapshot 校验该 requirement。Scratch 不解析或重写 `requires`
directive；调用方 WGSL source 仍是事实来源。

`LayoutCodecUsage` 包含 `'immediate'`。
`LayoutArtifact.usageCompatibility.immediate` 对当前 scalar、vector 与 `mat4x4f`
field vocabulary 为 true，对任何 array member 为 false。显式请求不兼容的
immediate usage 会产生结构化 LayoutCodec diagnostic。只有 compatible
LayoutUploadView 才能作为 command immediate data。

生成 accessor 仍只输出 struct、constant 与 field reader，绝不注入
`requires immediate_address_space;` 或 `var<immediate>`。Raw ArrayBuffer 与
ArrayBufferView 路径继续存在，因此当前 codec vocabulary 不会限制合法 WGSL
store type。

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
