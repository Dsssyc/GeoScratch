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
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from PIL import Image
from rasterio.crs import CRS
from rio_tiler.io import Reader

from .build import DEFAULT_OUTPUT_DIRECTORY, TILE_SIZE


@dataclass
class AggregateStats:
    tile_requests: int = 0
    tile_successes: int = 0
    tile_not_found: int = 0
    tile_failures: int = 0
    cog_window_reads: int = 0
    bytes_served: int = 0
    overview_reads: dict[int, int] = field(
        default_factory=lambda: {1: 0, 2: 0, 4: 0, 8: 0}
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

    def record_success(self, byte_count: int, decimation: int) -> None:
        with self.lock:
            self.tile_successes += 1
            self.cog_window_reads += 1
            self.bytes_served += byte_count
            self.overview_reads[decimation] += 1

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "tileRequests": self.tile_requests,
                "tileSuccesses": self.tile_successes,
                "tileNotFound": self.tile_not_found,
                "tileFailures": self.tile_failures,
                "cogWindowReads": self.cog_window_reads,
                "bytesServed": self.bytes_served,
                "overviewReads": {
                    str(factor): self.overview_reads[factor]
                    for factor in (1, 2, 4, 8)
                },
            }


@dataclass(frozen=True)
class TileRead:
    content: bytes
    valid_width: int
    valid_height: int
    decimation: int


class DemCogStore:
    def __init__(self, output_directory: str | Path) -> None:
        self.output_directory = Path(output_directory).resolve()
        self.cog_path = self.output_directory / "dem.cog.tif"
        self.manifest_path = self.output_directory / "manifest.json"
        if not self.manifest_path.is_file():
            raise FileNotFoundError(f"DEM manifest does not exist: {self.manifest_path}")
        self.manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        self.levels = {
            int(level["zoom"]): level
            for level in self.manifest["levels"]
        }

    def tile_facts(self, zoom: int, page_x: int, page_y: int) -> dict[str, int] | None:
        level = self.levels.get(zoom)
        if level is None or page_x < 0 or page_y < 0:
            return None
        if page_x >= level["pagesX"] or page_y >= level["pagesY"]:
            return None
        valid_width = min(TILE_SIZE, level["width"] - page_x * TILE_SIZE)
        valid_height = min(TILE_SIZE, level["height"] - page_y * TILE_SIZE)
        return {
            "validWidth": valid_width,
            "validHeight": valid_height,
            "decimation": level["decimation"],
        }

    def read_tile(self, zoom: int, page_x: int, page_y: int) -> TileRead:
        facts = self.tile_facts(zoom, page_x, page_y)
        if facts is None:
            raise KeyError((zoom, page_x, page_y))
        if not self.cog_path.is_file():
            raise FileNotFoundError(self.cog_path)

        width = self.manifest["rasterDimensions"]["width"]
        height = self.manifest["rasterDimensions"]["height"]
        west, south, east, north = self.manifest["bounds"]
        decimation = facts["decimation"]
        source_x0 = page_x * TILE_SIZE * decimation
        source_y0 = page_y * TILE_SIZE * decimation
        source_x1 = min(width, source_x0 + facts["validWidth"] * decimation)
        source_y1 = min(height, source_y0 + facts["validHeight"] * decimation)
        bounds = (
            west + (east - west) * source_x0 / width,
            south + (north - south) * source_y0 / height,
            west + (east - west) * source_x1 / width,
            south + (north - south) * source_y1 / height,
        )

        with Reader(str(self.cog_path)) as reader:
            image = reader.part(
                bounds,
                bounds_crs=CRS.from_epsg(4326),
                dst_crs=CRS.from_epsg(4326),
                indexes=1,
                width=facts["validWidth"],
                height=facts["validHeight"],
                resampling_method="nearest",
            )
        north_up = np.ma.filled(image.array, 0)[0].astype(np.uint8, copy=False)
        south_up = np.flipud(north_up)
        tile = np.zeros((TILE_SIZE, TILE_SIZE), dtype=np.uint8)
        tile[: facts["validHeight"], : facts["validWidth"]] = south_up
        encoded = io.BytesIO()
        Image.fromarray(tile, mode="L").save(
            encoded,
            format="PNG",
            optimize=False,
            compress_level=9,
        )
        return TileRead(
            content=encoded.getvalue(),
            valid_width=facts["validWidth"],
            valid_height=facts["validHeight"],
            decimation=decimation,
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

    @app.get("/tiles/{zoom}/{page_x}/{page_y}.png")
    def tile(zoom: int, page_x: int, page_y: int) -> Response:
        stats.record_request()
        if store.tile_facts(zoom, page_x, page_y) is None:
            stats.record_not_found()
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "DEM_TILE_OUT_OF_RANGE",
                    "tile": {"zoom": zoom, "x": page_x, "y": page_y},
                },
            )
        try:
            tile_read = store.read_tile(zoom, page_x, page_y)
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
        stats.record_success(len(tile_read.content), tile_read.decimation)
        return Response(
            tile_read.content,
            media_type="image/png",
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "ETag": (
                    f'"{store.manifest["contentVersion"]}-{zoom}-{page_x}-{page_y}"'
                ),
                "X-DEM-Valid-Width": str(tile_read.valid_width),
                "X-DEM-Valid-Height": str(tile_read.valid_height),
                "X-DEM-Overview-Decimation": str(tile_read.decimation),
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
