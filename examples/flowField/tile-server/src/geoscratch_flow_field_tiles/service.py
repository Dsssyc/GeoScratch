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
from .cog import COG_ARTIFACT_MARKER
from .cog_tiles import CogVelocityTile, CogVelocityTileReader
from .collection import (
    COG_COLLECTION_MARKER,
    _shared_snapshot_contract,
    _validate_collection_manifest_identity,
)


FLOW_RG32F_MEDIA_TYPE = "application/vnd.geoscratch.flow-rg32f"
REVALIDATED_CACHE_CONTROL = "public, no-cache"


@dataclass
class AggregateStats:
    matrix_ids: tuple[str, ...]
    time_ids: tuple[str, ...]
    tile_requests: int = 0
    tile_successes: int = 0
    tile_not_found: int = 0
    tile_failures: int = 0
    tile_not_modified: int = 0
    cog_window_reads: int = 0
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

    def record_not_modified(self, *, cog_window: bool = False) -> None:
        with self.lock:
            self.tile_not_modified += 1
            if cog_window:
                self.cog_window_reads += 1

    def record_success(
        self,
        byte_count: int,
        matrix_id: str,
        time_id: str,
        *,
        cog_window: bool = False,
    ) -> None:
        with self.lock:
            self.tile_successes += 1
            if cog_window:
                self.cog_window_reads += 1
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
                "cogWindowReads": self.cog_window_reads,
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
    backend = "precomputed-pages"
    uses_cog_windows = False

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
        self._verified_tiles: dict[Path, tuple[int, int, int, int, int]] = {}
        self._verified_tiles_lock = threading.Lock()

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

    def ensure_tile_available(
        self,
        page: dict[str, Any],
    ) -> tuple[Path, tuple[int, int, int, int, int]]:
        relative_path = Path(page["path"])
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise FileNotFoundError("declared Flow Field page path is invalid")
        path = self.output_directory / relative_path
        if not path.is_file():
            raise FileNotFoundError(f"declared Flow Field page is missing: {relative_path}")
        stat = path.stat()
        if stat.st_size != page["byteLength"]:
            raise FileNotFoundError(
                f"declared Flow Field page has the wrong byte length: {relative_path}"
            )
        return path, (
            stat.st_dev,
            stat.st_ino,
            stat.st_size,
            stat.st_mtime_ns,
            stat.st_ctime_ns,
        )

    def verify_tile(self, page: dict[str, Any]) -> bool:
        path, fingerprint = self.ensure_tile_available(page)
        with self._verified_tiles_lock:
            if self._verified_tiles.get(path) == fingerprint:
                return False
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != page["sha256"]:
            raise FileNotFoundError(
                f"declared Flow Field page has the wrong hash: {Path(page['path'])}"
            )
        _path, after = self.ensure_tile_available(page)
        if after != fingerprint:
            raise FileNotFoundError(
                f"declared Flow Field page changed while being verified: {Path(page['path'])}"
            )
        with self._verified_tiles_lock:
            self._verified_tiles[path] = fingerprint
        return False

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
        path, fingerprint = self.ensure_tile_available(page)
        relative_path = Path(page["path"])
        content = path.read_bytes()
        _path, after = self.ensure_tile_available(page)
        if after != fingerprint:
            raise FileNotFoundError(
                f"declared Flow Field page changed while being read: {relative_path}"
            )
        with self._verified_tiles_lock:
            is_verified = self._verified_tiles.get(path) == fingerprint
        if not is_verified and hashlib.sha256(content).hexdigest() != page["sha256"]:
            raise FileNotFoundError(
                f"declared Flow Field page has the wrong hash: {relative_path}"
            )
        if not is_verified:
            with self._verified_tiles_lock:
                self._verified_tiles[path] = fingerprint
        return TileRead(content=content, page=page, time_id=time_id)


class CogCollectionTileStore:
    backend = "cog-collection"
    uses_cog_windows = True

    def __init__(
        self,
        output_directory: str | Path,
        *,
        max_window_reads: int = 4,
    ) -> None:
        if (
            isinstance(max_window_reads, bool)
            or not isinstance(max_window_reads, int)
            or max_window_reads <= 0
        ):
            raise ValueError("max_window_reads must be a positive integer")
        self.output_directory = Path(output_directory).resolve()
        marker_path = self.output_directory / COG_COLLECTION_MARKER
        collection_manifest_path = self.output_directory / "manifest.json"
        runtime_manifest_path = self.output_directory / "runtime-manifest.json"
        if (
            marker_path.is_symlink()
            or collection_manifest_path.is_symlink()
            or runtime_manifest_path.is_symlink()
            or not marker_path.is_file()
            or not collection_manifest_path.is_file()
            or not runtime_manifest_path.is_file()
        ):
            raise FileNotFoundError("Flow Field COG collection metadata is unavailable")
        marker = _read_json(marker_path, "Flow Field COG collection marker")
        collection_manifest = _read_json(
            collection_manifest_path,
            "Flow Field COG collection manifest",
        )
        runtime_bytes = runtime_manifest_path.read_bytes()
        identity = _validate_collection_manifest_identity(
            collection_manifest,
            runtime_bytes,
        )
        if marker != {
            "kind": "geoscratch-flow-field-cog-collection",
            "contentVersion": identity["contentVersion"],
        }:
            raise ValueError("Flow Field COG collection marker is invalid")
        runtime_record = collection_manifest.get("runtimeManifest")
        if (
            not isinstance(runtime_record, dict)
            or runtime_record.get("path") != "runtime-manifest.json"
        ):
            raise ValueError("Flow Field COG collection runtime path is invalid")

        self.collection_manifest = collection_manifest
        self.manifest_path = runtime_manifest_path
        self.manifest_bytes = runtime_bytes
        self.manifest = json.loads(runtime_bytes)
        self.manifest_etag = f'"{hashlib.sha256(runtime_bytes).hexdigest()}"'
        self.matrix_ids = tuple(self.manifest["tileMatrixSet"]["tileMatrixIds"])
        self.time_ids = tuple(
            f"t{time_record['timeIndex']:02d}"
            for time_record in self.manifest["times"]
        )
        self.pages = _page_records(self.manifest["pages"])
        self._window_reads = threading.BoundedSemaphore(max_window_reads)
        self._readers: dict[str, CogVelocityTileReader] = {}
        self._cog_paths: dict[str, Path] = {}
        self._cog_fingerprints: dict[str, tuple[int, int, int, int, int]] = {}
        self._verified_pages: dict[
            tuple[str, str, int, int, str],
            tuple[int, int, int, int, int],
        ] = {}
        self._verified_pages_lock = threading.Lock()

        facts = collection_manifest["construction"]["facts"]
        records = facts["snapshots"]
        expected_times = {f"t{record['timeIndex']:02d}" for record in records}
        if expected_times != set(self.time_ids):
            raise ValueError("Flow Field COG collection runtime times are inconsistent")
        for record in records:
            self._open_snapshot(record)
        if set(self._readers) != set(self.time_ids):
            raise ValueError("Flow Field COG collection reader inventory is incomplete")

    def _open_snapshot(self, record: dict[str, Any]) -> None:
        time_index = record.get("timeIndex")
        if isinstance(time_index, bool) or not isinstance(time_index, int) or time_index < 0:
            raise ValueError("Flow Field COG collection snapshot time is invalid")
        time_id = f"t{time_index:02d}"
        expected_directory = f"snapshots/{time_id}"
        expected_manifest = f"{expected_directory}/manifest.json"
        if (
            record.get("directory") != expected_directory
            or record.get("manifestPath") != expected_manifest
        ):
            raise ValueError("Flow Field COG collection snapshot path is invalid")
        manifest_path = _safe_collection_path(
            self.output_directory,
            record.get("manifestPath"),
            "snapshot manifest",
        )
        cog_path = _safe_collection_path(
            self.output_directory,
            record.get("cogPath"),
            "snapshot COG",
        )
        marker_path = _safe_collection_path(
            self.output_directory,
            f"{expected_directory}/{COG_ARTIFACT_MARKER}",
            "snapshot marker",
        )
        if (
            manifest_path.is_symlink()
            or cog_path.is_symlink()
            or marker_path.is_symlink()
            or not manifest_path.is_file()
            or not cog_path.is_file()
            or not marker_path.is_file()
            or _sha256_file(manifest_path) != record.get("manifestSha256")
        ):
            raise ValueError("Flow Field COG collection snapshot artifact is invalid")
        snapshot_manifest = _read_json(manifest_path, "Flow Field COG snapshot manifest")
        if _read_json(marker_path, "Flow Field COG snapshot marker") != {
            "kind": "geoscratch-flow-field-cog-artifact",
            "contentVersion": record.get("contentVersion"),
        }:
            raise ValueError("Flow Field COG collection snapshot marker is invalid")
        construction = snapshot_manifest.get("construction")
        snapshot_facts = (
            construction.get("facts")
            if isinstance(construction, dict)
            else None
        )
        snapshot = (
            snapshot_facts.get("snapshot")
            if isinstance(snapshot_facts, dict)
            else None
        )
        cog = (
            snapshot_facts.get("cog")
            if isinstance(snapshot_facts, dict)
            else None
        )
        if (
            not isinstance(snapshot, dict)
            or not isinstance(cog, dict)
            or snapshot.get("timeIndex") != time_index
            or snapshot.get("modelTime") != record.get("modelTime")
            or snapshot.get("velocityHash") != record.get("velocityHash")
            or snapshot_manifest.get("contentVersion") != record.get("contentVersion")
            or snapshot_manifest.get("sourceHash") != record.get("sourceHash")
            or cog.get("sha256") != record.get("cogSha256")
            or cog.get("sizeBytes") != record.get("cogSizeBytes")
            or cog_path.name != cog.get("path")
            or _shared_snapshot_contract(snapshot_manifest)
            != self.collection_manifest["construction"]["facts"][
                "sharedSnapshotContract"
            ]
        ):
            raise ValueError("Flow Field COG collection snapshot identity is invalid")
        before = _file_fingerprint(cog_path)
        reader = CogVelocityTileReader(manifest_path, cog_path)
        after = _file_fingerprint(cog_path)
        if before != after or reader.time_index != time_index:
            raise ValueError("Flow Field COG collection snapshot changed during startup")
        self._readers[time_id] = reader
        self._cog_paths[time_id] = cog_path
        self._cog_fingerprints[time_id] = after

    def tile_facts(
        self,
        time_id: str,
        matrix_id: str,
        tile_row: int,
        tile_col: int,
    ) -> dict[str, Any] | None:
        if tile_row < 0 or tile_col < 0:
            return None
        return self.pages.get((time_id, matrix_id, tile_row, tile_col))

    def etag(self, page: dict[str, Any]) -> str:
        return f'"{page["sha256"]}"'

    def verify_tile(self, page: dict[str, Any]) -> bool:
        time_id = f"t{page['timeIndex']:02d}"
        key = (
            time_id,
            page["matrixId"],
            page["tileRow"],
            page["tileCol"],
            page["sha256"],
        )
        fingerprint = self._ensure_cog_available(page)
        with self._verified_pages_lock:
            if self._verified_pages.get(key) == fingerprint:
                return False
        tile = self._read_cog_tile(page, time_id)
        with self._verified_pages_lock:
            self._verified_pages[key] = fingerprint
        return True

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
        tile = self._read_cog_tile(page, time_id)
        key = (time_id, matrix_id, tile_row, tile_col, page["sha256"])
        fingerprint = self._cog_fingerprints[time_id]
        with self._verified_pages_lock:
            self._verified_pages[key] = fingerprint
        return TileRead(content=tile.content, page=page, time_id=time_id)

    def _read_cog_tile(
        self,
        page: dict[str, Any],
        time_id: str,
    ) -> CogVelocityTile:
        reader = self._readers[time_id]
        try:
            with self._window_reads:
                before = self._ensure_cog_available(page)
                tile = reader.read_tile(
                    page["matrixId"],
                    page["tileRow"],
                    page["tileCol"],
                )
                after = self._ensure_cog_available(page)
        except (OSError, RuntimeError, ValueError) as error:
            raise OSError(f"Flow Field COG window read failed: {error}") from error
        if before != after:
            raise OSError("Flow Field COG changed during its window read")
        if (
            len(tile.content) != page["byteLength"]
            or tile.sha256 != page["sha256"]
            or tile.maximum_speed != page["maximumSpeed"]
        ):
            raise OSError("Flow Field COG runtime page identity changed")
        return tile

    def _ensure_cog_available(
        self,
        page: dict[str, Any],
    ) -> tuple[int, int, int, int, int]:
        time_id = f"t{page['timeIndex']:02d}"
        path = self._cog_paths.get(time_id)
        expected = self._cog_fingerprints.get(time_id)
        if path is None or expected is None:
            raise FileNotFoundError(f"Flow Field COG snapshot {time_id} is unavailable")
        try:
            observed = _file_fingerprint(path)
        except OSError as error:
            raise FileNotFoundError(
                f"Flow Field COG snapshot {time_id} is unavailable"
            ) from error
        if observed != expected:
            raise FileNotFoundError(f"Flow Field COG snapshot {time_id} changed after startup")
        return observed


def _page_records(
    records: list[dict[str, Any]],
) -> dict[tuple[str, str, int, int], dict[str, Any]]:
    pages: dict[tuple[str, str, int, int], dict[str, Any]] = {}
    for page in records:
        time_id = f"t{page['timeIndex']:02d}"
        key = (time_id, page["matrixId"], page["tileRow"], page["tileCol"])
        if key in pages:
            raise ValueError(f"Flow Field runtime manifest contains a duplicate page: {key}")
        pages[key] = page
    return pages


def _safe_collection_path(root: Path, value: object, label: str) -> Path:
    if not isinstance(value, str) or not value:
        raise ValueError(f"Flow Field COG collection {label} path is invalid")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts or relative.as_posix() != value:
        raise ValueError(f"Flow Field COG collection {label} path is invalid")
    candidate = root
    for part in relative.parts:
        candidate = candidate / part
        if candidate.is_symlink():
            raise ValueError(f"Flow Field COG collection {label} path is invalid")
    try:
        candidate.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (FileNotFoundError, ValueError) as error:
        raise ValueError(f"Flow Field COG collection {label} path is invalid") from error
    return candidate


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"{label} is unreadable") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_fingerprint(path: Path) -> tuple[int, int, int, int, int]:
    if path.is_symlink() or not path.is_file():
        raise FileNotFoundError(path)
    stat = path.stat()
    return (
        stat.st_dev,
        stat.st_ino,
        stat.st_size,
        stat.st_mtime_ns,
        stat.st_ctime_ns,
    )


def _create_store(
    output_directory: str | Path,
    *,
    max_cog_window_reads: int,
) -> VelocityTileStore | CogCollectionTileStore:
    output = Path(output_directory).resolve()
    marker = output / COG_COLLECTION_MARKER
    if marker.exists() or marker.is_symlink():
        return CogCollectionTileStore(
            output,
            max_window_reads=max_cog_window_reads,
        )
    return VelocityTileStore(output)


def create_app(
    output_directory: str | Path = DEFAULT_OUTPUT_DIRECTORY,
    *,
    max_cog_window_reads: int = 4,
) -> FastAPI:
    store = _create_store(
        output_directory,
        max_cog_window_reads=max_cog_window_reads,
    )
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
        payload = {
            "status": "ok",
            "contentVersion": store.manifest["contentVersion"],
            "pageCount": len(store.pages),
            "particleSimulation": store.manifest["construction"]["quality"][
                "particleSimulation"
            ],
        }
        if store.backend == "cog-collection":
            payload["backend"] = store.backend
        response = JSONResponse(payload)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/manifest.json")
    def manifest(request: Request) -> Response:
        headers = {
            "Cache-Control": REVALIDATED_CACHE_CONTROL,
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
        headers = {"Cache-Control": REVALIDATED_CACHE_CONTROL, "ETag": etag}
        conditional = request.headers.get("if-none-match") == etag
        try:
            if conditional:
                conditional_cog_window = store.verify_tile(page)
                tile_read = None
            else:
                conditional_cog_window = False
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
        if conditional:
            stats.record_not_modified(cog_window=conditional_cog_window)
            return Response(status_code=304, headers=headers)
        if tile_read is None:
            raise RuntimeError("Flow Field tile read unexpectedly missing")
        stats.record_success(
            len(tile_read.content),
            tile_read.page["matrixId"],
            tile_read.time_id,
            cog_window=store.uses_cog_windows,
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
    parser.add_argument("--max-cog-window-reads", type=int, default=4)
    arguments = parser.parse_args()
    uvicorn.run(
        create_app(
            arguments.output,
            max_cog_window_reads=arguments.max_cog_window_reads,
        ),
        host=arguments.host,
        port=arguments.port,
        access_log=False,
    )


if __name__ == "__main__":
    main()
