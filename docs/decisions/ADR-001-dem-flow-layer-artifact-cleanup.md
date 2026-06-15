# ADR-001: Clean DEM Flow Layer Accumulation Artifacts

## Status

Accepted

## Date

2026-06-15

## Context

The `examples/m_demLayer` flow visualization uses a strong static rendering strategy:

- `flowVoronoi.wgsl` renders a screen-space velocity texture.
- `simulation.compute.wgsl` advances particles by sampling that velocity texture.
- `particles.wgsl` draws particle segments into a ping-pong trail texture.
- `swap.wgsl` preserves the previous trail texture and applies a slow full-screen decay.

This produces dense, stable flow patterns, but it can leave visible artifacts. The current history texture is screen-space and long-lived, so stale pixels survive camera changes. The flow texture also has no explicit validity mask, so non-zero velocities outside the intended physical flow domain can continue to seed particles and trails.

## Decision

Keep the flow generation, particle advection, and ping-pong accumulation model. Add an artifact cleanup layer around the existing pipeline instead of replacing the rendering algorithm.

The cleanup layer should cover three concerns:

1. **Validity masking**: introduce a flow-domain mask and use it consistently when generating velocity, advancing particles, and preserving history.
2. **History cleanup**: extend the trail swap pass with configurable decay, cutoff, and mask-based clearing.
3. **Camera invalidation**: clear screen-space history during map movement without disabling current flow rendering, then restart particles when the camera settles.

## Implementation Plan

1. Add a validity signal for the flow domain. This may be a separate `r8unorm` mask texture or an alpha channel in a future velocity texture format. The mask should represent whether a screen pixel belongs to the meaningful flow domain, not just whether velocity is non-zero.
2. Use the mask in the velocity pass. `flowVoronoi.wgsl` should avoid writing usable velocity for invalid samples.
3. Use the mask in the simulation pass. `simulation.compute.wgsl` should rebirth particles when their sampled velocity pixel is invalid, even if the sampled velocity is non-zero.
4. Convert `swap.wgsl` from pure decay into a cleanup pass. It should keep the current long-tail behavior for valid pixels, clear invalid pixels, and drop very low residual values below a tunable cutoff.
5. Re-enable camera lifecycle handling in `steadyFlowLayer.js`: movement should invalidate screen-space history while keeping current-frame flow rendering active, and `restart()` should reset particle state after movement ends.
6. Expose cleanup tuning as layer options, including `trailDecay`, `trailCutoff`, `clearOnMove`, and `useFlowMask`.

Implementation note: the current example data does not include an independent physical water or flow-domain mask. Until such data exists, the example derives a conservative geometry support signal from the Delaunay triangles using a configurable maximum station-edge length (`flowDomainMaxEdge`). This is a domain-support heuristic, not a replacement for a true hydrological mask.

## Implementation Status

Implemented for `examples/m_demLayer` on 2026-06-15.

- The flow-domain mask is stored in a separate `r8unorm` screen-dependent texture.
- `flowVoronoi.wgsl` writes velocity gated by optional speed cutoff plus geometry support, while the cleanup mask itself represents geometry support so low-speed in-domain pixels are not erased as holes.
- `simulation.compute.wgsl` samples the mask and rebirths particles outside valid pixels.
- `swap.wgsl` applies configurable decay, low-value cutoff, and mask-based trail clearing.
- `steadyFlowLayer.js` exposes `trailDecay`, `trailCutoff`, `clearOnMove`, `useFlowMask`, `flowMaskCutoff`, and `flowDomainMaxEdge`.
- Camera movement clears screen-space history while keeping simulation and current flow rendering active, then restarts particles after movement settles.
- Follow-up hardening guards zero `maxSpeed` normalization and clamps velocity color-ramp indices, without changing the retained-history rendering model.

Verification is covered by `tests/dem-flow-cleanup.test.js`, `npm test`, `npm run build`, and WebGPU browser screenshots of `examples/m_demLayer`.

## Non-Goals

- Do not replace the current particle advection algorithm.
- Do not remove ping-pong trail accumulation.
- Do not switch to a path-based or mesh-based flow renderer.
- Do not tune away static density by simply lowering particle count.

## Alternatives Considered

### Lower Global Trail Decay

Reducing the decay factor quickly hides artifacts, but it also weakens the static flow texture that makes this example valuable. This should remain a runtime preset, not the main fix.

### Full Clear Every Frame

Clearing every frame removes residual artifacts, but it destroys the accumulation effect and changes the visual model.

### Reproject History Across Camera Changes

History reprojection can preserve trails during interaction, but it is more complex and still needs validity rejection. Clearing or pausing history during movement is the safer first step.

### Particle Lifetime Only

Particle lifetime helps avoid degeneration, but it does not clean stale pixels already written to the history texture. It should complement, not replace, masked history cleanup.

## Industry References

- Mapbox `raster-particle` exposes `raster-particle-fade-opacity-factor` and `raster-particle-reset-rate-factor` as first-class controls for trail length and particle reset behavior: <https://docs.mapbox.com/style-spec/reference/layers/#raster-particle-fade-opacity-factor>
- Mapbox's WebGL wind implementation uses a retained screen texture with configurable `fadeOpacity`, `dropRate`, and `dropRateBump`: <https://github.com/mapbox/webgl-wind>
- deck.gl `TripsLayer` models trails as a finite time window via `fadeTrail` and `trailLength`: <https://deck.gl/docs/api-reference/geo-layers/trips-layer>
- WebGPU render passes distinguish preserving existing attachment contents from clearing them via `loadOp`: <https://developer.mozilla.org/en-US/docs/Web/API/GPUCommandEncoder/beginRenderPass>

## Consequences

- Static flow rendering remains dense and expressive.
- Artifact cleanup becomes explicit and configurable instead of incidental.
- Movement behavior becomes predictable because screen-space history is invalidated deliberately.
- The example gains a clear path to production-quality masking without coupling the cleanup policy to the core flow algorithm.
