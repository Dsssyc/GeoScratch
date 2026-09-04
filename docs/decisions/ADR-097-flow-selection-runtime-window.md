# ADR-097: Flow Selection-Driven Runtime Window

## Status

Accepted and implemented as an additive `Flow Field` resource owner. GPU publication and renderer
integration remain on the existing temporal path until the next clean-cut phase. This decision
does not change the frozen `Flow Layer` example or public Geo/Scratch APIs.

## Date

2026-09-04

## Context

The first `Flow Field` prototype permanently owned current, next, and prefetch runtimes and moved
them after a fixed number of render frames. That model cannot represent arbitrary seeks, reverse
playback, exact samples, or manifest-declared temporal gaps. It also makes runtime identity depend
on a dense numeric ordinal rather than schema-two `sampleKey`.

Replacing a pair is asynchronous. The old pair may still be captured by an in-flight frame while
one or two new runtimes are being created. A rapid seek can supersede creation, and an aborted
factory may still resolve late. Without an explicit owner, these races can publish stale pairs,
double-dispose runtimes, or exceed the intended GPU/Worker/page budgets.

## Decision

### Dataset and selection authority

One runtime window is permanently bound to an immutable dataset identity consisting of
`datasetId`, `sourceHash`, and `contentVersion`, plus the normalized time axis. Runtime leases are
keyed by `sampleKey`; `timeIndex` is provenance only. The window accepts the exact,
interpolated, and gap selections produced by ADR-096 and revalidates their samples and declared
adjacency before changing state.

An exact selection owns one unique runtime and exposes the same lease as both shader endpoints
with alpha zero. An interpolated selection owns its declared lower and upper samples. A gap
becomes active synchronously and exposes no runtime, so the clock may continue across it without
sampling or blending retained data.

### Latest-wins pair work

Every request receives a monotonic revision and an immutable ticket whose terminal result is
`ready`, `gap`, `superseded`, `failed`, or `disposed`. A newer request settles the older ticket as
superseded. Resource work has a separate pair identity: changing alpha within the same pair
retargets the existing work and does not restart factories, while a different pair aborts the old
candidate and can only commit if it is still the latest requested pair.

Shared sample leases are reused. For example, replacing A/B with B/C creates only C; B is retained
until the old pair and every frame capture release their references. A ready capture is immutable,
binds request revision, pair generation, selection, alpha, samples, and concrete runtimes, and
owns an idempotent release operation. A retired pair is disposed only after all captures release.

### Hard ownership bound and bounded cancellation

The first implementation has no lookahead runtime. It permits at most two active unique runtimes
plus two candidate unique runtimes and requires `maxOwnedRuntimes` to be exactly four. Returned
runtimes, runtimes undergoing disposal, and late resolved runtimes remain counted until disposal
succeeds. Pending creations are counted separately before a factory starts.

The factory contract is explicitly `createReadyRuntime`: a returned runtime has already completed
its safety-cover initialization and GPU acknowledgement. It receives an AbortSignal and attempt
identity and must settle within `maxCreationSettleMs`, including after cancellation. The window
cannot simultaneously preserve a strict ownership cap and make progress past a factory that
ignores abort forever. A timeout therefore enters the explicit fatal `factory-unresponsive`
state; a later successful result is adopted only for exactly-once disposal, never for activation.
The timeout classifies the contract violation and stops new work; JavaScript cannot force-settle
the factory Promise. If a factory never settles at all, final window disposal intentionally remains
pending because the owner cannot both forget a possible future runtime and guarantee its later
cleanup.

Two factories for one candidate run concurrently. The first real failure aborts its sibling. A
factory may never return a runtime object previously seen by the window, even after disposal. A
late duplicate of an active runtime is rejected without disposing the active owner's lease.

### Velocity ready-runtime adapter

The `Flow Field` velocity adapter fulfils `createReadyRuntime` without adding readiness policy to
Geo. It creates one sample-key Virtual Raster runtime with an owned request executor and borrowed
application `WorkerSystem`, waits for its minimum-level safety demand, encodes the resulting GPU
publication into a Surface-free submission, and returns only after native outcome, queue
completion, and Virtual Raster acknowledgement have all settled successfully.

An abort during safety-demand initialization starts idempotent runtime disposal so request work
can converge. Once a publication is submitted, abort does not race disposal against GPU
acknowledgement: every native/done/ack observer settles first, then the runtime is disposed.
Synchronous encode or submit failure leaves the publication owned by the runtime and disposal
uses the existing Virtual Raster abandon path. Primary, observer, acknowledgement, and cleanup
failures are retained in one aggregate, and a successful result is returned only for native status
`observed-succeeded`.

### Failure and disposal

An ordinary factory failure settles the latest ticket as failed after every partial success is
released; a later request may retry. Cleanup failure and factory unresponsiveness are persistent
fatal states: they cancel candidate work, wake capacity waiters, prevent later requests and stale
commits, and remain visible in facts. The failed runtime remains counted when disposal did not
succeed.

Window disposal is idempotent. It invalidates the latest ticket, aborts creation, waits for every
factory completion required by the bounded-settling contract, waits for all captures, drains every
retirement, and calls the supplied runtime disposer at most once per runtime identity. Cleanup
failures are aggregated after all reachable owners have been settled. A factory that permanently
violates the settling contract therefore also prevents disposal settlement, as described above.

## Consequences

- Runtime allocation follows timeline selections instead of render-frame counts.
- Exact samples, reverse seeks, gaps, and rapid seek storms have explicit outcomes.
- Stale asynchronous work cannot replace the current pair.
- Runtime ownership is bounded and observable even during overlap and disposal.
- This first version deliberately omits lookahead; it can be added later without changing ticket,
  capture, or lease identity.
- Camera-driven fine-LoD settlement is not part of `createReadyRuntime` admission and must not
  become model-clock readiness.
- The renderer still needs a later adapter that creates safety-ready velocity runtimes, consumes
  captures, and owns per-frame Virtual Raster publication acknowledgement.

## Alternatives Rejected

- Keep a permanent current/next/prefetch ring: rejected because the ring owns playback order and
  cannot express seek, reverse, or gap states.
- Identify leases by `timeIndex`: rejected because selected collections may be non-dense.
- Start every latest request immediately after abort: rejected because an uncooperative old
  factory could make the four-runtime bound fictional.
- Dispose a late duplicate result unconditionally: rejected because it may be the same object as
  a still-active lease.
- Recreate a shared endpoint during A/B to B/C: rejected because it wastes initialized safety
  coverage and weakens pair continuity.
- Treat a gap as loading: rejected because no runtime work can make omitted source samples appear.

## References

- [ADR-095: Bounded Flow Runtime Dataset Manifest](./ADR-095-bounded-flow-runtime-manifest.md)
- [ADR-096: Flow Model-Time Authority](./ADR-096-flow-model-time-authority.md)
