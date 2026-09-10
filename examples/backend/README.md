# Examples backend

One Python environment and HTTP application serve the example datasets. The DEM
and Flow modules retain their own manifests, tile encodings, cache semantics,
build tools, and tests. This is local example infrastructure, outside the
published `geoscratch` package.

## Setup

From the repository root, with Python 3.12–3.14:

```sh
npm run backend:setup
npm run dev
```

The shared service defaults to `http://127.0.0.1:8790`. Both datasets are available
in the same process:

| Prefix | Dataset | Endpoints below the prefix |
| --- | --- | --- |
| `/api/dem/` | Underwater Terrain elevation | `manifest.json`, `tiles/WebMercatorQuad/{matrix}/{row}/{col}.png`, `health`, `stats` |
| `/api/flow/` | Flow Field velocity | `manifest.json`, `tiles/WebMercatorQuad/{sampleKey}/{matrix}/{row}/{col}.rg32f`, `health`, `stats` |

`npm run dev` builds the library and Worker modules, starts the backend, waits
for its own process's liveness response, then starts Vite. Browser defaults use
same-origin API paths through Vite. `Ctrl+C`/SIGTERM/SIGHUP and a service exit clean up
the invocation's owned process groups on macOS/Linux, including npm children.
An occupied backend port fails with guidance and leaves existing services alone.

Use `npm run dev:backend` or `npm run dev:frontend` to run only one side.
`npm run serve` starts the backend alongside Vite preview after `npm run build`.
Static deployments must provide equivalent `/api` routing or explicit
`?tileServer=` URLs; Vite's proxy is a development/preview facility.

`config.json` defines the shared default host and port. Set `EXAMPLES_BACKEND_PORT`
in the launching shell to override the port; separate frontend/backend terminals
must use the same value. `EXAMPLES_DEM_OUTPUT` and `EXAMPLES_FLOW_OUTPUT` optionally
select existing data directories, resolved from the repository root:

```sh
EXAMPLES_BACKEND_PORT=8791 npm run dev
npm run dev -- --host 127.0.0.1 --port 5174
```

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
node tests/browser/examples-backend.mjs
EXAMPLES_PROOF_PREVIEW=1 node tests/browser/examples-backend.mjs
```

The shared pytest configuration collects composition tests here and the existing
DEM/Flow suites beside their datasets, using importlib mode for duplicate test
filenames. Backend source and dependencies live here exclusively. Old local
per-example virtual environments are unused and are not automatically deleted.

The browser proof requires both existing datasets, installed Chrome with headless
WebGPU support, and built examples for preview mode. It switches the normal
examples browser from Underwater Terrain to Flow Field and back, verifies tile
responses, exact Flow page SHA and conditional requests, retains the same backend
PID, and verifies both service ports close. External basemap imagery is supplied
by a deterministic image fixture; actual DEM/Flow requests use the shared backend.
