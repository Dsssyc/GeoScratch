# Geo Frame Driver Design

## Status

Approved for implementation on 2026-08-17.

## Goal

Let one Geo renderer run from either an independent GeoScratch frame loop or an
external map host without adding renderer modes or repeating host event wiring in
applications. Keep the public assembly small enough that a developer or agent can
understand the complete entry path from one example.

## Current Problem

`GeoViewSnapshot` already isolates the GPU frontier and renderer from camera ownership,
and `GeoFrameController` already owns latest-only capture, backpressure, and bounded
convergence. The remaining host-specific state machine is still application-owned:

- Underwater Terrain listens to MapLibre `move`, `resize`, and post-render `render` events;
- the application invents and caches a host-view revision;
- controller-owned convergence frames use a browser RAF rather than MapLibre's frame;
- WebGPU frame construction starts after an extra Promise boundary.

This is valid as an independent overlay fallback, but it is not the strongest embedded
MapLibre integration and it makes every downstream application repeat the same policy.

## Public Composition

The only new high-level assembly is:

```ts
const frames = createGeoFrameController({
    driver: mapLibreFrameDriver({
        id: 'terrain-frames',
        map,
        capture: readCameraAndViewport,
    }),
    render,
})
```

Without `driver`, `createGeoFrameController()` retains its current independent mode:
the caller can use the default browser scheduler or supply a low-level
`GeoFrameScheduler`. No separate standalone controller or renderer is introduced.

`driver` is mutually exclusive with descriptor-level `capture` and `scheduler`. This
keeps one obvious authority for host revisions, capture, scheduling, and shutdown.

## Contracts

### `GeoFrameDriver<Capture>`

A driver contributes exactly four things to `GeoFrameController`:

- a stable `id` for diagnostics;
- a scheduler on which the controller requests every external or convergence frame;
- a revisioned synchronous capture function;
- `start(invalidate)` and idempotent `stop()` lifecycle hooks.

The controller owns a supplied driver. Controller construction starts it only after the
controller callbacks exist, and `controller.stop()` stops it after cancelling queued
work. Driver setup failure is reported through the existing structured Geo diagnostic
path.

### `mapLibreFrameDriver()`

The dependency-light MapLibre-compatible driver:

- installs one no-draw custom layer;
- increments its host revision on `move` and `resize`;
- routes all controller scheduler requests through `map.triggerRepaint()`;
- executes the pending controller callback inside the custom layer `render` callback;
- caches one application capture per host revision;
- reattaches after `style.load` when the layer is absent;
- removes its listeners, pending callbacks, and custom layer on stop; and
- never mutates WebGL state or claims access to MapLibre's depth buffer.

The structural render method accepts MapLibre 4.7.1's three-argument callback and newer
callback shapes by ignoring all arguments. The application remains pinned to 4.7.1, whose
official source defines custom-layer `render(gl, matrix, options)` and permits repaint
requests through `Map.triggerRepaint()`:

- https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/style/style_layer/custom_style_layer.ts
- https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/

### Synchronous Admission

`GeoFrameController` invokes `render()` synchronously when a scheduled host callback is
admitted, then observes its returned Promise-like result asynchronously. An async render
function therefore executes through its first `await` inside the host custom-layer
callback. Underwater Terrain's normal-size path calls the terrain renderer and submits
WebGPU work before that first await.

Synchronous invocation does not make two canvases share a context, render pass, depth
buffer, or atomic presentation. It removes the avoidable application event and Promise
phase boundaries while preserving explicit two-context ownership.

## Ownership

- The host owns its map, camera, WebGL context, and interaction handlers.
- The MapLibre driver owns only its listeners, custom-layer registration, and pending
  scheduler callbacks.
- `GeoFrameController` owns the supplied driver and all Geo frame scheduling policy.
- `GeoViewAdapter` owns conversion into immutable view facts.
- The renderer continues to consume one camera-state contract and has no host mode.

## Underwater Terrain Migration

The example will use `mapLibreFrameDriver()` inside the controller descriptor and delete
its local MapLibre `move`, `resize`, and `render` frame-authority wiring. The window resize
listener remains application-owned only to call `map.resize()`; MapLibre's resulting
`resize` event is handled by the driver. Presentation changes and residency convergence
continue to call the same controller and are rendered on a MapLibre frame.

## Diagnostics And Simplicity Gates

- Invalid drivers, conflicting descriptor authorities, duplicate layer ids, and invalid
  MapLibre-compatible maps produce machine-readable Geo diagnostics.
- No renderer accepts `maplibre`, `standalone`, or `manual` mode flags.
- The example contains no local host-view revision counter or map render listener.
- One synthetic camera capture must produce the same downstream camera state regardless
  of whether the controller uses the default scheduler or the MapLibre driver.
- Public TypeScript coverage demonstrates the nested one-entry assembly.

## Verification

- Unit red/green proof for synchronous render invocation.
- Unit tests for MapLibre scheduling, revision caching, style reattachment, authority
  conflicts, and idempotent stop.
- Type-level public API coverage.
- Underwater Terrain structural ownership test.
- Canonical English and Chinese API documentation plus generated reference checks.
- Full typecheck, test, and build gates.
- Real WebGPU browser proof for camera motion, frame lag, stale transitions, convergence,
  cleanup, and clean console output.

## Non-Goals

- Sharing MapLibre's WebGL render pass or depth buffer with WebGPU.
- Implementing the standalone camera controller in this change.
- Adding a renderer mode enum or MapLibre dependency to the package.
- Generalizing custom layers for arbitrary non-frame MapLibre rendering.
