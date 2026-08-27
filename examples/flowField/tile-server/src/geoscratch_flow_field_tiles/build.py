from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import morecantile
import numpy as np

from .source import (
    DEFAULT_DATA_DIRECTORY,
    DEFAULT_DESCRIPTOR_PATH,
    SourceDataset,
    load_source_dataset,
)


TILE_SIZE = 256
MIN_TILE_MATRIX = 4
MAX_TILE_MATRIX = 9
MAX_TRIANGLE_EDGE_DEGREES = 0.04
PAGE_BYTE_LENGTH = TILE_SIZE * TILE_SIZE * 2 * 4
BUILD_ALGORITHM_VERSION = "flow-rg32f-wmq-v1"
WEB_MERCATOR_QUAD_URI = (
    "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad"
)
WEB_MERCATOR_CRS_URI = "http://www.opengis.net/def/crs/EPSG/0/3857"
WEB_MERCATOR_RADIUS = 6_378_137.0
WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066
TILE_SERVER_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_DIRECTORY = TILE_SERVER_ROOT / "cache"
WEB_MERCATOR_QUAD = morecantile.tms.get("WebMercatorQuad")


@dataclass(frozen=True)
class BuildResult:
    output_directory: Path
    manifest_path: Path
    source_hash: str
    content_version: str
    page_count: int
    total_raw_page_bytes: int
    duration_seconds: float


@dataclass(frozen=True)
class PageMapping:
    station_indices: np.ndarray
    weights: np.ndarray


class SupportedTriangleLocator:
    def __init__(self, dataset: SourceDataset) -> None:
        self.stations = dataset.stations.astype(np.float64)
        self.triangles = dataset.triangles.astype(np.int64)
        vertices = self.stations[self.triangles]
        edge_lengths = np.stack((
            np.linalg.norm(vertices[:, 0] - vertices[:, 1], axis=1),
            np.linalg.norm(vertices[:, 1] - vertices[:, 2], axis=1),
            np.linalg.norm(vertices[:, 2] - vertices[:, 0], axis=1),
        ), axis=1)
        self.supported_triangle_ids = np.flatnonzero(
            edge_lengths.max(axis=1) <= MAX_TRIANGLE_EDGE_DEGREES
        )
        west, south, _, _ = dataset.geographic_bounds
        self.origin = (west, south)
        bins: dict[tuple[int, int], list[int]] = {}
        for triangle_id in self.supported_triangle_ids:
            triangle_vertices = vertices[triangle_id]
            minimum = triangle_vertices.min(axis=0)
            maximum = triangle_vertices.max(axis=0)
            min_x = math.floor((minimum[0] - west) / MAX_TRIANGLE_EDGE_DEGREES)
            max_x = math.floor((maximum[0] - west) / MAX_TRIANGLE_EDGE_DEGREES)
            min_y = math.floor((minimum[1] - south) / MAX_TRIANGLE_EDGE_DEGREES)
            max_y = math.floor((maximum[1] - south) / MAX_TRIANGLE_EDGE_DEGREES)
            for bin_y in range(min_y, max_y + 1):
                for bin_x in range(min_x, max_x + 1):
                    bins.setdefault((bin_x, bin_y), []).append(int(triangle_id))
        self.bins = {key: tuple(values) for key, values in bins.items()}

    def locate(self, longitudes: np.ndarray, latitudes: np.ndarray) -> PageMapping:
        if longitudes.shape != latitudes.shape:
            raise ValueError("longitude and latitude arrays must have matching shapes")
        sample_count = longitudes.size
        station_indices = np.full((sample_count, 3), -1, dtype=np.int32)
        weights = np.zeros((sample_count, 3), dtype=np.float64)
        west, south = self.origin
        bin_x = np.floor(
            (longitudes - west) / MAX_TRIANGLE_EDGE_DEGREES
        ).astype(np.int64)
        bin_y = np.floor(
            (latitudes - south) / MAX_TRIANGLE_EDGE_DEGREES
        ).astype(np.int64)
        keys = np.stack((bin_x, bin_y), axis=1)
        order = np.lexsort((keys[:, 1], keys[:, 0]))
        sorted_keys = keys[order]
        group_starts = np.concatenate((
            np.asarray([0], dtype=np.int64),
            np.flatnonzero(np.any(sorted_keys[1:] != sorted_keys[:-1], axis=1)) + 1,
        ))
        group_ends = np.concatenate((
            group_starts[1:],
            np.asarray([sample_count], dtype=np.int64),
        ))
        for group_start, group_end in zip(group_starts, group_ends, strict=True):
            key = sorted_keys[group_start]
            candidates = self.bins.get((int(key[0]), int(key[1])))
            if not candidates:
                continue
            sample_indices = order[group_start:group_end]
            unresolved = np.ones(sample_indices.size, dtype=bool)
            x = longitudes[sample_indices]
            y = latitudes[sample_indices]
            for triangle_id in candidates:
                if not unresolved.any():
                    break
                triangle = self.triangles[triangle_id]
                vertices = self.stations[triangle]
                ax, ay = vertices[0]
                bx, by = vertices[1]
                cx, cy = vertices[2]
                denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
                if denominator == 0:
                    continue
                first = (
                    (by - cy) * (x - cx) + (cx - bx) * (y - cy)
                ) / denominator
                second = (
                    (cy - ay) * (x - cx) + (ax - cx) * (y - cy)
                ) / denominator
                third = 1.0 - first - second
                triangle_weights = np.stack((first, second, third), axis=1)
                inside = unresolved & np.all(triangle_weights >= -1e-12, axis=1)
                inside &= np.all(triangle_weights <= 1.0 + 1e-12, axis=1)
                if not inside.any():
                    continue
                resolved_samples = sample_indices[inside]
                station_indices[resolved_samples] = triangle.astype(np.int32)
                weights[resolved_samples] = triangle_weights[inside]
                unresolved[inside] = False
        return PageMapping(station_indices=station_indices, weights=weights)


def _tile_matrix_limits(
    geographic_bounds: tuple[float, float, float, float],
) -> tuple[dict[str, int | str], ...]:
    west, south, east, north = geographic_bounds
    limits: list[dict[str, int | str]] = []
    for level in range(MIN_TILE_MATRIX, MAX_TILE_MATRIX + 1):
        north_west = WEB_MERCATOR_QUAD.tile(west, north, level)
        south_east = WEB_MERCATOR_QUAD.tile(east, south, level)
        limits.append({
            "matrixId": str(level),
            "minTileRow": north_west.y,
            "maxTileRow": south_east.y,
            "minTileCol": north_west.x,
            "maxTileCol": south_east.x,
        })
    return tuple(limits)


def _projected_bounds(
    geographic_bounds: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    west, south, east, north = geographic_bounds

    def projected_y(latitude: float) -> float:
        clamped = min(WEB_MERCATOR_LATITUDE_LIMIT, max(-WEB_MERCATOR_LATITUDE_LIMIT, latitude))
        return WEB_MERCATOR_RADIUS * math.asinh(math.tan(math.radians(clamped)))

    return (
        WEB_MERCATOR_RADIUS * math.radians(west),
        projected_y(south),
        WEB_MERCATOR_RADIUS * math.radians(east),
        projected_y(north),
    )


def _texel_centers(
    matrix_level: int,
    tile_row: int,
    tile_col: int,
) -> tuple[np.ndarray, np.ndarray]:
    world_cells = (1 << matrix_level) * TILE_SIZE
    global_cols = tile_col * TILE_SIZE + np.arange(TILE_SIZE, dtype=np.float64) + 0.5
    global_rows = tile_row * TILE_SIZE + np.arange(TILE_SIZE, dtype=np.float64) + 0.5
    longitudes = global_cols / world_cells * 360.0 - 180.0
    mercator_y = math.pi * (1.0 - 2.0 * global_rows / world_cells)
    latitudes = np.degrees(np.arctan(np.sinh(mercator_y)))
    return (
        np.broadcast_to(longitudes, (TILE_SIZE, TILE_SIZE)).reshape(-1),
        np.broadcast_to(latitudes[:, None], (TILE_SIZE, TILE_SIZE)).reshape(-1),
    )


def _render_page(mapping: PageMapping, field: np.ndarray) -> np.ndarray:
    output = np.zeros((TILE_SIZE * TILE_SIZE, 2), dtype=np.float64)
    valid = mapping.station_indices[:, 0] >= 0
    if valid.any():
        values = field[mapping.station_indices[valid]].astype(np.float64)
        output[valid] = np.sum(values * mapping.weights[valid, :, None], axis=1)
    return output.astype("<f4").reshape(TILE_SIZE, TILE_SIZE, 2)


def _page_relative_path(
    time_index: int,
    matrix_level: int,
    tile_row: int,
    tile_col: int,
) -> Path:
    return Path(
        "tiles",
        "WebMercatorQuad",
        f"t{time_index:02d}",
        str(matrix_level),
        str(tile_row),
        f"{tile_col}.rg32f",
    )


def _write_page(
    output_directory: Path,
    page: np.ndarray,
    *,
    time_index: int,
    matrix_level: int,
    tile_row: int,
    tile_col: int,
) -> dict[str, Any]:
    relative_path = _page_relative_path(
        time_index,
        matrix_level,
        tile_row,
        tile_col,
    )
    destination = output_directory / relative_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    little_endian = np.asarray(page, dtype="<f4")
    payload = little_endian.tobytes(order="C")
    if len(payload) != PAGE_BYTE_LENGTH:
        raise RuntimeError(
            f"RG32F page byte length mismatch: expected {PAGE_BYTE_LENGTH}, received {len(payload)}"
        )
    destination.write_bytes(payload)
    speed = np.linalg.norm(little_endian.astype(np.float64), axis=2)
    return {
        "timeIndex": time_index,
        "matrixId": str(matrix_level),
        "tileRow": tile_row,
        "tileCol": tile_col,
        "path": relative_path.as_posix(),
        "byteLength": PAGE_BYTE_LENGTH,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "maximumSpeed": float(speed.max(initial=0.0)),
    }


def _read_page(path: Path) -> np.ndarray:
    payload = path.read_bytes()
    if len(payload) != PAGE_BYTE_LENGTH:
        raise RuntimeError(
            f"RG32F child page byte length mismatch: expected {PAGE_BYTE_LENGTH}, received {len(payload)}"
        )
    values = np.frombuffer(payload, dtype="<f4")
    if not np.isfinite(values).all():
        raise RuntimeError(f"RG32F child page contains a non-finite value: {path}")
    return values.reshape(TILE_SIZE, TILE_SIZE, 2)


def _downsample_parent(
    output_directory: Path,
    time_index: int,
    child_level: int,
    parent_row: int,
    parent_col: int,
    child_limit: dict[str, int | str],
) -> tuple[np.ndarray, float, float]:
    composite = np.zeros((TILE_SIZE * 2, TILE_SIZE * 2, 2), dtype=np.float64)
    for child_y in range(2):
        for child_x in range(2):
            child_row = parent_row * 2 + child_y
            child_col = parent_col * 2 + child_x
            child_is_covered = (
                int(child_limit["minTileRow"]) <= child_row
                <= int(child_limit["maxTileRow"])
                and int(child_limit["minTileCol"]) <= child_col
                <= int(child_limit["maxTileCol"])
            )
            if not child_is_covered:
                continue
            child_path = output_directory / _page_relative_path(
                time_index,
                child_level,
                child_row,
                child_col,
            )
            if not child_path.is_file():
                raise RuntimeError(f"Covered RG32F child page is missing: {child_path}")
            child = _read_page(child_path).astype(np.float64)
            row = child_y * TILE_SIZE
            col = child_x * TILE_SIZE
            composite[row:row + TILE_SIZE, col:col + TILE_SIZE] = child
    parent64 = composite.reshape(TILE_SIZE, 2, TILE_SIZE, 2, 2).mean(
        axis=(1, 3),
        dtype=np.float64,
    )
    reconstructed = np.repeat(np.repeat(parent64, 2, axis=0), 2, axis=1)
    velocity_error = np.linalg.norm(composite - reconstructed, axis=2)
    maximum_error = float(velocity_error.max(initial=0.0))
    rmse = float(math.sqrt(np.mean(np.square(velocity_error), dtype=np.float64)))
    return parent64.astype("<f4"), maximum_error, rmse


def _parity_samples(output_directory: Path, pages: list[dict[str, Any]]) -> dict[str, Any]:
    seed = 20_260_827
    generator = random.Random(seed)
    selected_count = min(16, len(pages))
    selected_indices = sorted(generator.sample(range(len(pages)), selected_count))
    samples: list[dict[str, Any]] = []
    for page_index in selected_indices:
        page = pages[page_index]
        texel_row = generator.randrange(TILE_SIZE)
        texel_col = generator.randrange(TILE_SIZE)
        values = _read_page(output_directory / page["path"])
        samples.append({
            "timeIndex": page["timeIndex"],
            "matrixId": page["matrixId"],
            "tileRow": page["tileRow"],
            "tileCol": page["tileCol"],
            "texelRow": texel_row,
            "texelCol": texel_col,
            "velocity": [
                float(values[texel_row, texel_col, 0]),
                float(values[texel_row, texel_col, 1]),
            ],
        })
    return {"seed": seed, "samples": samples}


def _manifest(
    dataset: SourceDataset,
    limits: tuple[dict[str, int | str], ...],
    pages: list[dict[str, Any]],
    mapping_page_count: int,
    reduction_error: list[dict[str, Any]],
    parity: dict[str, Any],
) -> dict[str, Any]:
    descriptor = dataset.descriptor
    content_version = (
        f"flow-{dataset.source_hash[:16]}-rg32f-wmq-z{MIN_TILE_MATRIX}-z{MAX_TILE_MATRIX}-v1"
    )
    spatial_page_count = sum(
        (int(limit["maxTileRow"]) - int(limit["minTileRow"]) + 1)
        * (int(limit["maxTileCol"]) - int(limit["minTileCol"]) + 1)
        for limit in limits
    )
    time_maximum_speeds = []
    for field_descriptor in descriptor.fields:
        page_maximum = max(
            page["maximumSpeed"]
            for page in pages
            if page["timeIndex"] == field_descriptor.time_index
        )
        source_values = dataset.fields[field_descriptor.time_index].astype(np.float64)
        time_maximum_speeds.append({
            "timeIndex": field_descriptor.time_index,
            "sourceMaximumSpeed": float(
                np.linalg.norm(source_values, axis=1).max(initial=0.0)
            ),
            "pageMaximumSpeed": page_maximum,
        })
    return {
        "schemaVersion": 1,
        "datasetId": descriptor.dataset_id,
        "sourceRevision": descriptor.source_revision,
        "sourceHash": dataset.source_hash,
        "contentVersion": content_version,
        "stationCount": descriptor.station_count,
        "source": {
            "crs": "EPSG:4326",
            "geographicBounds": list(dataset.geographic_bounds),
        },
        "projectedBounds": {
            "crs": WEB_MERCATOR_CRS_URI,
            "bounds": list(_projected_bounds(dataset.geographic_bounds)),
        },
        "times": [
            {
                "timeIndex": field.time_index,
                "modelTime": field.model_time,
                "unit": "ordinal",
                "phase": descriptor.phase,
                "sourceHash": field.sha256,
            }
            for field in descriptor.fields
        ],
        "tileMatrixSet": {
            "id": "WebMercatorQuad",
            "uri": WEB_MERCATOR_QUAD_URI,
            "crs": WEB_MERCATOR_CRS_URI,
            "cornerOfOrigin": "topLeft",
            "tileRowDirection": "south",
            "tileColDirection": "east",
            "tileWidth": TILE_SIZE,
            "tileHeight": TILE_SIZE,
            "minTileMatrix": str(MIN_TILE_MATRIX),
            "maxTileMatrix": str(MAX_TILE_MATRIX),
            "tileMatrixIds": [
                str(level) for level in range(MIN_TILE_MATRIX, MAX_TILE_MATRIX + 1)
            ],
            "limits": list(limits),
        },
        "encoding": {
            "channels": 2,
            "componentOrder": ["u", "v"],
            "sampleType": "float32-le",
            "layout": "rg-interleaved",
            "tileWidth": TILE_SIZE,
            "tileHeight": TILE_SIZE,
        },
        "unit": descriptor.unit,
        "basis": descriptor.basis,
        "temporalInterpolation": "component-wise-linear",
        "maximumSpeed": max(
            record["sourceMaximumSpeed"] for record in time_maximum_speeds
        ),
        "timeMaximumSpeeds": time_maximum_speeds,
        "pages": pages,
        "budgets": {
            "spatialPageCount": spatial_page_count,
            "timePageCount": len(pages),
            "pageByteLength": PAGE_BYTE_LENGTH,
            "totalRawPageBytes": len(pages) * PAGE_BYTE_LENGTH,
        },
        "construction": {
            "algorithmVersion": BUILD_ALGORITHM_VERSION,
            "topology": {
                "algorithm": "d3-delaunay-6",
                "triangleCount": descriptor.triangle_count,
                "sha256": dataset.connectivity_sha256,
            },
            "maximumTriangleEdgeDegrees": MAX_TRIANGLE_EDGE_DEGREES,
            "unsupportedVelocity": [0.0, 0.0],
            "finestInterpolation": "float64-barycentric-to-float32-le",
            "coarseReduction": "component-wise-2x2-average",
            "mappingPageCount": mapping_page_count,
            "reductionError": reduction_error,
            "parity": parity,
        },
    }


def _validate_staged_artifact(output_directory: Path, manifest: dict[str, Any]) -> None:
    pages = manifest.get("pages")
    if not isinstance(pages, list) or not pages:
        raise RuntimeError("Flow Field manifest must declare at least one RG32F page")
    for page in pages:
        relative_path = Path(page["path"])
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise RuntimeError(f"Flow Field page path is not relative: {relative_path}")
        path = output_directory / relative_path
        if not path.is_file():
            raise RuntimeError(f"Flow Field page artifact is missing: {path}")
        payload = path.read_bytes()
        if len(payload) != PAGE_BYTE_LENGTH or len(payload) != page["byteLength"]:
            raise RuntimeError(f"Flow Field page artifact has the wrong byte length: {path}")
        if hashlib.sha256(payload).hexdigest() != page["sha256"]:
            raise RuntimeError(f"Flow Field page artifact hash mismatch: {path}")
        if not np.isfinite(np.frombuffer(payload, dtype="<f4")).all():
            raise RuntimeError(f"Flow Field page artifact contains a non-finite value: {path}")


def _install_staged_directory(staged: Path, output: Path) -> None:
    if output.is_symlink():
        raise ValueError(f"Flow Field output directory cannot be a symbolic link: {output}")
    if output.exists() and not output.is_dir():
        raise ValueError(f"Flow Field output path must be a directory: {output}")
    if not output.exists():
        os.replace(staged, output)
        return
    backup = output.parent / f".{output.name}.backup-{uuid.uuid4().hex}"
    os.replace(output, backup)
    try:
        os.replace(staged, output)
    except BaseException:
        os.replace(backup, output)
        raise
    shutil.rmtree(backup)


def build_velocity_tiles(
    data_directory: str | Path = DEFAULT_DATA_DIRECTORY,
    output_directory: str | Path = DEFAULT_OUTPUT_DIRECTORY,
    *,
    descriptor_path: str | Path = DEFAULT_DESCRIPTOR_PATH,
    node_executable: str = "node",
) -> BuildResult:
    started = time.perf_counter()
    output = Path(output_directory).resolve()
    _require_safe_output_directory(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    dataset = load_source_dataset(
        data_directory,
        descriptor_path=descriptor_path,
        node_executable=node_executable,
    )
    limits = _tile_matrix_limits(dataset.geographic_bounds)
    limit_by_level = {int(limit["matrixId"]): limit for limit in limits}
    staged = Path(tempfile.mkdtemp(prefix=f".{output.name}.build-", dir=output.parent))
    try:
        pages: list[dict[str, Any]] = []
        locator = SupportedTriangleLocator(dataset)
        finest_limit = limit_by_level[MAX_TILE_MATRIX]
        mapping_page_count = 0
        for tile_row in range(
            int(finest_limit["minTileRow"]),
            int(finest_limit["maxTileRow"]) + 1,
        ):
            for tile_col in range(
                int(finest_limit["minTileCol"]),
                int(finest_limit["maxTileCol"]) + 1,
            ):
                longitudes, latitudes = _texel_centers(
                    MAX_TILE_MATRIX,
                    tile_row,
                    tile_col,
                )
                mapping = locator.locate(longitudes, latitudes)
                mapping_page_count += 1
                for field_descriptor, field in zip(
                    dataset.descriptor.fields,
                    dataset.fields,
                    strict=True,
                ):
                    pages.append(_write_page(
                        staged,
                        _render_page(mapping, field),
                        time_index=field_descriptor.time_index,
                        matrix_level=MAX_TILE_MATRIX,
                        tile_row=tile_row,
                        tile_col=tile_col,
                    ))
        reduction_error: list[dict[str, Any]] = []
        for matrix_level in range(MAX_TILE_MATRIX - 1, MIN_TILE_MATRIX - 1, -1):
            limit = limit_by_level[matrix_level]
            error_accumulators = {
                field.time_index: {"maximum": 0.0, "squared": 0.0, "count": 0}
                for field in dataset.descriptor.fields
            }
            for tile_row in range(
                int(limit["minTileRow"]),
                int(limit["maxTileRow"]) + 1,
            ):
                for tile_col in range(
                    int(limit["minTileCol"]),
                    int(limit["maxTileCol"]) + 1,
                ):
                    for field_descriptor in dataset.descriptor.fields:
                        page, maximum_error, rmse = _downsample_parent(
                            staged,
                            field_descriptor.time_index,
                            matrix_level + 1,
                            tile_row,
                            tile_col,
                            limit_by_level[matrix_level + 1],
                        )
                        pages.append(_write_page(
                            staged,
                            page,
                            time_index=field_descriptor.time_index,
                            matrix_level=matrix_level,
                            tile_row=tile_row,
                            tile_col=tile_col,
                        ))
                        accumulator = error_accumulators[field_descriptor.time_index]
                        accumulator["maximum"] = max(accumulator["maximum"], maximum_error)
                        accumulator["squared"] += rmse * rmse
                        accumulator["count"] += 1
            for time_index, accumulator in error_accumulators.items():
                reduction_error.append({
                    "timeIndex": time_index,
                    "matrixId": str(matrix_level),
                    "maximumVelocityError": accumulator["maximum"],
                    "rmse": math.sqrt(
                        accumulator["squared"] / max(1, accumulator["count"])
                    ),
                })
        pages.sort(key=lambda page: (
            page["timeIndex"],
            int(page["matrixId"]),
            page["tileRow"],
            page["tileCol"],
        ))
        reduction_error.sort(key=lambda record: (
            record["timeIndex"],
            int(record["matrixId"]),
        ))
        parity = _parity_samples(staged, pages)
        manifest = _manifest(
            dataset,
            limits,
            pages,
            mapping_page_count,
            reduction_error,
            parity,
        )
        _validate_staged_artifact(staged, manifest)
        manifest_path = staged / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        _install_staged_directory(staged, output)
    finally:
        if staged.exists():
            shutil.rmtree(staged)
    duration_seconds = time.perf_counter() - started
    return BuildResult(
        output_directory=output,
        manifest_path=output / "manifest.json",
        source_hash=dataset.source_hash,
        content_version=manifest["contentVersion"],
        page_count=len(pages),
        total_raw_page_bytes=len(pages) * PAGE_BYTE_LENGTH,
        duration_seconds=duration_seconds,
    )


def _require_safe_output_directory(output: Path) -> None:
    if output.name != "cache" or output == Path(output.anchor) or output == Path.home():
        raise ValueError(
            "Flow Field generated output must be an explicit cache directory"
        )


def verify_existing_tiles(output_directory: str | Path) -> dict[str, Any]:
    output = Path(output_directory).resolve()
    manifest_path = output / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"Flow Field manifest does not exist: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1:
        raise ValueError("Flow Field manifest schemaVersion must be 1")
    _validate_staged_artifact(output, manifest)
    pages = manifest["pages"]
    return {
        "contentVersion": manifest["contentVersion"],
        "pageCount": len(pages),
        "totalRawPageBytes": sum(page["byteLength"] for page in pages),
        "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build deterministic Flow Field WebMercatorQuad RG32F pages"
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_DATA_DIRECTORY)
    parser.add_argument("--descriptor", type=Path, default=DEFAULT_DESCRIPTOR_PATH)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_DIRECTORY)
    parser.add_argument("--node", default="node")
    parser.add_argument("--verify-existing", action="store_true")
    arguments = parser.parse_args()
    if arguments.verify_existing:
        print(json.dumps(verify_existing_tiles(arguments.output), sort_keys=True))
        return
    result = build_velocity_tiles(
        arguments.source,
        arguments.output,
        descriptor_path=arguments.descriptor,
        node_executable=arguments.node,
    )
    print(json.dumps({
        "contentVersion": result.content_version,
        "durationSeconds": result.duration_seconds,
        "manifest": str(result.manifest_path),
        "pageCount": result.page_count,
        "sourceHash": result.source_hash,
        "totalRawPageBytes": result.total_raw_page_bytes,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
