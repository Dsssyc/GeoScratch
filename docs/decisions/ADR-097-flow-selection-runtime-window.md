# ADR-097: Flow Selection-Driven Runtime Window

## Status

Accepted and implemented by the `Flow Field` application, demand coordinator, temporal bindings,
and renderer. The fixed three-slot temporal owner is no longer on the active path. This decision
does not change the frozen `Flow Layer` example or public Geo/Scratch APIs.
ADR-105 adds optional directional lookahead to this owner while preserving its bounds.

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

The window also has an idempotent request-stop phase distinct from resource disposal. Request stop
rejects new selections, settles the pending ticket, aborts candidate and capacity work, and calls
the supplied demand stopper exactly once for every runtime known at that point. A runtime returned
late is stopped before it is disposed. This phase does not release a pair, capture, BindSet, or GPU
resource, so the application can run it before draining observations without racing renderer
ownership. A one-shot termination promise independently reports persistent cleanup/unresponsive
failure, or settles as stopped only after complete normal disposal; fatal state therefore remains
observable even after the latest request ticket already reported ready or request production has
already stopped.

### Application, demand, and renderer integration

The application is the sole coordinator of the timeline and window. Timeline
`selectionRevision` and window ticket revision remain distinct and are recorded together in a
latest-only handshake. A late ticket cannot report readiness for another timeline selection.
Loading returns an effect-free frame and waits for exactly one ticket wake-up; it does not spin.
A gap also submits no simulation or raster publication, but display-paced invalidation continues
while the timeline says it needs another tick, allowing the clock to cross the gap.
Before either non-ready frame is returned, the renderer suspends its retained temporal binding.
That retires a stale long-lived pair capture after any in-flight frame releases and prevents an old
A/B BindSet plus an unpresented C/D pair from occupying all four runtime slots while E/F waits for
capacity.

An ordinary runtime factory failure is exposed as an effect-free failed frame and freezes the
clock. It is not upgraded to page failure and is not retried by display invalidation; the next
explicit play, pause, seek, rate, or loop control requests a retry. Persistent cleanup failure and
factory unresponsiveness use the independent termination signal and fail the page even when no
frame or request ticket remains pending.

The renderer accepts only an admitted ready timeline and obtains one pair-generation binding
frame before creating a submission. The binding provider keeps a long-lived capture for the
active BindSet, while each rendered frame owns another capture until native observation,
publication acknowledgement, demand registration, view feedback, and contour observation have
all settled. A replacement BindSet is created before the old set and long capture retire.
Consequently the window cannot dispose a runtime still referenced by a binding or in-flight frame.
Only a dedicated binding-superseded error may be converted into an effect-free retry. BindSet,
shader, resource, and cleanup errors keep their original identity and enter the application fatal
path instead of being mislabeled as a generation race.

Demand receives the same immutable ready capture as the renderer. It fans out one spatial set to
one or two unique runtimes, never reads the window again during reconciliation, and collapses an
exact sample's lower/upper roles into one request. Camera-driven fine-LoD settlements remain Geo
frame settlement facts only; they never become timeline readiness.

The application declares an aggregate four-runtime budget rather than multiplying a per-runtime
number silently: 192 request slots, 192 physical pages, 96 MiB of staging, four network tasks, and
four decode tasks are divided into four equal runtime partitions. The common steady pair therefore
uses two partitions, while an old captured pair and a new candidate can coexist within the same
explicit ceiling.

The application request-stop action runs after the frame controller stops but before Lifetime
observations drain. Full releases remain ordered renderer, temporal window, WorkerSystem,
GPURuntime, then map. A terminal gap records a gap last-frame fact instead of retaining an
unrelated rendered frame. Direct terminal rendering is guarded by the renderer in-flight lock and
any error explicitly enters page teardown. Terminal ready flush uses three render passes because
GPU view-demand feedback is one frame delayed: the first seeds
current-view feedback, the second requests and awaits that view's fine pages, and the third draws
after those pages have been published. All three passes reuse one immutable terminal view capture,
so MapLibre camera changes cannot rebind delayed feedback to a different view. Page disposal aborts
a concurrent terminal flush through
the common Lifetime stop signal, and active-state checks prevent another terminal phase from
starting after release begins.

The managed headless Chrome proof uses the complete schema-two COG collection, seeks from the
initial pair to model time 10.5, requests z10 pages for `t10` and `t11`, renders non-empty pixels,
drains Worker and native-submission activity to zero, and disposes renderer, window, WorkerSystem,
runtime, and map without cleanup failure. The proof also asserts the critical stop and release
subsequences rather than inferring safe ownership order from a zero-failure count.

The superseded schema-one frontend loader, numeric-time runtime source, fixed
current/next/prefetch owner, and its publication bookkeeping are removed rather than retained as
a second inactive API. The backend may still validate or explicitly serve historical pre-cut
artifacts, but the active browser has exactly one dataset and temporal ownership path.

## Consequences

- Runtime allocation follows timeline selections instead of render-frame counts.
- Exact samples, reverse seeks, gaps, and rapid seek storms have explicit outcomes.
- Stale asynchronous work cannot replace the current pair.
- Runtime ownership is bounded and observable even during overlap and disposal.
- This first version deliberately omits lookahead; it can be added later without changing ticket,
  capture, or lease identity.
- Camera-driven fine-LoD settlement is not part of `createReadyRuntime` admission and must not
  become model-clock readiness.
- Safety-ready construction, pair captures, and per-frame Virtual Raster acknowledgement now
  compose without moving Flow policy into Geo or Scratch.

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
