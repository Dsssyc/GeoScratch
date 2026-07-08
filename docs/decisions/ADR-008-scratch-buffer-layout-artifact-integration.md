# ADR-008: Integrate Scratch LayoutArtifact With Buffers And Uploads

## Status

Accepted

## Date

2026-07-08

## Context

ADR-007 introduced `LayoutCodec` as a runtime-independent preparation artifact. The codec could produce GPU-aligned upload bytes, readback views, and WGSL accessors, but `BufferResource` and `UploadCommand` still treated those artifacts as unrelated caller-side data.

That left three correctness gaps:

- buffers could not declare which `LayoutArtifact` defined their logical byte interpretation;
- uploads could not mechanically reject bytes produced for a different artifact;
- a larger GPU allocation could accept writes outside the logical layout region even when the buffer was intended to hold a fixed number of layout elements.

The Scratch API vision keeps resources as logical handles and transfers as explicit commands. This decision connects layout artifacts to that model without adding resource-level `write()` or `toArray()` sugar.

## Decision

Extend `BufferResourceDescriptor` with optional layout metadata:

- `layout?: LayoutArtifact`
- `elementCount?: number`

When a layout is provided, `elementCount` defaults to `1`. The buffer records:

- `layout`
- `elementCount`
- `layoutByteLength = layout.stride * elementCount`
- `layoutSubject`, a diagnostic subject for the attached artifact

Scratch-only descriptor fields remain logical metadata. They are not passed to `GPUDevice.createBuffer()`.

Extend `UploadCommandDescriptor` so `data` may be either raw bytes or a `LayoutUploadView` from `LayoutCodec.uploadView(...)`. The command normalizes a `LayoutUploadView` into an ordinary byte source, stores its `LayoutArtifact`, and still executes with `queue.writeBuffer(...)`.

Upload validation now checks:

- source byte range fits the source bytes and target GPU buffer size;
- if the target buffer has a layout, the written range fits `target.layoutByteLength`;
- if the upload carries a layout artifact and the target has one, both `structuralHash` values match.

Layout failures use existing `layout-codec` diagnostics:

- `SCRATCH_LAYOUT_UNSUPPORTED_FORMAT`
- `SCRATCH_CODEC_BYTE_LENGTH_MISMATCH`
- `SCRATCH_CODEC_STRUCTURAL_HASH_MISMATCH`

Readback interpretation remains explicit. Returned bytes are still interpreted through `codec.createReadbackView(bytes)` or another caller-selected view factory; `BufferResource` does not gain `toArray()` or `toBytes()`.

## Consequences

- `runtime.createBuffer({ size, usage, layout: codec.artifact })` creates a typed logical buffer while preserving raw buffers.
- `runtime.createUploadCommand({ target, data: codec.uploadView(values) })` validates the upload artifact against the target layout before writing bytes.
- A buffer can allocate more GPU bytes than its logical layout region, but upload commands cannot write past the declared layout region unless no layout metadata is attached.
- Program, BindSet, and shader accessor validation can later compare the same `LayoutArtifact.structuralHash` without changing this buffer/upload contract.

## Non-Goals

- Do not add shader reflection or Program-required codec validation.
- Do not make `LayoutCodec` an upload command factory.
- Do not add `BufferResource.write()`, `BufferResource.toArray()`, or `BufferResource.toBytes()`.
- Do not add render graph, scheduler, examples migration, geo layer changes, or material/style/layer concepts to scratch core.
