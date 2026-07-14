# ADR-039: Scratch Exclusive Surface Context Ownership

## Status

Accepted

## Date

2026-07-14

## Context

`GPUCanvasContext.configure()` replaces the active presentation configuration for
the context. Current WebGPU exposes that configuration synchronously through
`GPUCanvasContext.getConfiguration()`, but the query neither establishes which
Scratch object owns the context nor prevents another wrapper from mutating it. If
Scratch permits two live `Surface` wrappers for one context, each wrapper can retain
a different format, size, runtime, and disposal state even though only the last
native configuration is real. Submission preflight would then reason from stale
logical facts or defer the conflict to asynchronous native validation after
current-texture and encoder effects.

This contradicts the Scratch ownership model: a `Surface` owns its presentation
context and supplies the stable configuration facts used before submission effects.

## Decision

Each `GPUCanvasContext` has exactly one live Scratch `Surface` owner.

- Surface construction claims the context before canvas-size mutation,
  `GPUCanvasContext.configure()`, or runtime registration.
- A second claim from the same or a different `ScratchRuntime` fails with the
  structured `SCRATCH_SURFACE_CONTEXT_IN_USE` diagnostic. The diagnostic relates
  the attempted Surface, owning Surface, and relevant runtime identities.
- Every Surface operation verifies that its receiver is the exact claim owner.
  Forged or stale aliases fail with `SCRATCH_SURFACE_CONTEXT_NOT_OWNED` before
  canvas, context, current-texture, or encoder effects.
- Surface ownership, configuration, and lifecycle fields are read-only public
  observations backed by one module-private state record for the exact receiver.
  Ordinary untyped JavaScript field writes cannot transfer ownership, publish candidate
  configuration, make a live owner appear replaceable, or suppress cleanup. Disposal
  uses only that private state to unregister from the original runtime, unconfigure the
  original context, and release the original claim.
- `Surface.configure()` snapshots and validates the complete exposed native candidate:
  device, format, usage, view formats, color space, optional tone mapping, alpha mode,
  and canvas size. Iterable/dictionary inputs are materialized before native issue.
  After materialization, Scratch rechecks exact context ownership, runtime lifecycle,
  and the entry configuration version; reentrant disposal or reconfiguration therefore
  fails before canvas or native configuration effects. It then resizes the canvas,
  calls native configure, and requires `getConfiguration()` and the canvas dimensions
  to reflect the candidate before committing private state. Observation failure
  produces `SCRATCH_SURFACE_CONFIGURATION_FAILED`, restores the actual pre-call canvas
  dimensions and previous native configuration when possible, verifies both through
  readback, and never publishes the candidate facts.
- Before a configured Surface is used, Scratch calls `getConfiguration()` and compares
  current device, format, usage, view formats, color space, tone mapping, alpha mode,
  and canvas size with the private committed state. External configure, unconfigure,
  or resize drift fails with `SCRATCH_SURFACE_CONFIGURATION_STALE` before presentation
  effects.
- After submission validation and before creating any command encoder, Scratch prepares
  one immutable attachment lease for every executable Surface. The lease records exact
  receiver identity, format, and configuration version. Later `attachment-view` issue
  borrows the current texture and creates the requested native view without a second
  configuration query or a public-method branding path.
- `GPUCanvasContext.configure()` synchronously forbids usage containing
  `TRANSIENT_ATTACHMENT`. Surface normalization therefore rejects that bit with
  `SCRATCH_SURFACE_CONFIGURATION_FAILED` before canvas resize or native configure.
  Ordinary `TextureResource` attachments retain the native transient texture/view and
  clear/discard contracts; Surface does not fabricate a Canvas capability.
- Failed construction releases its uncommitted claim.
- Successful `Surface.dispose()` unconfigures the context, unregisters the Surface,
  and releases the claim. A replacement may then claim the context.
- Disposal completes logical unregister/release in `finally` even if a non-conforming
  native implementation throws from `unconfigure()`. The failure is retained as
  `SCRATCH_SURFACE_UNCONFIGURE_FAILED`; runtime disposal records it, continues all
  remaining cleanup, then rethrows the first retained failure.
- Submission retains a context-identity alias check as defense in depth before
  current-texture or encoder effects.

The claim registry is a module-private `WeakMap<GPUCanvasContext, Surface>`, paired
with a module-private `WeakMap<Surface, SurfaceState>` and a private weak map for
submission-scoped prepared attachment leases. None is a public matching service,
runtime reverse graph, observer, or historical log.

## Rejected Alternatives

### Multiple wrappers with shared mutable state

A canonical context record plus alias set and reference-counted disposal would make
configuration, labels, runtime ownership, and lifecycle implicitly shared between
otherwise independent Surface objects. That state machine has no demonstrated core
use case and makes disposal and cross-runtime ownership harder to reason about.

### `getConfiguration()` without ownership

The native query is necessary current-state evidence and Scratch uses it. By itself,
it cannot identify the owning logical Surface, stop a forged alias from configuring
or disposing the context, or make runtime cleanup exception-safe.

### Native validation only

Allowing the browser to report the conflict later loses precise Surface/runtime
attribution and may create current-texture or encoder effects first.

## Consequences

- Multi-canvas, offscreen, worker, and compute-only runtime workflows are unchanged.
- Replacing a Surface for one canvas requires explicit disposal of the prior owner.
- Same-context aliasing is a deterministic Scratch ownership error rather than a
  hidden last-configure-wins relationship.
- Surface ownership cannot be reassigned by writing public identity observations.
- Direct native context mutation is detected synchronously on the next managed
  Surface use and can be repaired explicitly with `Surface.configure()`.
- Native canvas usage, compatible view formats, color space, tone mapping, and alpha
  mode remain explicit Surface capabilities rather than being reduced to a fixed
  render-attachment-only descriptor.
- Reentrant option getters and iterators cannot make an obsolete configuration candidate
  authoritative, and a rollback is reported as restored only after exact native/canvas
  observations confirm it.
- Scratch still does not claim that synchronous Surface validation captures every
  asynchronous WebGPU validation, OOM, or device-loss outcome.
