# ADR-139: Reuse Flow Candidate Geometry Across Camera Priority Changes

## Status

Accepted. Refines ADR-132's immutable prepared spawn input: equal page/cell geometry
keeps its identity during camera movement while source demand metadata stays current.
Scratch, Geo, source sampling, and the GPU cover algorithm are unchanged.

## Context

The old candidate cache included camera coordinates because reconciliation scores
depend on them. A drag therefore recreated the same large cell array, packed it
again and compared the resulting bytes in the spawn owner. In a 120-input Native
drag profile these three paths consumed about 73% of the renderer's CPU samples.
The stationary throughput and particle-continuity gates did not detect that cost.

## Decision

Separate source-page selection, immutable cell geometry, and current reconciliation
metadata. Each encode validates its current input and selects a complete bounded
page set with the existing halo, overflow, fallback and refinement rules. The one
previous geometry result is reusable only when the address-space object, cell grid
and ordered matrix/row/column identities match. Refined coarse-cell omissions are
fully determined by that page set and grid. A different owner, including one with
the same public id, cannot supply cached pages.

Camera priority, desired sample level, source ceiling and frame provenance are
freshly attached for each reconciliation. They are never restored from the geometry
cache. The former priority tie could not alter page selection: duplicate spatial
keys with equal desired/source levels derive the same score for a given camera.

Stable geometry preserves the candidate arrays, so the renderer retains its opaque
immutable packed spawn artifact. Mutable byte views still require content comparison.
No extra cache tier, resource, source request, weaker precision or raw-view identity
shortcut is introduced.

## Verification

Focused tests preserve priority/provenance on reuse and compare changed page sets,
equal-count replacements and mixed-level refined cells against the pure candidate
generator. They cover changed desired/source metadata, different address-space
owners, stale epochs, invalid demands and invalid overflow on a populated cache.
Native drag profiling verifies that redundant materialization, packing and comparison
leave the hot path. Camera waiting/presentation latency is a separate follow-up;
this decision alone does not claim synchronized map and overlay presentation.
