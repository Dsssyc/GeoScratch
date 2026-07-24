# Program、Layout Codec 与 Shader 组合

状态: Vision draft
日期: 2026-07-24

## 决策

面向 shader 的 API 应拆成显式 artifact:

- `LayoutSpec` 描述逻辑数据形状。
- `LayoutArtifact` 记录算出的 offset、stride、padding、alignment mode、usage lowering、独立 `abiHash` / `schemaHash` identifier 与不可变 canonical signature。
- `LayoutCodec` 是由 layout 生成的准备期 artifact: CPU writer、readback view 与 WGSL accessor module。
- `ShaderModule` 拥有组合后的 WGSL source part、LayoutArtifact dependency、
  compilation hint、一个已确认原生 `GPUShaderModule` 与有界 compilation evidence。
- `Program` 是引用已确认 ShaderModule 的不可变、resource-free stage 与 requirement
  contract。
- `Pipeline` 是一个 Program 加 render 或 compute pipeline state 得到的稳定 WebGPU
  可执行状态。
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

user WGSL + generated accessor modules
    -> ShaderModule
    -> Program stage contract + bind-layout requirements
    -> Pipeline
    -> Command
    -> Submission
```

这样可以把代码生成与 runtime 执行接起来，同时不隐藏行为:

- Layout 与 shader helper 可以在 runtime 之前生成、在 build time 生成，也可以在 runtime 初始化阶段惰性生成。
- Submission-time 执行只消费显式 artifact。它不应依赖临时 string generation 或隐藏 shader mutation。
- 生成 artifact 必须可 inspect、可按 canonical ABI/schema signature 缓存，并通过 `09-diagnostics-validation` 中的共享 `ScratchDiagnostic` envelope 诊断。短 hash 本身不是 compatibility proof。

`ShaderModule` 与 `Program` discrimination 使用 exact built-in prototype 与
module-private `WeakMap`
state record 闭合。该 record 是 runtime ownership 与 disposal 的权威事实；公开的
`Program.runtime`、`Program.id` 与 `Program.isDisposed` 只是 immutable observation，
不是可写 authority。公开 `assertRuntime()` 与 `assertUsable()` 只是 convenience
validation method，并非内部 authority dispatch point；pipeline internal 直接读取
私有 state 与 lifecycle epoch，因此实例同名属性遮蔽公开方法也不能跳过 ownership
或 disposal check。`LayoutCodec` 则继续使用 exact prototype 加 module-private
`WeakSet` brand。每条 Pipeline creation path、每个显式 Shader inspection input 或
option，都会先调用 `isProgram()`，再执行内部 ownership validation 或读取 stage、
layout requirement。每个被选择的 stage 随后验证 exact ShaderModule brand、Runtime
ownership 与 lifecycle。Render/compute Pipeline object 也只有在 exact prototype 与
module-private state-map record 同时匹配后，才能进入 Command construction。Public
`instanceof`、同形方法、替换 `Symbol.hasInstance`、subclassing，以及
`Object.create(Program.prototype)` / `Object.create(LayoutCodec.prototype)` 都不能向
这些路径注入调用方伪造 facts。

Program 仍是 caller-owned shader contract。Program 构造会对每个 stage、constant
map、requirement iterable 与 LayoutArtifact witness 建立 immutable snapshot，
因此后续 caller mutation 不能改变任何 future Pipeline。每次 render/compute
Pipeline creation 捕获一个 Program/Runtime lifecycle stamp，并在 native work 前
形成 candidate-local immutable snapshot。随后校验每个被引用 ShaderModule 与
requirements，规范化自身 descriptor，并在 native issue 前及异步 commit 前重检
stamp。native issue 前发生 disposal 时报告 `SCRATCH_PROGRAM_DISPOSED`，不会重建
或重新编译 ShaderModule。不会自动 retry。这只是内部 acknowledgement
transaction，不增加 public `prepare()` method、mandatory state machine、跨 caller
code 持有的 lock 或 caller-visible preparation state。

## LayoutCodec

`LayoutCodec` 不是 resource，也不是 scheduler 特性。它是 typed layout 与 CPU、WGSL、readback 所需字节事实之间的桥。

输出:

- `FixedLayoutArtifact` 或 `RuntimeLayoutArtifact`：recursive type fact、
  offset、element/column stride、padding、显式 member layout、alignment、fixed
  length 或 runtime-tail fact、结构化 usage compatibility、capability
  requirement、`abiHash`、`schemaHash` 与 canonical signature
- CPU writer: 把逻辑值写入 GPU-aligned bytes，并跳过 padding
- upload view: 可由一个 upload command 发送的连续字节范围
- readback view factory: 从返回字节创建 typed、`DataView`、strided 或显式 deinterleaved view
- WGSL accessor module: 用于 shader 侧安全访问字段的生成 struct/function/constant
- buffer-view contract 与 WGSL constant：为 `bufferView`、`bufferArrayView`
  和 `bufferLength` 显式记录 source/target type、byte range、alignment、pointer
  path 与 required language feature
- diagnostics: 不支持的 field format、不兼容 usage、无法表达的 alignment、byte-length mismatch 或不安全 strided view request，并通过 `ScratchDiagnostic` 报告

一套 recursive model 覆盖 scope 内完整 host-shareable family：scalar、vector、
floating matrix、fixed array、structure、final-member runtime array、storage
atomic、显式 member `@align` / `@size`，以及 opaque fixed/runtime buffer root。
精确 binary16 conversion 属于 CPU ABI。TypeScript descriptor grammar 排除静态非法
nesting；runtime validation 对 JavaScript 与 dynamic input 执行相同约束。

只有 fixed artifact 发布 total `byteLength` 与 `stride`。Runtime artifact 发布 fixed
prefix 与 minimum binding size，并要求显式 `runtimeElementCount` 才产生具体 host
byte range。该 extent 贯穿 packing、writing、upload/readback view、BufferRegion
witness、Program minimum binding size 与 command range validation。

高性能 CPU 路径是:

```text
source AoS/SoA data
    -> CPU writer 填充一个 GPU-aligned ArrayBuffer 或 leased staging span
    -> 一个显式 UploadCommand 写入连续范围
```

这避免了每个 structure 一次 CPU-to-GPU 操作，也避免了用 GPU-side repack pass 导致 peak VRAM 接近翻倍。如果外部 schema 已经 GPU-aligned，writer 可以使用 direct view 或 bulk copy; 否则它在 CPU 侧把字段写入 aligned layout，并跳过 padding。

Raw packed bytes 仍然是 escape hatch，但不是默认 authoring model。要求作者在 shader 中手动复刻 WGSL padding 是正确性风险，尤其在 AI 辅助写代码时更容易出错。

Artifact 保持一套通用 host-shareable ABI。每个 `usageCompatibility` member
都是 immutable object，而不是 Boolean：它报告 compatibility、reason、required
device feature、required language feature 与 mutable-storage requirement。具名
`portable` uniform contract 应用 core uniform-address-space constraint；具名
`uniform_buffer_standard_layout` contract 保留同一 ABI，同时派生该
language-feature requirement。两者都不会静默选择第二套 packing。

ABI 与 schema identity 覆盖 recursive type 与 capability contract。Typed Program
requirement 默认要求 exact schema compatibility；native binding 独立校验 ABI、
usage、range 与 alignment。短 hash 是有界 identifier，因此不可变 canonical
signature 仍是最终 equality evidence。

## ShaderModule 与 Program

`ShaderModule` 拥有代码及紧邻代码的 compilation fact。`Program` 只拥有不可变
stage reference 与 requirement。两者都不拥有具体资源或场景含义。

ShaderModule 声明:

- 有序 WGSL source part，每一 part 可带 label
- generated accessor provenance 所需的 LayoutArtifact dependency
- 可选 entry-specific compilation hint，使用 `"auto"` 或显式原生 pipeline layout

Program 声明:

- 可选 `vertex`、`fragment` 与 `compute` stage，且至少存在一个 stage
- 每个被选 stage 对应一个已确认 ShaderModule
- 可选 entry point 与 stage-specific override constants
- required device features 与 limits
- required WGSL language features
- buffer layout requirements 与 LayoutArtifact witness

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

const simulateModule = await scratch.createShaderModule({
    label: 'simulate points module',
    sourceParts: [
        {
            label: 'Point accessors',
            code: pointCodec.wgslAccessors({ namespace: 'Point' }),
            layoutDependencies: [pointCodec.artifact],
        },
        {
            label: 'simulation',
            code: scratch.wgsl`
            @group(0) @binding(0)
            var<storage, read_write> points: array<PointStorage>;

            @compute @workgroup_size(64)
            fn main(@builtin(global_invocation_id) id: vec3u) {
                let i = id.x;
                let p = Point_readPosition(points, i);
                Point_writePosition(points, i, p);
            }
        `,
        },
    ],
})

const simulateProgram = scratch.createProgram({
    label: 'simulate points',
    compute: { module: simulateModule, entryPoint: 'main' },
    layoutRequirements: [{
        group: 0,
        binding: 0,
        type: 'storage',
        hasDynamicOffset: false,
        layout: pointCodec.artifact,
    }],
})
```

当 generated accessor 与 user WGSL 必须共享 declaration 时，它们组合成一个原生
ShaderModule。不同 Scratch ShaderModule 仍是不同原生 module，并可跨 stage 与
pipeline 复用。具体资源通过 BindSet 进入；执行通过 Command 进入。

## Program、Pipeline、BindSet、Command

保持这些职责分离:

```text
ShaderModule = source parts + compilation acknowledgement + native module
Program  = immutable stage references + requirements
Pipeline = Program + WebGPU pipeline static state
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
都会针对 Runtime snapshot 校验该 requirement。Scratch 还会从关联 layout 与
buffer-view contract 派生 requirement：`shader-f16` 是 device feature；
`buffer_view`、`unrestricted_pointer_parameters`、
`uniform_buffer_standard_layout` 与 `immediate_address_space` 在适用时是 WGSL
language feature。

`LayoutCodecUsage` 包含 `'immediate'`。
`LayoutArtifact.usageCompatibility.immediate` 只在 store type 为 constructible、
fixed-footprint 且不包含 array、atomic 或 opaque buffer 时 compatible。显式请求
不兼容 immediate usage 会产生结构化 LayoutCodec diagnostic。只有 compatible
`LayoutUploadView` 才能作为 command immediate data。其显式 `byteOffset` 与
`byteLength` 从 `bytes.buffer` 中选择字节，与既有 upload path 保持一致；该范围
不要求落在 `bytes` view 自身的 visible subrange 内。

`LayoutBufferViewContract` 同样让 buffer-view builtin 保持显式。它记录 address
space/access、source/target layout、fixed/runtime buffer size、byte range、
required alignment，以及 pointer 来自 originating variable 还是声明过的
function-parameter chain。Fixed parameter path 可以缩窄但不能扩大；
runtime-to-fixed path 会 fail closed。Program minimum binding size 与 command
range validation 直接消费这些事实，而不是从 shader prose 重建。

生成 accessor 仍只输出 struct、constant 与 field reader，绝不注入
`requires`/`enable` directive 或 resource declaration。Scratch 不解析或重写任意
caller WGSL、override expression 或 dynamic value；调用方 source 仍是事实来源。
Raw ArrayBuffer 与 ArrayBufferView 路径继续用于 managed host-layout vocabulary
之外的合法 WGSL domain。

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
