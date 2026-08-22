---
docId: geo.views-frames
canonical: true
apiSources:
  - packages/geoscratch/src/geo/frame-controller.ts
  - packages/geoscratch/src/geo/geo-view.ts
  - packages/geoscratch/src/geo/maplibre-frame-driver.ts
  - packages/geoscratch/src/geo/maplibre-planar-view.ts
---
# Views And Frame Control

[简体中文](./views-frames_zh.md) | [Geo overview](./README.md)

`GeoViewAdapter` reads an external camera or map and produces immutable
`GeoViewSnapshot` values containing a logical `referenceViewport`, matrices, camera
position, zoom, orientation, and monotonic frame and residency revisions. The MapLibre planar adapter
translates MapLibre-compatible state without making MapLibre the owner of Geo resources.

Snapshots are observations, not global camera state. Screen-based demand may consume
them for visualization, while simulations, prefetch, editing, or offline processes may
produce independent demand. This distinction prevents camera locality from becoming a
universal resource policy.

`GeoViewSource<View>` captures one immutable `{ view, presentationSize }` pair. It owns no frame
clock, revision, renderer, or external camera. `createGeoViewSource()` validates and
copies the positive integer physical presentation size while retaining the caller's immutable
view value. `mapLibrePlanarViewSource()` composes a planar adapter, structural MapLibre
map, presentation-size reader, and minimum elevation into that same source contract.
The source reads reference pixels from `map.transform.width/height`, so DPR changes the
WebGPU attachment size without changing camera projection, tile cover, or picking. A future
standalone camera can implement the same contract without changing a renderer.

`GeoFrameController` coordinates host-state capture, render construction, native
observation, delayed feedback, and invalidation for one assembled field. Every renderer
consumes the same frozen capture contract; host-driven and independent applications do
not select renderer modes.

## Two Entry Patterns

An independent application uses one source and the controller directly. The default scheduler is browser
`requestAnimationFrame`; tests, simulations, or manual loops can provide one
`GeoFrameScheduler` instead:

```ts
const view = createGeoViewSource({ id: 'view', capture: readIndependentView })
const frames = createGeoFrameController({
    capture: () => ({ revision: cameraRevision, snapshot: view.capture() }),
    render,
})
```

A MapLibre-hosted overlay adds exactly one nested driver:

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

`driver` is mutually exclusive with descriptor-level `capture` and `scheduler`. The
controller owns a supplied driver: construction starts it after controller callbacks exist,
and `stop()` cancels queued controller work before stopping the driver. The external map,
GPU runtime, field resources, and input controls remain caller-owned.

## Capture And Admission

An optional synchronous `capture()` returns a `GeoFrameCapture` containing a non-negative,
monotonically increasing revision and an immutable host snapshot. `invalidateNow()` calls
`capture()` inside an already-running host render callback. A new revision replaces the
pending capture in a latest-only mailbox; an identical revision increments
`deduplicatedInvalidationCount`, returns `false`, and does not schedule another submission.
A revision lower than the latest accepted capture stops the controller with
`GEO_FRAME_CAPTURE_STALE`. `render()` receives the frozen snapshot selected for that
submission, so later host mutation cannot change an admitted frame.

`invalidate()` remains a forceful application or convergence invalidation. It coalesces work
onto the configured frame scheduler and still renders when the host capture revision is
unchanged. This preserves presentation changes, residency completion, and GPU convergence.
When no `capture()` is configured, both invalidation methods preserve uncaptured scheduling.

A scheduler callback invokes `render()` synchronously, then observes its Promise-like result
asynchronously. An async render function therefore runs through its first `await` before the
host callback returns. This lets a prepared renderer submit WebGPU work in the same host
callback without making asynchronous observation block that callback.

Only construction of one submitted frame is mutually exclusive. The construction slot is
released before native observation and delayed settlement complete, while a separate
`maximumInFlightFrames` budget bounds submissions awaiting native observation. Its default is
three and its accepted range is one through eight. At capacity, repeated invalidations
collapse into one newest-state request without replaying intermediate camera states. Only the
latest submitted frame may request bounded convergence or residency follow-ups, so stale async
results cannot revive an obsolete decision. `snapshot()` exposes scheduling, in-flight,
capture-revision, and observation counters.

The budget is an application latency-throughput choice. One in-flight frame is the most
conservative camera-overlay policy, but it can reduce a 120 Hz host to half-rate when native
observation spans more than one display interval. A measured high-refresh overlay may select
two: pending invalidations remain latest-only, while the second slot prevents ordinary native
observation latency from suppressing the next host frame. Larger values require separate proof
because already-submitted frames cannot be cancelled.

## MapLibre Frame Driver

`mapLibreFrameDriver()` has no MapLibre package dependency. It validates a small structural
map contract, installs one `renderingMode: '2d'` custom layer, and performs no WebGL work.
`move` and `resize` advance one monotonic host revision. Controller requests call
`map.triggerRepaint()`, and the pending callback executes inside the custom-layer `render`
callback. Multiple changes before that callback retain only the newest revision; application
capture is cached once per revision. A `style.load` event reattaches the layer when absent.
Driver stop removes only its own layer, listeners, captures, and callbacks.

The shape is compatible with the example's pinned MapLibre GL JS 4.7.1 callback
`render(gl, matrix, options)` because the no-draw layer intentionally ignores all callback
arguments. See the [4.7.1 custom-layer source](https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/style/style_layer/custom_style_layer.ts)
and [current CustomLayerInterface documentation](https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/).

The driver synchronizes frame authority; it does not merge rendering contexts. A separate
WebGPU canvas still does not share MapLibre's WebGL context, render pass, depth buffer, or
atomic presentation.
