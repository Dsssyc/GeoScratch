---
docId: geo.views-frames.zh
canonical: false
translationOf: ./views-frames.md
canonicalDigest: e056efd9b9153c512101194eafaaffa40d566ff8125ed8bb1d878b6512f86e08
---
# 视图与帧控制

[English](./views-frames.md) | [Geo 概览](./README_zh.md)

`GeoViewAdapter` 读取外部 camera 或 map，并生成不可变 `GeoViewSnapshot`，其中包含
逻辑 `referenceViewport`、matrix、camera position、zoom、orientation，以及单调的 frame 与 residency
revision。MapLibre 平面 adapter 转换 MapLibre-compatible state，但不会让 MapLibre
成为 Geo resource owner。

Snapshot 是观测，不是全局 camera state。Screen-based demand 可以在可视化中消费它；
simulation、prefetch、editing 或 offline process 可以产生独立 demand。这一区分避免
camera locality 成为普遍资源策略。

`GeoViewSource<View>` 捕获一个不可变 `{ view, presentationSize }`。它不拥有 frame clock、revision、
renderer 或外部 camera。`createGeoViewSource()` 会验证并复制正整数物理 presentation size，
同时保留 caller 提供的 immutable view。`mapLibrePlanarViewSource()` 把 planar adapter、
structural MapLibre map、presentation-size reader 与 minimum elevation 组合成同一种 source contract。
该 source 从 `map.transform.width/height` 读取 reference pixels，因此 DPR 只改变 WebGPU
attachment size，不改变 camera projection、tile cover 或 picking。
未来独立相机可以实现同一契约，而无需修改 renderer。

`GeoFrameController` 为一个装配后的 field 协调 host-state capture、render construction、
native observation、delayed feedback 与 invalidation。所有 renderer 都消费同一个已冻结的
capture contract；host-driven 与 independent application 不会选择不同的 renderer mode。

## 两种入口形式

独立应用使用一个 source，并直接使用 controller。默认 scheduler 是浏览器 `requestAnimationFrame`；test、
simulation 或 manual loop 也可以提供一个 `GeoFrameScheduler`：

```ts
const view = createGeoViewSource({ id: 'view', capture: readIndependentView })
const frames = createGeoFrameController({
    capture: () => ({ revision: cameraRevision, snapshot: view.capture() }),
    render,
})
```

MapLibre-hosted overlay 只增加一个嵌套 driver：

```ts
const view = mapLibrePlanarViewSource({
    id: 'map-view',
    adapter,
    map,
    presentationSize: readPhysicalCanvasSize,
    minimumElevationMeters,
})
const frames = createGeoFrameController({
    driver: mapLibreFrameDriver({
        id: 'terrain-frames',
        map,
        capture: view.capture,
    }),
    render: (_frameNumber, capture) => renderer.render(capture),
})
```

`driver` 与 descriptor-level `capture`、`scheduler` 互斥。Controller 拥有传入的 driver：
构造过程会在 controller callback 已经存在后启动 driver；`stop()` 会先取消排队中的
controller work，再停止 driver。外部 map、GPU runtime、field resource 与 input control
仍由 caller 拥有。

## Capture 与准入

可选的同步 `capture()` 会返回 `GeoFrameCapture`，其中包含非负、单调递增的 revision 与
不可变 host snapshot。`invalidateNow()` 会在正在执行的 host render callback 内调用
`capture()`。新的 revision 会替换 latest-only mailbox 中待处理的 capture；相同 revision
会增加 `deduplicatedInvalidationCount`、返回 `false`，并且不会安排新的 submission。低于
最近已接受 revision 的 capture 会以 `GEO_FRAME_CAPTURE_STALE` 停止 controller。
`render()` 接收本次 submission 已冻结的 snapshot，因此后续 host mutation 无法改变已准入
的 frame。

`invalidate()` 仍是强制的 application 或 convergence invalidation。它会把工作合并到配置的
frame scheduler，即使 host capture revision 未变化也仍会 render，从而保留 presentation
change、residency completion 与 GPU convergence。未配置 `capture()` 时，两种 invalidation
方法保持无 capture 调度行为。

Scheduler callback 会同步调用 `render()`，再异步观察它返回的 Promise-like result。因此
async render function 会在 host callback 返回前一直运行到第一个 `await`。已完成准备的
renderer 可以在同一个 host callback 中提交 WebGPU work，而异步 observation 不会阻塞该
callback。

互斥范围只覆盖一个 submitted frame 的构建。构建 slot 会在 native observation 与延迟
settlement 完成前释放；另一个独立的 `maximumInFlightFrames` budget 会约束等待 native
observation 的 submission。默认值为 3，合法范围为 1 到 8。达到上限后，重复 invalidation
会合并为一个 newest-state request，而不会重放中间 camera state。只有最新 submitted frame
可以请求有界 convergence 或 residency follow-up，因此过期异步结果不能重新激活旧 decision。
`snapshot()` 会暴露 scheduling、in-flight、capture revision 与 observation counter。

该 budget 是由应用选择的 latency-throughput 权衡。一个 in-flight frame 是最保守的
camera-overlay policy；但当 native observation 跨越一个以上 display interval 时，它可能把
120 Hz host 压成半帧率。经过测量的高刷新率 overlay 可以选择两个 slot：pending
invalidation 仍保持 latest-only，第二个 slot 则避免普通 native observation latency 抑制下一
host frame。更大的值必须另行证明，因为已经提交的 frame 无法取消。

## MapLibre Frame Driver

`mapLibreFrameDriver()` 不依赖 MapLibre package。它验证一个很小的 structural map
contract，安装一个 `renderingMode: '2d'` custom layer，并且不执行任何 WebGL work。
`move` 与 `resize` 推进单调 host revision。Controller request 调用
`map.triggerRepaint()`，pending callback 在 custom-layer `render` callback 内执行。同一
callback 前发生多个 host change 时只保留最新 revision；application capture 每个 revision
只读取一次。`style.load` 会在 driver layer 缺失时重新挂载。Driver stop 只移除自己拥有的
layer、listener、capture 与 callback。

这个结构兼容 example 固定使用的 MapLibre GL JS 4.7.1 callback
`render(gl, matrix, options)`，因为 no-draw layer 会有意忽略所有 callback argument。参见
[4.7.1 custom-layer source](https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/style/style_layer/custom_style_layer.ts)
和[当前 CustomLayerInterface 文档](https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/)。

Driver 同步的是 frame authority，并不会合并 rendering context。独立 WebGPU canvas 仍不与
MapLibre 的 WebGL context、render pass、depth buffer 或 atomic presentation 共享状态。

相关决策：`docs/decisions/ADR-080-geo-view-source-terrain-frame-composition.md`
定义 view source 与 frame composition；
`docs/decisions/ADR-084-reference-pixel-terrain-lod.md` 区分逻辑 reference pixel
与物理 presentation pixel。
