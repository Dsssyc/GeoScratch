# ADR-030: Represent External Image Upload As An Ordered Queue Action

## Status

Accepted

## Date

2026-07-11

## Context

Scratch already represents the four WebGPU command-encoder copy directions through `CopyCommand`, CPU byte uploads through `GPUQueue.writeBuffer()` and `GPUQueue.writeTexture()`, and ordered GPU-to-CPU staging through `ReadbackCommand`. ADR-029 established one physical queue timeline that preserves the declared `SubmissionBuilder` order across encoder-backed work and immediate queue operations.

WebGPU also exposes `GPUQueue.copyExternalImageToTexture()`. Its source is a Web Platform image object rather than a Scratch resource, its pixels are captured when the queue method is called, and the operation performs the platform-defined color conversion and alpha handling. Treating it as a fifth `CopyCommand` kind would give a non-Scratch object invented resource and epoch semantics. Treating it as a byte texture upload would require CPU pixel extraction and would lose the native source-capture and color-conversion contract.

## Decision

### Public command family

Add `ExternalImageUploadCommand` with these discriminants:

```ts
commandKind: 'upload'
uploadKind: 'external-image'
```

Normalize the existing upload family at the same time:

```ts
UploadCommand.uploadKind = 'buffer'
TextureUploadCommand.uploadKind = 'texture'
ExternalImageUploadCommand.uploadKind = 'external-image'
```

`ExternalImageUploadCommand` retains the canonical `GPUCopyExternalImageSource` object by identity and exposes every meaningful field of `GPUCopyExternalImageSourceInfo`, `GPUCopyExternalImageDestInfo`, and the two-dimensional copy extent. Scratch fixes destination aspect to `all` and `depthOrArrayLayers` to `1`, because this operation accepts one layer of a plain color 2D texture.

The normalized command contract is immutable except for the explicit `dispose()` lifecycle transition. The external source object's contents remain application-owned and mutable.

### Native lowering and capture time

Lower exactly once to:

```ts
queue.copyExternalImageToTexture(sourceInfo, destinationInfo, copySize)
```

Scratch does not read source pixels, create an intermediate `ArrayBuffer`, call `writeTexture()`, or claim that the browser performs a zero-copy transfer. Source pixels are captured at native queue-call time, so a canvas or video may change after command construction and before replay.

Source ownership remains outside Scratch. Scratch does not close `ImageBitmap` or `VideoFrame` objects, dispose canvases or elements, control playback, fetch, decode, or retain hidden host-side pixel copies.

### Live validation

Construction normalizes the explicit descriptor without requiring an image or video to be loaded. Direct execution and submission preflight revalidate the command, runtime, target, queue method, current source dimensions and source range, target mip/origin/layer range, usage, dimension, sample count, format, and integer domains.

External-image destinations require both `GPUTextureUsage.COPY_DST` and `GPUTextureUsage.RENDER_ATTACHMENT`, dimension `2d`, sample count `1`, and a currently supported plain renderable `unorm`, `unorm-srgb`, `float`, or `ufloat` format. The format table follows the current WebGPU format capability table and checks device features for `core-features-and-limits`, `rg11b10ufloat-renderable`, `texture-formats-tier1`, and `texture-formats-tier2` where applicable. It is not the smaller byte-layout whitelist used by `TextureUploadCommand`.

Runtime source inspection uses standard dimension properties rather than realm-local constructor identity as the validity model. This keeps Window, Worker, and cross-realm platform objects usable. Origin cleanliness and source usability remain native browser decisions.

### Queue order and logical effects

Extend ADR-029's internal discriminated queue timeline with an `external-image-upload` action. It terminates a preceding encoder segment, occupies its exact submission step, and separates later encoder work without creating empty command buffers. Upload-only work still has no command buffer and registers aggregate completion after the final queue action.

Timeline preparation simulates a non-empty target write, captures its access and producer facts, and restores live state. Replay first calls the native queue method and only then commits the prepared target content effect. A successful non-empty upload advances `contentEpoch` exactly once, marks the target ready, records one target write and producer epoch, and leaves `allocationVersion` unchanged. The external source is not a Scratch read resource and receives no invented epoch.

A zero-width or zero-height command remains an explicit queue action so native argument and source-usability validation still occurs. It has no potential content effect: it does not make the target ready, advance an epoch, create a resource access, create a producer fact, or fabricate a command buffer.

### Native failure boundary

Deterministic descriptor, source-range, target, and queue-capability failures use:

```text
SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_INVALID
```

If `GPUQueue.copyExternalImageToTexture()` throws synchronously, Scratch wraps the exception with:

```text
SCRATCH_COMMAND_EXTERNAL_IMAGE_UPLOAD_FAILED
```

The diagnostic payload contains only serializable exception facts, while `ScratchDiagnosticError.cause` retains the original exception object. The failed action does not commit its logical effect, later queue actions are not replayed, earlier successful actions remain committed, and the builder remains non-retryable.

## Alternatives Considered

### Add a fifth `CopyCommand` kind

Rejected. `CopyCommand` is an encoder-backed copy between Scratch resources with explicit source epoch requirements. An external image is an application-owned Web Platform object and the native operation is immediate on `GPUQueue`.

### Extract pixels and use `writeTexture()`

Rejected. CPU extraction changes capture timing, color conversion, alpha semantics, source support, performance characteristics, and failure boundaries. It also hides a WebGPU-native capability that Scratch must express directly.

### Snapshot source readiness or pixels at construction

Rejected. Images and videos may become usable later, and mutable source contents must be captured when the native queue call occurs. Scratch retains identity and revalidates live dimensions instead.

### Let Scratch own source lifetime

Rejected. Closing images or frames, controlling video playback, and fetching or decoding data are application or loader responsibilities above the GPU kernel.

### Treat every zero-area copy as effect-free work

Rejected. Width or height zero removes the logical content write, but the native call remains observable through argument, origin-cleanliness, and source-usability validation and therefore remains an ordered queue action.

### Add `GPUExternalTexture` in the same slice

Rejected. `GPUExternalTexture` is a sampled binding with expiry and source-lifetime rules, not a texture upload. It requires a separate resource, binding, and validation decision.

## Consequences

- Scratch directly expresses all current WebGPU external image source types without CPU staging.
- External image uploads share the same exact physical queue order as existing uploads and encoder work.
- Source contents can change after command construction and are captured during replay.
- Target epochs and ledgers describe only native calls that returned successfully and had a non-empty content effect.
- Public TypeScript declarations use `GPUCopyExternalImageSource`, `GPUCopyExternalImageSourceInfo`, and `GPUCopyExternalImageDestInfo`; no compatibility aliases or handwritten declarations are added.
- Browser-dependent origin-cleanliness and source-usability checks remain at the native call boundary but retain structured Scratch context and the original exception.

