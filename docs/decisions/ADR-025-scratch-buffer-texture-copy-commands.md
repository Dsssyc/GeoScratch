# ADR-025: Complete Scratch CopyCommand Buffer Texture Directions

## Status

Accepted

## Date

2026-07-09

## Context

ADR-020 made buffer copy sources explicit by requiring `{ resource, contentEpoch }`.
ADR-024 extended the same source-epoch model to texture-to-texture copies. At that point `CopyCommand` still covered only two of the four GPU-side copy directions exposed by WebGPU command encoders:

- `copyBufferToBuffer`
- `copyTextureToTexture`

WebGPU also exposes `copyBufferToTexture` and `copyTextureToBuffer` on `GPUCommandEncoder`. These are GPU-side command-buffer operations. Treating `TextureUploadCommand` or `ReadbackOperation` as substitutes would blur the CPU boundary:

- `TextureUploadCommand` writes CPU-provided bytes through `GPUQueue.writeTexture`.
- `ReadbackOperation` materializes GPU results for CPU access through staging and mapping.
- `CopyCommand` records GPU-side copy commands in submission order.

Scratch core must express WebGPU-native GPU-side capabilities directly rather than forcing a CPU roundtrip when WebGPU already has a command encoder operation.

## Decision

`CopyCommandDescriptor` is now a four-way direction-specific union:

- `BufferToBufferCopyCommandDescriptor`
- `TextureToTextureCopyCommandDescriptor`
- `BufferToTextureCopyCommandDescriptor`
- `TextureToBufferCopyCommandDescriptor`

`CopyCommand.copyKind` is now:

```ts
type CopyKind =
    | 'buffer-to-buffer'
    | 'texture-to-texture'
    | 'buffer-to-texture'
    | 'texture-to-buffer'
```

The old ambiguous public descriptor names `BufferCopyCommandDescriptor` and `TextureCopyCommandDescriptor` are removed from the public TypeScript surface in this `0.x.x` clean cut. Source descriptors remain resource-kind-specific because they represent the common source epoch contract:

```ts
type BufferCopyCommandSourceDescriptor = {
    resource: BufferResource
    contentEpoch: number
}

type TextureCopyCommandSourceDescriptor = {
    resource: TextureResource
    contentEpoch: number
}
```

Buffer-texture copies use an explicit `TexelCopyBufferLayout`:

```ts
type TexelCopyBufferLayout = {
    offset?: number
    bytesPerRow: number
    rowsPerImage?: number
}
```

Texture endpoints expose `origin`, `mipLevel`, and `aspect`. This first slice supports `aspect: 'all'` only. Aspect-specific depth/stencil handling is intentionally deferred until Scratch has fuller format-aspect facts.

Lowering is direct:

- `buffer-to-buffer` -> `GPUCommandEncoder.copyBufferToBuffer`
- `texture-to-texture` -> `GPUCommandEncoder.copyTextureToTexture`
- `buffer-to-texture` -> `GPUCommandEncoder.copyBufferToTexture`
- `texture-to-buffer` -> `GPUCommandEncoder.copyTextureToBuffer`

All four copy kinds share the same epoch semantics:

- source descriptors declare the required source `contentEpoch`;
- source readiness and stale/read-before-write diagnostics use the existing `CopyCommand` dependency validation model;
- target writes advance target `contentEpoch`;
- target writes mark the resource ready;
- target writes preserve `allocationVersion`;
- `SubmittedWork.resourceAccesses` records actual source read and target write facts;
- `SubmittedWork.producerEpochs` records only target writes.

For buffer-texture copies, the runtime validates the target or source texture format through the currently supported byte-size table. This slice supports the same plain 4-byte color formats already used by texture upload. Unsupported formats fail with structured diagnostics rather than being treated as silently supported.

`TexelCopyBufferLayout.bytesPerRow` must be a multiple of 256 for command encoder buffer-texture copies, matching WebGPU validation for `GPUTexelCopyBufferInfo`. The existing `TextureUploadCommand` keeps its queue-write layout behavior and does not inherit this alignment rule.

## Alternatives Considered

### Reuse `TextureUploadCommand` for buffer-to-texture

Rejected. `TextureUploadCommand` means CPU bytes are written through the queue. A `BufferResource` to `TextureResource` copy is a GPU command encoder operation and must participate in copy source epoch validation and submitted-work ledgers as such.

### Treat texture-to-buffer as readback

Rejected. `copyTextureToBuffer` copies into a GPU buffer. CPU access still requires a later `ReadbackOperation` or explicit mapping path. Combining the two would hide the host synchronization boundary that the transfer vision keeps explicit.

### Keep ambiguous `BufferCopyCommandDescriptor` and `TextureCopyCommandDescriptor` names

Rejected. Once `CopyCommand` has four directions, names based only on one resource kind are ambiguous. During `0.x.x`, the public API should make the direction explicit rather than carry compatibility aliases that preserve old ambiguity.

### Support all texture formats and depth/stencil aspects now

Rejected. Scratch does not yet have enough format-aspect metadata in core to validate every WebGPU copy rule locally. This slice keeps the supported buffer-texture formats conservative and uses structured diagnostics for unsupported format/aspect combinations.

### Add region-level epochs

Rejected. Scratch currently tracks resource-level `contentEpoch`. Region-level epochs require a larger ledger and validation model.

### Add copy skip/fallback policies

Rejected. Copy target epoch production is still ambiguous under skip/fallback behavior. This decision keeps `whenMissing: 'throw'`.

## Consequences

- Scratch public API now directly expresses all four WebGPU-native copy command directions.
- Buffer-texture copy sources and targets participate in the same submitted-work access ledger as existing copy kinds.
- `TextureUploadCommand` and `ReadbackOperation` remain CPU-boundary concepts and are not used to emulate GPU-side copy commands.
- Public TypeScript users must use direction-specific copy descriptor names.
- Buffer-texture copies require explicit texel buffer layout.
- `bytesPerRow` alignment for command encoder buffer-texture copies differs from queue `writeTexture` and is validated separately.
- Depth/stencil aspect-specific buffer-texture copy, compressed texture block formats, region-level epochs, same-resource texture alias analysis, and non-throw copy readiness policies remain future work.
