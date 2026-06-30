# 提交与 Readback

状态: Vision draft
日期: 2026-06-30

## 决策

`Frame` 是提交单元，presentation 可选。compute 结果通过资源自身回到 CPU——`BufferResource` 就是它自己的 readback 句柄——用显式 `await` 读取。这解决 `06-design-review` 记录的缺口 2–4，让通用 compute 成为一等、可测试的用途。

## Frame 即提交单元

`Frame` 记录 passes 与 commands 并提交。presentation 只是一种模式，不是定义:

- 带 surface 输出 → presentation frame(current-frame texture、skip-empty-for-present)
- 不带 surface → compute 或 offscreen 提交

`submit()` 可 await 以等待 GPU 完成，底层是 `queue.onSubmittedWorkDone`。完成与数据 readback 是两件事: await `submit()` 告诉你工作结束了，但它不把数据搬到 CPU。

```ts
const f = scratch.frame()              // 不带 surface → compute 提交
    .compute(simulationPass, [simulate])

await f.submit()                       // GPU 完成本次提交时 resolve
```

presentation frame 就是同一个 builder 带上 surface 输出。因此 `Frame` 是唯一的提交概念; 没有单独的 `Submission` 或 `Batch` 类型。

## Readback: 资源即句柄

`BufferResource` 就是它自己的 readback 句柄，由 buffer 的 layout(见 `02-resources`)决定视图。常见路径不要求单独的 result 类型:

```ts
// 同质 buffer 或连续 segment → TypedArray
const data = await particles.toArray()
const segs = await packed.segment('flags').toArray()    // Int8Array

// struct(AoS)或异构 → ArrayBuffer + 按 layout 派生的 ArrayBufferView
const bytes = await particles.toBytes()                 // 拥有的拷贝
particles.at(i)                                         // 解码出的结构体（DataView 支撑）
particles.field('pos')                                  // strided 字段
```

性质:

- **由 layout 决定视图。** readback 映射 buffer 的 segment(`02-resources`): 标量 segment(或单 segment 标量 buffer)映射为 `TypedArray`; struct segment 映射为 `ArrayBuffer` 加上按 layout 派生的 `ArrayBufferView`。AoS 字段是 strided 的，所以通过 `DataView` 读取(或 deinterleave 成连续拷贝)，而非一个定死的 typed array。同一份声明 layout 同时驱动这个 CPU 视图和 GPU 侧的解释。
- **靠 provenance，而非手动排序。** readback 会等待产出该次 readback request 捕获的 buffer version 的提交。`02-resources` 已经追踪 version、readiness 和 last writer，runtime 因此知道该等什么。读一个从未被写过的 buffer 会报 unready，而不是返回垃圾数据。
- **显式 `await`。** 这是与 Taichi 唯一刻意的分歧: Taichi 的 host 访问(`field.to_numpy()`、`field[i]`)把 GPU sync 藏在 getter 后面。隐藏的 sync 在帧预算里是 stall 陷阱，所以代价以 `await` 的形式保持可见。
- **自动 staging。** runtime 持有 `MAP_READ` 暂存拷贝; 常见路径下 buffer 不声明 map usage，但需要 `copySrc`。`toBytes()` / `toArray()` 默认返回拥有的拷贝; zero-copy 的 mapped 视图是进阶逃生口，因为 mapped range 在 unmap 后失效。

## 延迟模型

句柄无需额外类型即可覆盖延迟谱的两端:

- **立即** —— `submit()` 后立刻 `await buffer.toArray()`。确定性; 会 stall 到 GPU 完成且 map 完成。这正是让 compute kernel 可从 CPU 测试的路径。
- **流水线** —— 在产出提交之后先启动 readback request，晚点再 await。latency-tolerant 的流式 helper(一圈 readback)可在此模型之上构建，无需改动它。

`ReadbackCommand` 只作为罕见的 ordered-staging 逃生口: 把 GPU copy/resolve 点显式放进已校验 command 图中的某个位置，然后在提交后 await 结果。它不是默认路径。

## 生命周期与泄漏

- readback 背后的 staging 由 runtime 持有，在 read resolve 或资源 dispose 时释放。
- 被请求却从不消费的 readback 会留下一个可检测的 pending readback operation。开发期 validation 应对 stale pending readback 告警，泄漏因此可见而非静默。

## 计时与查询(缺口 4)

GPU 计时复用 readback 路径，而不是另造一套机制:

- `QuerySetResource` 是 timestamp 或 occlusion query 的资源类型(必要时 feature-gated)。Pipeline statistics 不属于当前 WebGPU core contract; 除非未来明确支持某个目标平台，否则不进入核心设计。
- `timestampWrites` 挂在 pass spec 上(`pass.render({ ..., timestampWrites })`、`pass.compute({ ..., timestampWrites })`)。
- 结果通过同一个句柄取回: `await querySet.toArray()`(或先 resolve 进一个 buffer，再 `toArray()`)。

## 非目标

- 不隐藏 GPU sync。host 访问是显式 `await`，绝非透明 stall。
- 不加 Taichi 式 kernel DSL。WGSL 保持显式; 任何 auto-parallel 编写层都属于 `scratch` 之上，不在内核里。
- 不让 `ReadbackCommand` 成为默认。资源句柄是默认; command 是 ordered-staging 逃生口。
- 不要求 buffer 为常见 readback 路径声明 map usage; 由 runtime staging。
- 不引入单独的 `Submission` 或 `Batch` 类型。`Frame` 就是提交单元。
