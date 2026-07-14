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
  observations. The exact receiver also owns a module-private identity record captured
  at claim time and a private terminal-disposal fact. Ordinary untyped JavaScript field
  writes cannot transfer ownership, make a live owner appear replaceable, or suppress cleanup:
  managed use rejects public identity drift, while disposal still uses the private
  facts to unregister from the original runtime, unconfigure the original context,
  and release the original claim.
- `Surface.configure()` computes candidate format, alpha, and size facts without
  mutating committed state. It changes canvas size and issues native configure, then
  commits the candidate only after synchronous success. A synchronous failure is
  reported as `SCRATCH_SURFACE_CONFIGURATION_FAILED`, restores the prior canvas
  dimensions when possible, and leaves the prior logical/native configuration current.
- Before a configured Surface is used, Scratch calls `getConfiguration()` and compares
  current device, format, alpha mode, render-attachment usage, and canvas size with
  the logical owner. External configure, unconfigure, or resize drift fails with
  `SCRATCH_SURFACE_CONFIGURATION_STALE` before presentation effects.
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
with a module-private `WeakMap<Surface, SurfaceIdentity>` and terminal-disposal
`WeakSet<Surface>`. None is a public matching service, runtime reverse graph,
observer, or historical log.

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
- Scratch still does not claim that synchronous Surface validation captures every
  asynchronous WebGPU validation, OOM, or device-loss outcome.
