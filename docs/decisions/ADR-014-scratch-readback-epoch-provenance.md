# ADR-014: Add Scratch Readback Epoch Provenance

## Status

Accepted

## Date

2026-07-08

## Context

ADR-013 made `SubmittedWork` expose ordered resource access facts and write-producing content epochs. `ReadbackOperation` already accepted `after?: SubmittedWork`, but it only used that submitted work as a completion fence. It captured the live source resource epoch at readback creation and could silently stage a newer epoch if the source advanced before the readback was consumed.

The transfer vision requires readbacks to capture the source content epoch they intend to read. If that epoch is no longer available through the live resource path, Scratch should fail with a structured diagnostic instead of pretending that the older submitted result was read.

## Decision

`ReadbackOperation` now captures an optional `producerEpoch` from `after.producerEpochs` when the submitted work wrote the readback source resource.

When a matching producer is found:

- `producerEpoch` exposes the captured `SubmittedResourceEpoch`.
- `contentEpoch` is captured from `producerEpoch.contentEpoch`.
- `allocationVersion` is captured from `producerEpoch.allocationVersion`.

When `after` does not produce the source, it remains a valid completion fence and `ReadbackOperation` keeps the existing request-time source epoch capture behavior.

Readback creation and readback consumption both validate that the live source still matches the captured facts before staging a copy:

- stale content epoch fails with `SCRATCH_READBACK_SOURCE_EPOCH_STALE`;
- stale allocation version fails with `SCRATCH_READBACK_SOURCE_ALLOCATION_STALE`.

These diagnostics use phase `readback`, subject `ReadbackOperation`, and related source/submission subjects.

## Alternatives Considered

### Recover the older data automatically

Rejected. The current core readback path copies from the live source resource. Once that live resource advances, old bytes are not recoverable without an explicit ordered staging command or retained history.

### Require every `after` to produce the readback source

Rejected. `after` remains useful as a completion fence even when the readback source was prepared earlier or written outside the submitted work.

### Add `ReadbackCommand`

Rejected for this slice. Ordered staging inside a submission is useful future work, but this decision only guards the existing operation-based readback path.

### Implement full dependency validation

Rejected. Submission dependency validation can build on producer epochs later. This decision only prevents readback epoch drift.

## Consequences

- Public TypeScript users can inspect `ReadbackOperation.producerEpoch`.
- Readbacks fail before creating staging resources when the source no longer matches the captured epoch or allocation version.
- The existing completion-fence behavior of `after` is preserved when the submitted work does not produce the source.
- Resource readiness, validation-mode disposition changes, retained readback history, `ReadbackCommand`, automatic scheduling, and per-range epochs remain separate future work.
