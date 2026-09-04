# ADR-096: Flow Model-Time Authority

## Status

Accepted and implemented as an additive `Flow Field` timeline. The current renderer remains on
its historical frame-count clock until the selection-driven runtime-window migration is complete.
This decision does not change the frozen `Flow Layer` example or public Geo/Scratch APIs.

## Date

2026-09-04

## Context

The first `Flow Field` renderer advanced one source ordinal after a fixed number of completed
render frames. That couples model time to display refresh, GPU latency, page settlement, and
whether the map happens to request another frame. It also assumes dense source indices and
implicitly interpolates the final sample back to the first.

Runtime-manifest schema two instead provides numeric model time, stable sample keys, and an
explicit adjacency record. A selected collection may omit source samples, so two neighboring
manifest entries are not necessarily an interpolation interval. Runtime creation and safety-page
publication can also pause a visual selection; elapsed wall time during that pause must not be
replayed as a later model-time jump.

## Decision

`Flow Field` owns a CPU-only timeline independent of map, GPU, Worker, and raster lifetimes.
Every operation receives caller-origin monotonic wall time in milliseconds. Playback rate is a
non-zero signed number of model-time units per wall-clock second. Pause, seek, rate changes, loop
changes, and readiness updates re-anchor the wall clock explicitly; the timeline never reads a
hidden global clock.

The immutable timeline snapshot separates playback intent from admission:

- `playing` records whether the caller wants animation;
- `canAdvance` records whether readiness and the selected range permit time to move; and
- `needsTick` is exactly `playing && canAdvance`.

A blocked-to-ready transition establishes a new wall-time anchor without advancing model time.
Time spent waiting for a runtime pair is therefore never caught up after buffering.

Readiness is bound to a monotonic `selectionRevision`. A ready or blocked report for an older
revision is rejected atomically, so a late completion for a pre-seek selection cannot unlock the
new selection. Revisions advance when the resource support key changes: an exact sample, an
interpolated lower/upper pair, and a declared gap have distinct keys. Alpha changes inside the
same interpolated pair retain their revision and readiness; moving to another support key becomes
`selection-changed` until its runtime window is ready. A gap requires no runtime and is therefore
ready immediately under its new revision.

Time selection is a discriminated union:

- `exact` identifies one manifest sample;
- `interpolated` identifies an explicitly interpolable lower/upper pair and an alpha in `[0, 1]`;
  and
- `gap` identifies an omitted-source-sample interval and never produces an interpolation alpha.

A gap is data unavailability, not clock buffering. Forward and reverse playback may cross it so
later valid samples remain reachable, while the runtime window and renderer must not sample or
blend its endpoints. Clamp playback stops at the selected range boundary. Loop playback wraps
discontinuously and never creates a last-to-first interpolation pair. A single-sample axis is
exact and non-advancing.

All public results are immutable. Input validation and model-time arithmetic complete before any
timeline state changes; non-monotonic wall time, invalid readiness, zero/non-finite rate, and
finite-number overflow fail atomically.

Continuous playback computes movement from a stable model/wall anchor instead of repeatedly
adding a rounded per-frame delta. When a control or selection transition must re-anchor, the
timeline carries the finite residual lost by the last floating-point addition. This prevents
sub-ULP steps from disappearing forever at large but valid model-time magnitudes. Every adjacent
sample interval and the complete axis span must also be finite, not merely their endpoints.

## Consequences

- Model-time speed is independent of display frame rate and GPU completion latency.
- Buffering can pause model time without introducing a recovery jump.
- Stale readiness cannot cross a seek or support-pair transition.
- Small repeated time steps remain cumulative even when one step is below the current model-time
  ULP.
- Subset collections preserve honest temporal gaps while remaining traversable.
- Reverse playback and loop behavior use the same explicit authority as forward playback.
- Runtime-window readiness remains a separate composition concern; camera-driven fine-LoD page
  settlement must not become clock authority.
- The old `framesPerTime` path remains temporarily reachable only until the runtime-window clean
  cut, at which point it will be removed rather than retained as a second clock.

## Alternatives Rejected

- Advance by completed render-frame count: rejected because display throughput is not model time.
- Use `Date.now()` or `performance.now()` inside the timeline: rejected because it hides clock
  ownership and makes deterministic testing and re-anchoring ambiguous.
- Treat every adjacent manifest entry as interpolable: rejected because subset collections can
  omit source samples.
- Freeze the clock inside a declared gap: rejected because later published samples would become
  unreachable without an unrelated manual seek.
- Interpolate the last sample to the first in loop mode: rejected because no such adjacency is
  declared by the dataset.

## References

- [ADR-095: Bounded Flow Runtime Dataset Manifest](./ADR-095-bounded-flow-runtime-manifest.md)
