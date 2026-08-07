# ADR-063: Decouple DEM Render-Patch LoD from Raster Page LoD

## Status

Superseded by [ADR-064](ADR-064-dem-screen-space-render-patch-lod.md)

## Date

2026-08-07

## Context

ADR-061 moved DEM page selection, residency demand, visibility, and indirect counts to
`GpuTileFrontier`. The initial integration also used that page frontier directly as the
terrain draw-instance frontier. This accidentally coupled two independent ceilings:

- the DEM source and Virtual Raster have useful pages through WebMercatorQuad `z10`;
- the legacy terrain renderer refined its mesh through `z14`.

Every drawn page still used a fixed 64 by 64 terrain sector. Once the page frontier
reached `z10`, increasing map zoom could not produce finer geometry. Raising the
server manifest to `z14` would invent raster levels with no additional source detail,
increase network/cache/decode work, and misstate data provenance. Increasing the
sector resolution globally would multiply near- and far-field vertex work without
preserving tile-relative mesh-stitching behavior.

## Decision

### Separate authorities

`GpuTileFrontier` remains the sole authority for data-page visibility, residency,
demand, retirement, and fallback. Its maximum matrix level remains the manifest's
`z10`.

The DEM example owns a second persistent GPU stage, `DemRenderPatchFrontier`, because
page-to-patch interpretation and terrain mesh density are DEM rendering policy. It:

1. reads the current data frontier's map metadata, visible page descriptors, and
   GPU-produced instance count;
2. selects a render matrix level from camera zoom, the source page level, the `z14`
   render ceiling, and a maximum four-level expansion;
3. expands each source page into at most `4^4 = 256` descendant patches;
4. frustum-culls those patches with the same fixed-coordinate camera representation;
5. writes explicit `DemRenderPatch` descriptors and LoD-map/terrain indirect draw
   arguments.

The host still writes only map metadata. It does not traverse a render quadtree,
upload instance arrays, read patch counts back, or author draw counts.

### Explicit descriptor semantics

Each render patch carries both sets of facts:

- render identity: `matrixLevel`, `tileRow`, and `tileCol`;
- backing data identity: `samplingLevel`, source matrix/row/column, and source compact
  index.

`matrixLevel` may reach 14. `samplingLevel` remains the Virtual Raster fine-to-coarse
level supplied by the resident source page and therefore never claims unavailable
raster detail.

### Stitching and sampling

The LoD map encodes render matrix level in red and sampling level in green.

- Edge vertex snapping compares neighboring red values and therefore follows geometry
  LoD.
- Shared-edge height sampling takes the coarser explicit green value and therefore
  follows data availability.

Terrain vertices reconstruct fixed WebMercator positions from render-patch identity,
then use the existing world-coordinate Virtual Raster shader API. Render patches do
not own physical atlas slots and do not know neighboring page identities.

### Bounded distance behavior

The target level is capped by `sourceMatrixLevel + 4`. The data frontier already
selects coarser source pages with distance under pitched views, so far-field patches
remain correspondingly coarser while near `z10` pages may reach `z14`. Output capacity
is fixed at construction and overflow is bounded in the GPU state.

## Rejected Alternatives

### Advertise synthetic data pages through z14

Rejected. Resampling the same source into additional HTTP/cache pages increases work
and obscures the source-resolution ceiling without improving information content.

### Increase every terrain sector above 64 by 64

Rejected. This raises vertex cost for all pages, including distant pages, and does not
restore the legacy tile-relative refinement or diagnostic patch identity.

### Reintroduce a CPU render quadtree

Rejected. It would duplicate GPU visibility authority, require per-frame instance/count
uploads, and make page-frontier/render-frontier races non-auditable.

### Put terrain render patches into Scratch

Rejected. Scratch already exposes the required storage, compute, indirect, binding,
submission, provenance, and diagnostics capabilities. Terrain patch density and
mesh-stitching are not generic GPU primitives.

## Consequences

- Zooms above 10 continue refining terrain geometry through 14 while data requests and
  cache keys remain bounded by 10.
- LoD-map and terrain draw counts are produced by GPU compute and consumed indirectly
  in the same submission.
- Wireframe colors now identify render patches, making post-z10 subdivision and
  stitching visible without changing the shaded path.
- The persistent graph adds bounded parity patch/state/argument buffers and three
  compute kernels; it creates no per-frame GPU objects.
- The original implementation used integer zoom plus inherited data-frontier distance
  degradation. A pitched-camera regression proved that assumption insufficient: every
  descendant of one source page received the same render level, so near and far geometry
  did not independently converge to a screen-space error. ADR-064 retains this ADR's
  data/render/sampling separation while replacing that selection and the fixed LoD map.
