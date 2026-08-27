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

from .contracts import InterpolationSpec, TopologySpec, resolve_interpolation, resolve_topology
from .interpolation import TriangleLinearStencil, prepare_triangle_linear_stencil
from .source import (
    DEFAULT_DATA_DIRECTORY,
    DEFAULT_DESCRIPTOR_PATH,
    SourceDataset,
    load_source_dataset,
)
from .topology import PreparedDelaunayTopology, prepare_topology


TILE_SIZE = 256
MIN_TILE_MATRIX = 4
MAX_TILE_MATRIX = 9
PAGE_BYTE_LENGTH = TILE_SIZE * TILE_SIZE * 2 * 4
BUILD_ALGORITHM_VERSION = "flow-rg32f-wmq-v3"
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


def _texel_lattice(
    matrix_level: int,
    tile_row: int,
    tile_col: int,
) -> tuple[np.ndarray, np.ndarray]:
    world_cells = (1 << matrix_level) * TILE_SIZE
    global_cols = tile_col * TILE_SIZE + np.arange(TILE_SIZE, dtype=np.float64)
    global_rows = tile_row * TILE_SIZE + np.arange(TILE_SIZE, dtype=np.float64)
    longitudes = global_cols / world_cells * 360.0 - 180.0
    mercator_y = math.pi * (1.0 - 2.0 * global_rows / world_cells)
    latitudes = np.degrees(np.arctan(np.sinh(mercator_y)))
    return (
        np.broadcast_to(longitudes, (TILE_SIZE, TILE_SIZE)).reshape(-1),
        np.broadcast_to(latitudes[:, None], (TILE_SIZE, TILE_SIZE)).reshape(-1),
    )


def _render_page(stencil: TriangleLinearStencil, unique_field: np.ndarray) -> np.ndarray:
    return stencil.apply_unique(unique_field).reshape(TILE_SIZE, TILE_SIZE, 2)


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


def _finest_station_reconstruction_quality(
    output_directory: Path,
    dataset: SourceDataset,
    topology: PreparedDelaunayTopology,
    prepared_fields: tuple[np.ndarray, ...],
    finest_limit: dict[str, int | str],
) -> list[dict[str, Any]]:
    min_row = int(finest_limit["minTileRow"])
    max_row = int(finest_limit["maxTileRow"])
    min_col = int(finest_limit["minTileCol"])
    max_col = int(finest_limit["maxTileCol"])
    height = (max_row - min_row + 1) * TILE_SIZE
    width = (max_col - min_col + 1) * TILE_SIZE
    world_cells = (1 << MAX_TILE_MATRIX) * TILE_SIZE
    stations = topology.vertices_lon_lat
    global_x = (stations[:, 0] + 180.0) / 360.0 * world_cells
    mercator_y = np.arcsinh(np.tan(np.radians(stations[:, 1])))
    global_y = (1.0 - mercator_y / math.pi) * 0.5 * world_cells
    local_x = global_x - min_col * TILE_SIZE
    local_y = global_y - min_row * TILE_SIZE
    base_x = np.floor(local_x).astype(np.int64)
    base_y = np.floor(local_y).astype(np.int64)
    if np.any(base_x < 0) or np.any(base_x + 1 >= width):
        raise RuntimeError("finest reconstruction stations exceed longitude coverage")
    if np.any(base_y < 0) or np.any(base_y + 1 >= height):
        raise RuntimeError("finest reconstruction stations exceed latitude coverage")
    weight_x = (local_x - base_x)[:, None]
    weight_y = (local_y - base_y)[:, None]

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
                        MAX_TILE_MATRIX,
                        tile_row,
                        tile_col,
                    )
                )
        top_left = mosaic[base_y, base_x].astype(np.float64)
        top_right = mosaic[base_y, base_x + 1].astype(np.float64)
        bottom_left = mosaic[base_y + 1, base_x].astype(np.float64)
        bottom_right = mosaic[base_y + 1, base_x + 1].astype(np.float64)
        reconstructed = (
            (top_left * (1.0 - weight_x) + top_right * weight_x)
            * (1.0 - weight_y)
            + (bottom_left * (1.0 - weight_x) + bottom_right * weight_x)
            * weight_y
        )
        reference_speed = np.linalg.norm(reference, axis=1)
        reconstructed_speed = np.linalg.norm(reconstructed, axis=1)
        velocity_error = np.linalg.norm(reconstructed - reference, axis=1)
        stationary = reference_speed == 0.0
        moving = ~stationary
        false_moving = stationary & (reconstructed_speed > 0.0)
        collapsed_moving = moving & (reconstructed_speed == 0.0)
        directional = moving & (reconstructed_speed > 0.0)
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
            "timeIndex": field_descriptor.time_index,
            "topologyVertexCount": topology.vertex_count,
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
    mapping_statistics: list[dict[str, Any]],
    station_reconstruction_quality: list[dict[str, Any]],
) -> dict[str, Any]:
    descriptor = dataset.descriptor
    duplicate_statistics = topology.duplicate_statistics(dataset.fields)
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
    construction_identity = _construction_identity(
        dataset.source_hash,
        topology_manifest,
        interpolation_manifest,
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
        f"z{MIN_TILE_MATRIX}-z{MAX_TILE_MATRIX}-v3"
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
            "constructionHash": construction_hash,
            "topology": topology_manifest,
            "interpolation": interpolation_manifest,
            "unsupportedVelocity": [0.0, 0.0],
            "sampleRegistration": "global-texel-lattice",
            "levelConstruction": "direct",
            "mapping": mapping_statistics,
            "quality": {
                "finestMatrixId": str(MAX_TILE_MATRIX),
                "runtimeSampling": "global-lattice-bilinear",
                "stationReconstruction": station_reconstruction_quality,
            },
        },
    }


def _construction_identity(
    source_hash: str,
    topology_manifest: dict[str, object],
    interpolation_manifest: dict[str, object],
) -> dict[str, object]:
    return {
        "algorithmVersion": BUILD_ALGORITHM_VERSION,
        "sourceHash": source_hash,
        "topology": topology_manifest,
        "interpolation": interpolation_manifest,
        "tileMatrixSet": "WebMercatorQuad",
        "tileSize": TILE_SIZE,
        "minimumTileMatrix": MIN_TILE_MATRIX,
        "maximumTileMatrix": MAX_TILE_MATRIX,
        "sampleRegistration": "global-texel-lattice",
        "levelConstruction": "direct",
    }


def validate_artifact_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("schemaVersion") != 1:
        raise ValueError("Flow Field manifest schemaVersion must be 1")
    source_hash = manifest.get("sourceHash")
    construction = manifest.get("construction")
    if (
        not isinstance(source_hash, str)
        or len(source_hash) != 64
        or any(character not in "0123456789abcdef" for character in source_hash)
    ):
        raise ValueError("Flow Field manifest sourceHash is invalid")
    if not isinstance(construction, dict):
        raise ValueError("Flow Field manifest construction facts are missing")
    topology = construction.get("topology")
    interpolation = construction.get("interpolation")
    mapping = construction.get("mapping")
    quality = construction.get("quality")
    times = manifest.get("times")
    if (
        construction.get("algorithmVersion") != BUILD_ALGORITHM_VERSION
        or construction.get("sampleRegistration") != "global-texel-lattice"
        or construction.get("levelConstruction") != "direct"
        or construction.get("unsupportedVelocity") != [0.0, 0.0]
        or not isinstance(topology, dict)
        or topology.get("requested") != "delaunay"
        or topology.get("resolved") != "delaunay"
        or topology.get("inferred") is not True
        or not isinstance(interpolation, dict)
        or interpolation.get("requested") != "triangle-linear"
        or interpolation.get("resolved") != "triangle-linear"
        or interpolation.get("stationaryPolicy") != "require-all-moving"
        or interpolation.get("stationaryEpsilon") != 0.0
        or not isinstance(mapping, list)
        or len(mapping) != MAX_TILE_MATRIX - MIN_TILE_MATRIX + 1
        or not all(isinstance(entry, dict) for entry in mapping)
        or [entry.get("matrixId") for entry in mapping]
        != [str(level) for level in range(MIN_TILE_MATRIX, MAX_TILE_MATRIX + 1)]
        or not isinstance(quality, dict)
        or quality.get("finestMatrixId") != str(MAX_TILE_MATRIX)
        or quality.get("runtimeSampling") != "global-lattice-bilinear"
        or not isinstance(quality.get("stationReconstruction"), list)
        or not isinstance(times, list)
        or len(quality["stationReconstruction"]) != len(times)
    ):
        raise ValueError("Flow Field manifest construction contract is invalid")
    identity = _construction_identity(source_hash, topology, interpolation)
    expected_hash = hashlib.sha256(
        json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    expected_version = (
        f"flow-{expected_hash[:16]}-rg32f-wmq-"
        f"z{MIN_TILE_MATRIX}-z{MAX_TILE_MATRIX}-v3"
    )
    if (
        construction.get("constructionHash") != expected_hash
        or manifest.get("contentVersion") != expected_version
    ):
        raise ValueError("Flow Field manifest construction identity is invalid")


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
    topology: TopologySpec | None = None,
    interpolation: InterpolationSpec | None = None,
) -> BuildResult:
    started = time.perf_counter()
    output = Path(output_directory).resolve()
    _require_safe_output_directory(output)
    output.parent.mkdir(parents=True, exist_ok=True)
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
    prepared_topology = prepare_topology(dataset.stations, topology_spec)
    prepared_fields = tuple(
        prepared_topology.aggregate_field(field) for field in dataset.fields
    )
    limits = _tile_matrix_limits(dataset.geographic_bounds)
    staged = Path(tempfile.mkdtemp(prefix=f".{output.name}.build-", dir=output.parent))
    try:
        pages: list[dict[str, Any]] = []
        mapping_statistics: list[dict[str, Any]] = []
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
            for tile_row in range(
                int(limit["minTileRow"]),
                int(limit["maxTileRow"]) + 1,
            ):
                for tile_col in range(
                    int(limit["minTileCol"]),
                    int(limit["maxTileCol"]) + 1,
                ):
                    longitudes, latitudes = _texel_lattice(
                        matrix_level,
                        tile_row,
                        tile_col,
                    )
                    stencil = prepare_triangle_linear_stencil(
                        prepared_topology,
                        longitudes,
                        latitudes,
                        interpolation_spec,
                    )
                    level_statistics["pageCount"] += 1
                    level_statistics["targetCount"] += stencil.target_count
                    level_statistics["validTargetCount"] += stencil.valid_target_count
                    level_statistics["outsideTargetCount"] += (
                        stencil.outside_target_count
                    )
                    level_statistics["rejectedTargetCount"] += (
                        stencil.rejected_target_count
                    )
                    level_statistics["numericalTargetCount"] += (
                        stencil.numerical_target_count
                    )
                    for field_descriptor, field in zip(
                        dataset.descriptor.fields,
                        prepared_fields,
                        strict=True,
                    ):
                        pages.append(_write_page(
                            staged,
                            _render_page(stencil, field),
                            time_index=field_descriptor.time_index,
                            matrix_level=matrix_level,
                            tile_row=tile_row,
                            tile_col=tile_col,
                        ))
            mapping_statistics.append(level_statistics)
        pages.sort(key=lambda page: (
            page["timeIndex"],
            int(page["matrixId"]),
            page["tileRow"],
            page["tileCol"],
        ))
        station_reconstruction_quality = _finest_station_reconstruction_quality(
            staged,
            dataset,
            prepared_topology,
            prepared_fields,
            limits[-1],
        )
        manifest = _manifest(
            dataset,
            limits,
            pages,
            prepared_topology,
            interpolation_spec,
            mapping_statistics,
            station_reconstruction_quality,
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
    validate_artifact_manifest(manifest)
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
