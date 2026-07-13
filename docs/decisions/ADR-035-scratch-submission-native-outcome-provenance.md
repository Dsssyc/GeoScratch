# ADR-035: Observe Submission Native Outcomes And Preserve Content Truth

## Status

Accepted

## Date

2026-07-13

## Context

Scratch validates ownership, readiness, resource epochs, ranges, pass
compatibility, and queue capabilities before a submission touches WebGPU. It
then synchronously encodes command-buffer segments and replays queue actions in
the exact order declared by `SubmissionBuilder.steps`.

That preflight cannot acknowledge the WebGPU device timeline. Calls such as
`createCommandEncoder()`, pass and command encoding, `finish()`, queue writes,
`copyExternalImageToTexture()`, and `queue.submit()` return on the content
timeline while validation and internal work may report errors later. An invalid
object may also remain apparently usable until it contaminates a later encoder,
command buffer, or queue submission.

The runtime currently records broad `uncapturederror` incidents and wraps
`queue.onSubmittedWorkDone()` rejection. Neither boundary identifies the
Scratch submission attempt that enclosed an error. `SubmittedWork.report`
contains synchronous preflight diagnostics only, and `SubmittedWork.done`
observes queue completion only.

Logical effects are committed optimistically as physical queue actions are
replayed. If a delayed native error later proves that work invalid, rolling an
epoch backward would rewrite published history, while leaving the resource
`ready` would assert content Scratch can no longer prove. A separate current
content state is required.

ADR-032 established an always-current fact graph, bounded recorder, immutable
incidents, and finite deep capture. ADR-033 applied scoped acknowledgement to
pipelines, and ADR-034 applied it to readback staging and mapping. Submission
observation must reuse that model without putting permanent per-command scope
churn on the frame hot path.

## Decision

### Submission remains synchronous

`SubmissionBuilder.submit()` remains a synchronous non-thenable operation. It
resolves and validates the complete plan, creates command-buffer segments, and
physically replays queue actions before returning one `SubmittedWork`. Native
observation never moves queue calls to a microtask, conditionally awaits an
error scope, retries an action, or changes segmentation/order.

Every scope pushed by Scratch is popped in reverse order before `submit()`
returns or throws. Pop Promises are retained and internally observed
immediately. A synchronous native exception still propagates through the
existing structured throw boundary after scope ownership is balanced; any
later scope outcome is retained by runtime diagnostics even though no
`SubmittedWork` was returned.

Application-owned outer error scopes remain composable. Scratch opens only
balanced inner scopes and never clears, drains, or pairs an outer scope.

### Observation policy

Runtime diagnostics accepts `submissionScopes: 'summary' | 'off'` and a finite
positive `maxPendingNativeObservations`. `summary` is the default and the budget
defaults to 64.

One effectful summary submission reserves one bounded observation owner and
opens exactly one constant-size OOM/internal/validation scope bundle around all
Scratch-owned encoding and queue replay for that attempt. Scope count does not
depend on command, pass, segment, or queue-action count. A summary failure has
enclosing-submission-family attribution; its issued-location index narrows
investigation but does not fabricate a unique failing command.

`off` opens no submission error scope. Its public native outcome says
`unobserved`; successful queue completion is not presented as validation
acknowledgement. Effect-free work opens no scope and returns `no-native-work`.

Observation reservation occurs after complete Scratch preflight but before
encoder or queue side effects. Budget exhaustion fails synchronously with
`SCRATCH_SUBMISSION_NATIVE_OBSERVATION_BUDGET_EXCEEDED`; it never silently
degrades summary to off and never accumulates unbounded pop Promises.

### Finite detailed capture

`ScratchRuntime.diagnostics.capture()` accepts
`nativeSubmissionDetail: 'step'`. A capture requesting it instruments encoder
creation/finalization, pass begin/end, standalone/pass commands, and queue
actions with separate balanced scope bundles.

Detailed mode is not a persistent runtime option. It remains bounded by the
capture's operation, duration, evidence-byte, and explicit-stop rules. The
instrumentation plan is snapshotted at submission-attempt start and remains
fixed through the synchronous issue transaction. Multiple active captures
share one detailed plan rather than multiplying native calls.

Detailed attribution is exact to the scope location, not necessarily to one
native call inside that location. Each WebGPU scope/filter reports at most its
first captured error. Scratch never claims that a successful scope proves the
absence of errors outside its issue interval.

### Native stages and locations

Native outcomes distinguish `encoder-create`, `pass-begin`, `command-encode`,
`pass-end`, `encoder-finish`, `queue-action`, `queue-submit`,
`scope-settlement`, `queue-completion`, and `lifecycle-recheck`.

Queue actions distinguish command-buffer submission, buffer upload, texture
upload, and external-image upload. Location is a discriminated union for
submission, encoder segment, pass, standalone command, pass command, or queue
action. Each variant carries only the IDs and indices that define it. It never
retains command payloads, WGSL, upload data, mapped bytes, native handles, or a
mutable builder.

Synchronous exceptions, validation, internal, OOM, scope settlement, queue
completion, lifecycle, and device loss remain independent outcomes. Primary
diagnostic selection uses fixed stage and issue order after all applicable
outcomes settle. Promise settlement order and native message prose never select
a stable code or cause.

### SubmittedWork native outcome

`SubmittedWork.nativeOutcome` is a Promise that always resolves to a deeply
frozen serializable result. Its status is `no-native-work`,
`observed-succeeded`, `observed-failed`, `unobserved`, or
`observation-failed`. It never rejects away simultaneous evidence.

`SubmittedWork.report` remains the immutable synchronous preflight report and
is not mutated after exposure. `SubmittedWork.done` joins queue completion and
native observation. It rejects with one structured submission diagnostic if
either boundary proves failure or observation cannot settle; the complete
native outcome remains separately inspectable. `done` does not wait for
readback mapping, mapped-range access, host copy, retained results, or mapped
leases.

Queue-completion rejection remains enclosing-family evidence. It cannot by
itself identify one command or overwrite an independently successful readback
mapping outcome. Scratch internally observes the rejecting `done` branch so an
ignored Promise does not produce an unhandled rejection; awaiting it still
receives the structured failure.

All `SubmittedWork` identity, reports, ledgers, links, native outcome, and done
Promise move to ECMAScript-private backing state exposed through getter-only
properties. Direct and subclass construction are closed with a package-private
token. `SubmissionBuilder.submit()` remains the only construction path; the
class stays public for typing and `instanceof`.

### Content indeterminacy

Persistent resources and query slots gain an `indeterminate` readiness state.
It means the allocation or slot still exists but Scratch cannot prove that its
current contents match the logical epoch published by a failed submission.

Submission planning snapshots every persistent potential write and its produced
epoch. When native observation fails, observation settlement fails, or queue
completion rejects, all still-current potential writes from that submission
become indeterminate. Detailed attribution improves diagnosis but does not
attempt partial automatic recovery: later work may depend on an earlier failed
write, and the device timeline does not expose a complete causal graph.

The epoch is not decremented. Historical resource accesses, producer epochs,
execution outcomes, and native outcomes remain unchanged. A delayed failure
changes current readiness only when the target still has the epoch produced by
the failed submission. If a later acknowledged producer already advanced it,
the delayed failure cannot poison the newer content.

Indeterminate content is unexpected failure, not normal streaming absence.
Every resource/query read rejects before native effects in every validation and
readiness mode. `warn`, `off`, `skip-command`, `skip-pass`, and `use-fallback`
do not consume or hide it. A later explicit upload, copy, render, compute,
clear, or resolve producer advances a new epoch and restores ready state at the
current whole-resource/whole-slot granularity.

Surface current textures are ephemeral presentation targets and are not
retained as persistent indeterminate facts.

### Readback interaction

Direct readback uses the same summary/off/capture policy and pending-observation
budget around encoder creation, copy encoding, finish, and queue submit. Its
target remains the readback operation. Copy issue and mapping are independent;
host bytes are returned only after both applicable outcomes are observed.

Ordered readback observes its associated submission native outcome before
exposing bytes. An observed failure enclosing its staging-copy family makes the
bytes untrusted. With scopes explicitly off, mapping may still complete but the
provenance says copy validation was unobserved.

Queue-completion rejection alone does not fabricate mapping failure. If mapping
independently produced owned bytes, both the successful mapping facts and the
enclosing completion incident remain.

### Schema version 4

Operation records, incidents, snapshots, captures, queries, and exported
evidence advance together to version 4. Version 3 output and compatibility
conversion are not retained during `0.x.x`.

`ScratchGpuOperationTarget` adds `{ kind: 'submission'; submissionId: string }`.
Submission attempts use `submission-native-observation` operations and
`submission-failure` incidents. Direct readback copy issue remains a readback
target and readback-failure family. Queries accept submission ID, native stage,
location kind, and outcome status without weakening existing filters.

The current fact graph reports policy, budget, current/peak pending native
observations, and current effectful submitted work. These facts scale with
unsettled ownership, not runtime age. Capacity zero disables successful history
only, not current facts, scopes, failures, budget enforcement, or cleanup.

Native messages are bounded supporting evidence. OOM proves that a scope owned
by the submission family captured an error; it does not prove one command or
resource alone exhausted physical memory.

## Alternatives Considered

### Make submit asynchronous

Rejected. It would add an await boundary to every frame, change physical queue
issue timing, and make the public model depend on instrumentation.

### Always use per-command scopes

Rejected. Permanent O(N) scope and Promise churn contradicts the bounded ledger
design. Per-stage scopes exist only in finite capture.

### Use uncapturederror plus recent history only

Rejected. It is useful temporal evidence but cannot hermetically identify the
Scratch issue interval and may not be emitted for every error.

### Resolve done successfully and expose errors only in diagnostics

Rejected. A caller awaiting work would receive false success while Scratch
already knows the submission failed.

### Roll content epochs back after delayed failure

Rejected. Later submissions may already have consumed or advanced them.
Retroactive rollback would rewrite history and corrupt current facts.

### Keep failed content ready

Rejected. Scratch would assert bytes, texels, or query values native execution
did not confirm. Indeterminate is the honest current-state result.

### Add mapped leases or persistent supporting-object acknowledgement now

Rejected for this Goal. Mapped leases are a separate host-ownership API.
Sampler, query-set, bind-layout, and independent bind-group acknowledgement have
different persistent lifecycles. Lazy bind-group creation inside command
encoding may be enclosed by command observation but is not independently
acknowledged by this decision.

## Consequences

- Default effectful submissions pay constant-size asynchronous observation
  overhead; off mode remains explicit and honest.
- Detailed attribution is available for bounded reproduction windows without
  becoming a permanent runtime log.
- `SubmittedWork.done` becomes a stronger success boundary while preserving
  synchronous submission and readback independence.
- Delayed errors can make current content unusable until an explicit known
  producer restores it; epochs and historical reports remain monotonic.
- Schema version 4 represents submissions directly rather than fabricating
  resource or readback fields.
- Texture readback, mapped leases, persistent supporting-object provenance, raw
  device tracking, tracked dynamic values, render graphs, and legacy example
  migration remain explicit future work.
