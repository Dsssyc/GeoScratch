from __future__ import annotations

import argparse
import hashlib
import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from .build import (
    DEFAULT_OUTPUT_DIRECTORY,
    PAGE_BYTE_LENGTH,
    validate_artifact_manifest,
)


FLOW_RG32F_MEDIA_TYPE = "application/vnd.geoscratch.flow-rg32f"
IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"


@dataclass
class AggregateStats:
    matrix_ids: tuple[str, ...]
    time_ids: tuple[str, ...]
    tile_requests: int = 0
    tile_successes: int = 0
    tile_not_found: int = 0
    tile_failures: int = 0
    tile_not_modified: int = 0
    bytes_served: int = 0
    matrix_reads: dict[str, int] = field(init=False)
    time_reads: dict[str, int] = field(init=False)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def __post_init__(self) -> None:
        self.matrix_reads = {matrix_id: 0 for matrix_id in self.matrix_ids}
        self.time_reads = {time_id: 0 for time_id in self.time_ids}

    def record_request(self) -> None:
        with self.lock:
            self.tile_requests += 1

    def record_not_found(self) -> None:
        with self.lock:
            self.tile_not_found += 1

    def record_failure(self) -> None:
        with self.lock:
            self.tile_failures += 1

    def record_not_modified(self) -> None:
        with self.lock:
            self.tile_not_modified += 1

    def record_success(self, byte_count: int, matrix_id: str, time_id: str) -> None:
        with self.lock:
            self.tile_successes += 1
            self.bytes_served += byte_count
            self.matrix_reads[matrix_id] += 1
            self.time_reads[time_id] += 1

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "tileRequests": self.tile_requests,
                "tileSuccesses": self.tile_successes,
                "tileNotFound": self.tile_not_found,
                "tileFailures": self.tile_failures,
                "tileNotModified": self.tile_not_modified,
                "bytesServed": self.bytes_served,
                "matrixReads": dict(self.matrix_reads),
                "timeReads": dict(self.time_reads),
            }


@dataclass(frozen=True)
class TileRead:
    content: bytes
    page: dict[str, Any]
    time_id: str


class VelocityTileStore:
    def __init__(self, output_directory: str | Path) -> None:
        self.output_directory = Path(output_directory).resolve()
        self.manifest_path = self.output_directory / "manifest.json"
        if not self.manifest_path.is_file():
            raise FileNotFoundError(
                f"Flow Field manifest does not exist: {self.manifest_path}"
            )
        self.manifest_bytes = self.manifest_path.read_bytes()
        self.manifest = json.loads(self.manifest_bytes)
        validate_artifact_manifest(self.manifest)
        self.manifest_etag = f'"{hashlib.sha256(self.manifest_bytes).hexdigest()}"'
        self.matrix_ids = tuple(self.manifest["tileMatrixSet"]["tileMatrixIds"])
        self.time_ids = tuple(
            f"t{time_record['timeIndex']:02d}"
            for time_record in self.manifest["times"]
        )
        pages: dict[tuple[str, str, int, int], dict[str, Any]] = {}
        for page in self.manifest["pages"]:
            time_id = f"t{page['timeIndex']:02d}"
            key = (
                time_id,
                page["matrixId"],
                page["tileRow"],
                page["tileCol"],
            )
            if key in pages:
                raise ValueError(f"Flow Field manifest contains a duplicate page: {key}")
            expected_path = (
                f"tiles/WebMercatorQuad/{time_id}/{page['matrixId']}/"
                f"{page['tileRow']}/{page['tileCol']}.rg32f"
            )
            if page["path"] != expected_path or page["byteLength"] != PAGE_BYTE_LENGTH:
                raise ValueError(f"Flow Field manifest page contract is invalid: {key}")
            pages[key] = page
        self.pages = pages

    def tile_facts(
        self,
        time_id: str,
        matrix_id: str,
        tile_row: int,
        tile_col: int,
    ) -> dict[str, Any] | None:
        if tile_row < 0 or tile_col < 0:
            return None
        page = self.pages.get((time_id, matrix_id, tile_row, tile_col))
        if page is None:
            return None
        return page

    def etag(self, page: dict[str, Any]) -> str:
        return f'"{page["sha256"]}"'

    def read_tile(
        self,
        time_id: str,
        matrix_id: str,
        tile_row: int,
        tile_col: int,
    ) -> TileRead:
        page = self.tile_facts(time_id, matrix_id, tile_row, tile_col)
        if page is None:
            raise KeyError((time_id, matrix_id, tile_row, tile_col))
        relative_path = Path(page["path"])
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise FileNotFoundError("declared Flow Field page path is invalid")
        path = self.output_directory / relative_path
        if not path.is_file():
            raise FileNotFoundError(f"declared Flow Field page is missing: {relative_path}")
        content = path.read_bytes()
        if len(content) != page["byteLength"]:
            raise FileNotFoundError(
                f"declared Flow Field page has the wrong byte length: {relative_path}"
            )
        if hashlib.sha256(content).hexdigest() != page["sha256"]:
            raise FileNotFoundError(
                f"declared Flow Field page has the wrong hash: {relative_path}"
            )
        return TileRead(content=content, page=page, time_id=time_id)


def create_app(output_directory: str | Path = DEFAULT_OUTPUT_DIRECTORY) -> FastAPI:
    store = VelocityTileStore(output_directory)
    stats = AggregateStats(store.matrix_ids, store.time_ids)
    app = FastAPI(title="GeoScratch Flow Field velocity tiles", docs_url=None, redoc_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "HEAD", "OPTIONS"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> JSONResponse:
        response = JSONResponse({
            "status": "ok",
            "contentVersion": store.manifest["contentVersion"],
            "pageCount": len(store.pages),
        })
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/manifest.json")
    def manifest(request: Request) -> Response:
        headers = {
            "Cache-Control": IMMUTABLE_CACHE_CONTROL,
            "ETag": store.manifest_etag,
        }
        if request.headers.get("if-none-match") == store.manifest_etag:
            return Response(status_code=304, headers=headers)
        return Response(
            content=store.manifest_bytes,
            media_type="application/json",
            headers=headers,
        )

    @app.get(
        "/tiles/WebMercatorQuad/{time_id}/{matrix_id}/{tile_row}/{tile_col}.rg32f"
    )
    def tile(
        time_id: str,
        matrix_id: str,
        tile_row: int,
        tile_col: int,
        request: Request,
    ) -> Response:
        stats.record_request()
        page = store.tile_facts(time_id, matrix_id, tile_row, tile_col)
        if page is None:
            stats.record_not_found()
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "FLOW_FIELD_TILE_OUT_OF_RANGE",
                    "tile": {
                        "time": time_id,
                        "tileMatrix": matrix_id,
                        "tileRow": tile_row,
                        "tileCol": tile_col,
                    },
                },
            )
        etag = store.etag(page)
        headers = {"Cache-Control": IMMUTABLE_CACHE_CONTROL, "ETag": etag}
        try:
            tile_read = store.read_tile(time_id, matrix_id, tile_row, tile_col)
        except (FileNotFoundError, OSError) as error:
            stats.record_failure()
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "FLOW_FIELD_TILE_ARTIFACT_UNAVAILABLE",
                    "message": str(error),
                },
            ) from error
        if request.headers.get("if-none-match") == etag:
            stats.record_not_modified()
            return Response(status_code=304, headers=headers)
        stats.record_success(
            len(tile_read.content),
            tile_read.page["matrixId"],
            tile_read.time_id,
        )
        return Response(
            content=tile_read.content,
            media_type=FLOW_RG32F_MEDIA_TYPE,
            headers=headers,
        )

    @app.get("/stats")
    def aggregate_stats() -> JSONResponse:
        response = JSONResponse(stats.snapshot())
        response.headers["Cache-Control"] = "no-store"
        return response

    return app


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Serve immutable GeoScratch Flow Field RG32F pages"
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_DIRECTORY)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8788)
    arguments = parser.parse_args()
    uvicorn.run(
        create_app(arguments.output),
        host=arguments.host,
        port=arguments.port,
        access_log=False,
    )


if __name__ == "__main__":
    main()
