# ADR-020: Validate Scratch Copy Source Epochs

## Status

Accepted

## Date

2026-07-09

## Context

ADR-018 introduced resource readiness validation for declared draw and dispatch reads.
ADR-019 added required read content epochs for those command reads.

`CopyCommand` already participates in submitted-work ledgers as a source read plus target write, and the vision docs define copy as reading the source `contentEpoch` and advancing the target `contentEpoch`. The implementation still accepted a bare `BufferResource` source and only simulated the copy target as a producer during pre-encoding validation. That left copy source reads outside the same dependency model used by draw and dispatch commands.

## Decision

`CopyCommandDescriptor.source` now uses an explicit source descriptor:

- `resource: BufferResource`
- `contentEpoch: number`

`CopyCommandDescriptor.whenMissing` is required and only accepts `'throw'` in this slice. Copy has no skip or fallback semantics yet, so an unready copy source is a hard command policy failure in every `SubmissionValidationMode`.

`CopyCommand` rejects bare `BufferResource` sources. Missing source descriptors, missing `resource`, missing `contentEpoch`, non-integer epochs, negative epochs, wrong-runtime source resources, disposed source resources, and missing `GPUBufferUsage.COPY_SRC` fail with structured diagnostics.

Submission validation now checks copy source readiness and required source epoch before simulating the target write. Copy source validation uses the same exact epoch matching rules as ADR-019:

- required epoch greater than the simulated epoch produces `SCRATCH_SUBMISSION_READ_BEFORE_WRITE`;
- required epoch lower than the simulated epoch produces `SCRATCH_SUBMISSION_STALE_READ`;
- required epoch equal to the simulated epoch is valid.

Read-before-write and stale-read diagnostics remain optional dependency validation findings controlled by `SubmissionValidationMode`. Source readiness for `whenMissing: 'throw'` remains a hard command policy failure and is not weakened by `warn` or `off`.

Execution ledgers remain execution-derived:

- `SubmittedWork.resourceAccesses` records the actual copy source read and target write after encoding.
- `SubmittedWork.producerEpochs` records the copy target write only.
- Simulated-only validation facts are not recorded as submitted work.

## Alternatives Considered

### Keep `source: BufferResource` and add `sourceContentEpoch`

Rejected. Splitting the resource and required epoch across sibling fields makes it easier to pass mismatched facts around. The descriptor keeps the source content requirement local and inspectable.

### Keep accepting bare source resources as a compatibility path

Rejected. This is still a `0.x.x` Scratch API, and old Scratch APIs are reference material rather than compatibility constraints. Keeping both shapes would preserve ambiguity exactly where the dependency validator needs explicit facts.

### Implement skip-command, skip-pass, or fallback for copy sources

Rejected for this slice. Copy does not yet have a concrete skip/fallback policy surface, and pretending that copy can be skipped safely would make target epoch production ambiguous. V1 requires `whenMissing: 'throw'`.

### Validate range-level source epochs

Rejected. Scratch currently tracks per-resource epochs. Buffer-range and texture-region epochs remain future work.

## Consequences

- Copy commands authored against a source epoch must be refreshed when the source changes.
- Same-submission uploads can satisfy later copy source requirements.
- Same-submission copy targets can satisfy later copy source requirements.
- A copy cannot read the epoch it will produce in the same command; source validation happens before target write simulation.
- Existing copy call sites must migrate from `source: buffer` to `source: { resource: buffer, contentEpoch }`.
- Examples currently do not use `createCopyCommand`, so no runnable example migration is required for this slice.
- Query slot readiness, `ReadbackCommand`, texture copy source epochs, range-level epochs, skip/fallback policy, and automatic scheduling remain future work.
