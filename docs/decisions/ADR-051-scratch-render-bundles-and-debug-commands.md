# ADR-051: Add Scratch Render Bundles And Debug Commands

## Status

Proposed

## Date

2026-07-24

## Context

Scratch can submit ordinary render and compute commands but has no managed
equivalent for native `GPURenderBundleEncoder`, `GPURenderBundle`,
`executeBundles()`, or the debug command mixin. Raw device access therefore
remains the only path for valid static render-command reuse and encoder-native
debug groups.

Render bundles are not generic command buffers. They have a fixed render-pass
layout, admit a restricted command set, and clear render-pass state after
execution, including `executeBundles([])`. A persistent bundle also cannot
capture an attempt-local Surface or expired external texture as permanent
state.

## Decision Boundary

Phase 3 will complete this ADR with:

- native render-bundle encoder creation, command lowering, `finish()`, and
  render-pass execution;
- explicit bundle/pass layout compatibility;
- persistent realization only for persistent dependencies;
- explicit attempt-local realization or structured rejection for temporal
  dependencies, with no hidden rebuild;
- exact native state-clearing behavior after every bundle execution;
- immediate-data support where native render bundle commands allow it; and
- balanced push, pop, and marker commands on every native encoder family that
  supports the debug mixin.

Debug commands are executable Scratch commands with stable identity,
structured diagnostics, and bounded labels. They do not alter resource epochs
or create a logging ledger.

## Rejected Directions

- Replaying ordinary Draw commands instead of native bundles.
- Silent fallback re-encoding after a persistent bundle becomes stale.
- Capturing a Surface current texture or external frame as permanent bundle
  state.
- Ignoring `executeBundles()` state clearing.
- Treating debug markers as console logs or retained event history.

## Acceptance Evidence

The completed ADR requires native-call inventory, pass compatibility and
state-clearing tests, temporal dependency tests, immediate-data tests,
balanced-debug tests, bounded stress reuse, and a headed public-package
browser proof.
