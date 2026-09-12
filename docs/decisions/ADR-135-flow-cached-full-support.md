# ADR-135: Reuse Complete Source Support In Flow Presentation

## Status

Accepted. Extends the example-local cache consumption from ADR-118/123 to default
hard boundary A. Public Scratch/Geo APIs, source data, particle integration and
the A/B/C/D coverage semantics are unchanged.

## Context

The default hard presentation invokes a complete temporal velocity query for
every nonempty trail pixel. A captured Native frame contained about 1.35 million
eligible pixels, while fewer than 1,000 output alpha values differed from raw ink.
An independent repeated replay measured roughly 2.5 ms for that visible pass.
Unchanged alpha does not remove the need for a coverage proof; it motivates a
cheaper proof for the interior.

## Decision

Reuse the existing source-center cache's lossless owner support bits. A complete
known wet 2x2 footprint at both time endpoints proves A coverage exactly one:
ordinary advectable interpolation returns one, and temporal cancellation reaches
the existing stationary-support rule whose complete footprint also returns one.

The shader verifies source containment, requested level, threshold, cache lookup,
record bounds, owner membership and both samplers' edge-transition policy. Only
eight known supported source centers may take the early return. Unknown outer
halo distances are irrelevant to this full-support proof. Mixed, dry, missing,
fallback, capacity-omitted and incompatible cases use the unchanged full direct
coverage function. There is no cached-zero shortcut.

The history owner now builds/validates the existing pair cache for A as well as
C/D. The cache still borrows sources and snapshots, uses exact endpoint runtime,
publication and allocation identities, and requires observed producer versions
before reuse. A first dependent draw follows its build in the same submission.
The existing buffers, endpoint reuse and budgets are unchanged. B keeps its
direct sampling path. No extra texture, per-frame readback or backend plane is
introduced.

Raw history, separately clipped visible history and retained presentation keep
their existing lifetimes. This optimization cannot erase raw ink or interpret a
cache miss as a dry source. Current source/time semantics are preserved instead
of dropping visibility checks or lowering resolution.

## Verification

The native source-center proof compares cached A with the complete direct A
function across the existing source boundaries, page seams, missing endpoints,
coarse fallback, temporal reversals, cancellation and cache mismatch cases. It
also requires actual full-support hits, not an always-direct implementation.
Existing C/D and packed-record comparisons remain applicable. Actual-page quality,
retained history, cache coherence, visual-time and camera-continuity gates verify
the integration. Performance is measured separately with fixed-input replay and
native secondary-display playback; pass timings are not added into a frame cost.

The expanded native fixture covers 19 source states, 250 display cases and 142,750
positions with zero cached/direct coverage difference, including exact/just-below
kill and failed pages. A captured 3520x1760 real metadata-bound frame replays
byte-identically through cached and direct A. Twelve interleaved samples measured
0.949 ms cached versus 2.390 ms direct for that visible pass on Apple Metal 3.
This is an isolated pass result, not a whole-page FPS ratio. See
`tests/browser/flow-field-coverage-replay.mjs` for frozen inputs, output hashes and
unchanged frame/publication facts before and after timing.

Reverting this commit restores direct A presentation without data migration or
changes to frozen Flow Layer.
