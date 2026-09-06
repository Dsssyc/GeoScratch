from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import morecantile
import numpy as np

from .contracts import (
    BuildBudget,
    InterpolationSpec,
    TopologySpec,
    resolve_interpolation,
    resolve_topology,
)
from .interpolation import (
    BilinearSafeBlock,
    TriangleLinearStencil,
    apply_bilinear_safe_block,
    prepare_triangle_linear_stencil,
)
from .source import (
    DEFAULT_DATA_DIRECTORY,
    DEFAULT_DESCRIPTOR_PATH,
    SourceDataset,
    load_source_dataset,
)
from .topology import DuplicateStatistics, PreparedDelaunayTopology, prepare_topology


TILE_SIZE = 256
MIN_TILE_MATRIX = 4
MAX_TILE_MATRIX = 9
PAGE_BYTE_LENGTH = TILE_SIZE * TILE_SIZE * 2 * 4
BUILD_ALGORITHM_VERSION = "flow-rg32f-wmq-v4"
WEB_MERCATOR_QUAD_URI = (
    "http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad"
)
WEB_MERCATOR_CRS_URI = "http://www.opengis.net/def/crs/EPSG/0/3857"
WEB_MERCATOR_RADIUS = 6_378_137.0
WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066
TILE_SERVER_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT_DIRECTORY = TILE_SERVER_ROOT / "cache"
WEB_MERCATOR_QUAD = morecantile.tms.get("WebMercatorQuad")
ARTIFACT_MARKER_FILENAME = ".flow-field-artifact.json"


DEFAULT_BUILD_BUDGET = BuildBudget()


@dataclass(frozen=True)
class BuildResult:
    output_directory: Path
    manifest_path: Path
    source_hash: str
    content_version: str
    page_count: int
    total_raw_page_bytes: int
    duration_seconds: float


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


def _runtime_covered_texel_bounds(
    geographic_bounds: tuple[float, float, float, float],
    matrix_level: int,
) -> tuple[int, int, int, int]:
    west, south, east, north = geographic_bounds
    world_cells = (1 << matrix_level) * TILE_SIZE

    def world_position(longitude: float, latitude: float) -> tuple[float, float]:
        clamped = min(
            WEB_MERCATOR_LATITUDE_LIMIT,
            max(-WEB_MERCATOR_LATITUDE_LIMIT, latitude),
        )
        x = (longitude + 180.0) / 360.0 * world_cells
        mercator_y = math.asinh(math.tan(math.radians(clamped)))
        y = (1.0 - mercator_y / math.pi) * 0.5 * world_cells
        return x, y

    west_x, north_y = world_position(west, north)
    east_x, south_y = world_position(east, south)
    minimum_x = math.ceil(west_x - 0.5)
    minimum_y = math.ceil(north_y - 0.5)
    maximum_x = world_cells - 1 if east == 180.0 else math.floor(east_x - 0.5)
    maximum_y = math.floor(south_y - 0.5)
    return (
        min(world_cells - 1, max(0, minimum_x)),
        min(world_cells - 1, max(0, minimum_y)),
        min(world_cells - 1, max(0, maximum_x)),
        min(world_cells - 1, max(0, maximum_y)),
    )


def _texel_lattice(
    matrix_level: int,
    tile_row: int,
    tile_col: int,
) -> tuple[np.ndarray, np.ndarray]:
    return _texel_lattice_window(matrix_level, tile_row, tile_col, padding=0)


def _texel_lattice_window(
    matrix_level: int,
    tile_row: int,
    tile_col: int,
    *,
    padding: int,
) -> tuple[np.ndarray, np.ndarray]:
    if isinstance(padding, bool) or not isinstance(padding, int) or padding < 0:
        raise ValueError("padding must be a non-negative integer")
    world_cells = (1 << matrix_level) * TILE_SIZE
    offsets = np.arange(-padding, TILE_SIZE + padding, dtype=np.float64)
    global_cols = np.clip(
        tile_col * TILE_SIZE + offsets,
        0,
        world_cells - 1,
    )
    global_rows = np.clip(
        tile_row * TILE_SIZE + offsets,
        0,
        world_cells - 1,
    )
    longitudes = global_cols / world_cells * 360.0 - 180.0
    mercator_y = math.pi * (1.0 - 2.0 * global_rows / world_cells)
    latitudes = np.degrees(np.arctan(np.sinh(mercator_y)))
    side = TILE_SIZE + padding * 2
    return (
        np.broadcast_to(longitudes, (side, side)).reshape(-1),
        np.broadcast_to(latitudes[:, None], (side, side)).reshape(-1),
    )


def _render_page(
    stencil: TriangleLinearStencil,
    unique_field: np.ndarray,
) -> BilinearSafeBlock:
    return apply_bilinear_safe_block(
        stencil,
        unique_field,
        block_size=TILE_SIZE,
    )


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
            f"RG32F page byte length mismatch: expected {PAGE_BYTE_LENGTH}, received {len(payload)}"
        )
    values = np.frombuffer(payload, dtype="<f4")
    if not np.isfinite(values).all():
        raise RuntimeError(f"RG32F page contains a non-finite value: {path}")
    return values.reshape(TILE_SIZE, TILE_SIZE, 2)


def _station_reconstruction_quality(
    output_directory: Path,
    dataset: SourceDataset,
    topology: PreparedDelaunayTopology,
    interpolation: InterpolationSpec,
    prepared_fields: tuple[np.ndarray, ...],
    matrix_level: int,
    limit: dict[str, int | str],
) -> list[dict[str, Any]]:
    min_row = int(limit["minTileRow"])
    max_row = int(limit["maxTileRow"])
    min_col = int(limit["minTileCol"])
    max_col = int(limit["maxTileCol"])
    height = (max_row - min_row + 1) * TILE_SIZE
    width = (max_col - min_col + 1) * TILE_SIZE
    world_cells = (1 << matrix_level) * TILE_SIZE
    stations = topology.vertices_lon_lat
    global_x = (stations[:, 0] + 180.0) / 360.0 * world_cells
    mercator_y = np.arcsinh(np.tan(np.radians(stations[:, 1])))
    global_y = (1.0 - mercator_y / math.pi) * 0.5 * world_cells
    base_global_x = np.floor(global_x).astype(np.int64)
    base_global_y = np.floor(global_y).astype(np.int64)
    weight_x = (global_x - base_global_x)[:, None]
    weight_y = (global_y - base_global_y)[:, None]
    minimum_x, minimum_y, maximum_x, maximum_y = _runtime_covered_texel_bounds(
        dataset.geographic_bounds,
        matrix_level,
    )
    left_x = np.clip(base_global_x, minimum_x, maximum_x) - min_col * TILE_SIZE
    right_x = np.clip(base_global_x + 1, minimum_x, maximum_x) - min_col * TILE_SIZE
    top_y = np.clip(base_global_y, minimum_y, maximum_y) - min_row * TILE_SIZE
    bottom_y = np.clip(base_global_y + 1, minimum_y, maximum_y) - min_row * TILE_SIZE
    if (
        np.any(left_x < 0)
        or np.any(right_x >= width)
        or np.any(top_y < 0)
        or np.any(bottom_y >= height)
    ):
        raise RuntimeError("runtime reconstruction clamp exceeds declared page coverage")

    quality: list[dict[str, Any]] = []
    for field_descriptor, reference in zip(
        dataset.descriptor.fields,
        prepared_fields,
        strict=True,
    ):
        mosaic = np.zeros((height, width, 2), dtype=np.float32)
        for tile_row in range(min_row, max_row + 1):
            row = (tile_row - min_row) * TILE_SIZE
            for tile_col in range(min_col, max_col + 1):
                col = (tile_col - min_col) * TILE_SIZE
                mosaic[row:row + TILE_SIZE, col:col + TILE_SIZE] = _read_page(
                    output_directory / _page_relative_path(
                        field_descriptor.time_index,
                        matrix_level,
                        tile_row,
                        tile_col,
                    )
                )
        top_left = mosaic[top_y, left_x].astype(np.float64)
        top_right = mosaic[top_y, right_x].astype(np.float64)
        bottom_left = mosaic[bottom_y, left_x].astype(np.float64)
        bottom_right = mosaic[bottom_y, right_x].astype(np.float64)
        reconstructed = (
            (top_left * (1.0 - weight_x) + top_right * weight_x)
            * (1.0 - weight_y)
            + (bottom_left * (1.0 - weight_x) + bottom_right * weight_x)
            * weight_y
        )
        reference_speed = np.linalg.norm(reference, axis=1)
        reconstructed_speed = np.linalg.norm(reconstructed, axis=1)
        velocity_error = np.linalg.norm(reconstructed - reference, axis=1)
        stationary = reference_speed <= interpolation.stationary_epsilon
        moving = ~stationary
        false_moving = stationary & (
            reconstructed_speed > interpolation.stationary_epsilon
        )
        collapsed_moving = moving & (
            reconstructed_speed <= interpolation.stationary_epsilon
        )
        directional = moving & (
            reconstructed_speed > interpolation.stationary_epsilon
        )
        if directional.any():
            cosine = np.sum(reference[directional] * reconstructed[directional], axis=1)
            cosine /= reference_speed[directional] * reconstructed_speed[directional]
            angular_error = np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0)))
            maximum_angular_error = float(angular_error.max(initial=0.0))
            angular_rmse = float(
                math.sqrt(np.mean(np.square(angular_error), dtype=np.float64))
            )
        else:
            maximum_angular_error = 0.0
            angular_rmse = 0.0
        quality.append({
            "matrixId": str(matrix_level),
            "timeIndex": field_descriptor.time_index,
            "topologyVertexCount": topology.vertex_count,
            "stationaryEpsilon": interpolation.stationary_epsilon,
            "velocityRmse": float(
                math.sqrt(np.mean(np.square(velocity_error), dtype=np.float64))
            ),
            "maximumVelocityError": float(velocity_error.max(initial=0.0)),
            "angularRmseDegrees": angular_rmse,
            "maximumAngularErrorDegrees": maximum_angular_error,
            "stationaryVertexCount": int(np.count_nonzero(stationary)),
            "stationaryFalseMovingCount": int(np.count_nonzero(false_moving)),
            "maximumFalseMovingSpeed": float(
                reconstructed_speed[false_moving].max(initial=0.0)
            ),
            "movingVertexCount": int(np.count_nonzero(moving)),
            "movingCollapsedCount": int(np.count_nonzero(collapsed_moving)),
        })
    return quality


def _manifest(
    dataset: SourceDataset,
    limits: tuple[dict[str, int | str], ...],
    pages: list[dict[str, Any]],
    topology: PreparedDelaunayTopology,
    interpolation: InterpolationSpec,
    duplicate_statistics: DuplicateStatistics,
    mapping_statistics: list[dict[str, Any]],
    support_statistics: list[dict[str, Any]],
    station_reconstruction_quality: list[dict[str, Any]],
) -> dict[str, Any]:
    descriptor = dataset.descriptor
    topology_manifest = topology.manifest(duplicate_statistics)
    interpolation_manifest = {
        "requested": interpolation.kind,
        "resolved": interpolation.kind,
        "coordinateSpace": "EPSG:3857",
        "weightPrecision": "float64",
        "outputPrecision": "float32-le",
        "stationaryPolicy": interpolation.stationary_policy,
        "stationaryEpsilon": interpolation.stationary_epsilon,
    }
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
    times_manifest = [
        {
            "timeIndex": field.time_index,
            "modelTime": field.model_time,
            "unit": "ordinal",
            "phase": descriptor.phase,
            "sourceHash": field.sha256,
        }
        for field in descriptor.fields
    ]
    projected_bounds_manifest = {
        "crs": WEB_MERCATOR_CRS_URI,
        "bounds": list(_projected_bounds(dataset.geographic_bounds)),
    }
    matrix_set_manifest = {
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
    }
    encoding_manifest = {
        "channels": 2,
        "componentOrder": ["u", "v"],
        "sampleType": "float32-le",
        "layout": "rg-interleaved",
        "tileWidth": TILE_SIZE,
        "tileHeight": TILE_SIZE,
    }
    maximum_speed = max(
        record["sourceMaximumSpeed"] for record in time_maximum_speeds
    )
    semantic_identity = _semantic_identity({
        "datasetId": descriptor.dataset_id,
        "sourceRevision": descriptor.source_revision,
        "stationCount": descriptor.station_count,
        "source": {
            "crs": "EPSG:4326",
            "geographicBounds": list(dataset.geographic_bounds),
        },
        "projectedBounds": projected_bounds_manifest,
        "times": times_manifest,
        "tileMatrixSet": matrix_set_manifest,
        "encoding": encoding_manifest,
        "unit": descriptor.unit,
        "basis": descriptor.basis,
        "temporalInterpolation": "component-wise-linear",
        "maximumSpeed": maximum_speed,
        "timeMaximumSpeeds": time_maximum_speeds,
    })
    semantic_sha256 = hashlib.sha256(
        json.dumps(semantic_identity, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    ).hexdigest()
    page_set_sha256 = _page_set_sha256(pages)
    construction_identity = _construction_identity(
        dataset.source_hash,
        topology_manifest,
        interpolation_manifest,
        limits,
        page_set_sha256,
        semantic_sha256,
    )
    construction_hash = hashlib.sha256(
        json.dumps(
            construction_identity,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    content_version = (
        f"flow-{construction_hash[:16]}-rg32f-wmq-"
        f"z{MIN_TILE_MATRIX}-z{MAX_TILE_MATRIX}-v4"
    )
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
        "projectedBounds": projected_bounds_manifest,
        "times": times_manifest,
        "tileMatrixSet": matrix_set_manifest,
        "encoding": encoding_manifest,
        "unit": descriptor.unit,
        "basis": descriptor.basis,
        "temporalInterpolation": "component-wise-linear",
        "maximumSpeed": maximum_speed,
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
            "constructionHash": construction_hash,
            "pageSetSha256": page_set_sha256,
            "semanticSha256": semantic_sha256,
            "topology": topology_manifest,
            "interpolation": interpolation_manifest,
            "unsupportedVelocity": [0.0, 0.0],
            "sampleRegistration": "global-texel-lattice",
            "levelConstruction": "direct",
            "supportFilter": "bilinear-safe-erosion-1",
            "mapping": mapping_statistics,
            "quality": {
                "particleSimulation": "not-approved",
                "approvalReason": "resolution-error-budget-unset",
                "finestMatrixId": str(MAX_TILE_MATRIX),
                "runtimeSampling": "global-lattice-bilinear",
                "supportFilter": "bilinear-safe-erosion-1",
                "levelSupport": support_statistics,
                "stationReconstruction": station_reconstruction_quality,
            },
        },
    }


def _construction_identity(
    source_hash: str,
    topology_manifest: dict[str, object],
    interpolation_manifest: dict[str, object],
    limits: tuple[dict[str, int | str], ...] | list[dict[str, Any]],
    page_set_sha256: str,
    semantic_sha256: str,
) -> dict[str, object]:
    return {
        "algorithmVersion": BUILD_ALGORITHM_VERSION,
        "sourceHash": source_hash,
        "topology": topology_manifest,
        "interpolation": interpolation_manifest,
        "limits": list(limits),
        "pageSetSha256": page_set_sha256,
        "semanticSha256": semantic_sha256,
        "tileMatrixSet": "WebMercatorQuad",
        "tileSize": TILE_SIZE,
        "minimumTileMatrix": MIN_TILE_MATRIX,
        "maximumTileMatrix": MAX_TILE_MATRIX,
        "sampleRegistration": "global-texel-lattice",
        "levelConstruction": "direct",
        "supportFilter": "bilinear-safe-erosion-1",
    }


def _semantic_identity(manifest: dict[str, Any]) -> dict[str, Any]:
    return {
        name: manifest[name]
        for name in (
            "datasetId",
            "sourceRevision",
            "stationCount",
            "source",
            "projectedBounds",
            "times",
            "tileMatrixSet",
            "encoding",
            "unit",
            "basis",
            "temporalInterpolation",
            "maximumSpeed",
            "timeMaximumSpeeds",
        )
    }


def _page_set_sha256(pages: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for page in pages:
        record = (
            page["timeIndex"],
            page["matrixId"],
            page["tileRow"],
            page["tileCol"],
            page["path"],
            page["byteLength"],
            page["sha256"],
            page["maximumSpeed"],
        )
        digest.update(
            json.dumps(record, separators=(",", ":")).encode("utf-8") + b"\n"
        )
    return digest.hexdigest()


def validate_artifact_manifest(manifest: dict[str, Any]) -> None:
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise ValueError("Flow Field manifest schemaVersion must be 1")
    source_hash = manifest.get("sourceHash")
    source = manifest.get("source")
    projected_bounds = manifest.get("projectedBounds")
    matrix_set = manifest.get("tileMatrixSet")
    encoding = manifest.get("encoding")
    times = manifest.get("times")
    pages = manifest.get("pages")
    budgets = manifest.get("budgets")
    construction = manifest.get("construction")
    time_maximum_speeds = manifest.get("timeMaximumSpeeds")
    bounds = source.get("geographicBounds") if isinstance(source, dict) else None
    if (
        not _sha256(source_hash)
        or not isinstance(manifest.get("datasetId"), str)
        or not manifest["datasetId"]
        or not isinstance(manifest.get("sourceRevision"), str)
        or not manifest["sourceRevision"]
        or isinstance(manifest.get("stationCount"), bool)
        or not isinstance(manifest.get("stationCount"), int)
        or manifest["stationCount"] < 3
        or not isinstance(source, dict)
        or source.get("crs") != "EPSG:4326"
        or not isinstance(bounds, list)
        or len(bounds) != 4
        or not all(_finite_number(value) for value in bounds)
        or not (bounds[0] < bounds[2] and bounds[1] < bounds[3])
        or not isinstance(times, list)
        or not times
        or not isinstance(pages, list)
        or not isinstance(matrix_set, dict)
        or not isinstance(budgets, dict)
        or not isinstance(construction, dict)
        or not isinstance(projected_bounds, dict)
        or not isinstance(time_maximum_speeds, list)
    ):
        raise ValueError("Flow Field manifest data contract is invalid")

    expected_limits = list(_tile_matrix_limits(tuple(float(value) for value in bounds)))
    expected_projected_bounds = {
        "crs": WEB_MERCATOR_CRS_URI,
        "bounds": list(_projected_bounds(tuple(float(value) for value in bounds))),
    }
    expected_matrix_ids = [
        str(level) for level in range(MIN_TILE_MATRIX, MAX_TILE_MATRIX + 1)
    ]
    if (
        matrix_set.get("id") != "WebMercatorQuad"
        or matrix_set.get("uri") != WEB_MERCATOR_QUAD_URI
        or matrix_set.get("crs") != WEB_MERCATOR_CRS_URI
        or matrix_set.get("cornerOfOrigin") != "topLeft"
        or matrix_set.get("tileRowDirection") != "south"
        or matrix_set.get("tileColDirection") != "east"
        or matrix_set.get("tileWidth") != TILE_SIZE
        or matrix_set.get("tileHeight") != TILE_SIZE
        or matrix_set.get("minTileMatrix") != str(MIN_TILE_MATRIX)
        or matrix_set.get("maxTileMatrix") != str(MAX_TILE_MATRIX)
        or matrix_set.get("tileMatrixIds") != expected_matrix_ids
        or matrix_set.get("limits") != expected_limits
        or projected_bounds != expected_projected_bounds
        or encoding != {
            "channels": 2,
            "componentOrder": ["u", "v"],
            "sampleType": "float32-le",
            "layout": "rg-interleaved",
            "tileWidth": TILE_SIZE,
            "tileHeight": TILE_SIZE,
        }
        or manifest.get("temporalInterpolation") != "component-wise-linear"
        or not isinstance(manifest.get("unit"), str)
        or not isinstance(manifest.get("basis"), str)
    ):
        raise ValueError("Flow Field manifest raster contract is invalid")

    for time_index, record in enumerate(times):
        if (
            not isinstance(record, dict)
            or record.get("timeIndex") != time_index
            or record.get("modelTime") != time_index
            or record.get("unit") != "ordinal"
            or not isinstance(record.get("phase"), str)
            or not _sha256(record.get("sourceHash"))
        ):
            raise ValueError("Flow Field manifest time contract is invalid")

    spatial_page_count = sum(
        (int(limit["maxTileRow"]) - int(limit["minTileRow"]) + 1)
        * (int(limit["maxTileCol"]) - int(limit["minTileCol"]) + 1)
        for limit in expected_limits
    )
    expected_page_count = spatial_page_count * len(times)
    if len(pages) != expected_page_count:
        raise ValueError("Flow Field manifest page set is incomplete")
    page_index = 0
    for time_index in range(len(times)):
        for limit in expected_limits:
            matrix_id = str(limit["matrixId"])
            for tile_row in range(
                int(limit["minTileRow"]),
                int(limit["maxTileRow"]) + 1,
            ):
                for tile_col in range(
                    int(limit["minTileCol"]),
                    int(limit["maxTileCol"]) + 1,
                ):
                    page = pages[page_index]
                    expected_path = _page_relative_path(
                        time_index,
                        int(matrix_id),
                        tile_row,
                        tile_col,
                    ).as_posix()
                    if (
                        not isinstance(page, dict)
                        or page.get("timeIndex") != time_index
                        or page.get("matrixId") != matrix_id
                        or page.get("tileRow") != tile_row
                        or page.get("tileCol") != tile_col
                        or page.get("path") != expected_path
                        or page.get("byteLength") != PAGE_BYTE_LENGTH
                        or not _sha256(page.get("sha256"))
                        or not _nonnegative_number(page.get("maximumSpeed"))
                    ):
                        raise ValueError("Flow Field manifest page contract is invalid")
                    page_index += 1

    if budgets != {
        "spatialPageCount": spatial_page_count,
        "timePageCount": expected_page_count,
        "pageByteLength": PAGE_BYTE_LENGTH,
        "totalRawPageBytes": expected_page_count * PAGE_BYTE_LENGTH,
    }:
        raise ValueError("Flow Field manifest budget contract is invalid")

    if len(time_maximum_speeds) != len(times):
        raise ValueError("Flow Field manifest maximum-speed contract is invalid")
    for time_index, record in enumerate(time_maximum_speeds):
        page_maximum = max(
            page["maximumSpeed"]
            for page in pages
            if page["timeIndex"] == time_index
        )
        if (
            not isinstance(record, dict)
            or record.get("timeIndex") != time_index
            or not _nonnegative_number(record.get("sourceMaximumSpeed"))
            or record.get("pageMaximumSpeed") != page_maximum
        ):
            raise ValueError("Flow Field manifest maximum-speed contract is invalid")
    if manifest.get("maximumSpeed") != max(
        record["sourceMaximumSpeed"] for record in time_maximum_speeds
    ):
        raise ValueError("Flow Field manifest maximum-speed contract is invalid")

    topology = construction.get("topology")
    interpolation = construction.get("interpolation")
    mapping = construction.get("mapping")
    quality = construction.get("quality")
    if (
        construction.get("algorithmVersion") != BUILD_ALGORITHM_VERSION
        or construction.get("sampleRegistration") != "global-texel-lattice"
        or construction.get("levelConstruction") != "direct"
        or construction.get("supportFilter") != "bilinear-safe-erosion-1"
        or construction.get("unsupportedVelocity") != [0.0, 0.0]
        or not isinstance(topology, dict)
        or topology.get("requested") != "delaunay"
        or topology.get("resolved") != "delaunay"
        or topology.get("inferred") is not True
        or not isinstance(interpolation, dict)
        or interpolation.get("requested") != "triangle-linear"
        or interpolation.get("resolved") != "triangle-linear"
        or interpolation.get("stationaryPolicy") not in {"interpolate", "require-all-moving"}
        or isinstance(interpolation.get("stationaryEpsilon"), bool)
        or not _nonnegative_number(interpolation.get("stationaryEpsilon"))
        or not isinstance(mapping, list)
        or len(mapping) != len(expected_limits)
        or not isinstance(quality, dict)
        or quality.get("particleSimulation") != "not-approved"
        or quality.get("approvalReason") != "resolution-error-budget-unset"
        or quality.get("finestMatrixId") != str(MAX_TILE_MATRIX)
        or quality.get("runtimeSampling") != "global-lattice-bilinear"
        or quality.get("supportFilter") != "bilinear-safe-erosion-1"
        or not isinstance(quality.get("levelSupport"), list)
        or len(quality["levelSupport"]) != len(expected_limits) * len(times)
        or not isinstance(quality.get("stationReconstruction"), list)
        or len(quality["stationReconstruction"]) != len(expected_limits) * len(times)
    ):
        raise ValueError("Flow Field manifest construction contract is invalid")

    support_index = 0
    for limit in expected_limits:
        level_page_count = (
            int(limit["maxTileRow"]) - int(limit["minTileRow"]) + 1
        ) * (int(limit["maxTileCol"]) - int(limit["minTileCol"]) + 1)
        target_count = level_page_count * TILE_SIZE * TILE_SIZE
        for time_index in range(len(times)):
            record = quality["levelSupport"][support_index]
            if (
                not isinstance(record, dict)
                or record.get("matrixId") != limit["matrixId"]
                or record.get("timeIndex") != time_index
                or isinstance(record.get("rawAdvectableTargetCount"), bool)
                or not isinstance(record.get("rawAdvectableTargetCount"), int)
                or isinstance(record.get("bilinearSafeTargetCount"), bool)
                or not isinstance(record.get("bilinearSafeTargetCount"), int)
                or not 0 <= record["bilinearSafeTargetCount"]
                <= record["rawAdvectableTargetCount"] <= target_count
            ):
                raise ValueError("Flow Field manifest support quality is invalid")
            support_index += 1

    for limit, entry in zip(expected_limits, mapping, strict=True):
        level_page_count = (
            int(limit["maxTileRow"]) - int(limit["minTileRow"]) + 1
        ) * (int(limit["maxTileCol"]) - int(limit["minTileCol"]) + 1)
        target_count = level_page_count * TILE_SIZE * TILE_SIZE
        if (
            not isinstance(entry, dict)
            or entry.get("matrixId") != limit["matrixId"]
            or entry.get("pageCount") != level_page_count
            or entry.get("targetCount") != target_count
            or any(
                isinstance(entry.get(name), bool)
                or not isinstance(entry.get(name), int)
                or entry[name] < 0
                for name in (
                    "validTargetCount",
                    "outsideTargetCount",
                    "rejectedTargetCount",
                    "numericalTargetCount",
                )
            )
            or sum(
                entry[name]
                for name in (
                    "validTargetCount",
                    "outsideTargetCount",
                    "rejectedTargetCount",
                    "numericalTargetCount",
                )
            ) != target_count
        ):
            raise ValueError("Flow Field manifest mapping contract is invalid")

    reconstruction_index = 0
    for limit in expected_limits:
        for time_index in range(len(times)):
            record = quality["stationReconstruction"][reconstruction_index]
            if (
                not isinstance(record, dict)
                or record.get("matrixId") != limit["matrixId"]
                or record.get("timeIndex") != time_index
                or record.get("stationaryEpsilon")
                != interpolation["stationaryEpsilon"]
                or any(
                    not _nonnegative_number(record.get(name))
                    for name in (
                        "velocityRmse",
                        "maximumVelocityError",
                        "angularRmseDegrees",
                        "maximumAngularErrorDegrees",
                        "maximumFalseMovingSpeed",
                    )
                )
                or any(
                    isinstance(record.get(name), bool)
                    or not isinstance(record.get(name), int)
                    or record[name] < 0
                    for name in (
                        "topologyVertexCount",
                        "stationaryVertexCount",
                        "stationaryFalseMovingCount",
                        "movingVertexCount",
                        "movingCollapsedCount",
                    )
                )
                or record["stationaryVertexCount"] + record["movingVertexCount"]
                != record["topologyVertexCount"]
                or record["stationaryFalseMovingCount"]
                > record["stationaryVertexCount"]
                or record["movingCollapsedCount"] > record["movingVertexCount"]
            ):
                raise ValueError("Flow Field manifest quality contract is invalid")
            reconstruction_index += 1

    page_set_sha256 = _page_set_sha256(pages)
    if construction.get("pageSetSha256") != page_set_sha256:
        raise ValueError("Flow Field manifest page identity is invalid")
    semantic_identity = _semantic_identity(manifest)
    semantic_sha256 = hashlib.sha256(
        json.dumps(semantic_identity, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    ).hexdigest()
    if construction.get("semanticSha256") != semantic_sha256:
        raise ValueError("Flow Field manifest semantic identity is invalid")
    identity = _construction_identity(
        str(source_hash),
        topology,
        interpolation,
        expected_limits,
        page_set_sha256,
        semantic_sha256,
    )
    expected_hash = hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    expected_version = (
        f"flow-{expected_hash[:16]}-rg32f-wmq-"
        f"z{MIN_TILE_MATRIX}-z{MAX_TILE_MATRIX}-v4"
    )
    if (
        construction.get("constructionHash") != expected_hash
        or manifest.get("contentVersion") != expected_version
    ):
        raise ValueError("Flow Field manifest construction identity is invalid")


def _sha256(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(
        character in "0123456789abcdef" for character in value
    )


def _finite_number(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _nonnegative_number(value: object) -> bool:
    return _finite_number(value) and float(value) >= 0.0


def _validate_staged_artifact(output_directory: Path, manifest: dict[str, Any]) -> None:
    validate_artifact_manifest(manifest)
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
        values = np.frombuffer(payload, dtype="<f4")
        if not np.isfinite(values).all():
            raise RuntimeError(f"Flow Field page artifact contains a non-finite value: {path}")
        speed = np.linalg.norm(values.reshape(-1, 2).astype(np.float64), axis=1)
        if float(speed.max(initial=0.0)) != page["maximumSpeed"]:
            raise RuntimeError(f"Flow Field page maximum speed mismatch: {path}")


def _install_staged_directory(staged: Path, output: Path) -> None:
    _require_safe_output_directory(output)
    if output.is_symlink():
        raise ValueError(f"Flow Field output directory cannot be a symbolic link: {output}")
    if output.exists() and not output.is_dir():
        raise ValueError(f"Flow Field output path must be a directory: {output}")
    if not output.exists():
        os.replace(staged, output)
        return
    if not _is_owned_artifact_directory(output):
        raise ValueError(
            f"Flow Field refuses to replace a non-artifact cache directory: {output}"
        )
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
    topology: TopologySpec | None = None,
    interpolation: InterpolationSpec | None = None,
    budget: BuildBudget = DEFAULT_BUILD_BUDGET,
) -> BuildResult:
    started = time.perf_counter()
    if not isinstance(budget, BuildBudget):
        raise TypeError("budget must be a BuildBudget")
    requested_output = Path(os.path.abspath(os.fspath(output_directory)))
    _require_safe_output_directory(requested_output)
    requested_output.parent.mkdir(parents=True, exist_ok=True)
    if requested_output.is_symlink():
        raise ValueError(
            f"Flow Field output directory cannot be a symbolic link: {requested_output}"
        )
    output = requested_output.parent.resolve(strict=True) / requested_output.name
    _require_safe_output_directory(output)
    if output.exists() and not _is_owned_artifact_directory(output):
        raise ValueError(
            f"Flow Field refuses to replace a non-artifact cache directory: {output}"
        )
    dataset = load_source_dataset(
        data_directory,
        descriptor_path=descriptor_path,
    )
    topology_spec = resolve_topology(
        dataset.descriptor.topology if topology is None else topology
    )
    interpolation_spec = resolve_interpolation(
        dataset.descriptor.interpolation if interpolation is None else interpolation
    )
    limits = _tile_matrix_limits(dataset.geographic_bounds)
    _preflight_build(limits, len(dataset.fields), output.parent, budget)
    prepared_topology = prepare_topology(dataset.stations, topology_spec)
    prepared_fields = tuple(
        prepared_topology.aggregate_field(field) for field in dataset.fields
    )
    duplicate_statistics = prepared_topology.duplicate_statistics(dataset.fields)
    staged = Path(tempfile.mkdtemp(prefix=f".{output.name}.build-", dir=output.parent))
    try:
        pages: list[dict[str, Any]] = []
        mapping_statistics: list[dict[str, Any]] = []
        support_statistics: list[dict[str, Any]] = []
        for limit in limits:
            matrix_level = int(limit["matrixId"])
            level_statistics = {
                "matrixId": str(matrix_level),
                "pageCount": 0,
                "targetCount": 0,
                "validTargetCount": 0,
                "outsideTargetCount": 0,
                "rejectedTargetCount": 0,
                "numericalTargetCount": 0,
            }
            level_support = [
                {
                    "matrixId": str(matrix_level),
                    "timeIndex": field.time_index,
                    "rawAdvectableTargetCount": 0,
                    "bilinearSafeTargetCount": 0,
                }
                for field in dataset.descriptor.fields
            ]
            for tile_row in range(
                int(limit["minTileRow"]),
                int(limit["maxTileRow"]) + 1,
            ):
                for tile_col in range(
                    int(limit["minTileCol"]),
                    int(limit["maxTileCol"]) + 1,
                ):
                    longitudes, latitudes = _texel_lattice_window(
                        matrix_level,
                        tile_row,
                        tile_col,
                        padding=1,
                    )
                    stencil = prepare_triangle_linear_stencil(
                        prepared_topology,
                        longitudes,
                        latitudes,
                        interpolation_spec,
                    )
                    central_status = stencil.status.reshape(
                        TILE_SIZE + 2,
                        TILE_SIZE + 2,
                    )[1:-1, 1:-1]
                    level_statistics["pageCount"] += 1
                    level_statistics["targetCount"] += TILE_SIZE * TILE_SIZE
                    level_statistics["validTargetCount"] += int(
                        np.count_nonzero(central_status == 1)
                    )
                    level_statistics["outsideTargetCount"] += int(
                        np.count_nonzero(central_status == 0)
                    )
                    level_statistics["rejectedTargetCount"] += int(
                        np.count_nonzero(central_status == 2)
                    )
                    level_statistics["numericalTargetCount"] += int(
                        np.count_nonzero(central_status == 3)
                    )
                    for field_descriptor, field, support in zip(
                        dataset.descriptor.fields,
                        prepared_fields,
                        level_support,
                        strict=True,
                    ):
                        rendered = _render_page(stencil, field)
                        support["rawAdvectableTargetCount"] += (
                            rendered.raw_advectable_count
                        )
                        support["bilinearSafeTargetCount"] += (
                            rendered.bilinear_safe_count
                        )
                        pages.append(_write_page(
                            staged,
                            rendered.values,
                            time_index=field_descriptor.time_index,
                            matrix_level=matrix_level,
                            tile_row=tile_row,
                            tile_col=tile_col,
                        ))
            mapping_statistics.append(level_statistics)
            support_statistics.extend(level_support)
        pages.sort(key=lambda page: (
            page["timeIndex"],
            int(page["matrixId"]),
            page["tileRow"],
            page["tileCol"],
        ))
        station_reconstruction_quality: list[dict[str, Any]] = []
        for limit in limits:
            station_reconstruction_quality.extend(_station_reconstruction_quality(
                staged,
                dataset,
                prepared_topology,
                interpolation_spec,
                prepared_fields,
                int(limit["matrixId"]),
                limit,
            ))
        manifest = _manifest(
            dataset,
            limits,
            pages,
            prepared_topology,
            interpolation_spec,
            duplicate_statistics,
            mapping_statistics,
            support_statistics,
            station_reconstruction_quality,
        )
        _validate_staged_artifact(staged, manifest)
        manifest_path = staged / "manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        staged.joinpath(ARTIFACT_MARKER_FILENAME).write_text(
            json.dumps({
                "kind": "geoscratch-flow-field-artifact",
                "contentVersion": manifest["contentVersion"],
            }, sort_keys=True) + "\n",
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
    if (
        output.name != "cache"
        or output == Path(output.anchor)
        or output.parent == Path(output.anchor)
        or output == Path.home()
    ):
        raise ValueError(
            "Flow Field generated output must be an explicit cache directory"
        )
    if output.is_symlink():
        raise ValueError(f"Flow Field output directory cannot be a symbolic link: {output}")


def _preflight_build(
    limits: tuple[dict[str, int | str], ...],
    time_count: int,
    output_parent: Path,
    budget: BuildBudget,
) -> dict[str, int]:
    spatial_page_count = sum(
        (int(limit["maxTileRow"]) - int(limit["minTileRow"]) + 1)
        * (int(limit["maxTileCol"]) - int(limit["minTileCol"]) + 1)
        for limit in limits
    )
    time_page_count = spatial_page_count * time_count
    raw_page_bytes = time_page_count * PAGE_BYTE_LENGTH
    if spatial_page_count > budget.max_spatial_pages:
        raise ValueError(
            "Flow Field build exceeds the configured spatial page budget: "
            f"{spatial_page_count} > {budget.max_spatial_pages}"
        )
    if raw_page_bytes > budget.max_raw_page_bytes:
        raise ValueError(
            "Flow Field build exceeds the configured raw byte budget: "
            f"{raw_page_bytes} > {budget.max_raw_page_bytes}"
        )
    available = shutil.disk_usage(output_parent).free
    required = raw_page_bytes + budget.minimum_free_bytes
    if available < required:
        raise OSError(
            "Flow Field build does not have enough free disk space: "
            f"requires {required} bytes, available {available}"
        )
    return {
        "spatialPageCount": spatial_page_count,
        "timePageCount": time_page_count,
        "rawPageBytes": raw_page_bytes,
        "availableBytes": available,
    }


def _is_owned_artifact_directory(output: Path) -> bool:
    allowed_names = {ARTIFACT_MARKER_FILENAME, "manifest.json", "tiles"}
    if any(entry.name not in allowed_names for entry in output.iterdir()):
        return False
    marker = output / ARTIFACT_MARKER_FILENAME
    if marker.is_file():
        try:
            value = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        return value.get("kind") == "geoscratch-flow-field-artifact"
    manifest_path = output / "manifest.json"
    tiles = output / "tiles" / "WebMercatorQuad"
    if not manifest_path.is_file() or not tiles.is_dir():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return (
        manifest.get("schemaVersion") == 1
        and isinstance(manifest.get("datasetId"), str)
        and isinstance(manifest.get("pages"), list)
    )


def verify_existing_tiles(output_directory: str | Path) -> dict[str, Any]:
    output = Path(output_directory).resolve()
    manifest_path = output / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"Flow Field manifest does not exist: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    validate_artifact_manifest(manifest)
    _validate_staged_artifact(output, manifest)
    pages = manifest["pages"]
    finest_quality = [
        record
        for record in manifest["construction"]["quality"]["stationReconstruction"]
        if record["matrixId"] == str(MAX_TILE_MATRIX)
    ]
    return {
        "contentVersion": manifest["contentVersion"],
        "pageCount": len(pages),
        "totalRawPageBytes": sum(page["byteLength"] for page in pages),
        "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        "pageSetSha256": manifest["construction"]["pageSetSha256"],
        "particleSimulation": manifest["construction"]["quality"][
            "particleSimulation"
        ],
        "finestStationaryFalseMovingCount": sum(
            record["stationaryFalseMovingCount"] for record in finest_quality
        ),
        "finestMovingCollapsedCount": sum(
            record["movingCollapsedCount"] for record in finest_quality
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build deterministic Flow Field WebMercatorQuad RG32F pages"
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_DATA_DIRECTORY)
    parser.add_argument("--descriptor", type=Path, default=DEFAULT_DESCRIPTOR_PATH)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_DIRECTORY)
    parser.add_argument("--verify-existing", action="store_true")
    arguments = parser.parse_args()
    if arguments.verify_existing:
        print(json.dumps(verify_existing_tiles(arguments.output), sort_keys=True))
        return
    result = build_velocity_tiles(
        arguments.source,
        arguments.output,
        descriptor_path=arguments.descriptor,
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
