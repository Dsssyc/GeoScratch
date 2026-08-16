---
docId: geo.views-frames.zh
canonical: false
translationOf: ./views-frames.md
canonicalDigest: 0ad67dde061a0e2e1aaaa00bb61d9554770c83cbbcc324f123d5058fa3fffed6
---
# 视图与帧控制

[English](./views-frames.md) | [Geo 概览](./README_zh.md)

`GeoViewAdapter` 读取外部 camera 或 map，并生成不可变 `GeoViewSnapshot`，其中包含
viewport、matrix、camera position、zoom、orientation 与单调 revision。MapLibre 平面
adapter 转换 MapLibre-compatible state，但不会让 MapLibre 成为 Geo resource owner。

Snapshot 是观测，不是全局 camera state。Screen-based demand 可以在可视化中消费它；
simulation、prefetch、editing 或 offline process 可以产生独立 demand。这一区分避免
camera locality 成为普遍资源策略。

`GeoFrameController` 为一个装配后的 field 协调 host-state capture、resize、prepare、
render、feedback 与 invalidation。只有 descriptor 明确赋予责任时，它才拥有 frame-loop
authority。它不拥有外部 map、GPU runtime 或 field resource，除非这些对象被显式注册
清理。

可选的同步 `capture()` 会返回 `GeoFrameCapture`，其中包含非负、单调递增的 revision 与
不可变 host snapshot。`invalidateNow()` 会在正在执行的 host render callback 内调用
`capture()`，其时机早于任何 Promise 或异步 frame construction。新的 revision 会替换
latest-only mailbox 中待处理的 capture；相同 revision 会增加
`deduplicatedInvalidationCount`、返回 `false`，并且不会安排新的 submission。低于最近已接受
revision 的 capture 会以 `GEO_FRAME_CAPTURE_STALE` 停止 controller。异步 `render()` callback
接收本次 submission 已冻结的 snapshot，因此后续 host mutation 无法改变已经准入的 frame。

`invalidate()` 仍是强制的 application 或 convergence invalidation。它会把工作合并到配置的
frame scheduler，即使 host capture revision 未变化也仍会 render。这个区别使 camera-locked
overlay 能过滤无关的 host style 或 source repaint，同时不会抑制 presentation change、
residency completion 或 GPU convergence。未配置 `capture()` 时，两种 invalidation 方法保持
原有的无 capture 调度行为。

`invalidateNow()` 还会取消已排队的 callback，并从当前 host render callback 准入已捕获的
host state。互斥范围只覆盖一个 submitted frame 的构建。构建 slot 会在 native observation
与延迟 settlement 完成前释放；另一个独立的 `maximumInFlightFrames` budget 会约束等待
native observation 的 submission。默认值为 3，
合法范围为 1 到 8。达到上限后，重复 invalidation 会合并为一个 newest-state request；任一
observation 完成后只会释放该最新请求，不会重放中间 camera state。这样既保持异步地图跟随，
也不会建立无界 GPU queue。只有最新 submitted frame 可以请求有界 convergence 或
residency follow-up，因此过期异步结果不能重新激活旧 camera decision。`snapshot()` 会暴露
配置的 budget、当前 in-flight 数量、被去重的 invalidation，以及最近已接受和已提交的
capture revision。

该 budget 是由应用选择的 latency-throughput 权衡，而不是通用 quality 设置。与 camera
锁定的 overlay 通常应选择一个 in-flight frame，避免外部 map 建立以吞吐为导向的过期
camera presentation 队列；达到容量上限的 invalidation 仍会合并到最新 camera。独立
rendering 或 compute workload 可在吞吐量比 newest-state latency 更重要时使用更大的有界值。
