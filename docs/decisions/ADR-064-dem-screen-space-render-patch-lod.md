# ADR-064: Select DEM Render Patches by GPU Screen-Space Error

## Status

Superseded by [ADR-065](ADR-065-dem-projected-grid-spacing-lod.md). The bounded GPU
branch traversal and logical-patch lookup remain; its two-pixel error metric does not.

## Date

2026-08-07

## Context

ADR-063 correctly separated raster-page LoD from terrain geometry LoD, but its first
implementation still chose one render level for every descendant of a source page
from `ceil(mapMeta.zoomHint)`. Under a pitched camera, a page near the camera and a
page near the horizon therefore received equivalent geometry treatment whenever they
shared a source level. That over-tessellates global terrain and does not satisfy the
distance-dependent LoD contract.

The accompanying 512 by 256 LoD-map texture also encoded adjacency in source-image
UV space. A global `z14` render patch is much smaller than one texel in that texture,
so distinct logical patches eventually alias and mesh stitching cannot resolve the
actual selected neighbor.

Current MapLibre covering-tile selection permits variable zoom and computes desired
detail per candidate from camera-to-tile distance, viewport, field of view, and pitch.
Cesium terrain traversal refines each quadtree branch while its geometric error projects
above a pixel threshold. GeoScratch needs the same invariant without importing either
project's CPU traversal or making Scratch aware of terrain.

## Decision

### Keep data and geometry authorities separate

`GpuTileFrontier` remains the sole authority for resident raster pages, requests,
fallback, retirement, and the source `z10` ceiling. `DemRenderPatchFrontier` remains
example-owned and may refine geometry through `z14` without inventing raster detail.

### Select each render branch by screen-space error

For each visible source page, compute dispatch reserves one invocation for each of its
at-most `4^4 = 256` terminal descendant paths. Each invocation walks its bounded path
from the source page and stops at the first node whose projected error is at most two
pixels, or at the source-plus-four/`z14` ceiling. The error is
`(tile width / 64) * viewport height / (2 * tan(FOV / 2) * AABB distance)`
in WebMercator-relative meter coordinates.

Only the canonical top-left terminal path emits a stopped ancestor, so no node is
duplicated. Frustum rejection, descriptor writes, count production, and indirect draw
arguments remain GPU-only. `zoomHint` is not a render-patch selection input.

### Resolve adjacency from logical selected patches

Each parity owns a persistent open-addressed lookup buffer keyed by packed
`(matrixLevel, tileRow, tileCol)`. Capacity is the next power of two above twice the
maximum render-patch count. A persistent GPU clear command resets the selected parity
before compute; successful emitters insert their descriptor index. Hash overflow is
counted separately from descriptor overflow.

The terrain vertex shader probes one render-maximum-level cell across each patch edge,
then searches from `z14` toward `z0` for the selected patch covering that cell. This
finds finer, equal, or coarser neighbors without a source-domain texture, CPU neighbor
lists, or physical-atlas identity. Fine edges snap by `2^(ownLevel-neighborLevel)` and
shared-edge height sampling uses the greater available sampling level. The lookup is
global WebMercator tile identity, so its precision does not degrade with dataset area.

### Keep the frame graph minimal

The frame order is now:

1. data-frontier compute;
2. render-patch lookup clear plus SSE selection/finalization compute;
3. terrain indirect draw;
4. bounded data-frontier feedback.

The LoD-map texture, shader, pipeline, pass, draw commands, and provenance chain are
removed. All remaining resources and commands are persistent across frames and resize.

## Rejected Alternatives

### Use map zoom as a global render level

Rejected because zoom is only a view hint. It cannot express the distance variation
inside a pitched frustum.

### Traverse a complete CPU quadtree

Rejected because it duplicates GPU visibility authority and reintroduces per-frame
instance/count uploads. The bounded terminal-path dispatch has fixed capacity and no
CPU traversal.

### Keep a larger fixed LoD-map texture

Rejected because any finite source-domain raster aliases at a sufficiently high tile
level or sufficiently large dataset. Logical tile identity is the required invariant.

### Require raster pages above the source ceiling

Rejected because geometry density and data information content are independent. It
would add network, decode, cache, and residency work without increasing DEM detail.

## Consequences

- Near and far patches in one pitched frame can select different matrix levels.
- Data requests and cache identities remain bounded by the manifest's `z10` ceiling.
- Worst-case candidate and output counts remain bounded by construction.
- The lookup adds two 256 KiB parity buffers at the current 49-page capacity and one
  GPU clear per frame; it removes the LoD render target and a render pass.
- Geometry selection is deterministic and stateless. Data-page hysteresis remains in
  `GpuTileFrontier`; future geomorphing may reduce visible geometry transitions without
  changing this selection authority.
- Scratch gains no DEM, quadtree, tile, or Geo concept. The example composes existing
  buffers, compute, indirect execution, binding, submission, and provenance APIs.

## References

- [MapLibre covering tiles implementation](https://github.com/maplibre/maplibre-gl-js/blob/66256d0ece1b00c71cefa8c59668ba4f101e0495/src/geo/projection/covering_tiles.ts)
- [MapLibre covering tiles guide](https://github.com/maplibre/maplibre-gl-js/blob/66256d0ece1b00c71cefa8c59668ba4f101e0495/developer-guides/covering-tiles.md)
- [Cesium quadtree terrain selection](https://github.com/CesiumGS/cesium/blob/6d5d8b1f0725b6f831b336463f4b11c98023427b/packages/engine/Source/Scene/QuadtreePrimitive.js)
- [Cesium Native selection algorithm](https://cesium.com/learn/cesium-native/ref-doc/selection-algorithm-details.html)
