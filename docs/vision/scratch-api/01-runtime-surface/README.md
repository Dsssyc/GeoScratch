# Runtime And Surface

Status: Vision draft
Date: 2026-06-30

## Decision

The core API uses an explicit async `ScratchRuntime`. The runtime is not bound to a canvas. Presentation is modeled by separate `Surface` objects.

This follows the WebGPU lifecycle:

```text
GPUAdapter -> GPUDevice -> resources / queues / commands
canvas -> GPUCanvasContext -> configured presentation surface
```

Unlike WebGL, the GPU execution context is not the canvas context. This separation is required for multi-canvas, compute-only, offscreen, and worker-oriented workflows.

## Target Shape

```ts
const scratch = await ScratchRuntime.create({
    powerPreference: 'high-performance',
    requiredFeatures: [],
    requiredLimits: {},
})

const surface = scratch.surface(canvas, {
    format: 'preferred',
    alphaMode: 'premultiplied',
})
```

`ScratchRuntime` owns:

- `GPUDevice`
- `GPUQueue`
- device limits and features
- resource registry
- pipeline and bind group caches
- submission scheduler defaults
- device-loss state

`Surface` owns:

- `GPUCanvasContext`
- canvas or `OffscreenCanvas`
- presentation format
- alpha mode and configure options
- current presentation texture access
- resize policy

## Ownership Rules

- A resource belongs to exactly one `ScratchRuntime`.
- A surface is configured by exactly one `ScratchRuntime` at a time.
- Resources from one runtime cannot be used by commands recorded on another runtime.
- A surface current texture is presentation-submission-scoped and must not be stored as a persistent resource.
- Disposing a surface does not dispose the runtime.
- Disposing a runtime invalidates its resources, surfaces, pipelines, bind sets, and commands.

## Surface Is Not A TextureResource

A surface can produce a current presentation texture view, but it should not inherit from or masquerade as `TextureResource`.

Reasoning:

- swapchain textures are borrowed per presentation submission
- they are not long-lived logical resources
- their lifetime is controlled by the browser presentation system
- caching them like normal textures would corrupt allocation/content epoch semantics

Use a presentation-submission-scoped borrowed handle instead:

```ts
submission.render(outputPass, [compositeTo(surface.currentView(submission))])
```

The exact syntax may change, but the semantic boundary should not.

`Submission` here means the core submission builder defined in `05` / `07`. A compute-only submission has no current surface texture; only a presentation submission can borrow a surface current texture view.

## Device Loss

`ScratchRuntime` owns device-loss handling. After device loss:

- physical GPU objects are invalid
- logical resources may remain as rehydratable descriptions
- caches must be dropped
- surfaces must be reconfigured against the replacement device
- commands and pass specs can remain as logical descriptions if their dependencies can be rebuilt

The first implementation may choose a conservative failure mode, but the API should not make rehydration impossible.

## Non-Goals

- Do not provide a global device as a core contract.
- Do not bind runtime creation to canvas creation.
- Do not put React, Vue, Svelte, or other framework lifecycle helpers in the core.
- Do not make `Surface` responsible for resource caches or scheduling.
