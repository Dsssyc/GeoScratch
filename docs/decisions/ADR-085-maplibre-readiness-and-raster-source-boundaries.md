# ADR-085: Complete MapLibre and Raster Source Ownership Boundaries

## Status

Accepted. Extends ADR-080, ADR-083, and ADR-084 without adding a terrain facade or
moving source protocol into Geo.

## Date

2026-08-22

## Context

After the Underwater Terrain application became a thin explicit assembly, three residual
responsibilities remained misplaced or duplicated:

- the application waited for the complete MapLibre `load` event even though
  `mapLibreFrameDriver()` already owned custom-layer attachment and `style.load` reattachment;
- the DEM Worker accepted cached payloads after comparing only a subset of the canonical
  Virtual Raster cache metadata;
- the DEM source adapter reimplemented TileMatrix limits traversal, while the application
  reconstructed the decoded elevation range from manifest scale and offset.

The first two are reusable authority boundaries. The third is source-adapter cleanup, not a
reason to create a generic DEM or PNG source API.

## Decision

### MapLibre style readiness belongs to the frame driver

`MapLibreFrameMap` includes `isStyleLoaded()`. The driver installs its listeners immediately,
but it does not attach its custom layer or request an ineffective repaint while the initial
style is unready. Invalidations remain coalesced. The first `style.load` attaches the layer and
requests the pending frame; stopping before readiness removes listeners and pending callbacks.

Applications using the driver do not add a separate full-map `load` wait. Applications that do
not yet use the driver retain their own readiness policy until they migrate their frame
authority.

### Geo owns canonical cache-address matching

`virtualRasterCacheMetadataMatches()` compares untrusted stored metadata with every identity
field in one `VirtualRasterCacheAddress`, including source, tile matrix, tile coordinate,
plane, coherence, representations, decoder, sample type, and schema. Additional
source-specific metadata is permitted. A source Worker separately validates payload shape and
treats any identity mismatch as a cache miss.

### The DEM adapter owns its decoded source facts

The adapter uses `TileMatrixCoverage` as the single limits/index implementation and enumerates
canonical records through `coverage.coordinate()`. It still validates the untrusted manifest at
the source boundary, while the terrain cover independently validates its public descriptor.
The adapter exposes immutable `elevationRangeMeters`; application assembly no longer reads
sample scale or offset.

DEM manifest schema, HTTP paths, PNG decoding, Worker protocol, cache budgets, map style,
terrain exaggeration, controls, and presentation WGSL remain application-owned.

## Consequences

- Underwater Terrain can initialize map, GPU, manifest, and Worker catalog concurrently while
  the driver gates the first custom-layer frame on style readiness.
- Cached bytes cannot cross source, tile, revision, representation, decoder, or schema identity
  accidentally.
- Tile coverage order and compact indexing have one Geo implementation without collapsing
  separate validation boundaries.
- The example becomes thinner through better ownership rather than a broad convenience facade.
- Flow Layer keeps its current explicit map wait until it adopts `mapLibreFrameDriver()`.

## Rejected Alternatives

### Add a public MapLibre `load` wait helper

Rejected because custom-layer readiness is narrower than complete map loading and belongs to
the driver that owns attachment and repaint scheduling.

### Let each Worker compare a convenient metadata subset

Rejected because a valid cache key does not justify trusting persisted metadata, and different
sources would choose inconsistent identity subsets.

### Move the DEM manifest, decoder, or complete application into Geo

Rejected because those contracts describe one uint8 PNG/COG service and one example's product
policy rather than a reusable geographic primitive.
