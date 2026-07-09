# ADR-018: Add Scratch Resource Readiness Validation

## Status

Accepted

## Date

2026-07-09

## Context

ADR-013 added submitted resource access ledgers and producer epochs.
ADR-015 made draw commands declare explicit resource reads and writes.
ADR-016 added the first deterministic render attachment conflict validator.
ADR-017 separated submission validation disposition from diagnostic identity.

The implementation still had no explicit resource readiness state. Every `Resource` tracked `allocationVersion` and `contentEpoch`, but an empty resource and a resource with produced content were distinguishable only by convention. That blocked the next dependency-validation slice: a command with `whenMissing: 'throw'` should not read a resource that has never had content produced.

Full read-before-write validation still needs required-source-epoch semantics. Without that, the runtime must not reject resources prepared by earlier submitted work just because the producer is outside the current submission.

## Decision

Scratch resources now expose a minimal readiness state:

- `empty`
- `ready`
- `disposed`

New logical resources start as `empty` with `contentEpoch` still equal to `0`. Disposal marks the resource `disposed` and remains a hard lifecycle error through `Resource.assertUsable()`.

Any existing content-producing operation that advances `contentEpoch` also marks the resource `ready`. This includes buffer uploads, texture uploads, copy targets, query resolve destinations, dispatch declared writes, draw declared writes, and render pass `TextureResource` color attachment writes.

Allocation replacement advances `allocationVersion` and resets readiness to `empty`. This keeps allocation identity separate from content readiness: a replaced allocation may have the same logical resource id and prior content epoch history, but the new backing allocation is not readable until content is produced again.

`SubmissionBuilder.submit()` now validates `DrawCommand.resources.read` and `DispatchCommand.resources.read` before creating the command encoder when the command uses `whenMissing: 'throw'`.

The validator simulates readiness in explicit submission order:

- start from each resource's current `state`;
- upload, copy target, resolve destination, dispatch write, draw write, and render attachment write mark simulated readiness as `ready`;
- later command reads consult the simulated state;
- failed validation does not mutate real resource state, content epochs, or allocation versions.

Readiness failures use a structured diagnostic:

- code: `SCRATCH_COMMAND_RESOURCE_NOT_READY`
- severity: `error`
- phase: `command`
- subject: the reading command
- related: the resource, pass spec, and submission
- expected: `{ resourceState: 'ready' }`
- actual: step index, command id, command kind, access kind, resource id, resource kind, simulated resource state, content epoch, allocation version, and `whenMissing`

`SubmissionValidationMode` does not suppress this check. `whenMissing: 'throw'` is a command usage policy, not an optional dependency-validation disposition. The same empty-read failure throws in `validation: 'throw'`, `validation: 'warn'`, and `validation: 'off'`.

## Alternatives Considered

### Implement full read-before-write validation

Rejected for this slice. Readiness can answer whether a resource has any produced content, but it cannot yet answer whether a command requires a specific source epoch. Rejecting reads solely because there is no same-submission producer would incorrectly reject resources made ready by earlier submitted work.

### Put readiness under `SubmissionValidationMode`

Rejected. `SubmissionValidationMode` controls optional dependency diagnostics such as the ADR-016 render attachment conflict disposition. A command declaring `whenMissing: 'throw'` has explicitly requested hard failure for missing or unready read resources.

### Mutate real readiness during validation

Rejected. Pre-encoding validation must keep the existing failure guarantee: if validation throws, there is no command encoder, no queue submission, no content epoch advancement, and no resource readiness mutation.

### Add dirty, resizing, lost, range, or region readiness states

Rejected for V1. The vision documents leave room for richer readiness, but this slice needs only enough state to distinguish empty resources, ready resources, and disposed resources.

### Validate copy sources and query slots

Rejected for V1. Copy source readiness policy and query slot readiness need separate policy surfaces. This ADR only covers declared draw and dispatch reads plus simulated producer effects.

## Consequences

- New buffer and texture resources are usable as write targets while still not ready as read sources.
- Reads declared by draw and dispatch commands fail before GPU encoding when `whenMissing: 'throw'` and no current or simulated content exists.
- Same-submission producers can make later same-submission reads valid without mutating real state during validation.
- Resources made ready by earlier submitted work can be read in later submissions.
- `SubmittedWork.resourceAccesses` and `producerEpochs` keep their existing ordering and epoch meaning.
- `validation: 'warn'` and `validation: 'off'` do not weaken `whenMissing: 'throw'`.
- Full read-before-write validation, required-source-epoch declarations, stale-read validation, fallback selection, skip-command behavior, skip-pass behavior, range/region readiness, dirty/resizing/lost transitions, and automatic scheduling remain future work.
