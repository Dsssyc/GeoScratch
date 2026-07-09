# ADR-016: Validate Render Attachment Resource Conflicts

## Status

Accepted

## Date

2026-07-09

## Context

ADR-013 added ordered `SubmittedWork.resourceAccesses` and write-derived `SubmittedWork.producerEpochs`.
ADR-015 made `DrawCommand` declare explicit resource reads and writes, including render-command accesses.

Those facts make a first dependency-validation slice possible, but full read-before-write validation still needs explicit readiness and required-epoch semantics. One conflict class is already deterministic: a `TextureResource` used as the current render pass color attachment target is written by the pass itself. A draw in that same render step must not also declare the same texture as a command-level read or command-level write.

## Decision

`SubmissionBuilder.submit()` now validates render steps before beginning the WebGPU render pass.

For each render step:

- collect `TextureResource` color attachment targets from `RenderPassSpec.color`;
- ignore `Surface` targets because they are borrowed presentation targets, not persistent `TextureResource` handles;
- check each `DrawCommand.resources.read` and `DrawCommand.resources.write` entry;
- reject any draw declared access that points at the current pass color attachment target.

Conflicts fail with:

- code: `SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT`
- phase: `submission`
- subject: the offending `DrawCommand`
- related: the `RenderPassSpec`, conflicting `TextureResource`, and `Submission`

The diagnostic reports the step index, pass id, command id, access kind, resource id, resource kind, content epoch, and allocation version. The failure happens before command encoding, render-pass creation, epoch advancement, command-buffer finish, or queue submit.

Render attachment writes remain pass-level facts. A draw can still read a texture produced by an earlier render step when the current pass writes a different target.

## Alternatives Considered

### Implement full read-before-write validation

Rejected for this slice. The current implementation tracks content epochs and ordered access facts, but it does not yet model resource readiness or required source epochs. Rejecting every read without a prior write in the same submission would incorrectly reject resources prepared by earlier submissions or construction-time data.

### Fold render attachment writes into draw resources

Rejected. Render pass attachments are owned by `RenderPassSpec` and the WebGPU render pass descriptor, not by individual draw commands. Folding them into draw declarations would blur pass-level writes with command-level reads and writes.

### Infer conflicts from BindSet or shader inspection

Rejected. Bind sets and shader inspection can help validate compatibility, but they are not the authoritative command access contract. The validator uses explicit draw resource declarations plus pass attachment targets.

### Defer all dependency validation

Rejected. Current-pass attachment conflicts are already unambiguous and cheap to validate. Catching them now prevents invalid ledger facts and avoids encoding work that must be rejected.

## Consequences

- Draw commands cannot declare the current render pass color attachment target as a read or write resource.
- Invalid submissions fail before GPU encoding side effects and do not advance content epochs.
- Valid submitted work keeps the existing resource-access order and producer epoch semantics.
- Full read-before-write validation, readiness policy behavior, automatic scheduling, depth/stencil attachments, and ordered readback commands remain future work.
