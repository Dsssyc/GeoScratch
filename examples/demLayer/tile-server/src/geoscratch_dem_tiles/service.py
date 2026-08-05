from __future__ import annotations

import argparse
import io
import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from PIL import Image
from rio_tiler.io import Reader

from .build import (
    DEFAULT_OUTPUT_DIRECTORY,
    TILE_SIZE,
    WEB_MERCATOR_QUAD_MAX_ZOOM,
    WEB_MERCATOR_QUAD_MIN_ZOOM,
)


@dataclass
class AggregateStats:
    tile_requests: int = 0
    tile_successes: int = 0
    tile_not_found: int = 0
    tile_failures: int = 0
    cog_window_reads: int = 0
    bytes_served: int = 0
    matrix_reads: dict[int, int] = field(
        default_factory=lambda: {
            zoom: 0
            for zoom in range(WEB_MERCATOR_QUAD_MIN_ZOOM, WEB_MERCATOR_QUAD_MAX_ZOOM + 1)
        }
    )
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def record_request(self) -> None:
        with self.lock:
            self.tile_requests += 1

    def record_not_found(self) -> None:
        with self.lock:
            self.tile_not_found += 1

    def record_failure(self) -> None:
        with self.lock:
            self.tile_failures += 1

    def record_success(self, byte_count: int, tile_matrix: int) -> None:
        with self.lock:
            self.tile_successes += 1
            self.cog_window_reads += 1
            self.bytes_served += byte_count
            self.matrix_reads[tile_matrix] += 1

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "tileRequests": self.tile_requests,
                "tileSuccesses": self.tile_successes,
                "tileNotFound": self.tile_not_found,
                "tileFailures": self.tile_failures,
                "cogWindowReads": self.cog_window_reads,
                "bytesServed": self.bytes_served,
                "matrixReads": {
                    str(matrix): self.matrix_reads[matrix]
                    for matrix in range(
                        WEB_MERCATOR_QUAD_MIN_ZOOM,
                        WEB_MERCATOR_QUAD_MAX_ZOOM + 1,
                    )
                },
            }


@dataclass(frozen=True)
class TileRead:
    content: bytes
    tile_matrix: int
    tile_row: int
    tile_col: int


class DemCogStore:
    def __init__(self, output_directory: str | Path) -> None:
        self.output_directory = Path(output_directory).resolve()
        self.cog_path = self.output_directory / "dem.cog.tif"
        self.manifest_path = self.output_directory / "manifest.json"
        if not self.manifest_path.is_file():
            raise FileNotFoundError(f"DEM manifest does not exist: {self.manifest_path}")
        self.manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        self.limits = {
            limit["matrixId"]: limit
            for limit in self.manifest["tileMatrixSet"]["limits"]
        }

    def tile_facts(
        self,
        tile_matrix: str,
        tile_row: int,
        tile_col: int,
    ) -> dict[str, int] | None:
        try:
            zoom = int(tile_matrix)
        except ValueError:
            return None
        if str(zoom) != tile_matrix or tile_row < 0 or tile_col < 0:
            return None
        limit = self.limits.get(tile_matrix)
        if limit is None:
            return None
        if not (
            limit["minTileRow"] <= tile_row <= limit["maxTileRow"]
            and limit["minTileCol"] <= tile_col <= limit["maxTileCol"]
        ):
            return None
        return {"zoom": zoom, "tileRow": tile_row, "tileCol": tile_col}

    def read_tile(self, tile_matrix: str, tile_row: int, tile_col: int) -> TileRead:
        facts = self.tile_facts(tile_matrix, tile_row, tile_col)
        if facts is None:
            raise KeyError((tile_matrix, tile_row, tile_col))
        if not self.cog_path.is_file():
            raise FileNotFoundError(self.cog_path)

        with Reader(str(self.cog_path)) as reader:
            image = reader.tile(
                tile_col,
                tile_row,
                facts["zoom"],
                tilesize=TILE_SIZE,
                indexes=1,
                resampling_method="nearest",
            )
        tile = np.ma.filled(image.array, 0)[0].astype(np.uint8, copy=False)
        encoded = io.BytesIO()
        Image.fromarray(tile, mode="L").save(
            encoded,
            format="PNG",
            optimize=False,
            compress_level=9,
        )
        return TileRead(
            content=encoded.getvalue(),
            tile_matrix=facts["zoom"],
            tile_row=tile_row,
            tile_col=tile_col,
        )

    def etag(self, tile_matrix: str, tile_row: int, tile_col: int) -> str:
        return (
            f'"{self.manifest["contentVersion"]}-WebMercatorQuad-'
            f'{tile_matrix}-{tile_row}-{tile_col}"'
        )


def create_app(output_directory: str | Path = DEFAULT_OUTPUT_DIRECTORY) -> FastAPI:
    store = DemCogStore(output_directory)
    stats = AggregateStats()
    app = FastAPI(title="GeoScratch DEM COG tiles", docs_url=None, redoc_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "HEAD", "OPTIONS"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> JSONResponse:
        status = "ok" if store.cog_path.is_file() else "unavailable"
        response = JSONResponse({
            "status": status,
            "contentVersion": store.manifest["contentVersion"],
        }, status_code=200 if status == "ok" else 503)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/manifest.json")
    def manifest() -> JSONResponse:
        response = JSONResponse(store.manifest)
        response.headers["Cache-Control"] = "public, max-age=300"
        response.headers["ETag"] = f'"{store.manifest["sourceHash"]}"'
        return response

    @app.get("/tiles/WebMercatorQuad/{tile_matrix}/{tile_row}/{tile_col}.png")
    def tile(tile_matrix: str, tile_row: int, tile_col: int, request: Request) -> Response:
        stats.record_request()
        if store.tile_facts(tile_matrix, tile_row, tile_col) is None:
            stats.record_not_found()
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "DEM_TILE_OUT_OF_RANGE",
                    "tile": {
                        "tileMatrix": tile_matrix,
                        "tileRow": tile_row,
                        "tileCol": tile_col,
                    },
                },
            )
        etag = store.etag(tile_matrix, tile_row, tile_col)
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag})
        try:
            tile_read = store.read_tile(tile_matrix, tile_row, tile_col)
        except FileNotFoundError as error:
            stats.record_failure()
            raise HTTPException(
                status_code=503,
                detail={"code": "DEM_COG_UNAVAILABLE", "message": str(error)},
            ) from error
        except Exception as error:
            stats.record_failure()
            raise HTTPException(
                status_code=500,
                detail={"code": "DEM_TILE_READ_FAILED", "message": str(error)},
            ) from error
        stats.record_success(len(tile_read.content), tile_read.tile_matrix)
        return Response(
            tile_read.content,
            media_type="image/png",
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "ETag": etag,
                "X-DEM-Tile-Matrix": str(tile_read.tile_matrix),
                "X-DEM-Tile-Row": str(tile_read.tile_row),
                "X-DEM-Tile-Col": str(tile_read.tile_col),
            },
        )

    @app.get("/stats")
    def tile_stats() -> JSONResponse:
        response = JSONResponse(stats.snapshot())
        response.headers["Cache-Control"] = "no-store"
        return response

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the GeoScratch DEM COG pyramid")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_DIRECTORY)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    arguments = parser.parse_args()
    uvicorn.run(
        create_app(arguments.output),
        host=arguments.host,
        port=arguments.port,
        access_log=False,
    )


if __name__ == "__main__":
    main()
