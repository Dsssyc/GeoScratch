# ADR-032: Attribute Fallible GPU Allocation Operations

## Status

Accepted

## Date

2026-07-11

## Context

`GPUDevice.createBuffer()` and `GPUDevice.createTexture()` return JavaScript
handles synchronously, but WebGPU performs object validation and allocation on
the device timeline. A returned handle can therefore represent an invalid
internal object. `try/catch` observes a synchronous JavaScript exception; it
does not confirm device-timeline validation or allocation success.

Scratch previously installed initial buffer and texture handles immediately.
`TextureResource.resize()` likewise swapped its current allocation as soon as
`createTexture()` returned. Those APIs could consequently report a resource as
installed before WebGPU had acknowledged its validation and out-of-memory
scopes.

WebGPU error scopes are a device stack. Errors belong to the topmost matching
scope, each scope captures at most its first matching error, and `popErrorScope`
settles asynchronously. Keeping a Scratch scope open across an `await` would
allow unrelated application or Scratch operations to enter that scope. Exact
operation attribution therefore depends on a synchronous issue boundary, not
on waiting synchronously for a result.

Long-running rendering and compute runtimes also cannot retain a complete log
of every operation. Current resource facts, compact recent history, failure
evidence, and temporary deep investigation have different ownership and
retention requirements. Combining them in one growing ledger would make
diagnostics consume memory in proportion to runtime age and would make causal
inspection less useful over time.

## Decision

### Promise-returning allocation API

Public persistent buffer and texture allocation is asynchronous:

```ts
const buffer = await runtime.createBuffer(descriptor)
const texture = await runtime.createTexture(descriptor)
await texture.resize(nextSize)
```

`ScratchRuntime.buffer()` and `ScratchRuntime.texture()` are aliases of the
same Promise-returning runtime paths. Direct construction cannot allocate a
native object, and the resource classes do not expose an alternative static
synchronous factory. No synchronous alias, async flag, thenable allocation
object, compatibility overload, or duplicate resource type remains.

An ordinary Promise expresses the factual boundary: the returned resource is
usable only after the matching error scopes have settled successfully. Runtime
operation records are inspectable evidence, not a second resource-control API.

### Exact synchronous issue boundary

Every covered allocation attempt performs this sequence without an intervening
`await`:

1. push an `out-of-memory` scope;
2. push a `validation` scope;
3. issue exactly one native `createBuffer()` or `createTexture()` call;
4. pop the validation scope;
5. pop the out-of-memory scope;
6. retain both returned promises;
7. only then await settlement.

A synchronous native exception is retained while both scopes are popped. A
scope-pop rejection is a structural `SCRATCH_GPU_ERROR_SCOPE_FAILED` incident.
The implementation classifies a non-null validation-scope result as validation
and a non-null OOM-scope result as out-of-memory; it never parses native error
messages. If both scopes unexpectedly report errors, Scratch reports ambiguous
scope evidence rather than selecting a fabricated primary cause.

Because push, issue, and both pops are one uninterrupted JavaScript turn,
concurrent Scratch calls cannot capture one another. An application-owned outer
scope remains outermost before and after the Scratch operation. Raw operations
issued through `runtime.device` outside this boundary retain native semantics
and are not claimed as exactly attributed by Scratch.

### Transactional initial creation

Descriptor normalization and deterministic validation happen before the native
call. Scratch allocates operation and candidate resource IDs and records a
pending fact, but it does not create or register a live logical resource.

After both scopes settle successfully, Scratch constructs and registers the
resource with `allocationVersion = 1`, `contentEpoch = 0`, and `state = empty`.
On validation, OOM, scope, synchronous, disposal, or device-loss failure, the
candidate handle is destroyed when meaningful, the pending fact is removed,
and the Promise rejects with a `ScratchDiagnosticError` linked to a frozen
incident. A failed candidate never contributes to the current live resource
count or live logical footprint.

### Transactional texture replacement

A changed `TextureResource.resize()` records one pending replacement while the
old allocation remains current. Current descriptor, size, cached views,
versions, content epoch, and readiness continue to describe the old allocation.
Submission encoding does not wait for the replacement.

After scoped success, replacement commits in this order:

1. install the candidate texture and descriptor;
2. clear allocation-scoped views;
3. advance `allocationVersion` exactly once;
4. preserve `contentEpoch`;
5. set state to `empty`;
6. update current logical-footprint facts;
7. destroy the old texture.

Failure destroys only the candidate and leaves every old allocation fact
unchanged. A second changed resize while one is pending rejects with
`SCRATCH_TEXTURE_REPLACEMENT_PENDING`. A normalized same-size resize returns a
resolved Promise without an operation record, error scopes, or allocation.
Disposal can invalidate a pending transaction; it never makes the candidate
public. Device loss invalidates the whole device, so Scratch records loss and
does not describe this as a successful rollback to a usable old allocation.

### Four separate diagnostic retention models

Scratch uses four concepts rather than one ledger.

1. **Runtime Fact Graph** is always on. It retains current runtime lifecycle,
   live resources, installed allocation facts, pending covered operations,
   pending replacements, logical footprints, and links to latest allocation
   operations. Its size scales with current resources and pending work, not
   runtime age.
2. **Incident Flight Recorder** retains compact recent operation summaries and
   incidents in fixed-capacity rings with a shared serialized-evidence budget.
   Defaults are 256 operation records, 32 incidents, and 256 KiB of retained
   serialized evidence. Capacities are configurable and an operation capacity
   of zero disables successful-operation history without disabling current
   facts or failure incidents.
3. **Incident Report** freezes a bounded causal slice when a failure is
   observed. It contains IDs, subjects, descriptor summary, native category,
   serializable native facts, bounded recent operations, pressure evidence,
   completeness counters, and attribution confidence. Reports are deeply
   frozen and JSON-serializable.
4. **Deep Capture Session** is explicit and temporary. It can include call-site
   stacks, normalized descriptors, and larger operation detail. Every session
   has finite operation, duration, and evidence limits, stops at the first
   reached limit, and can be stopped explicitly. At most four sessions may be
   active per runtime. Capture is non-thenable and never waits for queue work.

The byte budget measures retained JSON evidence after deterministic
serialization. It is not an exact JavaScript heap measurement. Old records are
overwritten and overwrite/omission counts remain as fixed-size counters.
Successful default records contain no call stack, resource contents, shader
source, command payload, repeated full descriptors, mutable GPU handles, or
retained `SubmittedWork` objects.

### Read-only runtime diagnostics facade

`runtime.diagnostics` is a non-reassignable facade with these responsibilities:

```ts
runtime.diagnostics.snapshot()
runtime.diagnostics.operations(query?)
runtime.diagnostics.incidents(query?)
runtime.diagnostics.operation(operationId)
runtime.diagnostics.incident(incidentId)
runtime.diagnostics.capture(options)
```

Queries can select operation, resource, incident, kind, and sequence facts.
Every returned value is a detached, immutable, deterministic JSON value. The
facade exposes no runtime mutation and no `GPUDevice`, resource, buffer,
texture, command, pass, or submission handle.

The existing `off`, `warn`, and `throw` validation modes govern optional
finding disposition. They do not disable required allocation scopes, fact
maintenance, failure rejection, device-loss observation, or incident
retention.

### Attribution confidence and native events

Attribution uses four stable values:

- `exact-operation`: a matching covered Scratch scope identifies the operation;
- `enclosing-operation-family`: a family boundary is known but not one exact
  operation;
- `temporal-correlation`: bounded nearby Scratch facts exist but native
  evidence supplies no ownership link;
- `unknown`: no defensible Scratch link exists.

The runtime registers an `uncapturederror` listener when supported. It coexists
with application listeners, creates a bounded incident, does not write another
console message, and is removed on disposal. Such an event is at most temporal
correlation unless independent exact evidence exists.

The runtime also converts `device.lost` into a bounded incident containing loss
facts, pending covered operations, current resources, and recent summaries.
Pending operations do not prove causality, so device loss is temporal or
unknown. Scratch does not retry, recreate the runtime, replay submissions, or
claim that replacement rollback restored valid resources.

### OOM pressure evidence

An OOM scope identifies the operation where OOM became observable. It does not
prove that one candidate caused total memory pressure. The incident separates
`triggerOperation` from bounded `pressureContributors` and reports:

- candidate logical footprint;
- current and peak Scratch-owned logical footprint;
- current live counts by resource kind;
- a bounded largest-contributor set;
- bounded recent create/replace/dispose churn;
- overwritten or omitted evidence counts.

Buffer descriptor size is a logical byte footprint. Texture footprint is a
logical format-block, mip, layer, and sample calculation where the format
contract permits it. Neither value is physical VRAM, residency, driver padding,
compression, eviction, free memory, or process/system GPU memory. Browser,
driver, operating-system, other-tab, and other-process allocations are unknown.

### Native labels

Scratch preserves the user label as the logical label and supplies native
buffer/texture labels in the form `<user label> [scratch:<resource id>]`, or
`scratch:<resource id>` when no user label exists. Labels are advisory
correlation aids only. Scratch does not intern them globally, embed descriptors
or stacks, or parse them back into facts.

### Diagnostic codes and subjects

Allocation failures continue to use the `ScratchDiagnostic` envelope and add
explicit `GpuOperation` and `Incident` subjects. Stable codes include:

```text
SCRATCH_GPU_ALLOCATION_PENDING_CONFLICT
SCRATCH_BUFFER_ALLOCATION_VALIDATION_FAILED
SCRATCH_BUFFER_ALLOCATION_OUT_OF_MEMORY
SCRATCH_BUFFER_ALLOCATION_NATIVE_FAILED
SCRATCH_TEXTURE_ALLOCATION_VALIDATION_FAILED
SCRATCH_TEXTURE_ALLOCATION_OUT_OF_MEMORY
SCRATCH_TEXTURE_ALLOCATION_NATIVE_FAILED
SCRATCH_TEXTURE_REPLACEMENT_PENDING
SCRATCH_TEXTURE_REPLACEMENT_VALIDATION_FAILED
SCRATCH_TEXTURE_REPLACEMENT_OUT_OF_MEMORY
SCRATCH_TEXTURE_REPLACEMENT_NATIVE_FAILED
SCRATCH_GPU_ERROR_SCOPE_FAILED
SCRATCH_RUNTIME_UNCAPTURED_GPU_ERROR
SCRATCH_RUNTIME_DEVICE_LOST_DURING_GPU_OPERATION
SCRATCH_DIAGNOSTIC_CAPTURE_DEGRADED
SCRATCH_DIAGNOSTIC_CAPTURE_LIMIT_EXCEEDED
```

Dynamic IDs, labels, browser messages, and validation mode never enter codes.
The original native error may be the JavaScript `cause`; retained incident
facts contain only bounded serializable fields.

### Coverage boundary

Exact scoped attribution in this decision covers only public persistent
initial `BufferResource`, initial `TextureResource`, and
`TextureResource.resize()` allocation. Internal readback and command staging
buffers, samplers, query sets, bind groups, pipelines, command encoders,
command-buffer finalization, queue submissions/uploads, external-image upload,
mapping, and raw device calls remain inventoried future families.

The default command and submission hot paths gain no per-command recorder entry
or error scope. A future per-submission scope is benchmark-gated and must reuse
this operation/incident system rather than create another diagnostics channel.

## Alternatives Considered

### Keep synchronous public creation

Rejected. A synchronous return cannot represent asynchronous device-timeline
validation and OOM acknowledgement without overstating success.

### Return a thenable allocation operation

Rejected. It creates a second resource-control abstraction and preserves
ambiguous synchronous-looking code. Ordinary Promises are explicit and
composable.

### Keep a scope open until awaited

Rejected. Unrelated operations could enter the scope and corrupt attribution.

### Parse browser console or native error messages

Rejected. Message prose is implementation-defined, may be throttled, and is
not a stable machine contract.

### Retain one complete runtime ledger

Rejected. Retention would scale with runtime age, overwhelm developer and agent
inspection, and place logging cost on the submission path.

### Enable stacks by default

Rejected. Stack construction and retained strings are unnecessary for healthy
operations. Temporary capture provides them when requested.

### Treat the OOM trigger as the sole cause

Rejected. Scratch cannot observe all allocations or exact physical residency.

### Add per-submission scopes now

Rejected for this slice. It broadens attribution beyond allocation, changes a
hot path, and lacks measured browser/device-process cost evidence.

## Consequences

- Public buffer/texture allocation and texture replacement become breaking
  Promise-returning APIs during `0.x.x`.
- Logical resources are installed only after scoped native acknowledgement.
- Replacement preserves the previous allocation while a candidate is pending
  and commits once.
- Exact allocation incidents provide stable operation/resource IDs without
  claiming complete GPU-memory or device-loss causality.
- Current facts remain always available while historical evidence remains
  bounded.
- Applications and agents receive compact causal slices rather than raw logs.
- Native allocation scope settlement adds asynchronous latency; the measured
  cost and retained evidence are reported separately from queue completion.
- Deferred native operation families remain visible audit rows and future work,
  not implied coverage.
