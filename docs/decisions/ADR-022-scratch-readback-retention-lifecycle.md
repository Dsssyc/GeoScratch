# ADR-022: Add Scratch Readback Retention Lifecycle

## Status

Accepted

## Date

2026-07-09

## Context

ADR-010 added layout-aware readback operations. ADR-014 made operation-based readback capture source epoch and allocation provenance. ADR-021 kept query CPU visibility on the explicit resolve-then-readback path.

`ReadbackOperation` still only supported consume-on-read behavior: the first successful `toBytes()`, `toArray()`, or `toLayoutView()` returned an owned host copy and moved the operation to `consumed`. Repeated inspection required callers to create another readback operation, which re-staged, re-submitted, and re-mapped the same bytes even when the caller only wanted stable host-side reuse.

The Scratch transfer vision already separates resource identity, source epochs, readback operations, and future mapped leases or readback commands. This decision implements the next bounded slice: explicit operation-owned host result retention.

## Decision

`ReadbackOperationDescriptor` now accepts:

```ts
retain?: 'consume-on-read' | 'until-dispose'
```

Missing `retain` defaults to `consume-on-read`, preserving existing call-site behavior.

`ReadbackOperation` exposes:

```ts
retain: ReadbackRetentionPolicy
isResultRetained: boolean
retainedByteLength?: number
```

For `consume-on-read`, the first successful read returns an owned host copy, releases staging, and transitions to `consumed`. Later reads fail with `SCRATCH_READBACK_ALREADY_CONSUMED`.

For `until-dispose`, the first successful read performs the staging copy and map once, stores an operation-owned `Uint8Array` host copy, releases the staging buffer, and transitions to `ready`. Repeated `toBytes()`, `toArray()`, and `toLayoutView()` calls return fresh owned copies derived from the retained host bytes. User mutation of a returned value cannot mutate the retained operation result.

`ready` means retained host bytes exist for this implementation slice. The default consume-on-read path does not use `ready`.

Retained host bytes remain valid even if the source buffer's later `contentEpoch` advances after materialization. Before first materialization, the existing ADR-014 source epoch and allocation checks still run and fail before staging if the live source no longer matches the captured facts.

`cancel()` and `dispose()` clear retained bytes, clear `retainedByteLength`, mark `isResultRetained` false, release staging when present, and make later reads fail with structured readback lifecycle diagnostics.

Invalid retention policy values fail at construction with `SCRATCH_READBACK_RETAIN_INVALID`.

Readback lifecycle diagnostics now include structured operation facts such as state, retain policy, source id, range, content epoch, allocation version, producer submission id when applicable, retained byte length when applicable, staging byte count when applicable, and cancellation reason when applicable.

## Alternatives Considered

### Retain the mapped GPU staging buffer

Rejected. Retaining mapped staging would require mapped-range ownership rules, unmap timing, active lease diagnostics, and runtime budget policy. A host byte copy is deterministic, easy to clone safely, and lets staging be unmapped and destroyed immediately after materialization.

### Add mapped leases in the same slice

Rejected. Mapped leases need a separate lifetime model: lease creation, lease disposal, active lease diagnostics, operation disposal interactions, and invalid-view prevention after unmap. Host-copy retention solves repeated inspection without introducing zero-copy complexity.

### Add readback budgets or eviction policy now

Rejected. Budgets require runtime configuration, operation registries, byte accounting, stale-operation aging, diagnostic sinks, and an explicit eviction policy. This decision only retains bytes when a caller opts in on a specific operation.

### Add `ReadbackCommand`

Rejected. `ReadbackCommand` changes command graph ordering and ordered staging semantics. This decision keeps the existing operation-based path and only changes host result lifetime.

### Let retained reads revalidate source epochs

Rejected. Once bytes have been materialized into an operation-owned host copy, later source contents are irrelevant to that retained result. Epoch and allocation validation still applies before the first materialization because the live source resource is the copy source at that point.

## Consequences

- Existing readback call sites keep consume-on-read behavior by default.
- Callers that need repeated CPU inspection can opt into `retain: 'until-dispose'`.
- Repeated retained reads do not allocate another staging buffer, create another command encoder, submit another queue command, copy again, or map again.
- Retained reads trade memory for deterministic reuse until explicit cancel or dispose.
- Failure, cancellation, and disposal paths clear retained host bytes and staging resources.
- `ready` is now meaningful in the implemented API as "retained host result is available."
- Buffer and texture resources still do not gain `toBytes()`, `toArray()`, `read()`, or `write()` helpers.
- Mapped leases, readback budgets, texture readback, `ReadbackCommand`, range-level epochs, automatic scheduling, and resource-level readback sugar remain future work.
