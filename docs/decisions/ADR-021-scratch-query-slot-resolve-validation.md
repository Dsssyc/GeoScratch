# ADR-021: Validate Scratch Query Slot Resolve Sources

## Status

Accepted

## Date

2026-07-09

## Context

ADR-018 added resource readiness validation for declared draw and dispatch reads.
ADR-019 added required read content epochs for command reads.
ADR-020 extended the same dependency model to `CopyCommand` sources.

`QuerySetResource` is an indexed slot resource. Timestamp writes and occlusion query brackets write individual slots, and `ResolveQuerySetCommand` copies an explicit contiguous slot range into a destination buffer. Before this ADR, resolve commands accepted top-level `querySet`, `firstQuery`, and `queryCount` fields and only participated in submission validation as a destination buffer producer. That left query source slots outside Scratch's readiness and exact-epoch validation model.

## Decision

`QuerySetResource` now exposes per-slot readiness through `slotStates`:

- new slots start as `empty`;
- new slot content epochs start at `0`;
- query writes advance the slot content epoch and mark the slot `ready`;
- query set disposal remains a resource-level lifecycle error.

`ResolveQuerySetCommandDescriptor` now uses an explicit source descriptor:

- `source.querySet: QuerySetResource`
- `source.slots: QuerySetSlotReadDescriptor[]`
- `QuerySetSlotReadDescriptor.index: number`
- `QuerySetSlotReadDescriptor.contentEpoch: number`

`source.slots` must be non-empty, sorted, unique, and contiguous because WebGPU resolves a contiguous query range. The command derives `firstQuery` and `queryCount` from the slots for encoding and inspection. Old top-level `querySet`, `firstQuery`, and `queryCount` descriptor inputs are rejected.

`ResolveQuerySetCommandDescriptor.whenMissing` is required and only accepts `'throw'` in this slice. Query resolve has no skip or fallback semantics yet, so an unwritten source slot is a hard query policy failure in every `SubmissionValidationMode`.

Submission validation now simulates query slots separately from normal resource readiness:

- simulation starts from each query slot's current readiness and slot content epoch;
- timestamp writes mark their begin/end slots ready after their pass step;
- completed occlusion begin/end brackets mark the bracketed slot ready after their render step;
- resolve source slots are validated before the destination buffer is simulated as ready.

Resolve source slot epoch validation uses the same exact matching rules as ADR-019 and ADR-020:

- required slot epoch greater than the simulated slot epoch produces `SCRATCH_SUBMISSION_READ_BEFORE_WRITE`;
- required slot epoch lower than the simulated slot epoch produces `SCRATCH_SUBMISSION_STALE_READ`;
- required slot epoch equal to the simulated slot epoch is valid.

Unwritten resolve source slots use `SCRATCH_QUERY_RESOLVE_UNWRITTEN_RANGE` with `phase: 'query'`. This failure is not weakened by `validation: 'warn'` or `validation: 'off'` because it follows the command's explicit `whenMissing: 'throw'` policy.

Execution ledgers remain execution-derived:

- `SubmittedWork.resourceAccesses` records the resolve destination buffer write;
- `SubmittedWork.producerEpochs` records the resolve destination buffer producer epoch;
- query slot source facts stay in the command source descriptor and validation diagnostics.

## Alternatives Considered

### Keep `querySet`, `firstQuery`, `queryCount`, and add `contentEpochs`

Rejected. Splitting the query range and required slot epochs across sibling fields makes it easier to pass mismatched facts. A source descriptor keeps query-set identity, slot indices, and required epochs together.

### Keep accepting the old descriptor shape as a compatibility path

Rejected. Scratch is still in `0.x.x`, and old Scratch APIs are reference material rather than compatibility constraints. Keeping both shapes would preserve ambiguity exactly where resolve dependency validation needs explicit source facts.

### Record query slot reads as whole-resource reads in `SubmittedWork.resourceAccesses`

Rejected. Query slots are indexed source facts, while `SubmissionResourceAccess` is currently resource-level. Recording a query resolve as a whole `QuerySetResource` read would imply a misleading resource-level content epoch. Slot-aware submitted-work ledgers can be designed later if needed.

### Add skip or fallback policies for query resolve

Rejected for this slice. Skipping a resolve would make destination buffer epoch production ambiguous. V1 requires `whenMissing: 'throw'`.

## Consequences

- Resolve commands authored against a slot epoch must be refreshed when the slot is written again.
- Same-submission timestamp writes can satisfy later resolves requiring their produced slot epochs.
- Same-submission occlusion begin/end brackets can satisfy later resolves requiring their produced slot epochs.
- A resolve cannot be satisfied by a query write that appears later in explicit submission order.
- Raw query-set backing values are not Scratch-level readiness; only Scratch query writes advance slot readiness and epochs.
- Existing resolve call sites must migrate to `source: { querySet, slots }` plus `whenMissing: 'throw'`.
- `SubmittedWork.resourceAccesses` and `producerEpochs` keep their existing buffer-resource meaning.
- Readback still happens through `ReadbackOperation`; this ADR does not add query result CPU-visible sugar.
- `ReadbackCommand`, pipeline statistics, slot-aware submitted-work ledgers, range-level epochs, skip/fallback policy, and automatic scheduling remain future work.
