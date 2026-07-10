# ADR-028: Execute Draw And Dispatch Readiness Policies

## Status

Accepted

## Date

2026-07-10

## Context

`DrawCommand` and `DispatchCommand` publicly accepted four resource readiness policies: `throw`, `skip-command`, `skip-pass`, and `use-fallback`. Submission validation only enforced `throw`. The other values bypassed the hard missing-resource error but still encoded the requested command, advanced declared writes, and created resource and producer ledger facts.

This was a public contract error. A skipped command could make an empty output appear ready, a skipped pass could still clear attachments and write query slots, and a fallback policy had no way to identify what actually entered the encoder. Optional dependency diagnostics and `SubmittedWork.resourceAccesses` could therefore describe work that the policy said should not happen.

Scratch already had immutable Draw/Dispatch contracts, explicit required read epochs, ordered readiness simulation, native direct/indexed/indirect lowering, and resource/producer ledgers. The missing boundary was one pre-encoder decision that selected the actual command sequence and made that decision observable.

This decision resolves the Draw/Dispatch readiness future-work notes in ADR-016, ADR-017, ADR-018, ADR-020, and ADR-027. It does not supersede their accepted validation, epoch, or native-execution decisions.

## Decision

### Typed command contract

Use one discriminated readiness descriptor:

```ts
type CommandReadinessDescriptor<FallbackCommand> =
    | {
        whenMissing: 'throw' | 'skip-command' | 'skip-pass'
        fallback?: never
    }
    | {
        whenMissing: 'use-fallback'
        fallback: FallbackCommand
    }
```

Draw can fall back only to `DrawCommand`; Dispatch can fall back only to `DispatchCommand`. Runtime construction validates the same command kind, runtime ownership, non-disposed lifecycle, identical declared-write resource identity set, and an acyclic chain. The policy and fallback reference are immutable after construction. There is no bare `use-fallback`, legacy alias, implicit resource substitution, or bind-set mutation path.

Fallback commands may use different pipelines, bindings, fixed-function buffers, counts, and declared reads. A selected fallback must still be compatible with the current pass. Native direct, indexed, and indirect encoding remains owned by the selected command; fallback resolution never interprets indirect argument bytes.

### One resolved submission plan

`SubmissionBuilder.submit()` resolves a plan before creating a WebGPU command encoder. The plan contains the validation report, resolved steps, final readiness/query simulation, and mutable execution-outcome drafts. Encoding consumes only the resolved steps and never revisits `SubmissionBuilder.steps` to make readiness decisions.

At each command position, resolution inspects every required read against the simulated state:

- `throw` raises `SCRATCH_COMMAND_RESOURCE_NOT_READY` before encoder creation in every validation mode.
- `skip-command` removes that command and does not apply its reads or writes.
- `skip-pass` removes the complete render/compute pass.
- `use-fallback` records the primary attempt and resolves the fallback at the same position, continuing through a finite chain.

Required-epoch stale/future diagnostics apply only to the final selected command. `SubmissionValidationMode` controls those optional dependency findings; it does not alter readiness control flow, and `off` does not remove execution outcomes.

### Transactional pass resolution

Each render/compute pass resolves against cloned resource-readiness state, query-slot state, and a pass-local dependency-diagnostic list. A `skip-pass` decision discards all three clones and every previously selected command in that pass. It therefore cannot leak command writes, attachment writes, timestamp writes, occlusion query writes, or dependency findings to later steps.

`skip-command` does not remove pass-level effects. A render pass with attachment operations still executes when all draws are skipped. A compute pass with no selected commands and no timestamp side effect does not enter the encoder and is reported as `skipped-empty`.

### Observable execution ledger

`SubmittedWork.executionOutcomes` is an immutable array of pass and command outcomes. Each render/compute pass has one pass outcome, and each requested Draw/Dispatch has one command outcome. Command attempts retain the policy and all missing-resource state/epoch facts. Outcomes distinguish requested IDs from encoded IDs and identify the final fallback when one executes.

The ledger is authoritative for expected skip/fallback control flow. Normal absence is not converted into a warning or error. All outcome objects, attempts, missing facts, diagnostic subjects, nested ID arrays, and the top-level array are frozen. The `executionOutcomes` property is read-only at both the TypeScript and runtime object boundaries.

`resourceAccesses` and `producerEpochs` are still created during encoding, but only from resolved commands and executed pass effects. A skipped primary or pass cannot leave resource or producer facts. Known static zero-count commands remain non-producers; indirect selected fallbacks remain conservative potential producers without host inspection.

### Scope boundary

The complete four-policy contract applies to Draw and Dispatch. `CopyCommand`, `ReadbackCommand`, and `ResolveQuerySetCommand` remain compile-time and runtime `throw`-only because their skip/result lifecycle is not defined by this decision.

## Alternatives Considered

### Keep non-throw policies as validation-only hints

Rejected. It preserves contradictory public behavior and creates writes and epochs for commands that policy says did not execute.

### Decide policy again while encoding

Rejected. Validation, dependency simulation, outcomes, and encoding could drift. A single resolved plan is the only execution fact source.

### Replace missing GPU resources through CPU callbacks

Rejected. It hides resource identity and dependencies, encourages per-submission mutation, and cannot preserve native GPU-driven indirect execution.

### Let fallback change the declared write set

Rejected. Downstream commands would no longer have a stable producer contract. Fallback may change how work is produced, not which logical resources it promises to produce.

### Record skips as diagnostics

Rejected. Expected streaming absence is control flow, not a validation failure. Machine-readable execution outcomes are the correct observable contract.

### Extend every command family in the same change

Rejected. Copy, ordered staging, and query resolve have distinct lifecycle and result semantics. Inventing non-throw behavior for them would make the contract broader but less precise.

## Consequences

- All four public Draw/Dispatch readiness policies now change actual encoder behavior.
- Downstream readiness observes only real selected writes.
- `skip-pass` is atomic across commands, attachments, timestamps, occlusion queries, diagnostics, resource epochs, and producer facts.
- Fallback chains retain complete attempt evidence and only the final selected command reaches native encoding.
- `SubmittedWork.executionOutcomes`, `resourceAccesses`, and `producerEpochs` can be cross-checked without primary/skipped ghosts.
- Illegal fallback contracts and hard runtime failures continue to use the shared `ScratchDiagnostic` envelope.
- CPU-dynamic resolvers, automatic scheduling, expanded resource states, and non-throw policies for Copy/Readback/Resolve remain future work.
