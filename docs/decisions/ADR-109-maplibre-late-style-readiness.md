# ADR-109: Recover Late MapLibre Style Readiness

## Status

Accepted. Extends ADR-085's driver-owned readiness gate without adding an application
wait or changing Flow Field's data, GPU pipelines or frame budget.

## Date

2026-09-06

## Evidence

The normal Flow Field route stayed at model time zero with no submitted frames even
though the v3 backend and raster requests succeeded. Its Map is created before the
asynchronous dataset/GPU initialization. By driver startup, the host's `style.load`
event could already have fired while `isStyleLoaded()` still returned false for
pending raster tiles. Listening only for the next style.load stranded the initial
frame. The source-free proof style did not exercise this interval.

## Decision

The Geo frame driver additionally listens for host `idle`. While running without
an owned layer, it rechecks `isStyleLoaded()`, checks for a conflicting layer and
uses the existing attachment/repaint path when ready. Normal startup still attaches
immediately through a true readiness snapshot or style.load. The recovery does not
become a universal full-map idle wait and does not invent a second readiness owner.

Idle is chosen over a general style-data callback because style-data may precede
style.load within the same style initialization. Attaching on that earlier callback
would collide with the existing strict style.load replacement checks. An idle event
after attachment is a no-op, so rendering cannot create an idle/repaint loop. Stop
removes all listeners, including recovery, and never removes a foreign layer.

## Verification

Unit tests reproduce the missed event before applying the fix, then cover deferred
latest-state delivery, repeated idle, stop-before-ready and foreign-layer preservation.
A normal-route browser test uses real MapLibre with delayed raster tiles and tests
both cold startup and reload. It must not use the source-free proof style.
