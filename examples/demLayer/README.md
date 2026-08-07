# DEM Layer

The DEM Layer streams standard `WebMercatorQuad` height tiles through Workers into
a bounded GPU virtual-raster atlas. Start the local tile service as documented in
[`tile-server/README.md`](./tile-server/README.md), then run `npm run dev` from the
repository root.

Disk caching is disabled by default:

```text
http://localhost:5173/demLayer/?cache=none
```

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
