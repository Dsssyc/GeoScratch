# ADR-052: Close Scratch Texture Transfer And Readback

## Status

Accepted

## Date

2026-07-24

## Context

Scratch already expresses all four encoder copy directions, queue texture
uploads, and buffer readback. Three managed gaps remain:

- `TextureUploadCommand` cannot select `GPUTexelCopyTextureInfo.aspect`;
- `ReadbackOperation` cannot directly describe a texture subresource; and
- the documented zero-copy `ReadbackOperation.map()` lease is not implemented.

Using a CPU image path or forcing callers to manually compose hidden staging
buffers would weaken native transfer semantics and make row padding, epochs,
mapping authority, cancellation, and diagnostics inconsistent.

## Decision Boundary

Phase 4 completes this ADR with one canonical transfer model:

- texture upload `aspect`, defaulting to `"all"`, lowered through the existing
  single queue `writeTexture()` path;
- direct texture readback that captures allocation version, content epoch,
  mip, origin, extent, aspect, and optional interpretation;
- native texture-to-buffer staging with exact format/block/aspect rules and
  explicit distinction between padded staging rows and logical result rows;
- owned logical bytes for `toBytes()` and compatible explicit-buffer
  composition; and
- one bounded-lifetime mapped readback lease that performs no additional host
  copy and invalidates every view when closed.

Readback mapping remains staging ownership, not public mapping on
`TextureResource` or `BufferResource`. It must integrate with staging budgets,
one active mapping authority, cancellation, disposal, device loss, retained
results, diagnostics, and epoch validation.

## Public Contract

`TextureUploadCommandDescriptor` gains `aspect?: GPUTextureAspect`, normalized
to `"all"` on the command. The selected aspect is included in the existing
`GPUQueue.writeTexture()` destination. Its data layout follows the queue-write
rules: unlike encoder copies, neither `offset` nor `bytesPerRow` receives the
encoder-only alignment requirement. Format/aspect copy capability, physical
subresource coverage, texel-block geometry, row footprint, and source byte
range are still validated before submission.

Direct texture readback uses this descriptor:

```ts
type TextureReadbackSourceDescriptor = Readonly<{
    resource: TextureResource
    mipLevel?: number
    origin?: TextureReadbackOrigin
    size: TextureReadbackSize
    aspect?: GPUTextureAspect
    layout?: LayoutArtifact
}>
```

`ReadbackOperationDescriptor.source` accepts either the existing
`BufferRegion` or this descriptor. Construction captures the texture's current
allocation version and content epoch. The operation exposes `sourceKind`,
the normalized source, and an optional `rowLayout`. Ordered
`ReadbackCommand` remains buffer-only because it represents an explicit
submission position rather than the default direct-readback path.

`TextureReadbackRowLayout` records all facts needed to distinguish the two byte
representations:

```ts
type TextureReadbackRowLayout = Readonly<{
    format: GPUTextureFormat
    aspect: GPUTextureAspect
    blockWidth: number
    blockHeight: number
    bytesPerBlock: number
    widthInBlocks: number
    heightInBlocks: number
    logicalBytesPerRow: number
    logicalRowsPerImage: number
    logicalBytesPerImage: number
    logicalByteLength: number
    stagingBytesPerRow: number
    stagingRowsPerImage: number
    stagingBytesPerImage: number
    stagingByteLength: number
}>
```

The staging row stride is the logical row footprint rounded up to 256 bytes.
The staging allocation contains complete padded rows and images. `toBytes()`
copies only logical row bytes into a tightly packed, operation-owned result;
it never exposes row or image padding as logical data. `toArray()` and
`toLayoutView()` consume that same logical representation. An optional
`LayoutArtifact` is interpretation metadata over the complete tightly packed
result and must be readback-compatible with its byte length.

`ReadbackOperation.map()` returns `Promise<MappedReadbackLease>`. The lease
exposes:

```ts
class MappedReadbackLease {
    readonly id: string
    readonly operation: ReadbackOperation
    readonly state: 'mapped' | 'released' | 'cancelled' | 'failed' | 'disposed'
    readonly view: ArrayBuffer
    readonly byteLength: number
    readonly rowLayout?: TextureReadbackRowLayout
    readonly layout?: LayoutArtifact
    dispose(): void
}
```

For a buffer source, `view` spans the requested buffer range and `rowLayout`
is absent. For a texture source, `view` is the native padded staging mapping
and `rowLayout` describes how to address it. Obtaining the range does not make
an additional host copy. Closing the lease unmaps and destroys staging,
invalidates the `view` getter, completes the mapping authority, and consumes
the operation. Identity, terminal lease state, and immutable layout facts
remain inspectable after close. A previously obtained native mapped range is
detached by native unmap/destruction.

Mapping is a one-shot alternative to host-copy materialization. A readback may
have one materialization owner: one mapped lease, one consume-on-read caller,
or the shared retained-host-copy materialization. `map()` rejects after host
bytes have been retained and while another materialization owns the operation.
Closing a mapped lease does not create retained host bytes, even when
`retain: "until-dispose"` was requested.

Operation cancellation or disposal closes an active lease with the
corresponding terminal lease state. Runtime disposal and device loss close it
as failed. In all cases the staging reservation and mapping diagnostic
operation are released exactly once. Native cleanup failures are recorded as
structured diagnostics and never restore mapping authority.

## Native Lowering

Direct texture readback allocates one runtime-owned
`MAP_READ | COPY_DST` buffer under the existing readback budgets, then issues
exactly:

```ts
encoder.copyTextureToBuffer(
    { texture, mipLevel, origin, aspect },
    { buffer: staging, offset: 0, bytesPerRow, rowsPerImage },
    size
)
```

No CPU image extraction, hidden public `BufferResource`, or second transfer
path is permitted. Format/aspect validation uses the same texel-copy footprint
facts as `CopyCommand`. Compressed formats retain the pinned feature-level
rule. Depth/stencil formats require a single copyable aspect and complete
physical subresource coverage. Source usage, sample count, mip/origin/range,
block alignment, allocation version, content epoch, and indeterminate content
are checked before native copy issue.

An explicit `CopyCommand` from the same texture subresource into a buffer with
the published staging layout followed by buffer readback therefore has the
same native row representation. Direct `toBytes()` differs only by removing
the published padding.

## Diagnostics

Readback diagnostics remain bounded and byte-free. Existing readback operation
targets and runtime facts gain optional source-kind, texture subresource,
logical-byte, and staging-row fields. They contain resource identities,
captured epochs, dimensions, and byte counts, but no native texture, staging
buffer, mapped view, or payload bytes.

## Rejected Directions

- CPU upload/readback substitutes for native GPU copies.
- A second texture upload implementation.
- Returning padded staging bytes as if they were tightly packed logical rows.
- Exposing native staging buffers or persistent mapped views.
- Silently reading a replacement allocation or newer content epoch.

## Acceptance Evidence

This ADR requires table-driven format/aspect/footprint tests,
allocation and epoch race tests, mapped-view detachment tests, staging-budget
stress evidence, composition tests with explicit CopyCommand paths, and headed
public-package browser proofs.
