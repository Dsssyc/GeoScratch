# ADR-041: Resolve Current-Content Reads At The Submission Step

## Status

Accepted

## Date

2026-07-16

## Context

ADR-019 made DrawCommand and DispatchCommand reads require an exact numeric `contentEpoch`. That contract is useful when a command is intentionally tied to one immutable content version, but it also makes a stable command unusable after every legal producer update. A long-running render or compute loop then has to reconstruct the command solely to copy a later epoch number into an otherwise unchanged descriptor.

The replacement must preserve explicit submission order and exact historical facts. It must not turn a resource into mutable command state, infer dependencies, reorder work, inspect GPU bytes, or weaken lifecycle and readiness checks.

## Decision

DrawCommand and DispatchCommand read declarations use this closed union:

```ts
export type CommandResourceReadEpoch = number | 'current-at-step'

export type CommandResourceReadDescriptor = {
    readonly resource: BufferResource | TextureResource
    readonly contentEpoch: CommandResourceReadEpoch
}
```

A numeric epoch keeps ADR-019 exact-match semantics. A command that declares `'current-at-step'` instead resolves the resource content that exists immediately before the selected command at its explicit submission position:

1. Start from the resource facts at submission preparation.
2. Apply only earlier submission-step effects in declared order.
3. Resolve readiness and a same-kind fallback chain.
4. For the final selected command, read the simulated content state before that command's own writes.

There is no lookahead to later producers, automatic sorting, retry, command mutation, or fallback from a stale numeric epoch to current content. The sentinel is a frozen declarative value, not a callback, closure, tracked value, setter, or mutable relationship to the Resource.

Resolution occurs in `throw`, `warn`, and `off` validation modes. Validation mode controls optional numeric epoch findings; it does not disable ownership, lifecycle, readiness, indeterminate-content, binding, allocation, usage, layout, pass-conflict, or readiness-policy checks. Empty content still follows the command's explicit `whenMissing` policy. Indeterminate content remains a hard failure. A selected fallback resolves its own declarations only; skipped primary and skipped pass facts do not enter the execution ledger.

The same mode is valid for shader resources and fixed-function vertex, index, and indirect reads. Copy, Readback, and query-slot source descriptors keep their existing exact numeric epoch APIs.

`SubmittedWork.resourceAccesses` keeps both sides of the historical fact:

- `declaredContentEpoch` stores the authored numeric epoch or `'current-at-step'`;
- `contentEpochBefore` and `contentEpochAfter` remain resolved numeric facts captured at execution preparation;
- `allocationVersion` remains the physical-allocation fact used by that access.

These records are frozen, bounded by the submitted work, serializable, and unaffected by later resource changes. The command declaration is never rewritten with the resolved number.

## Alternatives Considered

### Rebuild commands after every producer

Rejected. It treats an otherwise stable pipeline/binding/execution contract as frame-local state and creates avoidable allocation and identity churn.

### Read `resource.contentEpoch` when constructing the submission

Rejected. Application-side sampling can occur before earlier steps in that same submission produce content, and it duplicates scheduler knowledge without preserving an authored-vs-resolved fact.

### Accept callbacks or aliases such as `latest`

Rejected. Callbacks introduce timing, exception, capture, and serializability ambiguity. Multiple aliases enlarge the public contract without adding capability. `'current-at-step'` names the exact resolution boundary.

### Apply current-content semantics to every source descriptor

Rejected. Copy, Readback, and query operations intentionally retain exact source provenance. This decision solves stable executable command reads without silently changing transfer or query contracts.

## Consequences

- Stable DrawCommand and DispatchCommand objects can follow explicit preceding producers across long-running submissions.
- Numeric exact reads remain available and remain strict.
- Submission order stays authored and observable; the mode does not schedule work.
- Readiness and delayed-failure truth remain stronger than validation-mode convenience.
- Historical access facts distinguish authored policy from the exact numeric content actually read.
- Range-level or subresource-level epochs remain separate future work.
