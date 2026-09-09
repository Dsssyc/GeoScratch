# ADR-126: Validate and Resolve Cover Vertical Metadata by Ancestry

## Status

Accepted. Clarifies the immutable vertical hierarchy in ADR-083/086 without changing
standard tile identity, geometry ownership, or passive Virtual Raster.

## Date

2026-09-09

## Context

At `69c0a5e`, a complete hierarchy with a full z0 limit and a smaller z1 limit passed
validation. Geometry still covered all descendants of the minimum limit. A geometry
patch outside the z1 limit indexed unsigned offsets outside its declared metadata;
the CPU reference likewise dereferenced a missing record. Validation also allowed
child bounds outside their ancestor bounds, undermining conservative parent selection.
These defects predate the parallel candidate dispatch.

## Decision

Require exactly one immutable record for each declared tile, ordered by level, row,
and column. Validate count before enumerating records. Every record must lie inside
the global vertical range and its nearest declared ancestor, and every declared tile
must descend from the minimum geometry domain. Invalid metadata fails before GPU
resource allocation with a structured Geo diagnostic.

Resolve each geometry patch against its nearest declared ancestor, checking the
actual spatial limit before indexing. This applies both above the highest metadata
level and outside a smaller finer limit. Missing records inside a declared limit
remain invalid. CPU and GPU use the same containment contract; residency supplies no
bounds and does not participate in selection.

Native terrain validation confirmed that existing DEM source metadata describes
individual raster-level extrema, not ancestor envelopes (a z5 minimum near -1007 m
has a z6 descendant near -2646 m). Terrain therefore derives enclosing geometry
ranges by unioning immutable descendant ranges into their ancestors after applying
exaggeration. This conversion and hierarchy validation precede renderer allocation;
source metadata, backend data, Worker scheduling, and residency remain unchanged.

Cover and source-demand feedback decoders also use existing `GeoDiagnosticError`
envelopes with stable codes and reason fields, replacing prose-only native exceptions.
Successful empty results and failed-cover revocation retain their existing behavior.

## Alternatives and Consequences

Requiring every finer limit to cover all minimum-domain descendants would reject
legitimate local metadata and duplicate conservative ancestor records. Reading an
unchecked offset or accepting incomplete declared records is unsafe. Nearest-ancestor
resolution costs at most the declared level count, with a direct hit for ordinary
complete spatial hierarchies. It creates no new resource owner or public scheduler.

This decision does not fix the separate error of measuring only two endpoint heights
of a non-flat vertical interval. That continuous projection problem requires its own
mathematical bound and native regression proof.

## Verification and Rollback

Regression checks cover narrower finer limits, ancestor enclosure, huge missing
metadata rejection before allocation, structured feedback, and explicit 40/52-bit
candidate fixtures. Run the terrain gates and existing native outcome checks. Revert
this commit after later dependent fixes; no backend data migration is involved.
