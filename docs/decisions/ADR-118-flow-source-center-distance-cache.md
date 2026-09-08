# ADR-118: Cache Source-Center Flow Distances On The GPU

## Status

Accepted. Supersedes only ADR-117's direct-per-fragment execution and zero-cache
resource decision. C/D contour reconstruction, temporal interpolation, Feather,
particle sampling/death, and A/B semantics remain unchanged. A remains the default.
The direct C/D shader stays available as the miss path and verification reference.
This is example-local GPU caching, not a change to Scratch/Geo or source protocols.

## Date

2026-09-08

## Context

Recomputing four endpoint distance samples from up to 32 U/V texel loads for each
visible fragment repeats source-level work across many screen pixels. The endpoint
center distances do not depend on temporal interpolation alpha, the C/D kernel,
Feather, or camera projection. Cache those source-level results without introducing
a network boundary plane or a second decoded-payload stream.

## Decision

History owns one `FlowCenterCache` for the current endpoint pair and a bounded
selected source-page set. Each pair-page contains 257 by 257 packed u32 records,
including the next shared source-center row and column so one page lookup supplies
the four adjacent center records. Both endpoints occupy the same record.

Each endpoint byte encodes the sign, unknown-owner and unknown-halo flags, and
four times squared distance. The exact possible truncated center magnitudes are
.5, sqrt(.5), and 1.5 source texels, encoded as 1, 2, and 9. This is a lossless
code for this binary-support stencil, not a general float distance quantizer.
All source samples are read through the existing generated U/V samplers and their
source-bound/resolved-level checks.

The fragment path keeps the actual sampler's requested/common-level and transition
readiness proof. It reads four packed records, decodes both endpoint distances,
mixes by current alpha, and uses the unchanged C or D reconstruction and Feather.
The same-sign interior shortcuts remain valid even if an irrelevant outer halo is
unknown. A required unknown owner/halo uses the existing A display fallback.
Cache miss, lookup zero, capacity omission, or incompatible cache configuration
uses the original direct C/D path. A cache miss is not classified as a dry source.

## Page Planning And Budgets

The pure planner validates the 2D 256-texel page address space, requested level,
capacity, and every input page identity, including pages later excluded. It selects
only the requested level, sorts/deduplicates by canonical source table index and
keeps the first capacity pages. The plan key contains only that level and selected
indices. Lookup entries are slot plus one; zero means direct reconstruction. Job
records contain global tile column, tile row, destination slot and padding.
The planner changes cache coverage only, never source demand or residency budgets.

Capacity is 1 through 48 pair-pages. At 48, records occupy 12,681,408 bytes
(12.094 MiB), plus 4 times `pageTableEntryCount` bytes for lookup, 768 bytes for
jobs and 16 bytes for config. Buffer sizes remain fixed for that cache instance.
This explicitly adds local GPU storage and computation; C/D no longer claim zero
derived resources. There is no new network tile, CPU raster/decode, persistent
cache record, GPU readback, or backend channel.

## Invalidation And Submission Ownership

Reusable context consists of both endpoint runtime identities, both **current
publication snapshot epochs**, requested level and selected-page plan key, and
the source resources' identities/allocation versions. The activity-kill threshold
is immutable for the cache instance. Alpha, C/D selection, Feather and camera
matrices are excluded. A camera-induced page-set change still invalidates the plan.

Invalidation conservatively rebuilds the whole selected set. Any endpoint snapshot
epoch change can rebuild even if the changed source page is unrelated; there is no
per-page dirty tracking claim. Temporal interpolation-only updates reuse the same
endpoint distance records while independently evaluating current alpha.

The renderer encodes source Virtual Raster publication uploads first, then cache
uploads/build compute, then dependent presentation in the same submission. It
supplies snapshots from those publications, not a stale previously committed
snapshot. The cache borrows endpoint runtimes, snapshots and source resources;
history owns its buffers, bindings, shader, pipeline, commands and pass.

A new context is not reusable merely because work was encoded. For a nonempty
build, observation must contain that encoded build command and native submission
completion must succeed before publishing the reusable key. Failed or abandoned
builds invalidate the reusable CPU label. Empty plans upload lookup/config that
select direct sampling. Source uploads and cache construction precede every first
dependent draw; cached results are not adopted ahead of their queue dependency.

History observes the cache together with its owning submitted frame, retains the
existing single in-flight-frame discipline, and disposes cache resources on normal
shutdown or construction failure. C/D add a local compute pass only on rebuild,
not a new per-frame render pass or a new source request.

## Verification And Limits

Native checks measured maximum cached/direct coverage difference of zero and
validated 100,230 packed record samples. Keep the direct implementation as an
independent execution reference and retain source-zero, cancellation, shared
edges, unknown halo, time joins, cache reuse/invalidation and disposal gates.
The pure planner tests cover deterministic selection, duplicates, foreign-domain
rejection, nonzero tile origins, capacity truncation and all 48 job/lookup bounds.

This changes where repeated distance work runs, not the contour model or particle
time integration. Direct fallback can still be expensive, whole-set epoch changes
can still trigger rebuilds, and no frame-rate improvement is guaranteed solely by
the buffer budget. Wall-clock-normalized particle/trail cadence is not part of this
decision and has not been implemented by this slice.

## Rollback

Baseline `3ecd413` is retained by local branch
`socu/flow-before-cadence-3ecd413`. Commit this cache slice independently before
further cadence work; reverting its commit restores direct C/D execution without
changing source data or removing the reconstruction choices.
