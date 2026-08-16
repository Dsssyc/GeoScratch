---
docId: geo.views-frames.zh
canonical: false
translationOf: ./views-frames.md
canonicalDigest: 7217b2a95ddc6a2a914c5323e0765dbf2bccd941097581160d88e33d2df7ecb5
---
# 视图与帧控制

[English](./views-frames.md) | [Geo 概览](./README_zh.md)

`GeoViewAdapter` 读取外部 camera 或 map，并生成不可变 `GeoViewSnapshot`，其中包含
viewport、matrix、camera position、zoom、orientation 与单调 revision。MapLibre 平面
adapter 转换 MapLibre-compatible state，但不会让 MapLibre 成为 Geo resource owner。

Snapshot 是观测，不是全局 camera state。Screen-based demand 可以在可视化中消费它；
simulation、prefetch、editing 或 offline process 可以产生独立 demand。这一区分避免
camera locality 成为普遍资源策略。

`GeoFrameController` 为一个装配后的 field 协调 snapshot read、resize、prepare、
render、feedback 与 invalidation。只有 descriptor 明确赋予责任时，它才拥有 frame-loop
authority。它不拥有外部 map、GPU runtime 或 field resource，除非这些对象被显式注册
清理。

`invalidate()` 会把工作合并到配置的 frame scheduler；`invalidateNow()` 会取消已排队的
callback，并从正在执行的 host render callback 启动当前 submission，使 overlay 能消费与
地图宿主相同的 camera revision。互斥范围只覆盖一个 submitted frame 的构建。构建 slot
会在 native observation 与延迟 settlement 完成前释放；另一个独立的
`maximumInFlightFrames` budget 会约束等待 native observation 的 submission。默认值为 3，
合法范围为 1 到 8。达到上限后，重复 invalidation 会合并为一个 newest-state request；任一
observation 完成后只会释放该最新请求，不会重放中间 camera state。这样既保持异步地图跟随，
也不会建立无界 GPU queue。只有最新 submitted frame 可以请求有界 convergence 或
residency follow-up，因此过期异步结果不能重新激活旧 camera decision。`snapshot()` 会暴露
配置的 budget 与当前 in-flight 数量。

该 budget 是由应用选择的 latency-throughput 权衡，而不是通用 quality 设置。与 camera
锁定的 overlay 通常应选择一个或两个 in-flight frame，避免外部 map 建立以吞吐为导向的
过期 camera presentation 队列；独立 rendering 或 compute workload 可在吞吐量比
newest-state latency 更重要时使用更大的有界值。
