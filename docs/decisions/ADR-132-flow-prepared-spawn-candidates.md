# ADR-132: Prepare Immutable Flow Spawn Candidates

## Status

Accepted

## Date

2026-09-11

## Context

Resident Flow Field playback on a 144 Hz display repeatedly compared 3.75 MiB of
packed spawn candidates. An isolated timer measured 2.86 ms mean per comparison.
The renderer already reuses candidate-cell identity for unchanged spatial demand,
but the spawn API accepts mutable ArrayBufferViews and must detect in-place edits.
Replacing its content check with raw object identity would violate that contract.

Flow Field still uses the GPU camera cover. The CPU production migration applies
to Underwater Terrain; stationary Flow cover builds were already reused.

## Decision

`prepareFlowSpawnCandidates()` creates an example-local, opaque preparation
artifact backed by a private copy of complete packed records. Callers can inspect
its byte length but cannot obtain or mutate its owned bytes. Forged or copied
descriptor objects are not admitted. The artifact is CPU data with ordinary
garbage-collected lifetime, not a GPU Resource or publication epoch.

The spawn index accepts either this artifact or the existing mutable view. A
successfully observed build may reuse the exact prepared identity without a
content scan when its temporal key, bind set and produced-resource versions also
match. An equal replacement artifact is compared once before its identity is
adopted. Raw views always retain content comparison, including in-place edits and
unaligned views. Failed, abandoned or obsolete builds cannot publish a prepared
identity ahead of GPU ownership.

The renderer prepares one artifact when its candidate-cell identity changes and
retains the existing packed bytes for the optional contour consumer. This adds
one bounded CPU copy per spatial candidate change, rather than per frame. Both
arrays are limited by the existing candidate capacity. `candidateComparisonCount`
reports actual content-comparison calls and can prove scan-free steady playback.

No public Scratch/Geo API, cover policy, candidate order, spawn predicate,
particle data, backend artifact, or single-frame admission rule changes.

## Verification

Tests cover copying ownership, source mutation, stable identity without scans,
equal replacement promotion, forged descriptors, resource epoch invalidation,
failed/unsubmitted native work, and the preceding mutable-input contract.
Native playback must retain one spatial build and unchanged candidate-comparison
count while alpha advances, then correctly rebuild after camera/time changes.

The current native 144 Hz steady-playback proof kept candidateComparisonCount at
zero across both DPR 1 and DPR 2 windows. Typecheck, build and 1,794 Node tests
passed (two existing opt-in browser gates pending). The original frame admission
and GPU costs remain, so eliminating this scan alone does not establish 144 FPS.
