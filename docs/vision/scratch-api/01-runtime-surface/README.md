# Runtime And Surface

Status: Vision draft
Date: 2026-07-12

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
- pipeline and acknowledged supporting-object registries; each BindSet privately owns its prepared bind group
- submission scheduler defaults
- device-loss state
- current GPU operation facts and bounded diagnostic evidence
- current readback command/operation ownership and finite staging budgets

`Surface` owns:

- `GPUCanvasContext`
- canvas or `OffscreenCanvas`
- complete presentation configuration: format, usage, view formats, color space,
  optional tone mapping, and alpha mode
- current presentation texture access
- resize policy

## Ownership Rules

- A resource belongs to exactly one `ScratchRuntime`.
- A runtime's `GPU`, adapter, device, queue, and feature/limit snapshots are
  immutable ownership facts after creation; application code cannot swap the
  native device underneath diagnostics or allocation.
- Runtime disposal, device loss, and a monotonically increasing lifecycle epoch live
  in one module-private authority cell. Public lifecycle properties and
  `assertActive()` are observations of that cell; Scratch-internal lifecycle checks
  invoke the private authority directly, so an own property that shadows a public
  method cannot suppress lifecycle validation.
- A `GPUCanvasContext` is claimed by exactly one live `Surface`, and therefore
  exactly one `ScratchRuntime`, at a time.
- Resources from one runtime cannot be used by commands recorded on another runtime.
- A surface current texture is presentation-submission-scoped and must not be stored as a persistent resource.
- Disposing a surface does not dispose the runtime.
- Disposing a runtime invalidates its resources, surfaces, pipelines, bind sets, and commands.

## Exclusive Canvas-Context Ownership

`Surface` creation claims its `GPUCanvasContext` before changing canvas size or
calling `GPUCanvasContext.configure()`. A second live `Surface` for that context
is rejected with `SCRATCH_SURFACE_CONTEXT_IN_USE`, whether it comes from the same
runtime or another runtime. The diagnostic identifies both the attempted Surface
and the current owner; rejection performs no canvas, configure, or runtime-registry
effect. Every later Surface operation rechecks exact receiver identity; forged or
stale aliases fail with `SCRATCH_SURFACE_CONTEXT_NOT_OWNED` before lifecycle or
presentation effects.

Surface ownership, configuration, and lifecycle fields are read-only observations.
One module-private state record is authoritative for the exact receiver, including
terminal disposal. Ordinary untyped JavaScript field writes cannot transfer the claim,
publish candidate configuration, make a live owner replaceable, or suppress cleanup;
`dispose()` always cleans the originally claimed context and unregisters from the
original runtime.

`Surface.configure()` is a synchronous candidate transaction over format, usage,
view formats, color space, optional tone mapping, alpha mode, and size. Iterable and
dictionary inputs are materialized before native issue. Scratch then rechecks exact
context ownership, runtime lifecycle, and the entry configuration version, so a getter
or iterator that reentrantly disposes or reconfigures the Surface invalidates the
candidate before canvas or native effects. After canvas resize and native configure
return, Scratch requires `GPUCanvasContext.getConfiguration()` plus the canvas
dimensions to reflect the candidate before committing private state. Failure produces
`SCRATCH_SURFACE_CONFIGURATION_FAILED`, restores the actual pre-call canvas dimensions
and previous native configuration when possible, verifies both by exact readback, and
never publishes the candidate facts. `GPUCanvasContext.configure()` forbids usage that
contains `GPUTextureUsage.TRANSIENT_ATTACHMENT`, so Surface normalization rejects that
bit synchronously before canvas or native configuration effects. Transient attachments
remain available through ordinary `TextureResource` descriptors. Asynchronous native
validation remains part of the WebGPU error model and is not fabricated as synchronous
success/failure.

Before managed use, Scratch calls `GPUCanvasContext.getConfiguration()` and compares
its device, format, usage, view formats, color space, tone mapping, alpha mode, and
current canvas size with the private committed facts. Direct native configure,
unconfigure, or canvas-size drift therefore produces
`SCRATCH_SURFACE_CONFIGURATION_STALE` before current-texture or encoder effects. An
explicit `surface.configure()` or `surface.resize()` may restore the owned
configuration; submission never repairs it implicitly.

`Surface.dispose()` unconfigures the context and releases the claim. A replacement
Surface may claim it only after that explicit lifecycle transition. Construction
that fails after claiming also releases its uncommitted claim. Logical disposal,
runtime unregister, and claim release complete even if a non-conforming native
`unconfigure()` throws; the structured `SCRATCH_SURFACE_UNCONFIGURE_FAILED` is
reported after cleanup. Runtime disposal retains that failure, completes every other
owned cleanup and device destruction, then rethrows the first retained failure.
Scratch does not maintain multiple wrappers with hidden shared configuration.

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

## Explicit Surface And Resource Resize

`Surface` and persistent `TextureResource` allocations have separate ownership. An application that wants an offscreen texture to follow a surface coordinates both lifecycle operations explicitly:

```ts
surface.resize(nextSize)
await target.resize(surface.size)
```

`TextureResource.resize()` is a Promise-returning allocation transaction. The old allocation remains current while native validation and out-of-memory scopes settle. A successful changed size advances `allocationVersion`, preserves `contentEpoch`, and leaves the replacement allocation empty until a later content-producing operation writes it. This is not a surface responsibility and does not add submission or queue work.

Core does not install a `ResizeObserver`, poll canvas dimensions, register a hidden surface subscription, scan runtime textures, or infer which resource follows which surface. Future tracked or derived dimensions may call the same explicit resize primitive, but they must not create a second allocation-replacement path.

## Async Pipeline Ownership

Render and compute pipeline factories are runtime-owned asynchronous
transactions:

```ts
const renderPipeline = await runtime.createRenderPipeline(renderDescriptor)
const computePipeline = await runtime.createComputePipeline(computeDescriptor)
```

The runtime does not publish a pending pipeline wrapper. Pipeline preparation captures
an internal Program/Runtime lifecycle stamp, materializes caller-owned Program and
descriptor facts, and rechecks the stamp before any shader-module, pipeline-layout, or
native pipeline creation. The same stamp is checked after the native async transaction
settles and before a successful result is committed as a public Pipeline. A lifecycle
change before native issue reports the direct Runtime or Program diagnostic with zero
native creation work. A change after issue rejects publication and records the bounded
pipeline-creation lifecycle diagnostic; Scratch does not claim that an already-issued
WebGPU promise can be cancelled.

Only one bounded pending fact is retained while shader-module and pipeline-layout
scopes, compilation information, and the native async pipeline Promise settle. Before
commit Scratch also rechecks every BindLayout. Current pipeline facts scale with live
pipelines; historical operations remain in the bounded recorder. Pipeline creation
does not add work or waits to `SubmissionBuilder.submit()`, does not expose a public
`prepare()` state, and does not replay caller getters through automatic retry.

## Async Supporting-Object Ownership

Persistent SamplerResource, QuerySetResource, BindLayout, and BindSet factories
are also Promise-only runtime transactions:

```ts
const sampler = await runtime.createSampler(samplerDescriptor)
const querySet = await runtime.createQuerySet(queryDescriptor)
const layout = await runtime.createBindLayout(layoutDescriptor)
const set = await runtime.createBindSet(layout, bindings)
```

Each candidate is registered only after native issue, scope acknowledgement,
and lifecycle rechecks succeed. Constructors and synchronous bypasses are
closed. BindSet creation additionally completes generation-one preparation;
later allocation replacement makes it stale and requires explicit
`await set.prepare()`. Submission stays synchronous and never performs this
work, waits for it, or retries it.

## Readback Ownership And Budgets

Readback ownership belongs to the runtime, not to a global queue helper or a
resource convenience method. Runtime creation accepts only the implemented
finite policy:

```ts
const runtime = await ScratchRuntime.create({
    readback: {
        maxPendingOperations: 16,
        maxStagingBytes: 64 * 1024 * 1024,
    },
})
```

`runtime.readbackPolicy` is a frozen normalized snapshot. The runtime fact
graph reports current readback commands, active or retained operations,
current/peak staging bytes, current/peak retained host bytes, and active
mappings. These are current ownership facts and do not grow with runtime age.
GPU staging bytes are logical Scratch allocation facts, not physical residency
or free-VRAM measurements; retained host bytes are counted separately.

Creating a direct `ReadbackOperation` is synchronous because it allocates
nothing. Its first materialization reserves budget and acknowledges one
ephemeral staging buffer before encoder or queue use. Ordered factories are
Promise-only because their reusable staging slot must be acknowledged before a
`ReadbackCommand` becomes visible:

```ts
const command = await runtime.createReadbackCommand(descriptor)
const alias = await runtime.readbackCommand(descriptor)
```

There is no synchronous ordered factory, pending wrapper, lazy submit-time
allocation, hidden retry, or native staging handle on the public objects.
`SubmissionBuilder.submit()` remains synchronous and never waits for mapping or
host-copy completion.

## Submission Native Observation Ownership And Budgets

Submission native observation is runtime-owned diagnostics policy. Runtime
creation exposes the complete persistent policy surface:

```ts
const runtime = await ScratchRuntime.create({
    diagnostics: {
        submissionScopes: 'summary',
        maxPendingNativeObservations: 64,
    },
})
```

`summary` is the default. One effectful submission or direct readback reserves
one native-observation owner and uses one constant-size validation, internal,
and out-of-memory scope bundle around its complete native issue family. The
number of scopes does not grow with passes, commands, encoder segments, or
queue actions. `off` opens no such scopes and reports explicit `unobserved`
provenance; it does not reinterpret queue completion as native validation
acknowledgement. Effect-free submissions reserve no owner and report
`no-native-work`.

`maxPendingNativeObservations` is a shared finite limit for unsettled
submission and direct-readback observations. Exhaustion fails before encoder or
queue effects instead of silently degrading to `off`. The always-current fact
graph exposes `submissionScopes`, `maxPendingNativeObservations`,
`currentPendingNativeObservations`, `peakPendingNativeObservations`, and
`currentEffectfulSubmittedWork`. These facts scale with unsettled ownership,
not runtime age; bounded operation and incident history remains a separate
retention concern.

## Device Loss

`ScratchRuntime` owns device-loss handling. After device loss:

- physical GPU objects are invalid
- logical resources may remain as rehydratable descriptions
- caches must be dropped
- surfaces must be reconfigured against the replacement device
- commands and pass specs can remain as logical descriptions if their dependencies can be rebuilt

Device loss produces a bounded runtime incident with pending-operation and current-resource context. Nearby operations are temporal evidence, not proof of causality. The listener and every covered allocation remain tied to the same immutable runtime-owned device. The runtime does not automatically retry allocations, recreate the device, rehydrate resources, or replay submissions.

The first implementation may choose a conservative failure mode, but the API should not make rehydration impossible.

## Non-Goals

- Do not provide a global device as a core contract.
- Do not bind runtime creation to canvas creation.
- Do not put React, Vue, Svelte, or other framework lifecycle helpers in the core.
- Do not make `Surface` responsible for resource caches or scheduling.
