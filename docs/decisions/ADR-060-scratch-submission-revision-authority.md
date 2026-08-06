# ADR-060: Scratch Submission Revision Authority

## Status

Accepted

## Date

2026-08-06

## Context

Persistent GPU systems can prebuild resources, pipelines, bind sets, and commands while
one small CPU-authored fact changes per frame. A caller may assemble a
`SubmissionBuilder`, then advance the external fact before calling `submit()`. Resource
epochs cannot represent this condition when the stale fact controls which already-built
commands are valid rather than the content of one GPU resource.

Geo's persistent tile frontier needs this check for acknowledged residency publication
and immutable per-view uploads. The primitive is generic Scratch submission authority;
Scratch must not call a Geo callback or own a Geo state machine.

## Decision

`GPURuntime.createSubmissionAuthority()` creates a runtime-associated
`SubmissionAuthority` with one module-private monotonic revision and an explicit
disposed state.

- `stamp()` returns a frozen branded `SubmissionAuthorityStamp` for the current
  revision.
- `advance()` increments the revision once and returns the new stamp.
- `dispose()` invalidates every stamp. It is idempotent.
- `SubmissionBuilder.require(stamp)` records the immutable requirement privately. It
  executes no callback and performs no native work.
- `submit()` validates genuine stamp identity, exact Runtime, current revision, and
  lifecycle at submission entry.
- After all caller-owned sampling/materialization, Surface preparation, and ordered
  readback claims are complete, `submit()` validates the requirements again. This
  second check occurs before `beginSubmissionNativeObservation()`, error scopes,
  command-encoder creation, or queue effects. Failure releases acquired readback claims.
- Invalid, wrong-Runtime, stale, and disposed requirements produce structured
  `SCRATCH_SUBMISSION_AUTHORITY_*` diagnostics.

Authority state stores only the current revision. Stamps are branded through weak
module-private records, and builders retain only their explicitly required stamps.
There is no callback, lock, wait queue, prepare state, retry, revision history, hidden
submission, or unbounded frontier-owned ledger.

This is a consistency and supported-composition boundary, not a same-realm security
boundary. Scratch intentionally keeps direct resource, region, command, bind-set, and
declared-access descriptors inspectable. An expert may recover resources from those
descriptors and construct another explicit Scratch command or readback. Such use is an
intentional escape hatch and assumes responsibility for its own temporal authority.
Higher-level APIs may narrow their own public capabilities without making Scratch's
primitive graph secret.

## Rejected Alternatives

### A caller callback checked by SubmissionBuilder

Rejected. It would execute arbitrary code at a critical native boundary, import domain
semantics into Scratch, and make validation reentrant.

### Locks, waits, or automatic retry

Rejected. Submission remains synchronous. Caller-owned materialization may have side
effects and cannot be replayed safely.

### Resource content epochs alone

Rejected. A revision may invalidate a command graph even when no exposed resource
content epoch has changed yet.

### Hiding all Scratch descriptors

Rejected. Direct WebGPU-style control and verifiable declared resource access are core
Scratch capabilities. Higher-level convenience boundaries do not convert them into a
security sandbox.

## Consequences

- A prebuilt submission fails before native observation or encoding when an associated
  view or residency revision advances.
- Persistent GPU objects remain reusable; only bounded immutable stamps and the
  per-view upload command are rebuilt.
- Domain owners decide when a successful transaction advances their authority.
- Direct Scratch escape hatches remain available and explicit.
