# ADR-024: Validate Scratch Texture Copy Source Epochs

## Status

Accepted

## Date

2026-07-09

## Context

ADR-020 made `CopyCommand` sources explicit for buffer-to-buffer copies by requiring `{ resource, contentEpoch }`, but it left texture copy source epochs as future work. The Scratch transfer vision already defines GPU-to-GPU copies as explicit commands that read a source `contentEpoch` and advance the target `contentEpoch`.

ADR-023 then made color and depth/stencil render attachments first-class epoch-producing `TextureResource` writes. Without texture-to-texture copy support, a rendered texture could be sampled by later commands when declared as a read, but it could not be copied into another persistent texture through the same explicit transfer and validation model.

## Decision

`CopyCommandDescriptor` is now a union:

- `BufferCopyCommandDescriptor` for existing buffer-to-buffer copies;
- `TextureCopyCommandDescriptor` for `TextureResource` to `TextureResource` copies.

Texture copy sources use the same explicit source descriptor shape as buffer copies:

```ts
{
    resource: TextureResource
    contentEpoch: number
}
```

Texture copy descriptors also declare:

- `sourceOrigin`
- `targetOrigin`
- `size`
- `whenMissing: 'throw'`

`CopyCommand` exposes `copyKind: 'buffer-to-buffer' | 'texture-to-texture'`. Buffer copies continue to lower to `GPUCommandEncoder.copyBufferToBuffer`. Texture copies lower to `GPUCommandEncoder.copyTextureToTexture`.

Texture copy source readiness and required source epochs use the same validation rules as ADR-020:

- an unready source with `whenMissing: 'throw'` fails with `SCRATCH_COMMAND_RESOURCE_NOT_READY` in every `SubmissionValidationMode`;
- a required source epoch greater than the simulated epoch produces `SCRATCH_SUBMISSION_READ_BEFORE_WRITE`;
- a required source epoch lower than the simulated epoch produces `SCRATCH_SUBMISSION_STALE_READ`;
- an equal required epoch is valid.

Texture copy target writes advance the target `contentEpoch`, mark the target ready, preserve `allocationVersion`, and are recorded in `SubmittedWork.resourceAccesses` and `SubmittedWork.producerEpochs`.

This first texture copy slice accepts only same-format, single-sample, different-resource `TextureResource` to `TextureResource` copies whose source and target regions fit within their resource bounds. Source textures require `GPUTextureUsage.COPY_SRC`; target textures require `GPUTextureUsage.COPY_DST`.

## Alternatives Considered

### Keep texture copy as a prose-only vision example

Rejected. The old vision example used `source: sceneColor` and `region`, which no longer matched the explicit source epoch model accepted by ADR-020. Keeping that example would preserve a misleading old API shape.

### Support texture-to-buffer or buffer-to-texture copies in the same slice

Rejected. Texture upload and readback already have separate lifecycle and layout concerns. This decision only completes the GPU-to-GPU texture copy path.

### Add texture-region epochs

Rejected. Scratch currently tracks `contentEpoch` at resource granularity. Region-level epochs would require a larger simulation, ledger, and diagnostic contract.

### Allow same-resource texture copies

Rejected. Same-resource texture copies need region overlap and alias analysis. This slice rejects same-resource copies to keep the validation contract explicit and conservative.

### Add copy skip or fallback policies

Rejected. Copy target epoch production is still ambiguous under skip/fallback behavior. This slice keeps `whenMissing: 'throw'`, matching ADR-020.

## Consequences

- Texture copy sources now participate in readiness and exact epoch validation.
- Texture copy target writes now participate in submitted-work ledgers and producer epochs.
- Render attachment writes and texture uploads can satisfy later texture copy source requirements in the same submission.
- Texture copy targets can satisfy later command reads when those reads declare the produced epoch.
- Existing buffer copy behavior is preserved under the `buffer-to-buffer` branch.
- `ReadbackCommand`, texture readback, texture-region epochs, same-resource texture overlap checks, multisample resolves, depth/stencil aspect-specific copy, and automatic scheduling remain future work.
