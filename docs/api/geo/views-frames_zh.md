---
docId: geo.views-frames.zh
canonical: false
translationOf: ./views-frames.md
canonicalDigest: d3b244499465b2338ea11991bac78e6dfce05c97401ce571c3850cebe1982edd
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
地图宿主相同的 camera revision。互斥范围只覆盖一个 submitted frame 的构建。Submission
slot 会在 native observation 与延迟 settlement 完成前释放；这些 promise 会被独立追踪，
不能拖延更新 camera 的提交。只有最新 submitted frame 可以请求有界 convergence 或
residency follow-up，因此过期异步结果不能重新激活旧 camera decision。
