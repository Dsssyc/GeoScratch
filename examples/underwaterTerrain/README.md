# Underwater Terrain

The Underwater Terrain example reveals terrain below an existing MapLibre basemap while
preserving the map as geographic context. Its current Surface Reveal strategy composites a
semi-transparent WebGPU terrain canvas over the basemap; it does not claim depth-correct
ground translucency or reduce the example to bathymetry data alone.

Standard `WebMercatorQuad` DEM tiles stream through Workers into a bounded GPU
virtual-raster atlas. Start the local tile service as documented in
[`tile-server/README.md`](./tile-server/README.md), then run `npm run dev` from the
repository root.

The WebGPU overlay permits two native frames in flight. This bounded double-flight policy keeps
120 Hz camera tracking from collapsing to half-rate while latest-only pending capture prevents
an unbounded stale queue. A no-draw MapLibre custom-layer driver
captures a `mapLibrePlanarViewSource`, and the terrain renderer consumes that capture directly
inside the matching host frame. Size changes, frame settlement, and residency work remain inside
the public Geo contracts rather than being translated by the example.
The capture keeps MapLibre CSS/reference pixels separate from the physical WebGPU presentation
size, so Retina changes attachment resolution without changing terrain topology or DEM demand.
Capacity-blocked invalidations coalesce until that frame is observed; the next host repaint uses
the newest revision instead of replaying intermediate views. The two canvases keep independent
WebGL and WebGPU contexts and do not claim shared depth or atomic presentation.

The high-pitch benchmark runs 90 display-paced camera updates in both shaded and wireframe
presentations. One inverse-cover compute dispatch directly generates bounded standard
`WebMercatorQuad` patches and performs local 2:1 closure; no root/trial traversal exists.
The acceptance gate requires at least 65 submitted camera transitions, zero stale transitions,
lag P95 no greater than one frame, and native observation P95 no greater than 25 ms.

`main.ts` contains only page configuration, controls, proof loading, and page lifetime.
`application.ts` is the complete explicit map, runtime, DEM source, Virtual Raster, renderer,
view source, frame driver, and controller assembly.

The root `npm run dev` and `npm run build` commands first run the generic
`geoscratch-worker` build declared by [`../worker-modules.ts`](../worker-modules.ts).
It emits an ignored `public/scratch-workers/` manifest and standalone ESM artifact;
the DEM source does not depend on a Vite Worker URL plugin or a generated URL module.

Disk caching is disabled by default:

```text
http://localhost:5173/underwaterTerrain/?cache=none
```

## Underwater Terrain controls

The `Underwater Terrain` panel in the upper-right corner contains live rendering controls
and cache configuration.

The `Rendering` folder exposes `Tile wireframe`. It switches immediately to the
already-created diagnostic pipeline: each logical render patch
`(matrixLevel, row, column)` receives a stable pseudo-random color and only the
post-stitch triangle edges are drawn. The setting is stored independently at
`geoscratch.examples.underwaterTerrain.rendering.v1` in `localStorage`; it does not reload
the page, alter cache query parameters, or rebuild the virtual raster.

## Data and geometry LoD

The manifest declares source pages through z10. `GpuWebMercatorQuadCover` independently
selects geometry through z14, but every output remains a standard
`(tileMatrix, tileRow, tileCol)` identity. Camera/view-derived windows select from the
fixed global matrix; they are not a moving clipmap grid. Below 60 degrees pitch, the
GPU anchors a 128-cell patch mesh to the 512-reference-pixel WebMercator zoom, evaluates
projected geometry-cell span over the complete reference viewport footprint, and uses one
uniform level. At and above 60 degrees it probes standard parent candidates
directly and refines only where the rotation-invariant local projective Jacobian
exceeds the eight-reference-pixel cell threshold plus the explicit numerical tolerance.
Both paths conservatively reject invisible
candidates, perform local 2:1 closure, build the full-identity neighbor lookup, and
write indirect draw arguments in one bounded dispatch.

The COG manifest contains a complete immutable min/max elevation record for every declared
source tile. Geometry above z10 uses the z10 ancestor bound. These records tighten culling and
projected quality without allowing cache, network, residency, or atlas state to influence LoD.

The boundary can be configured before Vite starts:

```text
VITE_UNDERWATER_TERRAIN_VARIABLE_LOD_PITCH_DEGREES=55 npm run dev
```

Missing or blank input uses 60. Values must be finite degrees from 0 through 90;
invalid input fails before GPU initialization. This environment variable is example
composition only. Geo receives normalized radians and never reads Vite or process
environment state.

This is a hard quality/performance boundary. A camera immediately below the threshold
keeps one level over the full footprint and can draw substantially more geometry than
the variable cut at the boundary. Lower the environment value when sustained tilted
interaction matters more than uniform pre-boundary detail.

The cover also emits desired raster facts. A z14 geometry patch retains
`desiredSampleLevel = 14` while lowering its executable request to the corresponding
z10 source ancestor. `VirtualRasterRuntime.reconcileViewDemands()` consumes those
explicit pages. The scheduler marks exact-resident pages used and requests only missing
pages within the runtime-owned demand budget. Virtual Raster never inspects zoom or
selects geometry LoD.

Terrain samples by global fixed coordinate. Until an exact source page is resident,
the page table resolves a lower ancestor without changing geometry topology. Mesh
stitching uses only the standard geometry cover. Wireframe mode therefore shows
post-z10 geometry directly while network, cache, and atlas activity remain source
truthful.

The application does not own the terrain vertex shader. Geo's
`webMercatorTerrainWgslModule` generates logical patch lookup, high-precision
camera-relative positioning, cross-LoD mesh stitching, Virtual Raster height
sampling, and the built-in wireframe fragment. This example's
`terrain-presentation.wgsl` contains only the shaded fragment presentation.

The `Cache` folder exposes all supported application cache settings:

- `Cache policy`: `Disabled`, `Session`, `Durable`, or `Clear on open`;
- `Namespace`, `Maximum MiB`, `Maximum entries`, and `Persistence` under
  `Advanced`;
- `Apply & Reload` to validate the complete draft, save the preference, and
  rebuild the terrain runtime from the resulting URL;
- `Restore defaults` to remove the saved preference and cache query parameters.

Edits remain a panel-only draft until `Apply & Reload` is selected. The running
Worker, persistent cache, and GPU virtual raster are never hot-switched.

The panel stores only its versioned configuration at
`geoscratch.examples.underwaterTerrain.cache-panel.v1` in `localStorage`. It does not store
tile bytes, cache metadata, entry keys, or diagnostics there. A URL containing
any cache parameter is authoritative for that load; a saved preference is used
only when the URL contains no cache parameters. If `localStorage` is unavailable,
explicit URL configuration still works and the panel reports the degraded
preference state.

`Restore defaults` does not delete existing durable IndexedDB or OPFS cache
payloads. Use the cache API's explicit invalidation or clear operation when the
application intends to remove stored data.

Persistent storage is application-configurable:

```text
http://localhost:5173/underwaterTerrain/?cache=persistent&cacheLifecycle=session
http://localhost:5173/underwaterTerrain/?cache=persistent&cacheLifecycle=durable-reuse
http://localhost:5173/underwaterTerrain/?cache=persistent&cacheLifecycle=durable-clear-before-open
```

Supported cache parameters are:

| Parameter | Values | Default when `cache=persistent` |
| --- | --- | --- |
| `cacheNamespace` | non-empty namespace | `geoscratch-dem-webmercator-raw-v2` |
| `cacheLifecycle` | `session`, `durable-reuse`, `durable-clear-before-open` | `session` |
| `cacheMaxMiB` | integer from 1 through 4096 | `128` |
| `cacheMaxEntries` | integer from 1 through 65536 | `2048` |
| `cachePersistence` | `best-effort`, `request` | `best-effort` |

`session` still uses IndexedDB and OPFS during the page lifetime. Use `cache=none`
when the visualization must not write disk-backed cache data. `request` asks the
browser storage manager to protect origin data from automatic eviction; it does not
change the selected cache lifecycle.

`cacheMaxMiB` and `cacheMaxEntries` are totals for the whole example, not
per-Worker multipliers. The executor partitions both totals exactly over the active
cache shards. If the entry total is smaller than the Worker count, remaining Workers
run without a cache shard.
