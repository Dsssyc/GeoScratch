# ADR-039: Scratch Exclusive Surface Context Ownership

## Status

Accepted

## Date

2026-07-14

## Context

`GPUCanvasContext.configure()` replaces the active presentation configuration for
the context. The native API does not expose a complete synchronous query for that
current configuration. If Scratch permits two live `Surface` wrappers for one
context, each wrapper can retain a different format, size, runtime, and disposal
state even though only the last native configuration is real. Submission preflight
would then reason from stale logical facts or defer the conflict to asynchronous
native validation after current-texture and encoder effects.

This contradicts the Scratch ownership model: a `Surface` owns its presentation
context and supplies the stable configuration facts used before submission effects.

## Decision

Each `GPUCanvasContext` has exactly one live Scratch `Surface` owner.

- Surface construction claims the context before canvas-size mutation,
  `GPUCanvasContext.configure()`, or runtime registration.
- A second claim from the same or a different `ScratchRuntime` fails with the
  structured `SCRATCH_SURFACE_CONTEXT_IN_USE` diagnostic. The diagnostic relates
  the attempted Surface, owning Surface, and relevant runtime identities.
- Failed construction releases its uncommitted claim.
- Successful `Surface.dispose()` unconfigures the context, unregisters the Surface,
  and releases the claim. A replacement may then claim the context.
- Submission retains a context-identity alias check as defense in depth before
  current-texture or encoder effects.

The claim registry is a module-private `WeakMap<GPUCanvasContext, Surface>`. It is
not a public matching service, runtime reverse graph, observer, or historical log.

## Rejected Alternatives

### Multiple wrappers with shared mutable state

A canonical context record plus alias set and reference-counted disposal would make
configuration, labels, runtime ownership, and lifecycle implicitly shared between
otherwise independent Surface objects. That state machine has no demonstrated core
use case and makes disposal and cross-runtime ownership harder to reason about.

### Submission-time configuration inference

WebGPU does not provide a complete reliable descriptor query from the borrowed
current presentation texture. Inference would be incomplete and would occur too
late to preserve Scratch's before-effect validation boundary.

### Native validation only

Allowing the browser to report the conflict later loses precise Surface/runtime
attribution and may create current-texture or encoder effects first.

## Consequences

- Multi-canvas, offscreen, worker, and compute-only runtime workflows are unchanged.
- Replacing a Surface for one canvas requires explicit disposal of the prior owner.
- Same-context aliasing is a deterministic Scratch ownership error rather than a
  hidden last-configure-wins relationship.
- Scratch still does not claim that synchronous Surface validation captures every
  asynchronous WebGPU validation, OOM, or device-loss outcome.
