# DEM Layer

The DEM Layer streams standard `WebMercatorQuad` height tiles through Workers into
a bounded GPU virtual-raster atlas. Start the local tile service as documented in
[`tile-server/README.md`](./tile-server/README.md), then run `npm run dev` from the
repository root.

Disk caching is disabled by default:

```text
http://localhost:5173/demLayer/?cache=none
```

## DEM controls

The `DEM Layer` panel in the upper-right corner contains live rendering controls
and cache configuration.

The `Rendering` folder exposes `Tile wireframe`. It switches immediately to the
already-created diagnostic pipeline: each logical render patch
`(matrixLevel, row, column)` receives a stable pseudo-random color and only the
post-stitch triangle edges are drawn. The setting is stored independently at
`geoscratch.examples.demLayer.rendering.v1` in `localStorage`; it does not reload
the page, alter cache query parameters, or rebuild the virtual raster.

## Data and geometry LoD

The source-backed `WebMercatorQuad` data frontier is capped by the manifest at
`z10`. Terrain geometry is independent: a persistent GPU compute stage expands
visible resident pages into frustum-culled render patches through `z14`, then
writes the LoD-map and terrain indirect draw arguments. Zooming beyond `z10`
therefore continues to refine the 64 by 64 terrain sectors without requesting,
decoding, or caching synthetic higher-level raster pages.

Every render patch retains its explicit Virtual Raster `samplingLevel`. The LoD
map stores geometry level and sampling level separately, so edge vertex snapping
uses render LoD while shared-edge height sampling uses the coarser available data
LoD. Wireframe mode makes this post-`z10` subdivision directly visible.

The `Cache` folder exposes all supported application cache settings:

- `Cache policy`: `Disabled`, `Session`, `Durable`, or `Clear on open`;
- `Namespace`, `Maximum MiB`, `Maximum entries`, and `Persistence` under
  `Advanced`;
- `Apply & Reload` to validate the complete draft, save the preference, and
  rebuild the DEM runtime from the resulting URL;
- `Restore defaults` to remove the saved preference and cache query parameters.

Edits remain a panel-only draft until `Apply & Reload` is selected. The running
Worker, persistent cache, and GPU virtual raster are never hot-switched.

The panel stores only its versioned configuration at
`geoscratch.examples.dem.cache-panel.v1` in `localStorage`. It does not store
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
http://localhost:5173/demLayer/?cache=persistent&cacheLifecycle=session
http://localhost:5173/demLayer/?cache=persistent&cacheLifecycle=durable-reuse
http://localhost:5173/demLayer/?cache=persistent&cacheLifecycle=durable-clear-before-open
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
