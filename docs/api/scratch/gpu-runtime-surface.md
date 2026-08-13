---
docId: scratch.gpu-runtime-surface
canonical: true
apiSources:
  - packages/geoscratch/src/scratch/gpu/runtime.ts
  - packages/geoscratch/src/scratch/gpu/surface.ts
  - packages/geoscratch/src/scratch/gpu/temporal-texture.ts
---
# GPU Runtime And Surfaces

[简体中文](./gpu-runtime-surface_zh.md) | [Scratch overview](./README.md)

`GPURuntime.create()` is the explicit asynchronous device boundary. One runtime owns
its adapter, device, queue, capabilities, diagnostics, resource registry, and
submission authority. Creation does not require a canvas. Device loss and disposal
advance lifecycle authority so stale asynchronous completions cannot mutate a newer
state.

`Surface` is separately owned presentation state around a canvas context. It may be
configured, resized, and disposed without disposing the runtime. A current swap-chain
texture is temporal: `SurfaceTextureLease`, `SurfaceTextureView`, and external texture
bindings are attempt-local handles, not persistent resources. They cannot escape the
acquisition/submission interval in which WebGPU defines them.

The runtime does not choose a render loop, camera, scene, or map. The surface does not
own the device. Applications may own multiple surfaces for one runtime, but runtime
ownership validation prevents resources from crossing devices accidentally.
