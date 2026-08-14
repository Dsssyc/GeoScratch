# ADR-075: Name the Surface-Reveal Example Underwater Terrain

## Status

Accepted

## Date

2026-08-15

## Context

The example formerly named `DEM Layer` renders underwater terrain above an existing
MapLibre basemap with semi-transparent alpha compositing. The composition preserves the
basemap as geographic context while making terrain that is conceptually below the mapped
water surface visible.

`DEM` identifies an elevation-raster representation, not the visible subject or the
composition. `Bathymetry` identifies depth measurement and likewise does not cover the
terrain mesh, GPU-driven LoD, Virtual Raster sampling, or the context-preserving reveal.
Industry terminology separates the subject from the visibility mechanism: underground or
undersea content is commonly exposed through see-through ground, surface transparency, or
other occlusion-management strategies.

## Decision

The active example is named `Underwater Terrain` and uses:

- route and directory `underwaterTerrain` / `examples/underwaterTerrain/`;
- visible title, controls, runtime labels, and current tests named `Underwater Terrain`;
- `UnderwaterTerrain` prefixes for example-owned TypeScript and proof identities.

`Surface Reveal` describes the broader visual objective: expose content below an existing
mapped surface while retaining that surface as context. It is documentation terminology,
not a new Scratch or Geo public API in this decision. The current strategy is
context-preserving alpha compositing; it does not claim depth-correct ground translucency.

`DEM` names remain only where they accurately identify the elevation raster, tile payload,
source protocol, shader sampling namespace, or cache identity. Historical `m_demLayer`
references remain source facts. No active `demLayer` route or compatibility alias is kept.

## Consequences

- The catalog describes what users see instead of exposing an input encoding.
- Example-owned controls, map hosting, lifecycle labels, and proof hooks share one identity.
- DEM tile and cache code retains precise data terminology without redefining the example.
- Future Surface Reveal strategies such as depth-aware translucency, cutaways, or ghosting
  can be discussed without renaming the underwater-terrain subject.
- Existing saved panel preferences under the former example keys are intentionally not
  migrated during the 0.x clean cut.

## Rejected Alternatives

### Bathymetry Layer

Rejected because bathymetry describes measurements rather than the rendered terrain and
visibility relationship.

### Surface Translucency

Rejected because the current implementation composites a terrain canvas over the basemap;
it does not make the mapped surface a depth-correct translucent occluder.

### Surface Reveal as the example title

Rejected because it names the reusable visual objective rather than the concrete subject
shown by this example.
