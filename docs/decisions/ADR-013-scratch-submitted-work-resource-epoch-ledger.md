# ADR-013: Add SubmittedWork Resource Epoch Ledger

## Status

Accepted

## Date

2026-07-08

## Context

Scratch resources already track `allocationVersion` and `contentEpoch`, and existing commands advance content epochs for uploads, copies, query resolves, compute dispatch writes, and render texture attachment writes. `SubmittedWork` previously exposed command buffers, diagnostics, and completion, but it did not retain the ordered resource access facts that produced those content epochs.

The vision docs require `SubmittedWork` to become the durable evidence source for future dependency validation, readiness handling, and readback provenance. That evidence should be structured and inspectable instead of encoded in prose diagnostics or hidden inside mutable resource handles.

## Decision

`SubmittedWork` now exposes two readonly public arrays:

- `resourceAccesses`: ordered facts for explicit resource reads and writes submitted by upload, copy, query resolve, compute dispatch, and render texture attachment steps.
- `producerEpochs`: write-only facts derived from `resourceAccesses`, recording the content epoch produced by each write.

Each access records the submission step index, step kind, command identity when present, pass identity when present, resource identity, resource diagnostic subject, access kind, before/after content epochs, and allocation version. Producer epochs expose the same resource identity facts plus the produced content epoch and the step/command/pass origin.

The ledger is observational. It records the order and epoch facts from the existing submission path without changing GPU command ordering, validation policy, resource readiness behavior, or epoch advancement semantics.

## Alternatives Considered

### Infer reads from bind sets or shader inspection

Rejected. The current Scratch API direction favors explicit command declarations for core scheduling facts. Bind and shader inspection can help validate layouts, but they should not silently become the source of resource dependency facts for this slice.

### Implement dependency validation immediately

Rejected. Validation needs an evidence layer first. This decision only makes submitted resource facts available so future validation can consume a stable ledger.

### Track query slot producer epochs here

Rejected. Query slots are indexed subresources and need a separate provenance model. This decision only records resolve destination buffer writes and leaves query slot lineage for a later query-specific design.

### Expose mutable resource handles in ledger entries

Rejected. Public entries expose stable ids, labels, kinds, diagnostic subjects, and epoch values. They do not expose mutable resource objects as ledger contents.

## Consequences

- Public TypeScript users can inspect submitted resource reads, writes, and produced epochs through both `geoscratch` and `geoscratch/scratch`.
- Future dependency validation and readback provenance can consume ordered structured facts instead of re-walking submitted commands.
- Ledger arrays and entries are frozen when attached to `SubmittedWork`, reducing accidental caller mutation.
- Draw resource declarations, readiness state, validation mode behavior, automatic scheduling, and query slot provenance remain separate future work.
