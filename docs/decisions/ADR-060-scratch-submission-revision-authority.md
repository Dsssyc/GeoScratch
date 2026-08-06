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

Geo's persistent tile frontier needs this check for acknowledged residency publication,
immutable per-view uploads, and the A/B state transition that occurs only when a
submission is actually issued. The primitive is generic Scratch submission authority;
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
- `SubmissionBuilder.consume(stamp)` records both a requirement and a successful-submit
  revision transition. One builder may consume a given authority at most once.
- `submit()` validates genuine stamp identity, exact Runtime, current revision, and
  lifecycle for required and consumed stamps at submission entry.
- After all caller-owned sampling/materialization, Surface preparation, and ordered
  readback claims are complete, `submit()` validates the requirements again. This
  second check occurs before `beginSubmissionNativeObservation()`, error scopes,
  command-encoder creation, or queue effects. Failure releases acquired readback claims.
- After every synchronous queue action succeeds, `SubmittedWork` exists, and all
  readback claims are adopted, Scratch rechecks all consumed stamps as one set and
  advances each authority exactly once through a module-private non-virtual commit.
  Unsubmitted builders and synchronous submission failures consume nothing. Two
  competing builders that captured the same revision cannot both submit.
- Invalid, duplicate-consume, wrong-Runtime, stale, and disposed requirements produce structured
  `SCRATCH_SUBMISSION_AUTHORITY_*` diagnostics.

Consumption records that native work was synchronously issued and adopted; it does not
claim that asynchronous native observation later succeeded. An `observed-failed` or
indeterminate native outcome does not roll the revision back, because replaying the same
A/B transition could race work already issued to the queue. Existing potential-write,
content-indeterminacy, `nativeOutcome`, and `done` contracts report that outcome.

Authority state stores only the current revision. Stamps are branded through weak
module-private records, and builders retain only their explicitly required or consumed stamps.
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
- Cancelled or never-submitted work does not advance an A/B sequence; a successful
  synchronous submit return does, independent of caller frame numbering.
- Persistent GPU objects remain reusable; only bounded immutable stamps and the
  per-view upload command are rebuilt.
- Domain owners may advance authority explicitly after their own transaction or let a
  submission consume a captured revision at the bounded commit point.
- Direct Scratch escape hatches remain available and explicit.
