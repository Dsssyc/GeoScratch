# ADR-083: Generate a Standard WebMercatorQuad Cover from the View and Keep Virtual Raster Passive

## Status

Accepted. Supersedes the LoD-authority and root-forward traversal decisions in
ADR-061, ADR-063, ADR-064, ADR-066, ADR-076, ADR-078, and ADR-082. It preserves their
still-valid high-precision coordinate, local projected-error evidence, deterministic
output, 2:1 adjacency, mesh-stitching, indirect execution, diagnostics, and measured
browser-gate requirements.

## Date

2026-08-18

## Context

The terrain implementation accumulated two LoD authorities. A resident
`GpuTileFrontier` selected source pages and a separate `GpuRenderPatchFrontier`
selected geometry by traversing immutable safety-cover roots. Performance work made
the repeated traversal faster, but did not remove the duplicated model or satisfy the
earlier requirement that selection scale with a bounded visible set rather than a
world hierarchy.

Binding geometry directly to atlas residency is also incorrect. Raster pages may
arrive asynchronously, fall back to ancestors, or stop at a lower source ceiling,
while geometry can still require a finer standard patch. The cover and residency
therefore need explicit one-way composition rather than shared authority.

## Decision

Geo will provide one GPU-driven, camera-derived WebMercatorQuad cover. It computes a
conservative visible footprint, derives view-centered level bands, and directly
enumerates standard `tileMatrix/tileRow/tileCol` identities. Bands are snapped to the
fixed OGC matrix hierarchy; no camera-local tile grid is created. The result is
canonical, prefix-free, complete over visible source coverage, and balanced so edge
neighbors differ by at most one level.

The cover does not begin at z0, source roots, safety pages, or atlas slots. A bounded
final visibility test may reject directly generated candidates, but there is no
root-to-leaf DFS, repeated trial cut, or previous-topology authority.

The cover and a sampling-demand producer explicitly choose desired raster pages.
Virtual Raster consumes those demands and owns only request scheduling, cancellation,
retry, cache integration, residency, eviction, publication, page-table/atlas state,
exact/ancestor resolution, generation safety, and diagnostics. It does not compute
view LoD or change requested semantic precision.

Geometry level, desired sample level, resolved sample level, and source level ceiling
remain separate facts throughout feedback and diagnostics.

## Consequences

- Every externally meaningful tile remains interoperable OGC WebMercatorQuad data.
- Selection work follows the bounded candidate/output cover instead of rejected tree
  ancestors and 17 complete trial traversals.
- Equal current views produce equal geometry regardless of residency timing.
- A fine mesh can render immediately from a resident coarse ancestor and converge as
  finer raster pages arrive.
- Known source ceilings suppress impossible requests without coarsening geometry.
- `GpuTileFrontier` and `GpuRenderPatchFrontier` are removed after parity; 0.x retains
  no compatibility selector.
- Existing performance instrumentation remains, but reports inverse-cover candidate,
  output, balance, demand, and observation facts.

## Rejected Alternatives

### Continue optimizing root-forward traversal

Rejected because parallel traversal still evaluates a hierarchy that the view can
address directly and preserves a second geometry authority.

### Traverse physical atlas slots to choose geometry

Rejected because residency is delayed availability and may contain overlapping
parent/child transition pages. It cannot define a stable geometry cut.

### Use a moving geometry-clipmap grid as tile identity

Rejected because a camera-local grid does not satisfy WebMercatorQuad matrix, row,
column, cache, request, or cross-application interoperability contracts. Only the
view-centered level-band idea is retained.

### Let Virtual Raster choose a lower LoD when exact data is absent

Rejected because fallback changes current resolution, not desired precision. The
requested and resolved identities must remain independently observable.
