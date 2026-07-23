# ADR-052: Close Scratch Texture Transfer And Readback

## Status

Proposed

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

Phase 4 will complete this ADR with one canonical transfer model:

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

## Rejected Directions

- CPU upload/readback substitutes for native GPU copies.
- A second texture upload implementation.
- Returning padded staging bytes as if they were tightly packed logical rows.
- Exposing native staging buffers or persistent mapped views.
- Silently reading a replacement allocation or newer content epoch.

## Acceptance Evidence

The completed ADR requires table-driven format/aspect/footprint tests,
allocation and epoch race tests, mapped-view detachment tests, staging-budget
stress evidence, composition tests with explicit CopyCommand paths, and headed
public-package browser proofs.
