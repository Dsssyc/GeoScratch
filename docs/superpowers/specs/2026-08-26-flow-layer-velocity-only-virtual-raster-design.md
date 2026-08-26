# Flow Layer Velocity-Only Virtual Raster Design

## Status

The design direction was approved on 2026-08-26. This written specification requires
user review before implementation planning begins.

## Goal

Replace the whole-field, viewport-rasterized Flow Layer with tiled temporal velocity
sampling while keeping the normal transferred data surface minimal. The Flow Layer
visualizes advectable motion, not authoritative water presence. It derives dynamic
particle support, spawning, lifecycle, and the visible Flow support contour on the GPU
from the velocity field already required for simulation.

## Current Facts

The current example loads one `station.bin` plus 27 whole `uv_N.bin` files. Each file
contains 117,148 `float32` pairs. The page builds one global Delaunay triangulation,
expands 234,240 triangles into 702,720 non-indexed vertices, and rasterizes two temporal
fields into viewport-sized `rg32float` velocity and `r8unorm` mask textures every frame.
The mask combines a maximum-triangle-edge heuristic with `FLOW_DISPLAY_EXTENT`; it is
neither a hydraulic wet/dry result nor a stable vector boundary.

Exact zero velocity is ambiguous between dry and stationary water. That ambiguity does
not need to be resolved by this presentation layer: neither case contains advectable
motion, so neither should retain or spawn Flow particles. This is a Flow-support rule,
not a claim about physical water extent.

## Invariants

1. The normal time-varying payload contains only the two velocity components required
   by the Flow simulation.
2. No boundary texture, vector-feature tileset, water-depth plane, wet/dry plane, or SDF
   is requested by the normal Flow path.
3. Semantic states are derived views, not separate network or atlas planes.
4. A zero velocity sample may be valid source data while remaining non-advectable.
5. Flow support means "motion suitable for particle advection" and never means
   authoritative physical water presence.
6. Particle death at the support boundary is absorbing: the old particle retires and a
   replacement starts without a connecting segment. Reflection and boundary sliding do
   not exist.
7. Scratch remains domain-neutral and acquires no Flow, tile, boundary, or particle
   policy.
8. Particle positions remain canonical and LoD-independent. Tile and page identities
   are transient sampling, demand, and locality facts only.
9. Screen-space history textures, reverse-gather reprojection, decay, cutoff, and
   presentation remain viewport resources rather than Virtual Raster pages.

## Minimal Data Product

### Manifest

One immutable `FlowDatasetManifest` records:

- dataset id, source revision, payload checksums, and ordered model times;
- `WebMercatorQuad` coverage, geographic bounds, page size, and source levels;
- velocity component order, units, vector basis, byte order, and sample encoding;
- temporal interpolation policy;
- maximum-speed normalization facts;
- phase labels such as cold-start, spin-up, transient, or production as scalar
  per-frame metadata rather than raster channels.

Application settings, not the source manifest, own `FLOW_DISPLAY_EXTENT` and explicit
finite `activitySpawn` and `activityKill` thresholds satisfying
`activitySpawn > activityKill >= 0`. Those settings enter frame provenance but do not
create data URLs, cache identities, or raster channels.

### Velocity pages

The initial correct implementation uses the current public Virtual Raster shape:
two-channel `float32` pages lowered to an `rg32float` atlas. This is eight payload bytes
per logical texel. Unsupported source locations are deterministically encoded as zero
velocity by the source builder. Missing, failed, stale, or uncovered pages remain
page-table statuses and are not disguised as successful zero-valued pages.

The normal path adds no per-texel dynamic channel. A future authoritative activity bit
or 16-bit velocity encoding requires separate measured evidence, an explicit error
budget, and a reviewed API change; neither is part of this design.

## Deterministic Offline Construction

The source builder reads the complete station coordinates and each temporal U/V slice,
constructs the accepted global Delaunay field once, and samples that field onto one
global `WebMercatorQuad` logical texel lattice. It must not triangulate tiles
independently. Tile edges therefore sample the same global field and cannot select
different local triangulations.

The target field construction uses Delaunay barycentric interpolation at target texel
centers and Geo Virtual Raster logical bilinear filtering at runtime. The unused IDW
helper in the current shader is not parity authority. Unsupported triangles lower to
zero velocity without creating a second mask product. Application display exclusion is
evaluated at runtime and is never baked into source pages.

The builder produces deterministic multilevel pages, source metadata, checksums, and
seeded parity samples. Vector downsampling must preserve component semantics and report
measured velocity error; it must not derive direction by averaging angles.

## Temporal Virtual Sampling

The runtime holds one current time plane, one next time plane, and at most one bounded
prefetch plane. A submission step sees one immutable temporal pair and one progress
value. Both time samples are evaluated at the same canonical position and compatible
resolved level before interpolation. A missing or failed member makes the Flow sample
unavailable; an atlas slot from another time or generation is never read as fallback.

The derived shader-level contract is conceptually:

```text
FlowSample {
    status
    velocity
    speed
    advectable
}
```

Only velocity and Virtual Raster status are stored. The remaining values are computed:

```text
velocity = mix(velocity0, velocity1, progress)
speed = length(velocity)
advectable = status is available
    && position is inside presentation policy
    && speed >= activityKill
```

This requires a generic bounded temporal Virtual Raster composition in Geo. It does not
justify a Flow-specific page table, scheduler, Worker pool, or Scratch primitive.

## Particle Support And Lifecycle

### Spawn support

A bounded GPU preprocess classifies currently sampled logical cells with
`speed >= activitySpawn`, compacts their canonical cell identities, and publishes an
immutable `FlowSpawnIndex`. Dead particles sample this index rather than retrying random
positions across the complete display extent. The final jittered position is validated
against the same temporal Flow snapshot before adoption.

If the index is empty or its required pages are unavailable, affected particle slots
become explicitly dormant. They do not spin in a rejection loop. The application may
scale active particle count with measured supported area, but the maximum pool remains
262,144 until a separate measured decision changes it.

### Survival and death

Each integration substep samples the candidate position. A particle retires when the
sample is unavailable, outside presentation policy, or below `activityKill`. If a
required substep budget would overflow, the particle retires rather than risking a
cross-support segment.

Retirement and rebirth write:

```text
currentPosition = spawnPosition
previousPosition = spawnPosition
velocity = zero
age = zero
stagnantAge = zero
```

The particle draw therefore emits no old-to-new line. Independent finite lifetime and
stagnant-age limits guarantee reclamation of exact or near-zero velocity particles.
Field validity is never mutated to achieve particle lifecycle behavior.

## Derived Dynamic Flow Contour

When the visible Flow support boundary is enabled, a bounded tiled GPU marching-squares
preprocess evaluates `speed - activityKill` from the same immutable temporal velocity
snapshot. It emits transient line segments for the zero contour. No vector boundary
payload, stable feature id, geometry residency, or picking contract is introduced.

Logical cells use half-open tile ownership, and corner values resolve through the
cross-page Virtual Raster accessor. Ambiguous marching-squares cases use one declared
deterministic decider. Capacity overflow is a structured hard diagnostic rather than a
silently truncated contour.

The contour represents advectable Flow support. It must not be documented or styled as
an authoritative wet shoreline or flood extent.

## Demand, Ownership, And Lifetime

- Geo owns tile identities, Virtual Raster demand, residency, immutable snapshots,
  fallback status, generated accessors, and the generic temporal composition.
- Scratch owns Worker execution, persistent raw-payload cache, GPU resources, commands,
  submissions, epochs, and diagnostics without acquiring Geo or Flow meaning.
- The Flow source adapter owns URL construction, decoding, checksums, units, source
  revision, and offline-build schema.
- The Flow example owns thresholds, temporal playback, spawn policy, particle lifecycle,
  dynamic contour presentation, history, camera integration, and total budgets.

View-visible velocity pages are demanded first. Particle displacement may add a bounded
predictive halo, and the next temporal plane may prefetch the same spatial set. Demand
feedback remains workgroup-reduced and bounded; there is no CPU particle mirror,
per-particle readback, persistent virtual address, or whole-domain request.

Disposal stops demand and frame production, cancels or settles loaders, drains issued
submissions and readbacks, disposes derived spawn/contour state and Virtual Raster
resources, and only then releases the runtime and map authorities.

## Performance Contract

- Normal time-varying transfer remains exactly two velocity components: eight bytes per
  logical texel with the current `float32` API.
- No normal request URL or cache identity exists for depth, wet mask, boundary mask,
  SDF, or vector geometry.
- Active residency is bounded to the current/next planes plus one explicit prefetch
  window and pinned safety coverage.
- Network, decoded staging, atlas, page-table, spawn-index, contour, particle, and
  history bytes are reported separately.
- No optimization claim about 16-bit encoding is accepted without before/after payload,
  GPU-memory, sampling-error, and frame-time measurements.

## Failure Semantics

- Invalid manifests, payload sizes, non-finite velocity, checksum mismatch, unsupported
  units or basis, and incoherent temporal pairs fail with structured diagnostics.
- Missing or failed velocity samples are non-advectable and retire affected particles;
  they are never treated as successful stationary water.
- Stale generation or time responses cannot publish into the active pair.
- Spawn-index and contour overflow are bounded diagnostic failures.
- A source outage preserves bounded history decay and converges to dormant particles
  without retaining unbounded retries or observations.

## Verification Contract

### Source and unit gates

- verify all 27 ordered model times, page dimensions, checksums, units, basis, and
  content versions;
- compare tiled velocity against source stations, seeded triangle interiors, unsupported
  triangles, and page-edge samples, then verify display exclusion independently at
  runtime;
- prove adjacent tiles and parent/fine samples satisfy declared error bounds;
- prove the build never triangulates independently per tile.

### GPU and browser gates

- two complete 27-slice cycles preserve time indices, progress, bounded residency, and
  deterministic prefetch;
- a cold-start fixture whose nonzero velocity expands from one inlet produces no spawn
  outside current Flow support and activates dormant slots only as support grows;
- exact zero and near-zero fields reclaim all particles within finite lifecycle bounds;
- candidate-position and substep checks prevent one-frame cross-support segments;
- temporal missing/fallback transitions never mix unrelated LoDs or time generations;
- tiled marching-squares output is deterministic and seamless across page boundaries;
- the normal network and cache trace contains no boundary, depth, wet-mask, SDF, or
  vector-feature payload;
- long-running operation, residency, staging, particle, spawn, contour, and history
  counts remain bounded with zero pending work after drain;
- existing camera reprojection, resize, 660-plus-frame cadence, structured failure, and
  cleanup gates continue to pass.

## Non-Goals

- Authoritative water presence, flood extent, water-surface, depth, or wet/dry display.
- Boundary feature identity, attributes, topology, or picking.
- Reflection, projection, sliding, wall-normal response, or SDF-based collision.
- A Flow-specific scheduler, page table, Worker pool, scene hierarchy, or Scratch API.
- Preserving the current viewport Voronoi stage, whole-field Worker transfers, global
  particle longitude/latitude `f32` ABI, or screen-UV field sampling.
- Introducing 16-bit payloads, a second activity channel, or additional raster planes
  without measured evidence and a separately approved contract.

## Related Material

- [Geo Virtual Raster Flow readiness](../../review/geo-virtual-raster-flow-readiness.md)
- [ADR-044: Flow Layer Scratch clean cut](../../decisions/ADR-044-flow-layer-scratch-api-clean-cut.md)
- [Current Virtual Raster API](../../api/geo/virtual-raster.md)
