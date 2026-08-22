# ADR-084: Separate Reference Pixels from Presentation Pixels in Terrain LoD

## Status

Accepted. Extends ADR-080 and ADR-083. It preserves the single GPU inverse-cover
authority, standard WebMercatorQuad identities, passive Virtual Raster, projected-cell
quality, deterministic output, and 2:1 mesh stitching.

## Date

2026-08-22

## Context

The MapLibre view source used the WebGPU canvas device-pixel size both to resize the
presentation attachments and to convert projected cells into screen pixels. A Retina
display therefore refined geometry one additional level even though the map camera,
visible geographic footprint, and canonical tile needs were unchanged.

The built-in terrain mesh used 64 cells per patch with an eight-pixel cell threshold.
At DPR 1 this produced approximately the same tile identities as a 256-screen-pixel
source, while Mapbox and MapLibre use a 512-screen-pixel tile convention and a
128-cell terrain mesh. The cover also used one global exaggerated elevation range for
every patch, which made shallow tiles inherit the deepest source bound.

## Decision

Geo view snapshots use a logical reference-pixel viewport for camera, cover, projected
quality, and picking. View-source captures separately carry the physical presentation
size consumed by Surface and attachment resize. MapLibre supplies its transform width
and height as the reference viewport and an application reader supplies the WebGPU
presentation size. DPR changes presentation resolution but not geometry or page demand.

The built-in terrain policy uses a 512-reference-pixel zoom convention, 128 cells per
patch, an eight-reference-pixel maximum cell span, and a small explicit refinement
tolerance. Uniform mode is anchored at the floor of the conventional map zoom and may
only refine the complete footprint; variable mode retains direct projected-cell
probing above the pitch boundary.

Terrain sources may supply one complete immutable WebMercatorQuad elevation-bound
hierarchy. The cover resolves exact or source-ceiling-ancestor bounds from an immutable
GPU buffer. Missing complete metadata uses one global range; partial metadata is
invalid. Runtime residency and cache state never participate.

Public names distinguish `referenceViewport`, `presentationSize`, and
`maximumCellSpanReferencePixels`. Old ambiguous names are removed during 0.x.

## Consequences

- Equal logical views produce equal geometry and DEM demand on ordinary and Retina
  displays.
- Retina still improves framebuffer, depth, line, and fragment sampling resolution.
- A denser raster payload remains a same-page representation choice, not a z+1 demand.
- Fewer 128-cell patches preserve approximately the previous DPR-1 cell density while
  reducing patch identities, lookup entries, and demand duplication.
- Static tile bounds tighten terrain visibility without introducing cache-history LoD.
- Consumers must migrate the clean-cut view and policy field names.

## Rejected Alternatives

### Divide the current threshold by DPR

Rejected because it retains a physical-pixel camera contract and spreads presentation
policy into every cover consumer.

### Clamp patch count to a MapLibre-like constant

Rejected because tile count depends on viewport, zoom, pitch, coverage, and elevation;
a silent cap would create holes or hidden quality loss.

### Request z+1 DEM pages on Retina displays

Rejected because presentation density is not geographic precision and many sources do
not provide additional information at that level.

### Use resident DEM tiles as the elevation hierarchy

Rejected because network and cache timing would change geometry topology for an equal
view.

