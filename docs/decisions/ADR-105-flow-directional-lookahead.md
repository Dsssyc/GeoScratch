# ADR-105: Bounded Directional Flow Lookahead

## Status

Accepted for Flow Field. Extends ADR-097 without restoring a fixed temporal ring.
Scratch, Geo, the frozen Flow Layer, source format and aggregate budgets are unchanged.

## Date

2026-09-06

## Context

Fixed-camera playback at 0.2 model units/s paused about every five seconds. Five
observed transitions stopped particles for 0.47–0.52 seconds. Individual requests
completed in milliseconds, but the next sample's 42 detail pages started only
after the new pair was selected and took about 0.37–0.39 seconds as a batch.
There was no corresponding main-thread long task or camera change. The correct
presentation readiness gate exposed late preparation rather than lost tiles.

## Decision

The existing temporal window remains the sole runtime owner. It may additionally
hold one optional sample selected by the application in playback direction.
Prefetch does not change requested model time, selection revision, active pair or
presented time. It uses the same safety-ready factory, capture leases, cancellation,
late-completion cleanup and hard four-runtime budget as foreground work.

An immutable prefetch capture borrows the optional runtime through GPU observation.
Current-view demand is mapped into that runtime's own standard page identities with
background prefetch intent. Its pending publications are uploaded and acknowledged
through the renderer's existing submission/observation path before activation; no
second Surface, scheduler, decoded-data cache or boundary plane is introduced.

Already-owned endpoints can be promoted synchronously. A foreground selection joins
a matching pending factory rather than creating a duplicate. Unrelated speculative
work yields capacity; captured or disposing runtimes continue to count. Returning
to the old pair after a changed prefetch intent must retire any abandoned joined
holder before another holder is installed.

Ordinary prefetch failures do not fail current playback or retry every frame. A
failed speculative runtime is excluded from reuse and retired capture-safely; later
foreground demand may create a fresh runtime. Cleanup failure and unresponsive
factories remain fatal. Once a runtime is active, its errors are active errors and
must not be suppressed as speculative failures.

The application selects the sample after the current upper endpoint for forward
playback, or before the lower endpoint for reverse playback. Exact selections use
their next directional neighbor. Pause disables speculation; declared gaps are not
interpolated or silently crossed by lookahead. Looping may warm one destination
sample but does not fabricate last-to-first interpolation. A discontinuous wrap,
seek, changed view, very high rate or slow source can still require the retained
loading path. Readiness is never bypassed to hide insufficient preparation.

## Verification

Window tests cover foreground identity, synchronous promotion, exact contractions,
pending joins, changed intent, rejection, cancellation, captured retirement, shared
capacity, fatal failure and zero-runtime disposal. Pure selection tests cover
direction, pause, gaps, loop destinations and singleton axes. View warming and
browser cadence are verified separately from safety-only factory readiness.
