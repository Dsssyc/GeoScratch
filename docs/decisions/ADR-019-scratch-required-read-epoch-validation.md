# ADR-019: Validate Scratch Command Required Read Epochs

## Status

Accepted

## Date

2026-07-09

## Context

ADR-018 added resource readiness validation for `DrawCommand` and `DispatchCommand` declared reads. That can reject reads from empty resources, but it cannot prove that a command is reading the exact contents it was authored against.

Scratch resources already track `contentEpoch`, and submitted work already records ordered resource access and producer epoch facts. The next dependency-validation slice needs commands to declare the source epoch they require, while still preserving explicit submission order instead of introducing automatic scheduling.

## Decision

`CommandResourceAccessDescriptor.read` now uses explicit read descriptors:

- `resources.read: CommandResourceReadDescriptor[]`
- `resources.write: Resource[]`

`CommandResourceReadDescriptor` stores:

- `resource: Resource`
- `contentEpoch: number`

`DrawCommand` and `DispatchCommand` reject bare `Resource` entries in `resources.read`. Missing `resource`, missing `contentEpoch`, non-integer epochs, negative epochs, wrong-runtime resources, and disposed resources fail with structured diagnostics.

Submission validation now simulates each resource as:

- readiness state
- content epoch

The simulation starts from the real resource state and current `contentEpoch`. Uploads, texture uploads, copy targets, query resolve destinations, dispatch declared writes, draw declared writes, and render color attachment writes advance the simulated epoch and mark the simulated resource ready. Reads are checked before writes from the same command. Render attachment writes become visible after the render step.

Readiness checks and epoch checks are separate:

- `SCRATCH_COMMAND_RESOURCE_NOT_READY` remains a hard command policy failure for `whenMissing: 'throw'`.
- `SubmissionValidationMode` does not weaken `whenMissing: 'throw'`.
- If a read resource is empty, readiness failure occurs before epoch mismatch.

Required read epochs use exact matching:

- required epoch greater than the simulated epoch produces `SCRATCH_SUBMISSION_READ_BEFORE_WRITE`;
- required epoch lower than the simulated epoch produces `SCRATCH_SUBMISSION_STALE_READ`;
- required epoch equal to the simulated epoch is valid.

Read-before-write and stale-read diagnostics are dependency validation findings controlled by `SubmissionValidationMode`:

- `throw`: throw a structured diagnostic error before encoder creation;
- `warn`: attach the diagnostic to `SubmittedWork.report` and continue;
- `off`: skip this epoch dependency validator.

Pre-encoding validation does not mutate real resource state, `contentEpoch`, or `allocationVersion`. Real mutation still happens only when transfer commands execute or GPU commands are encoded.

## Alternatives Considered

### Minimum epoch matching

Rejected. A command requiring at least epoch 3 would silently accept epoch 4, even if epoch 4 contains different contents than the command was prepared for. Exact matching forces callers or tooling to refresh stale commands explicitly.

### Keep read declarations as bare resources

Rejected. Bare resources only answer what is read. They cannot distinguish a valid read of current contents from a stale command or an unsatisfied future producer dependency.

### Make write declarations carry required epochs too

Rejected for this slice. Writes remain plain `Resource[]` because this goal only needs source content requirements for reads. Write epoch production is still derived from execution order.

### Add automatic scheduling now

Rejected. The core submission model remains explicit order plus validation. A future scheduler can use the read/write facts without changing this command contract.

## Consequences

- Public TypeScript users can inspect required read source epochs through `geoscratch` and `geoscratch/scratch`.
- Commands authored before a resource update now fail as stale reads unless refreshed with the new source epoch.
- Same-submission producers can satisfy later reads when the command declares the epoch that the earlier producer will create.
- `SubmittedWork.resourceAccesses` and `SubmittedWork.producerEpochs` remain execution-derived ledgers; they do not record simulated-only facts.
- Range-level buffer epochs and region-level texture epochs remain future work.
- Copy source readiness and query slot readiness remain future work.
