# ADR-049: Unify Scratch Attempt-Local Texture Handles

## Status

Accepted

## Date

2026-07-24

## Context

Scratch currently models persistent textures with `TextureResource` and borrows
the current canvas texture only while realizing a render attachment. WebGPU
also exposes two texture-like values whose validity is temporal rather than
persistent:

- `GPUExternalTexture`, imported from a video source and valid according to
  task or source-frame lifetime; and
- the texture returned by `GPUCanvasContext.getCurrentTexture()`, valid for the
  current presentation attempt.

Neither value has Scratch allocation versions, content epochs, replacement,
resize, destruction, or persistent resource identity. Treating either as a
`TextureResource` would fabricate ownership. Keeping separate hidden paths
would make binding, copying, render attachments, bundle realization, and
diagnostics disagree about which native texture belongs to one submission.

The frozen baseline is WebGPU CRD 14 July 2026, SHA-256
`23b38cef5e23be710ef865b800f63e5874edd03bb08bbecfa8ac5b3020b47d30`.

## Decision

Scratch uses one module-private `AttemptTextureAuthority` for both external
textures and current surface textures. It is constructed only by
`SubmissionBuilder.submit()` after deterministic plan validation and before the
first selected native operation. It:

- imports each selected external binding once and acquires each selected
  Surface current texture at most once per submission attempt;
- shares that realization across every selected use in the attempt;
- never mutates persistent `PassSpec`, `Command`, `BindSet`, or resource state;
- validates exact Runtime, Surface, source, task/frame, configuration, and
  usage facts before native effects;
- expires every public Surface borrow at the attempt boundary or earlier
  lifecycle invalidation;
- keeps native handles out of persistent diagnostics and serialized evidence;
  and
- supports structured stale-handle, wrong-Runtime, unsupported-usage, and
  native-import diagnostics.

The authority is not a render graph, scheduler, or persistent cache. Its maps
exist only for the synchronous native-issue portion of one submission. Closing
the authority drops every native external texture, surface texture, generated
surface view, and attempt-local bind group reference.

## Public Contract

### External Texture Binding

An external texture is authored as a stable import description:

```ts
type ExternalTextureBindingDescriptor = {
    label?: string
    source: HTMLVideoElement | VideoFrame
    colorSpace?: PredefinedColorSpace
}

const video = runtime.externalTexture({
    label: 'camera frame',
    source: videoElement,
    colorSpace: 'srgb',
})
```

`runtime.createExternalTextureBinding(descriptor)` is the canonical factory and
`runtime.externalTexture(descriptor)` is its compact alias. Both are
synchronous because they do not call `GPUDevice.importExternalTexture()`.
`ExternalTextureBinding` retains the caller-provided source privately so the
source can be imported during each selected submission. Public observations and
diagnostics expose only bounded source facts; they never expose or serialize the
source object or pixels.

An external-texture `BindLayout` entry has `type: 'external-texture'`. Its
corresponding BindSet value may be:

- `ExternalTextureBinding`, lowered with `GPUDevice.importExternalTexture()`;
- `TextureResource`, lowered as its current `GPUTexture`;
- `TextureViewSpec`, lowered as a freshly validated `GPUTextureView`;
- `SurfaceTextureLease`, lowered as the attempt's current `GPUTexture`; or
- `SurfaceTextureView`, lowered as a view of that same current texture.

This is the complete managed representation of the frozen native external
texture binding resource union. It does not equate a persistent texture with an
imported video frame.

### Surface Texture Lease

A submission owns its Surface borrow:

```ts
const submission = runtime.createSubmission()
const current = submission.surfaceTexture(surface)
const sampled = current.view({
    label: 'current surface sample',
    dimension: '2d',
})
```

`SubmissionBuilder.surfaceTexture(surface)` returns a
`SurfaceTextureLease`. The lease is a branded declarative borrow, not a native
texture and not a `Resource`. It records the exact builder, Runtime, Surface,
and Surface configuration version. It has no allocation version, content
epoch, resize, upload, destroy, or native-handle property.

`SurfaceTextureLease.view(descriptor?)` returns a branded
`SurfaceTextureView`. The view descriptor is snapshotted and validated against
the Surface format, view formats, dimensions, and configured usage. Neither the
lease nor its view calls `getCurrentTexture()` or `createView()`.

A lease can be selected as:

- a render or resolve attachment;
- the texture endpoint of `CopyCommand`;
- the source of `SurfaceTextureLease.view()` for an ordinary texture binding;
- a texture or view resource in an external-texture binding.

The Surface's committed `GPUCanvasConfiguration.usage` must contain the native
usage required by every selected role. A lease is valid only in its owning
builder's first submission attempt. Reconfiguration, Surface disposal, Runtime
disposal, device loss, a different builder, or completion/failure after native
issue makes it stale. Deterministic preflight failure before native issue does
not fabricate an acquisition.

Existing `RenderPassSpec` targets may continue to name a `Surface` directly.
That form is syntactic sugar for an internal borrow owned by the submitting
builder. It lowers through the same `AttemptTextureAuthority`, so attachment,
copy, and binding uses of one Surface share one `getCurrentTexture()` result.
The raw `Surface.getCurrentTexture()` method is removed from the managed public
API; callers needing unmanaged access already have the explicit
`runtime.device` and `surface.context` escape hatches.

### BindSet Realization

Persistent-only BindSets retain the existing acknowledged `prepare()` contract.
A BindSet containing `ExternalTextureBinding`, `SurfaceTextureLease`, or
`SurfaceTextureView` has `preparationState: 'attempt-local'` and
`isAttemptLocal: true`. Creation validates and freezes the stable binding shape
without creating a native bind group. The selected submission creates exactly
one native bind group for that BindSet in its attempt; callers do not call
`prepare()` per frame and Scratch does not mutate or repair the BindSet.

Direct `DrawCommand.encode()`, `DispatchCommand.encode()`, or
`CopyCommand.encode()` without a submission authority rejects temporal
dependencies with a structured diagnostic. Submission encoding supplies the
attempt-local bind group or texture endpoint explicitly.

### Copy Contract

Persistent texture reads keep their explicit content epoch:

```ts
{ resource: texture, contentEpoch: texture.contentEpoch }
```

A Surface read instead uses:

```ts
{ surface: surfaceTextureLease }
```

`SurfaceTextureLease` is also accepted as a texture copy destination. It never
acquires or advances a persistent content epoch. Copy validation uses the
Surface's snapshotted format, size, sample count `1`, dimension `2d`, and
configured usage while preserving the existing native
`copyTextureToTexture()`, `copyBufferToTexture()`, and
`copyTextureToBuffer()` paths.

## Ordering And Error Ownership

Submission first resolves readiness/fallback selection and validates every
selected temporal dependency. No source getter, callback, or user iterator is
invoked after native issue begins. The synchronous native sequence then stays
inside the submission's existing error-scope and provenance authority:

1. import/acquire the first time a selected dependency is needed;
2. create any selected view;
3. create the selected attempt-local bind group;
4. encode the command that consumes it;
5. submit in authored order;
6. expire the authority and its public Surface leases.

No `await` is inserted between `importExternalTexture()` and the selected
command use. Synchronous exceptions are converted to structured submission
failures. Asynchronous validation, internal, OOM, uncaptured-error, and device
loss outcomes remain owned by `SubmittedWork`; Scratch does not claim
synchronous success.

## Identity And Diagnostics

`ExternalTextureBinding`, `SurfaceTextureLease`, and `SurfaceTextureView` use
private brand/state maps and exact-receiver checks. Forged objects, prototype
aliases, wrong-Runtime values, wrong-builder leases, and stale leases fail
before native effects.

Attempt facts include bounded IDs, source kind, safely observable dimensions,
color space, Surface ID/configuration version, selected roles, and native
operation locations. They exclude source objects, frame contents, pixels,
native handles, and unbounded histories. Native object equality on external
texture re-import is never interpreted as a Scratch allocation or content
epoch.

The public contracts therefore distinguish:

- an external texture source description that can be realized for a selected
  attempt;
- a submission-scoped surface texture lease that can produce declarative,
  validated views;
  and
- persistent `TextureResource` and `TextureViewSpec`.

The classes are exported from both `geoscratch` and `geoscratch/scratch`, but
their constructors are private. Only the factories above can create genuine
instances.

## Rejected Directions

- Persistent logical resources for external or presentation textures.
- A per-frame `prepare()` state machine.
- CPU pixel extraction or upload as a substitute for native import.
- Independent current-texture acquisition paths for attachments and other
  commands.
- A caller callback or provider invoked after native effects begin.
- Awaiting an error-scope result between external texture import and use.
- Persisting an attempt-local bind group or surface view as prepared BindSet
  state.
- Retaining video frames, pixels, native textures, or unbounded attempt
  histories in diagnostics.

## Acceptance Evidence

The Phase 1 checkpoint is backed by focused lifecycle, anti-forgery,
cross-family binding/copy/attachment, type, and provenance tests. The complete
Node suite reported 1063 passing with the two pre-existing expected pending
browser/final-audit gates; typecheck, package/example build, the fixed
WebGPU/WGSL manifest audit, and the 51-call submission native provenance
inventory passed. `tests/scratch-temporal-texture.test.js` includes 17 focused
cases, including a regression proving that a later lease use does not inspect
Surface configuration after encoder creation.

Bounded stress evidence and headed public-package browser proofs remain global
Phase 6 gates for the complete seven-family goal. They are not claimed by this
Phase 1 checkpoint.
