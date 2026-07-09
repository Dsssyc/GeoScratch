# ADR-023: Add Scratch Depth/Stencil Render Attachments

## Status

Accepted

## Date

2026-07-09

## Context

ADR-016 through ADR-021 built the submission validation chain for render attachment conflicts, validation disposition, readiness simulation, exact read epochs, copy source epochs, and query slot resolve epochs. ADR-022 completed the next readback lifecycle slice.

`RenderPassSpec` still only modeled color attachments. The Scratch vision documents already treat depth and stencil attachments as render attachment resources that follow the same content epoch and explicit dependency model as color render targets. Leaving them outside `RenderPassSpec` meant depth writes were invisible to readiness simulation, `SubmittedWork.resourceAccesses`, `SubmittedWork.producerEpochs`, and same-pass conflict validation.

## Decision

`RenderPassSpecDescriptor` now accepts an optional depth/stencil attachment:

```ts
type RenderPassDepthStencilAttachmentSpec = {
    target: TextureResource
    viewDescriptor?: GPUTextureViewDescriptor
    depthLoad?: GPULoadOp
    depthStore?: GPUStoreOp
    depthClear?: number
    stencilLoad?: GPULoadOp
    stencilStore?: GPUStoreOp
    stencilClear?: number
}
```

The target must be a same-runtime usable `TextureResource` with `GPUTextureUsage.RENDER_ATTACHMENT` and a depth/stencil-compatible format. `Surface` is not accepted because a surface current texture is a presentation-scoped color target, not a persistent depth/stencil resource.

Depth/stencil attachments lower to `GPURenderPassDescriptor.depthStencilAttachment`. Depth load/store defaults are `clear` / `store` when the depth aspect is used. Stencil load/store defaults are `clear` / `store` when the stencil aspect is used. Stencil fields are only accepted for stencil-capable formats.

Depth/stencil attachment writes are pass-level render writes:

- the target `contentEpoch` advances when the render pass completes;
- the write is recorded in `SubmittedWork.resourceAccesses`;
- the produced epoch is recorded in `SubmittedWork.producerEpochs`;
- the target is marked ready in pre-encoding readiness simulation for later submission steps;
- the write does not advance `allocationVersion`.

Same-pass conflict validation now includes the active depth/stencil attachment target. A draw command that declares the current depth/stencil target as a command-level read or write produces `SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT`, subject to the existing `SubmissionValidationMode` disposition.

Render pipeline compatibility now checks `depthStencil.format` against the active render pass depth/stencil target. A pipeline with `depthStencil` cannot be recorded into a pass without a depth/stencil attachment, and mismatched formats fail with `SCRATCH_PIPELINE_DEPTH_STENCIL_MISMATCH`.

## Alternatives Considered

### Fold depth writes into draw command writes

Rejected. WebGPU owns depth/stencil attachment load/store and write behavior at the render pass boundary. Individual draw commands can affect depth values, but the attachment resource write belongs to the pass, just like color attachments.

### Treat depth writes as allocation changes

Rejected. A depth/stencil pass changes texel contents, not the physical GPU texture object. Advancing `allocationVersion` would force unnecessary bind group and view invalidation. `contentEpoch` is the correct dependency and readback fact.

### Accept `Surface` as a depth target

Rejected. A surface current texture is a borrowed presentation color target with submission-scoped lifetime. Depth/stencil requires an explicit persistent `TextureResource` with inspectable epochs and lifetime.

### Add read-only same-pass depth sampling

Rejected. Same-pass read-only depth usage needs explicit read-only attachment flags, shader usage constraints, and alias rules. This slice keeps the simpler rule: the active depth/stencil attachment is a pass-level write and cannot be declared as a draw read or write in the same pass.

### Add automatic render graph scheduling

Rejected. Scratch core remains explicit submission order plus validation. This decision adds facts and validation without reordering work or hiding dependency decisions.

## Consequences

- Depth/stencil attachments are first-class `RenderPassSpec` state.
- Depth/stencil texture writes now participate in content epochs, readiness simulation, submitted-work ledgers, and producer epochs.
- Later passes can read a depth/stencil texture produced by an earlier pass when they declare the produced `contentEpoch`.
- Same-pass draw read/write conflicts cover depth/stencil attachments as well as color attachments.
- Pipeline depth/stencil format mismatches fail before encoding.
- Existing color attachment behavior and diagnostics remain unchanged.
- Read-only same-pass depth sampling, transient attachments, attachment pooling, multisample resolves, texture-region epochs, range-level epochs, and automatic scheduling remain future work.
