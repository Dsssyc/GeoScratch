# ADR-002: Reproject DEM Flow History During Camera Movement

## Status

Accepted

## Date

2026-06-15

## Context

`examples/m_demLayer` uses particle line segments plus ping-pong screen textures to build dense flow trails. ADR-001 added mask-based cleanup and a clear-on-move fallback, but clearing screen-space history during drag weakens the static accumulation that makes the example valuable.

The alternative world-space or vector trail buffer was previously tested and rejected for this case because memory use scales with line count and retained trail nodes. The current raster trail model is lighter: particles generate the current frame, and the texture stores history.

## Decision

Use screen-space reverse reprojection for flow history during camera movement. Keep the particle advection and ping-pong trail texture model. Do not introduce a world-space or vector trail buffer.

The history pass should use reverse gather, not forward scatter:

1. Start from the current screen pixel.
2. Unproject it through the current inverse camera matrix.
3. Intersect the ray with the Mercator `z=0` plane.
4. Project that world point with the previous camera matrix.
5. Reject samples outside clip bounds or with invalid depth.
6. Sample the previous trail texture and continue applying decay, cutoff, and flow-domain masking.

## Implementation Plan

- Add `historyMode` to `SteadyFlowLayer` with values `reproject`, `clear`, and `off`. Default to `reproject`. Preserve `clearOnMove: false` as `historyMode: 'off'` when `historyMode` is not explicitly set.
- Track previous and current camera state for history reprojection: matrix, inverse matrix, high/low center, and viewport.
- Extend the cleanup uniform used by `swap.wgsl` with history mode, validity, previous/current camera state, and viewport state.
- Keep the existing clear pass as a fallback for the first frame, resize, large jumps, non-invertible matrices, and explicit `historyMode: 'clear'`.
- In `historyMode: 'reproject'`, camera movement must not reset particles or disable current rendering. History continuity should come from texture reprojection.

## Alternatives Considered

### Keep Clear-on-Move

Simple and robust, but it discards accumulated trails during interaction and makes the static rendering strategy look weaker while moving.

### World-Space or Vector Trail Buffer

Can preserve history accurately, but memory grows with retained line segments and trail nodes. This conflicts with the desired lightweight raster history model.

### Lower Trail Decay

Hides artifacts faster, but reduces the long-tail density that the example is designed to show.

## Consequences

- Static trail accumulation can remain visible during drag, zoom, and pan.
- The implementation adds camera-state bookkeeping and a more complex full-screen history shader.
- Repeated texture reprojection may introduce blur, so decay and cutoff remain important.
- The first implementation assumes Mapbox Mercator and a Mercator `z=0` flow plane. Terrain-height reprojection and globe projection are out of scope.
