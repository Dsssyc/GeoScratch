from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path
from typing import Callable

import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse


EXAMPLES_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DEM_OUTPUT = EXAMPLES_ROOT / "underwaterTerrain/tile-server/cache"
DEFAULT_FLOW_OUTPUT = EXAMPLES_ROOT / "flowField/tile-server/cog-collection"
LOGGER = logging.getLogger("uvicorn.error")


def _dem_app(output: Path) -> FastAPI:
    from geoscratch_dem_tiles.service import create_app

    return create_app(output)


def _flow_app(output: Path) -> FastAPI:
    from geoscratch_flow_field_tiles.service import create_app

    return create_app(output)


def _unavailable_app(detail: dict[str, str]) -> FastAPI:
    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

    @app.api_route("/{path:path}", methods=["GET", "HEAD"])
    def unavailable(path: str) -> JSONResponse:
        return JSONResponse(
            {"detail": detail}, status_code=503,
            headers={"Cache-Control": "no-store"},
        )

    return app


def create_app(
    dem_output: str | Path = DEFAULT_DEM_OUTPUT,
    flow_output: str | Path = DEFAULT_FLOW_OUTPUT,
) -> FastAPI:
    """Admit each dataset independently, then retain its identity until restart."""
    app = FastAPI(title="GeoScratch examples backend", openapi_url=None)
    modules: dict[str, dict[str, str]] = {}
    factories: tuple[tuple[str, Path, Callable[[Path], FastAPI], str], ...] = (
        ("dem", Path(dem_output), _dem_app, "npm run data:dem:build"),
        ("flow", Path(flow_output), _flow_app, "See examples/backend/README.md#prepare-flow-data"),
    )
    for name, output, factory, preparation in factories:
        try:
            child = factory(output)
            modules[name] = {"status": "ready", "healthUrl": f"/api/{name}/health"}
        except Exception as error:
            # Dataset admission is the isolation boundary. Log the full cause;
            # serve a bounded diagnostic instead of aborting unrelated modules.
            LOGGER.exception("Cannot initialize examples dataset %s", name)
            detail = {
                "code": "EXAMPLES_DATASET_UNAVAILABLE",
                "dataset": name,
                "message": f"{type(error).__name__}: {str(error)[:500]}",
                "preparation": preparation,
                "recovery": "Prepare or repair the dataset, then restart the backend.",
            }
            child = _unavailable_app(detail)
            modules[name] = {"status": "unavailable", **detail}
        app.mount(f"/api/{name}", child)

    @app.get("/api/health")
    def health() -> JSONResponse:
        # Liveness is independent of dataset readiness. Module states describe
        # startup admission; their own endpoints retain runtime validation.
        return JSONResponse({
            "service": "geoscratch-examples-backend",
            "pid": os.getpid(),
            "status": "ok" if all(
                module["status"] == "ready" for module in modules.values()
            ) else "degraded",
            "modules": modules,
        }, headers={"Cache-Control": "no-store"})

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve all GeoScratch example datasets")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--dem-output", type=Path, default=DEFAULT_DEM_OUTPUT)
    parser.add_argument("--flow-output", type=Path, default=DEFAULT_FLOW_OUTPUT)
    args = parser.parse_args()
    uvicorn.run(create_app(args.dem_output, args.flow_output),
                host=args.host, port=args.port, access_log=False)


if __name__ == "__main__":
    main()
