---
docId: geo.views-frames.zh
canonical: false
translationOf: ./views-frames.md
canonicalDigest: 78426bc0f404ea32d71dc85472e1f8856d018793ddd3c50ecf949b03c5b6db10
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
