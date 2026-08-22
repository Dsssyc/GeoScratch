# ADR-086: Use One Adaptive WebMercatorQuad Cover and Keep Feature Conformance Independent

## Status

Accepted. Supersedes the pitch-gated selection parts of ADR-083 and ADR-084 while
preserving their standard `WebMercatorQuad` identities, inverse-cover authority,
reference-pixel quality, passive Virtual Raster, deterministic output, 2:1 adjacency,
high-precision coordinates, and explicit diagnostics.

## Date

2026-08-22

## Context

The first inverse-cover implementation copied a historical MapLibre distinction into
Geo. Below a configurable pitch it selected one uniform matrix level over the complete
footprint; at and above that pitch it selected distance-varying levels. The default
boundary was 60 degrees.

MapLibre does not use 60 degrees to enable terrain. Its non-terrain path may retain one
zoom level below a pitch/FOV boundary, while terrain always permits variable zoom and
uses elevation-aware bounds. That distinction is entangled with its terrain source,
render-to-texture, and draping architecture. GeoScratch already owns explicit vertical
bounds, geometry selection, field residency, and GPU execution as separate facts, so a
hard algorithm switch is neither required nor desirable. It produces a topology cliff
for an otherwise continuous camera movement and leaks example policy into a public
geometry selector.

The cover also accumulated source and draw responsibilities. Its policy included a
raster source ceiling, its kernel emitted raster requests, and its output wrote a
terrain vertex count into draw-indirect arguments. Those facts are not properties of a
standard geometry cut.

Future vector features will conform to a rendered surface through a dedicated compute
preprocess stage. They will not be rasterized into terrain-tile textures. Feature
identity, source tiling, picking provenance, and invalidation must therefore remain
independent from terrain patch identity even when the preprocess stage consumes the
current surface geometry and field sampler.

## Decision

`GpuWebMercatorQuadCover` uses one adaptive projected-cell selector at every pitch.
Pitch and FOV affect the projection matrix naturally; neither selects an algorithmic
mode. The selector remains camera-derived, bounded, prefix-free, deterministic, and
edge-balanced. There is no compatibility threshold or uniform branch in the public API,
CPU oracle, GPU ABI, feedback, example configuration, or documentation.

The cover owns only geometry-cut products:

- standard patch descriptors;
- full-identity lookup and adjacency closure;
- patch count and projected-quality feedback;
- immutable vertical bounds used only for visibility and projected quality.

Vertical bounds replace terrain-specific elevation vocabulary at the cover boundary.
A flat consumer supplies `[0, 0]`; terrain supplies field-derived minimum/maximum
heights; extruded or other 3D consumers may supply their own conservative bounds. No
`terrain` boolean changes selection behavior.

Raster source lowering is a separate GPU demand-projection component. It consumes a
cover frame plus one tiled representation's source limits and emits desired/source-
ceiling request facts. Virtual Raster remains passive and consumes only the resulting
explicit `ViewTileDemandSet`.

Patch-mesh indirect arguments are a separate adapter. It combines one consumer-owned
vertex count with the cover's GPU patch count without giving the cover ownership of
terrain geometry or draw policy.

A future feature-surface conformance stage will consume feature geometry, a surface
geometry product or matching field sampler, and explicit invalidation facts. It will
produce derived GPU geometry, feature IDs, picking provenance, and indirect arguments.
It is not part of `MapFieldLayer`, Virtual Raster, the terrain renderer, or Scratch.
Camera-only movement must not rebuild camera-independent conformed geometry unless an
explicit screen-space tessellation policy changes its topology.

## Consequences

- Crossing 60 degrees cannot cause a global cover-mode discontinuity.
- Top-down and pitched views share one quality definition and one GPU path.
- Cover APIs no longer expose selection mode, pitch threshold, source ceiling, raster
  demand, terrain vertex count, or terrain draw arguments.
- Geometry LoD, source LoD, resolved raster LoD, and feature conformance remain separate
  observable facts.
- The unified selector must be recalibrated rather than inheriting the old eight-pixel
  threshold blindly. A 512-reference-pixel tile and 128-cell patch provide a four-
  reference-pixel natural starting point; browser evidence determines the accepted
  quality/capacity values.
- Feature rendering can preserve vector identity and picking instead of becoming a
  terrain texture, at the cost of an explicit derived-geometry lifecycle.

## Rejected Alternatives

### Smooth the 60-degree switch

Rejected because blending two selection authorities retains duplicate semantics and
still makes pitch an algorithm selector.

### Keep source demand and draw arguments inside the cover

Rejected because raster ceilings and mesh vertex counts are consumer facts. Keeping
them inside the geometry selector would recreate the coupling that the future feature
pipeline must avoid.

### Use terrain render-to-texture draping for vector features

Rejected because it ties feature rendering to terrain tile identity and texture
resolution, weakens feature/picking provenance, and duplicates a historical WebGL
workaround instead of using explicit WebGPU compute products.

### Let atlas residency define the geometry cut

Rejected for the reasons in ADR-083. Residency is delayed availability, not desired
geometry or semantic precision.
