# ADR-017: Apply Submission Validation Disposition

## Status

Accepted

## Date

2026-07-09

## Context

ADR-016 added the first deterministic submission dependency validator: a draw command must not declare the current render pass `TextureResource` color attachment as a command-level read or write.

The `SubmissionBuilderOptions.validation` surface already accepted `'off' | 'warn' | 'throw'`, and the Scratch vision documents define validation mode as an action policy rather than part of diagnostic identity. The implementation still threw the render-resource conflict directly, so successful `SubmittedWork.report` objects were always empty and `warn` / `off` did not behave differently from `throw`.

## Decision

`SubmissionBuilder.submit()` now performs a validation pass before GPU encoding.

Required hard validation still throws structured diagnostics regardless of validation mode. This includes runtime ownership, disposed objects, pass and command compatibility, target format mismatches, required resource usage, and invalid command or pass lifecycle state.

Optional submission dependency validation currently covers the ADR-016 render-resource conflict only. That validation produces `ScratchDiagnostic` entries and then applies the builder validation mode:

- `throw`: throw `ScratchDiagnosticError` with a `ScratchDiagnosticReport` before render pass creation, command encoding, queue submission, or resource epoch mutation.
- `warn`: attach the deterministic report to `SubmittedWork.report` and expose the same diagnostics through `SubmittedWork.diagnostics`, then continue submission.
- `off`: skip this optional dependency validator and submit with an empty report.

Diagnostic identity is independent of validation mode. The render-resource conflict keeps the same code and structured payload in `throw` and `warn` modes:

- code: `SCRATCH_SUBMISSION_RESOURCE_ACCESS_CONFLICT`
- phase: `submission`
- subject: the offending `DrawCommand`
- related: the `RenderPassSpec`, conflicting `TextureResource`, and `Submission`

`SubmittedWork.diagnostics` remains an alias of `SubmittedWork.report.diagnostics`.

## Alternatives Considered

### Make all submission validation mode-controlled

Rejected. Some checks are required platform-safety or lifecycle checks. Treating wrong-runtime resources, disposed commands, invalid pass kinds, or missing required WebGPU usage as warnings would allow the runtime to continue from an incoherent state.

### Keep direct throws until full dependency validation exists

Rejected. The public `SubmissionValidationMode` contract is already present, and ADR-016 gave the implementation a concrete optional validator. Keeping the direct throw path would leave `warn` / `off` misleading and would keep `SubmittedWork.report` unused for submission validation.

### Convert error diagnostics to warning severity in `warn` mode

Rejected. Validation mode controls disposition, not diagnostic identity. The finding remains an error-severity dependency conflict; `warn` mode only changes whether the runtime throws or attaches the report and continues.

## Consequences

- Development mode can continue using `validation: 'throw'` for fail-fast conflict detection.
- Profiling or exploratory runs can use `validation: 'warn'` to inspect deterministic submission diagnostics while still producing submitted work.
- `validation: 'off'` skips only this optional dependency validator; it does not bypass hard safety checks.
- `SubmittedWork.report` can now contain submission validation findings.
- Full read-before-write validation remains future work.
- Resource readiness policy behavior remains future work.
- Automatic scheduling and pass or command sorting remain future work.
- Depth/stencil attachment conflict validation remains future work.
