# Examples backend

One Python environment and HTTP application serve the example datasets. The DEM
and Flow modules retain their own manifests, tile encodings, cache semantics,
build tools, and tests. This is local example infrastructure, outside the
published `geoscratch` package.

## Setup

From the repository root, with Python 3.12–3.14:

```sh
npm run backend:setup
npm run dev:backend
```

The shared service defaults to `http://127.0.0.1:8790`. Both datasets are available
in the same process:

| Prefix | Dataset | Endpoints below the prefix |
| --- | --- | --- |
| `/api/dem/` | Underwater Terrain elevation | `manifest.json`, `tiles/WebMercatorQuad/{matrix}/{row}/{col}.png`, `health`, `stats` |
| `/api/flow/` | Flow Field velocity | `manifest.json`, `tiles/WebMercatorQuad/{sampleKey}/{matrix}/{row}/{col}.rg32f`, `health`, `stats` |

`GET /api/health` returns process liveness with HTTP 200 and `Cache-Control:
no-store`. Its `modules` describe dataset admission at startup; `status` is `ok`
when both were admitted, or `degraded` otherwise. Dataset-specific endpoints
retain runtime validation. It is not a full artifact-integrity check.

If one dataset cannot initialize, its requests return HTTP 503 with
`detail.code: EXAMPLES_DATASET_UNAVAILABLE`, dataset identity, a bounded cause,
and preparation/recovery guidance. Other datasets remain usable. Full errors go
to the backend log. Initialization is attempted once per process; repairing or
replacing a dataset requires restarting the backend. A process/native crash
still affects both modules; this is application-level initialization isolation.

Serving never builds data. Flow retains its immutable startup identity and
fingerprint checks. Published manifest bytes, relative page paths, ETags, tile
bytes, and cache policies are preserved through the prefixed routes.

## Prepare DEM data

```sh
npm run data:dem:build
```

The input remains `examples/underwaterTerrain/assets/dem.png`, and output remains
`examples/underwaterTerrain/tile-server/cache/`. Existing data requires no move
or rebuild. See [DEM data documentation](../underwaterTerrain/tile-server/README.md).

## Prepare Flow data

The existing collection remains at `examples/flowField/tile-server/cog-collection/`.
The descriptor stays beside it at `source-dataset.json`; raw source files remain
in `examples/public/json/examples/flow/`.

For a new collection, inspect the read-only plan before starting construction:

```sh
npm run data:flow:plan
npm run data:flow:build
```

These commands explicitly select all source times at matrix 10 and use the
documented 11,953,369-byte snapshot estimate. The build enforces existing storage
budgets and does not replace an existing collection automatically. Resume,
replacement, source selection, and custom budgets remain explicit builder
options; see [Flow construction documentation](../flowField/tile-server/README.md).

Both modules' CLI tools are installed in `examples/backend/.venv/bin/`. Standalone
`dem-tile-serve` and `flow-field-tile-serve` remain available for isolated tests
and direct `?tileServer=` integrations; ordinary example browsing uses the shared
service. Custom shared inputs can be selected with `--dem-output` and
`--flow-output`; construction commands accept their existing `--output` options.

## Verify

```sh
npm run test:backend
```

The shared pytest configuration collects composition tests here and the existing
DEM/Flow suites beside their datasets, using importlib mode for duplicate test
filenames. Backend source and dependencies live here exclusively. Old local
per-example virtual environments are unused and are not automatically deleted.
