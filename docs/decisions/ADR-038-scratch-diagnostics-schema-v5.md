# ADR-038: Represent Supporting-Object Evidence Truthfully In Schema V5

## Status

Accepted

## Date

2026-07-13

## Context

ADR-032 through ADR-035 established a bounded operation ledger, discriminated
resource/pipeline/readback/submission targets, finite incidents and deep capture,
and explicit native observation. Schema v4 still assumes that resource operation
targets are content-bearing buffer or texture allocations. Reusing those fields
for samplers, query sets, bind layouts, or bind sets would fabricate content
epochs, readiness, or byte footprints.

Supporting-object creation and BindSet preparation also add native transactions
whose stages and object relationships must be inspectable without parsing
implementation-defined browser prose or retaining unbounded snapshots.

## Decision

### Clean schema v5

Operation records, incident reports, runtime snapshots, capture reports, query
results, native outcomes, and exported evidence advance together to version 5.
Schema v4 writers, adapters, aliases, and dual output are removed during
`0.x.x`.

The operation target union represents `Resource`, `Pipeline`, `BindLayout`, and
`BindSet` explicitly. Existing command, readback, submission, and runtime
incident context remains where required by its owning evidence family; no target
is coerced into a Resource.

Resource targets are discriminated:

- Buffer and Texture may report allocation version, scalar content epoch and
  state, and known logical footprint.
- Sampler reports allocation version without content epoch, readiness, or
  footprint.
- QuerySet reports allocation version, query type, count, and bounded indexed
  slot facts without scalar content epoch or readiness.

BindLayout targets report identity, group, normalized entry shape, and
acknowledgement state without allocation or content fields. BindSet targets
report identity, layout identity, preparation state, generation, and current
snapshot hash without pretending to be resources.

`BufferRegion` and `TextureViewSpec` are diagnostic subjects or related bounded
evidence. They are not operation targets, allocations, or pressure contributors
and never double-count parent resources.

### New operation families

Schema v5 adds:

- `sampler-allocation`
- `query-set-allocation`
- `bind-layout-allocation`
- `bind-set-preparation`

Preparation evidence distinguishes descriptor/preflight validation, native
issue, synchronous native throw, texture-view scope acknowledgement, bind-group
scope acknowledgement, runtime/device lifecycle recheck, snapshot recheck,
atomic commit, cancellation, and explicit retry.

Stable diagnostics use structured codes, subjects, related subjects,
expected/actual payloads, and bounded evidence. Native message prose may remain
bounded supporting evidence but is never parsed into a stable classification.

### Failure and OOM attribution

Independent native outcomes are retained independently. BindSet preparation
chooses a primary failure through a documented stable causal order and keeps
secondary or derivative outcomes as related evidence. A failed candidate never
produces a successful current fact.

An OOM record identifies the exact scoped operation that observed OOM and may
include bounded current Buffer/Texture pressure and recent create/replace/dispose
churn. Scratch does not estimate native byte sizes for samplers, query sets,
layouts, views, or bind groups and does not claim one candidate alone caused
aggregate OOM. Unknown native and non-Scratch pressure stays unknown.

### Retention model

The ADR-032 retention split remains:

- always-current facts scale with live or pending state, not runtime age;
- recent operation history has fixed configurable capacity;
- immutable incidents are bounded by count and serialized-evidence budget; and
- deep capture is explicit, finite, temporary, and automatically detached.

Successful unchanged BindSet use creates no preparation operation, history
record, incident, scope work, or copied binding snapshot. Submission evidence may
reference BindSet identity, generation, and snapshot hash, but does not duplicate
the complete binding table.

Capacity zero disables successful history only. It does not disable current
facts, failures, lifecycle handling, required scopes, or structured validation.
No new validation path throws prose-only errors.

## Alternatives Considered

### Add optional fields to the v4 resource target

Rejected. A wide optional object would permit impossible combinations and make
agent/tooling interpretation depend on convention instead of the type
discriminator.

### Keep v4 and emit a second supporting-object report

Rejected. Dual schemas would drift and require callers to correlate two partial
histories.

### Record every successful BindSet use

Rejected. Frame-rate use would scale CPU memory and agent context with runtime
age while adding no new preparation fact.

### Estimate supporting-object memory

Rejected. WebGPU exposes no reliable portable physical footprint for these
objects. Fabricated estimates would weaken OOM diagnosis.

## Consequences

- Runtime evidence describes each object kind without fake scalar state.
- Supporting-object failures remain locally repairable and causally inspectable.
- Existing bounded-ledger and source-minimization guarantees remain intact.
- Every schema-v4 consumer must migrate in the same clean cut.
