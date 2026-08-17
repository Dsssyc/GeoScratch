# ADR-079: Compose Geo Frame Authority Through Owned Drivers

## Status

Accepted. Extends ADR-069 without changing its latest-only capture, bounded native
observation, or convergence rules.

## Date

2026-08-17

## Context

`GeoViewSnapshot` already prevents the GPU frontier and terrain renderer from depending on
MapLibre camera ownership. ADR-069 moved capture, backpressure, delayed feedback, and bounded
convergence into `GeoFrameController`. Underwater Terrain nevertheless still owned a small
MapLibre-specific state machine: `move` and `resize` revisions, capture caching, a post-render
event listener, and cleanup for those listeners.

That path was not fundamentally invalid. A separate WebGPU canvas must retain its own device,
surface, resources, and asynchronous observation, and a future standalone GeoScratch
application needs independent frame and camera authority. The problem was treating independent
frame scheduling as the only host integration. MapLibre-hosted overlays should admit work from
the host's own render callback, while both forms continue to use one controller and renderer.

## Decision

### Keep one controller and renderer contract

`GeoFrameControllerDescriptor` accepts an optional `GeoFrameDriver<Capture>`. A driver supplies
one stable id, revisioned capture, scheduler, start hook, and idempotent stop hook. It is mutually
exclusive with descriptor-level `capture` and `scheduler`; accepting competing authorities would
make revision and lifecycle ownership ambiguous.

The controller owns a supplied driver. It defensively captures the driver methods, starts the
driver after the controller callbacks exist, cancels queued work before driver stop, and stops
the driver at most once. Applications without a driver retain the existing browser scheduler or
explicit low-level scheduler path. No standalone-specific or host-specific renderer is added.

### Admit frame construction synchronously

When a scheduler callback is admitted, the controller invokes `render()` synchronously and then
observes its returned Promise-like result asynchronously. An async render operation executes
through its first `await` in that callback. A prepared renderer can therefore encode and submit
WebGPU work during a host custom-layer callback without making native observation synchronous.

This is an invocation guarantee, not a promise that every render operation submits before its
first await. Resize or preparation may intentionally defer submission.

### Provide a dependency-light MapLibre driver

`mapLibreFrameDriver()` accepts a structural map contract and does not import MapLibre. It adds
one no-draw `renderingMode: '2d'` custom layer. Controller scheduler requests call
`map.triggerRepaint()`; the pending callback runs inside that layer's `render` method. `move` and
`resize` advance one monotonic host revision, while capture is cached once per revision. Multiple
changes before one host frame collapse to the newest revision. `style.load` reattaches an absent
owned layer.

The driver removes only its own layer, listeners, callbacks, and cached capture. A pre-existing
layer id is a structured `GEO_MAPLIBRE_FRAME_LAYER_CONFLICT` and is never removed during failed
setup. The no-draw layer ignores callback arguments and performs no WebGL state changes.

The example is pinned to MapLibre GL JS 4.7.1, whose public custom-layer contract is
`render(gl, matrix, options)`. Ignoring callback arguments also remains compatible with newer
custom-layer callback shapes:

- [MapLibre GL JS 4.7.1 custom-layer source](https://github.com/maplibre/maplibre-gl-js/blob/v4.7.1/src/style/style_layer/custom_style_layer.ts)
- [Current CustomLayerInterface documentation](https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/)

### Preserve the two-context boundary

The MapLibre driver synchronizes camera capture and frame admission. It does not make WebGPU a
MapLibre WebGL custom renderer and does not claim shared context, depth, render pass, command
encoder, or atomic presentation. The WebGPU canvas, `GPURuntime`, `Surface`, and Geo renderer
remain independently owned.

## Consequences

- Underwater Terrain has one nested host entry and no application-owned map render listener,
  host revision, or capture cache.
- Presentation changes, residency settlement, and convergence frames request a MapLibre repaint
  through the same driver instead of starting a separate browser RAF phase.
- Standalone applications remain first-class and use the controller directly.
- A future standalone camera controller only needs to produce the existing capture/view facts;
  it does not require another terrain renderer or LoD implementation.
- Host-driver implementations carry explicit setup and cleanup responsibility, while the
  controller remains the single scheduling and backpressure authority.

## Rejected Alternatives

### Add renderer modes

Rejected because `maplibre`, `standalone`, and `manual` branches inside renderers would duplicate
camera and LoD behavior and make equivalent view facts produce different execution paths.

### Keep MapLibre event wiring in every application

Rejected because host revision, capture caching, repaint scheduling, style reload, and cleanup
are reusable Geo integration semantics rather than Underwater Terrain presentation policy.

### Treat the WebGPU overlay as a WebGL custom layer

Rejected because MapLibre's custom layer receives a WebGL context. It can synchronize a separate
WebGPU submission but cannot merge the two APIs' contexts, render passes, or depth attachments.

### Remove independent scheduling

Rejected because standalone maps, simulations, editing tools, offscreen work, and future globe
applications must be able to own their camera and frame clocks without constructing MapLibre.
