# ADR-123: Reuse Unchanged Flow Center-Cache Endpoints

## Status

Accepted. Example-local source-center cache optimization. Network payloads,
distance reconstruction, source residency and public Scratch/Geo APIs are unchanged.

## Date

2026-09-08

## Context

The source-center cache packs the lower and upper time endpoint into one u32 per
center. Changing either endpoint previously rebuilt both. Ordinary time movement
from t0/t1 to t1/t2 therefore reread t1 even when its source publication and the
selected spatial plan were unchanged. Three controlled 30-page time transitions
measured cache builds with mean 7.47 ms and median 6.42 ms before this phase.

## Decision

Retain endpoint provenance from the last successfully observed build. Reuse only
when the exact spatial plan/level matches and an endpoint has the same runtime
object, publication epoch and page-table/atlas allocation identities as one of the
previous endpoints. Retained output content/allocation versions must also match.
Whole-key reuse checks the owned cache configuration, lookup and records rather
than trusting a CPU key after their contents were changed.

Use the existing fourth u32 of each build job. Each endpoint has a two-bit selector:
zero rebuilds it, one copies the old lower byte, two copies the old upper byte.
The config remains 16 bytes and each center remains one packed u32. No texture,
readback, network channel or new per-particle storage is added.

Each compute invocation reads only its own previous packed record, selects the
reusable byte(s), and writes that complete record once. Job slots are unique;
there is no inter-invocation swap dependency. A wanted mask suppresses source
loads for reused endpoints. Copying both endpoints needs no U/V sampling.
For a copying build, the records read declares the previously observed exact
content epoch, not `current-at-step`. Scratch can therefore reject a write queued
between selection and execution instead of letting the new build legitimize
clobbered bytes. Fresh reconstruction does not need this old-content dependency.

An endpoint epoch covers its complete source publication, including owner and
neighbor/halo residency. Any change to that endpoint rebuilds it conservatively;
the other unchanged endpoint can still be reused. Plan or level changes require
a complete rebuild. This does not introduce per-page/halo dependency tracking.

Starting a new build revokes the preceding committed key before records can be
overwritten. Only observed successful work establishes the new complete target
pair and output versions. Failed, abandoned or externally modified output cannot
be used as partial-build input. Exact-time endpoint aliases and forward/reverse
time movement follow the same identity matching rather than separate timing modes.

## Verification And Rollback

Node tests cover endpoint matching, aliases, epochs/allocations, output tampering,
plan changes, receipt rejection and disposal. Native proofs compare complete packed
records with forced full reconstruction, including unknown owner/halo flags, and
verify that reused endpoints have zero source loads. Timing kernels omit diagnostic
counters. Real time-transition and steady-state benchmarks remain distinct; UI
seek settling includes source I/O and warm-up frames and is not cache-kernel time.
See the [benchmark record](../review/flow-pipeline-optimization-benchmarks.md).

This phase follows `2f3f65f`, is committed independently of upload scheduling,
and can be reverted without migrating backend data. The full reconstruction path
remains the reference whenever an endpoint cannot prove reuse.
