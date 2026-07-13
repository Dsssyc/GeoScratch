# 设计评审

状态: Review (vision draft)
日期: 2026-07-06

## 范围

本模块记录最初从两个角度评审 `00`–`05` 并推动后续 `07` 与 `08` 补充的那次 review:

1. **AI 辅助编写**("vibe coding"): 当使用 `scratch` 的大部分代码都由 AI 辅助写成时，这套设计是否仍然合适？
2. **通用 compute 对等性**: `scratch` 的目标和 WebGPU 一样，是 GPU 能力的 CPU 端映射——因此 compute 必须是与图形 *平起平坐* 的一等用途，而不是图形的附属。这套设计能否支撑严肃的高性能并行计算？

结论: 不需要重写。`00`–`05` 的实质(显式、声明式、可校验、fail-fast)本就高度契合。需要改的是 *首要目标的措辞*、三个定向的编写期修订(第一部分)、以及 **把 compute 从附属升为一等用途**(第二部分)。

状态: 第一部分(修订 A/B/C/D/E)、缺口 1(定位)、缺口 5(compute 校验 + dynamic offset)已 **并入** `00`-`05`、`08`、`09` 与 `scratch-graphics-kernel.md`。缺口 2-4(异步 readback、提交单元、GPU 计时/查询)现已跨 `05-passes-submissions-scheduler` 与 `07-transfers-epochs` **设计**。shader/codec/material 边界现已在 `08-programs-codecs` **设计**。统一 diagnostic contract 现已在 `09-diagnostics-validation` **设计**。本模块是评审记录; 已并入内容以 `00`-`05`、`07`、`08` 与 `09` 为 source of truth。持续更新的开放 review 项放在 `docs/review/`。

## 第一部分 — AI 时代编写视角

### 评判轴(更正)

早先的一种框定用"AI 读起来顺不顺"和"聪明 vs 无聊"来评判 API。两者都是错的轴。

- "聪明 vs 无聊"是个陷阱。"无聊"的极限是裸 WebGPU，而它是 *最不* 可验证的接口面，不是最可验证的: 它的有效性规则是隐式的，许多逻辑错误(allocation version 错、content epoch 错、写前读、resize 后 bind group 失效)不会报错，而是直接给出一张错的画面。
- 正确的轴是 **"加约束 + 加检查的抽象" vs "加隐藏行为的抽象"**。前者可以比裸 WebGPU *更* 抽象，同时 *更* 可验证。后者让同一段代码因调用点看不见的状态而行为不同。

下面每条修订都按两个问题评判，顺序如下:

1. 功能性: 它是否仍能表达真实工作负载，包括真正的运行时动态性？
2. 可验证性: 正确性能否通过局部阅读确认，系统能否抓住错误？

这条评判轴——务实功能优先，其次是可验证性即约束——取代"AI 可读性"和"聪明 vs 无聊"，作为本次修订的标准。

### 修订 A — 首要目标

替换"减少样板"这一目标。

早期写法(`00-overview`，修订 A 之前):

> 新的 `scratch` API 应减少 WebGPU 样板工作，同时保留直接 GPU 控制能力。

问题: 在 AI 时代，生成样板的边际成本接近于零，所以"更少的代码"是抽象层能提供的最不值钱的东西。冗长不是敌人; 歧义和隐藏/非局部状态才是。

建议目标:

> 新的 `scratch` API 应在保留直接 GPU 控制能力的同时，最大化"可局部验证的正确性"。它应补上裸 WebGPU 缺失的约束与检查，而不引入隐藏行为。由作者写出、再由 validator 校验的样板是可接受的; 歧义和不可见状态则不可接受。

推论:

- 保留那些"啰嗦"的特性——声明式 resource access、显式 transfer operation、显式 `BindLayout`、显式 submission 顺序。它们是这套设计中最具未来韧性的部分。不要仅仅为了简洁就自动推断它们。
- 每个"聪明"的特性(allocation version、content epoch、readiness、device-loss rehydration)都必须暴露可 inspect、可 assert 的状态，例如可读的 `allocationVersion` / `contentEpoch` / `state`(`02-resources` 已定义 `ResourceState`)。一个藏起"为什么发生了重建"的聪明特性是净负值。
- 这不削弱已有的 escape hatch 要求。直接的低层控制保留。

### 修订 B — 闭包策略

把现有的"不让 command count 默认就是闭包"(`04-pipelines-commands`)推广成一条按 *闭包编码了什么* 来分流的规则，而不是一刀切地回避。闭包有时是真实动态性的正当代价——一个只有在运行时剔除之后才知道的 draw count——而不是作者图省事。

分流:

1. **静态值，构造时即可得** → 不要闭包。应移除的例子: `range: () => [3]`，以及当 shader code 为常量时的 `codeFunc: () => shaderCode`。
   - 例外: 如果这层 thunk 是为了延迟到 device-ready，或为了让值之后可变，那它编码的是 *生命周期/时机*，这是正当的——但应通过 resource/ref 模型来表达，而不是临时闭包。
2. **CPU 动态值**(count 只有在 CPU 侧工作如剔除之后才知道) → 闭包正当。作为显式 escape hatch 保留。
3. **GPU 动态值**(count 由 GPU 产生，例如 GPU 剔除写出 draw arguments) → 优先 `indirect`，它在 `04-pipelines-commands` 中已是推荐的 GPU-driven 路径。严格优于 CPU 闭包: 无回读、全声明式、对 validation 可见。

动态 count 的可验证性阶梯(优先靠上):

```text
indirect buffer  >  ref / handle  >  closure
```

接入既有证据: 旧 API 已证明一种非闭包动态原语是可行的，只要它有稳定身份、可变内容和 dirty tracking。在 `0.x.x` 阶段，`aRef` / `ArrayRef` 这类旧名称只作为参考材料; 目标设计应在有价值时保留底层 handle pattern，而不是把这些名称或旧职责当作兼容性约束。

净规则: 静态 → 不要 thunk; CPU 动态 → 闭包可以; GPU 动态 → indirect。

### 修订 C — Shader 反射作为可选的、warn 级的交叉校验

保留显式 `BindLayout` 作为 source of truth(`03-bindings`，"explicit is the contract")。把反射从"脚手架 helper"提升为一道 *守卫*，针对 AI 最高频的那一类错误: bind layout 与 shader 不匹配(binding index、type、visibility)。

约束它，使它绝不造成功能倒退:

- **仅 dev。** 生产路径不硬依赖某个具体 WGSL parser。
- **默认 warn，而非 throw。** 一个滞后于 WGSL spec 的 parser 会对合法但少见的 layout 报假错——而那正是 kernel 承诺要支持的 exotic 用法。warn 让它保持建议性。
- **可按 entry 关闭。** 作者在有意构造 superset layout 时，可以静默某一项检查。
- **只做交叉校验。** 反射把显式 layout 与 shader 比对; 它绝不成为 layout 的 source of truth。

净效果: 在"改→跑→修"闭环的早期抓住常见错配，同时不让反射变成权威、也不挡住 exotic layout。

### 修订 D — Program/codecs，但不引入 Material

shader code 天然是混合结果: 一部分是用户写的 WGSL，一部分是生成的 layout/accessor 支撑代码，还有一部分是 WebGPU pipeline state。成熟引擎常用 material 或 node-material 层解决这个问题，但那会把数据、程序、表面语义与场景赋值关系耦合在一起，不适合 scratch。

目标拆分是:

```text
LayoutSpec -> LayoutArtifact -> LayoutCodec
user WGSL + generated accessors -> Program
Program entry point + pipeline state -> Pipeline
Pipeline + BindSet + counts/policy -> Command
```

`LayoutCodec` 是准备期 artifact，不是 submission-time magic。它可以在 runtime 前生成，也可以在 runtime 初始化阶段惰性生成，但 hot path 消费的是显式、可缓存 artifact。这样既避免 runtime 无法校验的割裂式外部 codegen，也避免在 `submit()` 里隐藏 shader mutation。

`Material` 被明确排除在 scratch core 概念之外。如果 scene 层需要 layer style、symbolizer、renderable layer 或 material-like package，那属于 `geo` 或应用，并且必须降低为 `Program`、`BindSet`、`Pipeline` 和 `Command`。

### 修订 E - Diagnostics 作为 machine-readable repair contract

intelligent-friendly loop 需要结构化 diagnostics，而不是 prose-only errors。如果 agent 必须解析英文才能理解 bind mismatch 或 read-before-write，这个 API 就没有达成自己的可验证性目标。

目标 diagnostic contract 是:

```text
ScratchDiagnostic = stable code + phase + subject + related + expected/actual + optional hints
```

`message` 与 `hint` 给人读。`code`、`phase`、`subject` 与已文档化 payload fields 给 tooling 和 tests 使用。Validation modes(`off` / `warn` / `throw`)控制处置方式，而不是 diagnostic identity。Repair suggestions 可以让修复更局部、更机械，但 scratch 不能静默应用它们。

该修订通过让 `09-diagnostics-validation` 成为 diagnostic envelope、phase sources、code naming、stability rules 与 repair suggestion boundaries 的 source of truth，解决剩余开放 review 项。

### 第一部分不改变什么

- **保留 `BindSet` 命名**(不改名为 `BindGroup`)。`BindSet` 比 `GPUBindGroup` 做得更多：它冻结逻辑 BufferRegion/TextureViewSpec binding，暴露 readiness 与 allocation staleness，并拥有显式 acknowledged preparation lifecycle(`03-bindings`)。语义不同正是它必须命名不同的理由。Submission 绝不惰性重建它。
- **不引入 `Material`。** kernel 保持 `Program`、`BindSet`、`Pipeline` 与 `Command` 分离。material-like scene concepts 留在 scratch 之上。
- **Diagnostics 不自动修复。** 结构化 suggestions 可以指导 tooling，但 resource usage、bind layouts、shader code 与 submission order 仍然必须是显式的用户或工具编辑。
- 保留显式的 `ScratchRuntime` / `Surface` 拆分、显式 resource access 与 transfer 声明、使用点上的 `whenMissing`、以及 `SubmissionValidationMode`(`off` / `warn` / `throw`)。它们本就与 AI 契合: 无隐藏全局状态、可局部推理、且提供了 agentic 闭环可以迭代对抗的错误面。

## 第二部分 — 通用 compute 对等性

这部分是在以"`scratch` 是 GPU 能力的 CPU 端接口(类同 WebGPU)、而不仅是图形内核"这一要求复查 `00`–`05` 之后补充的。严肃的高性能并行计算(仿真、scan/sort/reduce、迭代求解、ML 式 kernel)必须是一等用途。

### 已经能用的部分

- `01-runtime-surface` 已要求 runtime 支持 **compute-only / offscreen / worker**(不绑 canvas)。这是 GPGPU 的地基。
- `04-pipelines-commands` 的 **indirect dispatch**(`DispatchCount` 的 `{ indirect }`)就是 GPU-driven compute 路径: 上一趟 pass 产出的数量决定下一趟 dispatch 规模。
- storage buffer/texture 读写、override `constants`(参数化 workgroup size)、`requiredFeatures` / `requiredLimits` 钩子都在。
- `04` / `05` / `07` 的声明式 resource access、显式 transfer 与依赖校验，对 compute *链*(scan 的 up/down-sweep、迭代求解、simulate→sort→render)的价值 *比对图形还大*——这正是 GPGPU 正确性最容易错的地方。这套设计最"啰嗦"的特性，是它最强的 compute 资产。

### 缺口(按严重度排)

#### 缺口 1 — 定位: "图形内核"低估了 compute(已修)

早期文档把 scratch 称为 "the **graphics** kernel"; `00-overview` 是 "graphics execution kernel"; compute 出现为 "GPU compute-heavy **visualization**" 和 "visualization and compute tasks"——都是"服务于可视化的 compute"。

但 WebGPU 这个类比恰是要点: WebGPU 是 **GPU** API，graphics 与 compute 同级。若 compute 是一等用途，顶层心智模型应重定为 **"GPU 执行内核"**(compute + graphics)。否则 compute 会在后续每个决策里被默默当成二等。

#### 缺口 2 — 异步回读(readback)曾未建模(vision 层已修)

通查早期 `00`–`05`，只有 `map` 作为一种 buffer usage 出现(`02-resources`)。当时**没有任何 readback / `mapAsync` / 可 await 的结果获取机制**: command 家族是 Draw / Dispatch / Copy / Upload(没有 Readback)，唯一的提交单元是旧 `frame…submit()` 形状——纯 fire-and-forget，也没有 `queue.onSubmittedWorkDone`。

GPGPU 的常态是: dispatch → copy 到 readback buffer → `await map` → CPU 读结果 → 可能再喂下一趟 pass。这条路现在表达不出来。

它还戳穿了修订 A 的可验证性目标: 没有 readback，你 *根本写不出* 一个从 CPU 侧断言 compute kernel 输出是否正确的测试。所以这个缺口在功能性和可验证性上 *双失*。

已解决(`07-transfers-epochs`): readback 创建显式 `ReadbackOperation`——`await readback.toArray()`——显式 `await`，provenance 来自 operation 捕获的 content epoch。`ReadbackCommand` 仅作为 ordered-staging 逃生口保留，并产出同一种 operation 类型。

#### 缺口 3 — 提交单元曾是"presentation 味"的 `Frame`(vision 层已修)

早期 `05` 唯一的提交单元是 `Frame`，带显示倾向的语义(skip empty passes、current frame、surface 集成)。compute 往往不是"一帧": one-shot 任务、按自己的节奏跑、或在 present 之前先迭代 N 步。

该模型对"多 dispatch 录进一次 submission"支持得很好——适合 GPU-bound 迭代。它没覆盖的是"迭代中周期性 CPU 回读/反馈"，而这又和缺口 2 缠在一起。

已解决(`05-passes-submissions-scheduler` / `07-transfers-epochs`): scratch core submission unit 现在是 `Submission`，不是 `Frame`。一个 submission 可以 present 到 surface，也可以是 compute-only/offscreen。`Frame` cadence 属于 scratch core 之上的层。

#### 缺口 4 — 没有 GPU 计时 / 查询(vision 层已修)

早期 `00`–`05` 全文未提 `timestamp-query` 或 `GPUQuerySet`(唯一的 "profiling" 指的是 validation mode，不是 GPU 计时)。"高性能"意味着要能测; 没有 timestamp query 就调不动 kernel。它是 feature-gated 的可选项，但设计得给它一个落脚点: 一种 query resource kind 加一个 pass/command 触点。

#### 缺口 5 — compute 专属校验 + binding 完整性(已修)

- Draw/dispatch 与 pipeline preflight 现在会在 encoder creation 前校验 workgroup dimension、binding range、alignment、`minBindingSize`、storage limit 与 declared binding access。
- `03-bindings` 定义 command-owned named dynamic offset，并在构造期预先降低为 native binding order；同一 prepared BindSet 可被不同 immutable Command 选择不同 region，而不发生 mutation 或 preparation。

### 用评判轴小结

- **必须修**: 缺口 1(定位决定所有下游决策)、缺口 2(功能性 + 可验证性双失)。
- **应该修**: 缺口 3(功能性，且与缺口 2 耦合)、缺口 4(高性能的前提)。
- **在 binding-view clean cut 中已修**: 缺口 5。

净判断: 不是推倒，而是"把 compute 从附属升为一等"——重定位 + 补回读/提交语义 + 给计时和 compute 校验留位置。补对了，这套 read/write 依赖模型反而会成为 GPGPU 的强项。

## 决策状态

已并入 `00`–`05`、`07` 与 `scratch-graphics-kernel.md`:

1. `00-overview` 修订后的首要目标措辞(修订 A)。
2. `02-resources` 与 `04-pipelines-commands` 的闭包分流(修订 B)。
3. `03-bindings` 的"默认 warn、可关闭"dev 交叉校验(修订 C)。
4. `BindSet` 命名保留(已确认)。
5. 重定为"GPU 执行内核"、compute 同级(缺口 1)。
6. 通过显式 `ReadbackOperation` 的可 await readback，`await readback.toArray()`(缺口 2)——见 `07-transfers-epochs`。
7. 核心提交单元改名为 `Submission`，并拆分 `SubmissionBuilder` / `SubmittedWork`(缺口 3)——见 `05` 与 `07`。
8. timestamp/occlusion 的 indexed `QuerySet` 资源、`timestampWrites`、occlusion query bracket，以及显式 resolve/readback operations(缺口 4)——见 `07`。
9. validation / bindings 的 compute 限制校验与 dynamic offset(缺口 5)。
10. Program/layout-codec/shader-composition 拆分，并把 `Material` 排除出 scratch core(修订 D)——见 `08-programs-codecs`。
11. 统一 machine-readable diagnostic envelope、code stability、validation phases 与显式 repair suggestions(修订 E)——见 `09-diagnostics-validation`。

解决记录: 缺口 2–4 形成跨 `05` 与 `07` 的 transfer/submission 设计。提交命名问题(缺口 3)通过把 `Submission` 作为唯一 scratch core submission model 解决; readback(缺口 2)是显式 transfer operation + 显式 `await`; 计时(缺口 4)复用同一套 copy/readback 路径。
