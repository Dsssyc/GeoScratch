from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import morecantile
import numpy as np
import rasterio
import rio_cogeo
from rasterio.enums import MaskFlags
from rasterio.transform import Affine
from rasterio.windows import Window
from rio_cogeo.cogeo import cog_translate, cog_validate
from rio_cogeo.profiles import cog_profiles

from .contracts import InterpolationSpec, TopologySpec, resolve_interpolation, resolve_topology
from .interpolation import apply_bilinear_safe_block, prepare_triangle_linear_stencil
from .resolution import (
    ResolutionSelection,
    ResolutionSpec,
    select_resolution,
    web_mercator_matrix_pixel_size,
)
from .source import (
    DEFAULT_DATA_DIRECTORY,
    DEFAULT_DESCRIPTOR_PATH,
    SourceSnapshot,
    load_source_snapshot,
)
from .topology import WEB_MERCATOR_RADIUS, prepare_topology


COG_BLOCK_SIZE = 256
COG_BYTES_PER_PIXEL = 2 * np.dtype("<f4").itemsize
COG_ARTIFACT_MARKER = ".flow-field-cog-artifact.json"
NO_OVERVIEW_WARNING = (
    "The file is greater than 512xH or 512xW, it is recommended to include internal overviews"
)
TILE_SERVER_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COG_OUTPUT_DIRECTORY = TILE_SERVER_ROOT / "cog-cache"
WEB_MERCATOR_QUAD = morecantile.tms.get("WebMercatorQuad")
WEB_MERCATOR_MAX_LATITUDE = math.degrees(math.atan(math.sinh(math.pi)))


@dataclass(frozen=True, slots=True)
class CogBuildBudget:
    """Bounds a single-snapshot COG before any topology or raster allocation."""

    max_blocks: int = 4_096
    max_raw_bytes: int = 2 * 1024 * 1024 * 1024
    minimum_free_bytes: int = 256 * 1024 * 1024

    def __post_init__(self) -> None:
        for name, value in (
            ("max_blocks", self.max_blocks),
            ("max_raw_bytes", self.max_raw_bytes),
            ("minimum_free_bytes", self.minimum_free_bytes),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"{name} must be a positive integer")


@dataclass(frozen=True, slots=True)
class CogEncoding:
    """Lossless two-band Float32 COG encoding implemented by this prototype."""

    block_size: int = COG_BLOCK_SIZE
    compression: str = "DEFLATE"
    predictor: int = 3
    compression_level: int = 9
    big_tiff: str = "IF_SAFER"
    overview_policy: str = "none"

    def __post_init__(self) -> None:
        if self.block_size != COG_BLOCK_SIZE:
            raise ValueError("block_size must be 256")
        if self.compression != "DEFLATE":
            raise ValueError("compression must be DEFLATE")
        if self.predictor != 3:
            raise ValueError("predictor must be 3 for Float32")
        if self.compression_level != 9:
            raise ValueError("compression_level must be 9")
        if self.big_tiff != "IF_SAFER":
            raise ValueError("big_tiff must be IF_SAFER")
        if self.overview_policy != "none":
            raise ValueError("overview_policy must be none")

    def manifest(self) -> dict[str, Any]:
        return {
            "driver": "GTiff/COG",
            "bands": 2,
            "componentOrder": ["u", "v"],
            "sampleType": "float32",
            "interleave": "pixel",
            "blockWidth": self.block_size,
            "blockHeight": self.block_size,
            "compression": self.compression,
            "predictor": self.predictor,
            "compressionLevel": self.compression_level,
            "bigTiff": self.big_tiff,
            "nodata": None,
            "mask": None,
            "overviewPolicy": self.overview_policy,
        }


@dataclass(frozen=True, slots=True)
class CogGrid:
    matrix_id: int
    min_tile_row: int
    max_tile_row: int
    min_tile_col: int
    max_tile_col: int
    width: int
    height: int
    pixel_size_meters: float
    transform: tuple[float, float, float, float, float, float]
    projected_bounds: tuple[float, float, float, float]

    @property
    def block_count(self) -> int:
        return (
            (self.max_tile_row - self.min_tile_row + 1)
            * (self.max_tile_col - self.min_tile_col + 1)
        )

    @property
    def raw_bytes(self) -> int:
        return self.width * self.height * COG_BYTES_PER_PIXEL

    def manifest(self) -> dict[str, Any]:
        return {
            "crs": "EPSG:3857",
            "tileMatrixSet": "WebMercatorQuad",
            "matrixId": str(self.matrix_id),
            "tileLimits": {
                "minTileRow": self.min_tile_row,
                "maxTileRow": self.max_tile_row,
                "minTileCol": self.min_tile_col,
                "maxTileCol": self.max_tile_col,
            },
            "width": self.width,
            "height": self.height,
            "pixelSizeMeters": self.pixel_size_meters,
            "transform": list(self.transform),
            "projectedBounds": list(self.projected_bounds),
            "blockCount": self.block_count,
            "rawBytes": self.raw_bytes,
            "sampleRegistration": "pixel-center",
        }


@dataclass(frozen=True, slots=True)
class CogBudgetAssessment:
    grid: CogGrid
    budget: CogBuildBudget
    available_bytes: int
    required_peak_bytes: int
    violations: tuple[str, ...]

    @property
    def approved(self) -> bool:
        return not self.violations

    def manifest(self) -> dict[str, Any]:
        return {
            "approved": self.approved,
            "violations": list(self.violations),
            "limits": {
                "maxBlocks": self.budget.max_blocks,
                "maxRawBytes": self.budget.max_raw_bytes,
                "minimumFreeBytes": self.budget.minimum_free_bytes,
            },
            "observed": {
                "blockCount": self.grid.block_count,
                "rawBytes": self.grid.raw_bytes,
                "availableBytes": self.available_bytes,
                "requiredPeakBytes": self.required_peak_bytes,
            },
        }


@dataclass(frozen=True, slots=True)
class CogBuildPlan:
    selection: ResolutionSelection
    selected_grid: CogGrid
    grid: CogGrid
    matrix_override: int | None
    selected_budget: CogBudgetAssessment
    output_budget: CogBudgetAssessment

    @property
    def matrix_relation(self) -> str:
        if self.grid.matrix_id < self.selection.matrix_id:
            return "coarser-explicit-override"
        if self.grid.matrix_id > self.selection.matrix_id:
            return "finer-explicit-override"
        return "statistically-selected"

    def construction_manifest(self) -> dict[str, Any]:
        return {
            "resolution": self.selection.manifest(),
            "matrixOverride": self.matrix_override,
            "matrixDecision": {
                "selectedMatrixId": str(self.selection.matrix_id),
                "outputMatrixId": str(self.grid.matrix_id),
                "relation": self.matrix_relation,
            },
            "selectedGrid": self.selected_grid.manifest(),
            "grid": self.grid.manifest(),
        }

    def manifest(self) -> dict[str, Any]:
        return {
            **self.construction_manifest(),
            "preflight": {
                "selected": self.selected_budget.manifest(),
                "output": self.output_budget.manifest(),
            },
        }

    def require_output_approved(self) -> None:
        if self.output_budget.approved:
            return
        observed = self.output_budget.manifest()["observed"]
        raise ValueError(
            "Flow Field COG output plan exceeds configured budgets: "
            + ", ".join(self.output_budget.violations)
            + f"; blocks={observed['blockCount']}, rawBytes={observed['rawBytes']}, "
            + f"requiredPeakBytes={observed['requiredPeakBytes']}, "
            + f"availableBytes={observed['availableBytes']}"
        )


@dataclass(frozen=True, slots=True)
class CogBuildResult:
    output_directory: Path
    cog_path: Path
    manifest_path: Path
    content_version: str
    cog_sha256: str
    cog_size_bytes: int


def plan_velocity_cog_snapshot(
    stations: np.ndarray,
    geographic_bounds: tuple[float, float, float, float],
    output_parent: str | Path,
    *,
    resolution: ResolutionSpec | None = None,
    matrix_override: int | None = None,
    budget: CogBuildBudget = CogBuildBudget(),
) -> CogBuildPlan:
    if not isinstance(budget, CogBuildBudget):
        raise TypeError("budget must be a CogBuildBudget")
    selection = select_resolution(stations, resolution)
    selected_grid = _cog_grid(geographic_bounds, selection.matrix_id)
    matrix_id = selection.matrix_id
    if matrix_override is not None:
        if (
            isinstance(matrix_override, bool)
            or not isinstance(matrix_override, int)
            or not 0 <= matrix_override <= 24
        ):
            raise ValueError("matrix_override must be an integer in [0, 24] or None")
        matrix_id = matrix_override
    grid = _cog_grid(geographic_bounds, matrix_id)
    parent = Path(output_parent).resolve()
    if not parent.is_dir():
        raise FileNotFoundError(f"COG output parent does not exist: {parent}")
    available = shutil.disk_usage(parent).free
    selected_budget = _assess_cog_budget(selected_grid, budget, available)
    output_budget = _assess_cog_budget(grid, budget, available)
    return CogBuildPlan(
        selection=selection,
        selected_grid=selected_grid,
        grid=grid,
        matrix_override=matrix_override,
        selected_budget=selected_budget,
        output_budget=output_budget,
    )


def _assess_cog_budget(
    grid: CogGrid,
    budget: CogBuildBudget,
    available_bytes: int,
) -> CogBudgetAssessment:
    required_peak_bytes = grid.raw_bytes * 2 + budget.minimum_free_bytes
    violations: list[str] = []
    if grid.block_count > budget.max_blocks:
        violations.append(
            f"block budget {grid.block_count} > {budget.max_blocks}"
        )
    if grid.raw_bytes > budget.max_raw_bytes:
        violations.append(
            f"raw byte budget {grid.raw_bytes} > {budget.max_raw_bytes}"
        )
    if available_bytes < required_peak_bytes:
        violations.append(
            f"free-space budget {required_peak_bytes} > {available_bytes}"
        )
    return CogBudgetAssessment(
        grid=grid,
        budget=budget,
        available_bytes=available_bytes,
        required_peak_bytes=required_peak_bytes,
        violations=tuple(violations),
    )


def _validate_budget_manifest(value: object, grid: CogGrid) -> None:
    if not isinstance(value, dict):
        raise ValueError("Flow Field COG budget facts are invalid")
    limits = value.get("limits")
    observed = value.get("observed")
    if not isinstance(limits, dict) or not isinstance(observed, dict):
        raise ValueError("Flow Field COG budget facts are invalid")
    try:
        budget = CogBuildBudget(
            max_blocks=limits["maxBlocks"],
            max_raw_bytes=limits["maxRawBytes"],
            minimum_free_bytes=limits["minimumFreeBytes"],
        )
        available_bytes = observed["availableBytes"]
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("Flow Field COG budget facts are invalid") from error
    if (
        isinstance(available_bytes, bool)
        or not isinstance(available_bytes, int)
        or available_bytes < 0
    ):
        raise ValueError("Flow Field COG budget facts are invalid")
    expected = _assess_cog_budget(grid, budget, available_bytes).manifest()
    if value != expected:
        raise ValueError("Flow Field COG budget identity is invalid")


def _cog_grid(
    geographic_bounds: tuple[float, float, float, float],
    matrix_id: int,
) -> CogGrid:
    west, south, east, north = _require_geographic_bounds(geographic_bounds)
    north_west = WEB_MERCATOR_QUAD.tile(west, north, matrix_id)
    south_east = WEB_MERCATOR_QUAD.tile(east, south, matrix_id)
    min_col = int(north_west.x)
    max_col = int(south_east.x)
    min_row = int(north_west.y)
    max_row = int(south_east.y)
    pixel_size = web_mercator_matrix_pixel_size(matrix_id)
    half_world = math.pi * WEB_MERCATOR_RADIUS
    minimum_x = -half_world + min_col * COG_BLOCK_SIZE * pixel_size
    maximum_y = half_world - min_row * COG_BLOCK_SIZE * pixel_size
    width = (max_col - min_col + 1) * COG_BLOCK_SIZE
    height = (max_row - min_row + 1) * COG_BLOCK_SIZE
    maximum_x = minimum_x + width * pixel_size
    minimum_y = maximum_y - height * pixel_size
    return CogGrid(
        matrix_id=matrix_id,
        min_tile_row=min_row,
        max_tile_row=max_row,
        min_tile_col=min_col,
        max_tile_col=max_col,
        width=width,
        height=height,
        pixel_size_meters=pixel_size,
        transform=(pixel_size, 0.0, minimum_x, 0.0, -pixel_size, maximum_y),
        projected_bounds=(minimum_x, minimum_y, maximum_x, maximum_y),
    )


def _require_geographic_bounds(
    value: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    if not isinstance(value, (tuple, list)) or len(value) != 4:
        raise ValueError("geographic_bounds must contain west, south, east, north")
    if any(isinstance(component, bool) for component in value):
        raise ValueError("geographic_bounds must contain numeric coordinates")
    bounds = tuple(float(component) for component in value)
    if not all(math.isfinite(component) for component in bounds):
        raise ValueError("geographic_bounds must be finite")
    west, south, east, north = bounds
    if not -180.0 <= west < east <= 180.0:
        raise ValueError("geographic_bounds longitude must satisfy -180 <= west < east <= 180")
    if not (
        -WEB_MERCATOR_MAX_LATITUDE
        <= south
        < north
        <= WEB_MERCATOR_MAX_LATITUDE
    ):
        raise ValueError(
            "geographic_bounds latitude is outside the WebMercator domain"
        )
    return bounds


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(
        character in "0123456789abcdef" for character in value
    )


def _cog_pixel_centers_window(
    matrix_id: int,
    tile_row: int,
    tile_col: int,
    *,
    padding: int,
) -> tuple[np.ndarray, np.ndarray]:
    world_cells = (1 << matrix_id) * COG_BLOCK_SIZE
    offsets = np.arange(-padding, COG_BLOCK_SIZE + padding, dtype=np.float64) + 0.5
    global_cols = np.clip(
        tile_col * COG_BLOCK_SIZE + offsets,
        0.5,
        world_cells - 0.5,
    )
    global_rows = np.clip(
        tile_row * COG_BLOCK_SIZE + offsets,
        0.5,
        world_cells - 0.5,
    )
    longitudes = global_cols / world_cells * 360.0 - 180.0
    mercator_y = math.pi * (1.0 - 2.0 * global_rows / world_cells)
    latitudes = np.degrees(np.arctan(np.sinh(mercator_y)))
    side = COG_BLOCK_SIZE + padding * 2
    return (
        np.broadcast_to(longitudes, (side, side)).reshape(-1),
        np.broadcast_to(latitudes[:, None], (side, side)).reshape(-1),
    )


def _write_intermediate_tiff(
    path: Path,
    snapshot: SourceSnapshot,
    plan: CogBuildPlan,
    topology,
    unique_field: np.ndarray,
    interpolation,
) -> dict[str, Any]:
    grid = plan.grid
    transform = Affine(*grid.transform)
    profile = {
        "driver": "GTiff",
        "width": grid.width,
        "height": grid.height,
        "count": 2,
        "dtype": "float32",
        "crs": "EPSG:3857",
        "transform": transform,
        "nodata": None,
        "tiled": True,
        "blockxsize": COG_BLOCK_SIZE,
        "blockysize": COG_BLOCK_SIZE,
        "compress": "DEFLATE",
        "predictor": 3,
        "zlevel": 9,
        "interleave": "pixel",
        "BIGTIFF": "IF_SAFER",
    }
    pixel_digest = hashlib.sha256()
    raw_advectable_count = 0
    bilinear_safe_count = 0
    with rasterio.open(path, "w", **profile) as dataset:
        dataset.set_band_description(1, "U")
        dataset.set_band_description(2, "V")
        dataset.update_tags(
            AREA_OR_POINT="Point",
            GEOSCRATCH_ARTIFACT="flow-field-cog-snapshot",
            GEOSCRATCH_SOURCE_HASH=snapshot.source_hash,
            GEOSCRATCH_TIME_INDEX=str(snapshot.field_descriptor.time_index),
            GEOSCRATCH_SAMPLE_REGISTRATION="pixel-center",
        )
        dataset.update_tags(1, GEOSCRATCH_COMPONENT="u")
        dataset.update_tags(2, GEOSCRATCH_COMPONENT="v")
        for block_row, tile_row in enumerate(
            range(grid.min_tile_row, grid.max_tile_row + 1)
        ):
            for block_col, tile_col in enumerate(
                range(grid.min_tile_col, grid.max_tile_col + 1)
            ):
                longitudes, latitudes = _cog_pixel_centers_window(
                    grid.matrix_id,
                    tile_row,
                    tile_col,
                    padding=1,
                )
                stencil = prepare_triangle_linear_stencil(
                    topology,
                    longitudes,
                    latitudes,
                    interpolation,
                )
                rendered = apply_bilinear_safe_block(
                    stencil,
                    unique_field,
                    block_size=COG_BLOCK_SIZE,
                )
                band_first = np.moveaxis(rendered.values, 2, 0).astype(
                    "<f4",
                    copy=False,
                )
                dataset.write(
                    band_first,
                    window=Window(
                        block_col * COG_BLOCK_SIZE,
                        block_row * COG_BLOCK_SIZE,
                        COG_BLOCK_SIZE,
                        COG_BLOCK_SIZE,
                    ),
                )
                pixel_digest.update(band_first.tobytes(order="C"))
                raw_advectable_count += rendered.raw_advectable_count
                bilinear_safe_count += rendered.bilinear_safe_count
    return {
        "pixelSha256": pixel_digest.hexdigest(),
        "rawAdvectablePixelCount": raw_advectable_count,
        "bilinearSafePixelCount": bilinear_safe_count,
    }


def _translate_cog(source_tiff: Path, destination: Path, encoding: CogEncoding) -> None:
    profile = cog_profiles.get("deflate")
    profile.update({
        "blockxsize": encoding.block_size,
        "blockysize": encoding.block_size,
        "predictor": encoding.predictor,
        "zlevel": encoding.compression_level,
        "BIGTIFF": encoding.big_tiff,
        "interleave": "pixel",
    })
    # rio-cogeo documents overview_level=0 as an explicit empty overview set.
    # Source: https://cogeotiff.github.io/rio-cogeo/API/
    cog_translate(
        source_tiff,
        destination,
        profile,
        overview_level=0,
        overview_resampling="nearest",
        in_memory=False,
        quiet=True,
        forward_band_tags=True,
        forward_ns_tags=True,
        use_cog_driver=False,
    )


def _validate_cog(
    path: Path,
    grid: CogGrid,
    encoding: CogEncoding,
    expected_pixel_sha256: str,
    *,
    expected_source_hash: str,
    expected_time_index: int,
) -> dict[str, Any]:
    valid, errors, warnings = cog_validate(path, strict=False)
    unexpected_warnings = [warning for warning in warnings if warning != NO_OVERVIEW_WARNING]
    if not valid or errors or unexpected_warnings:
        raise RuntimeError(
            "Generated Flow Field COG failed validation: "
            + json.dumps({
                "errors": errors,
                "warnings": warnings,
            }, sort_keys=True)
        )
    pixel_digest = hashlib.sha256()
    with rasterio.open(path) as dataset:
        root_tags = dataset.tags()
        image_structure = dataset.tags(ns="IMAGE_STRUCTURE")
        if (
            dataset.crs is None
            or dataset.crs.to_string() != "EPSG:3857"
            or dataset.width != grid.width
            or dataset.height != grid.height
            or dataset.count != 2
            or dataset.dtypes != ("float32", "float32")
            or dataset.nodata is not None
            or dataset.block_shapes != [
                (encoding.block_size, encoding.block_size),
                (encoding.block_size, encoding.block_size),
            ]
            or dataset.overviews(1) != []
            or dataset.overviews(2) != []
            or dataset.transform != Affine(*grid.transform)
            or tuple(dataset.bounds) != grid.projected_bounds
            or dataset.descriptions != ("U", "V")
            or dataset.transform.e >= 0.0
            or any(flags != [MaskFlags.all_valid] for flags in dataset.mask_flag_enums)
            or root_tags.get("AREA_OR_POINT") != "Point"
            or root_tags.get("GEOSCRATCH_ARTIFACT")
            != "flow-field-cog-snapshot"
            or root_tags.get("GEOSCRATCH_SAMPLE_REGISTRATION") != "pixel-center"
            or root_tags.get("GEOSCRATCH_SOURCE_HASH") != expected_source_hash
            or root_tags.get("GEOSCRATCH_TIME_INDEX") != str(expected_time_index)
            or dataset.tags(1).get("GEOSCRATCH_COMPONENT") != "u"
            or dataset.tags(2).get("GEOSCRATCH_COMPONENT") != "v"
            or image_structure.get("LAYOUT") != "COG"
            or image_structure.get("COMPRESSION") != encoding.compression
            or image_structure.get("INTERLEAVE") != "PIXEL"
            or image_structure.get("PREDICTOR") != str(encoding.predictor)
        ):
            raise RuntimeError("Generated Flow Field COG structure is invalid")
        for _block, window in dataset.block_windows(1):
            values = dataset.read((1, 2), window=window, out_dtype="float32")
            if not np.isfinite(values).all():
                raise RuntimeError("Generated Flow Field COG contains non-finite values")
            pixel_digest.update(np.asarray(values, dtype="<f4").tobytes(order="C"))
    if pixel_digest.hexdigest() != expected_pixel_sha256:
        raise RuntimeError("Generated Flow Field COG pixels changed during translation")
    return {
        "pixelSha256": pixel_digest.hexdigest(),
        "overviewCount": 0,
        "blockCount": grid.block_count,
        "validationWarnings": warnings,
    }


def _build_manifest(
    snapshot: SourceSnapshot,
    plan: CogBuildPlan,
    encoding: CogEncoding,
    topology_manifest: dict[str, Any],
    interpolation_manifest: dict[str, Any],
    support: dict[str, Any],
    cog_path: Path,
    cog_validation: dict[str, Any],
) -> dict[str, Any]:
    cog_sha256 = _sha256(cog_path)
    cog_size = cog_path.stat().st_size
    source_facts = {
        "datasetId": snapshot.descriptor.dataset_id,
        "sourceRevision": snapshot.descriptor.source_revision,
        "sourceHash": snapshot.source_hash,
        "crs": "EPSG:4326",
        "geographicBounds": list(snapshot.geographic_bounds),
        "stationCount": snapshot.descriptor.station_count,
        "stationHash": snapshot.descriptor.station_sha256,
    }
    snapshot_facts = {
        "timeIndex": snapshot.field_descriptor.time_index,
        "modelTime": snapshot.field_descriptor.model_time,
        "velocityHash": snapshot.field_descriptor.sha256,
        "unit": snapshot.descriptor.unit,
        "basis": snapshot.descriptor.basis,
        "phase": snapshot.descriptor.phase,
    }
    construction = {
        "source": source_facts,
        "snapshot": snapshot_facts,
        "topology": topology_manifest,
        "interpolation": interpolation_manifest,
        "plan": plan.construction_manifest(),
        "encoding": encoding.manifest(),
        "support": support,
        "cog": {
            "path": cog_path.name,
            "sha256": cog_sha256,
            "sizeBytes": cog_size,
            **cog_validation,
        },
        "dependencies": {
            "numpy": np.__version__,
            "rasterio": rasterio.__version__,
            "gdal": rasterio.__gdal_version__,
            "rioCogeo": rio_cogeo.__version__,
        },
    }
    construction_sha256 = hashlib.sha256(
        json.dumps(construction, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    time_index = snapshot_facts["timeIndex"]
    return {
        "schemaVersion": 1,
        "artifactType": "flow-field-cog-snapshot",
        "datasetId": source_facts["datasetId"],
        "sourceRevision": source_facts["sourceRevision"],
        "sourceHash": source_facts["sourceHash"],
        "contentVersion": (
            f"flow-cog-{construction_sha256[:16]}-t{time_index:02d}-"
            f"z{plan.grid.matrix_id}-v1"
        ),
        "snapshot": snapshot_facts,
        "source": source_facts,
        "construction": {
            "sha256": construction_sha256,
            "facts": construction,
        },
        "preflight": plan.manifest()["preflight"],
        "quality": {
            "artifactRole": "reconstruction-prototype",
            "particleSimulation": "not-approved",
            "approvalReason": "single-snapshot-statistical-resolution-unvalidated",
        },
    }


def _safe_cog_output(output_directory: str | Path) -> Path:
    requested = Path(os.path.abspath(os.fspath(output_directory)))
    if requested.name != "cog-cache" or requested.parent == Path(requested.anchor):
        raise ValueError("Flow Field COG output must be an explicit cog-cache directory")
    requested.parent.mkdir(parents=True, exist_ok=True)
    if requested.is_symlink():
        raise ValueError("Flow Field COG output cannot be a symbolic link")
    output = requested.parent.resolve(strict=True) / requested.name
    if output.exists() and not _is_owned_cog_directory(output):
        raise ValueError("Flow Field refuses to replace an unowned cog-cache directory")
    return output


def _is_owned_cog_directory(output: Path) -> bool:
    if output.is_symlink() or not output.is_dir():
        return False
    marker_path = output / COG_ARTIFACT_MARKER
    manifest_path = output / "manifest.json"
    if not marker_path.is_file() or not manifest_path.is_file():
        return False
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(marker, dict) or not isinstance(manifest, dict):
        return False
    content_version = manifest.get("contentVersion")
    if marker != {
        "kind": "geoscratch-flow-field-cog-artifact",
        "contentVersion": content_version,
    }:
        return False
    construction = manifest.get("construction")
    if not isinstance(construction, dict):
        return False
    facts = construction.get("facts")
    cog = facts.get("cog") if isinstance(facts, dict) else None
    cog_name = cog.get("path") if isinstance(cog, dict) else None
    if (
        not isinstance(content_version, str)
        or not isinstance(cog_name, str)
        or Path(cog_name).name != cog_name
        or not cog_name.startswith("flow-t")
        or not cog_name.endswith(".cog.tif")
    ):
        return False
    allowed_names = {COG_ARTIFACT_MARKER, "manifest.json", cog_name}
    return {entry.name for entry in output.iterdir()} == allowed_names


def _install_cog_directory(staged: Path, output: Path) -> None:
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


def build_velocity_cog_snapshot(
    data_directory: str | Path = DEFAULT_DATA_DIRECTORY,
    output_directory: str | Path = DEFAULT_COG_OUTPUT_DIRECTORY,
    *,
    time_index: int = 0,
    descriptor_path: str | Path = DEFAULT_DESCRIPTOR_PATH,
    topology: TopologySpec | None = None,
    interpolation: InterpolationSpec | None = None,
    resolution: ResolutionSpec | None = None,
    matrix_override: int | None = None,
    encoding: CogEncoding = CogEncoding(),
    budget: CogBuildBudget = CogBuildBudget(),
) -> CogBuildResult:
    if not isinstance(encoding, CogEncoding):
        raise TypeError("encoding must be a CogEncoding")
    output = _safe_cog_output(output_directory)
    snapshot = load_source_snapshot(
        data_directory,
        time_index=time_index,
        descriptor_path=descriptor_path,
    )
    plan = plan_velocity_cog_snapshot(
        snapshot.stations,
        snapshot.geographic_bounds,
        output.parent,
        resolution=resolution,
        matrix_override=matrix_override,
        budget=budget,
    )
    plan.require_output_approved()
    topology_spec = resolve_topology(
        snapshot.descriptor.topology if topology is None else topology
    )
    interpolation_spec = resolve_interpolation(
        snapshot.descriptor.interpolation if interpolation is None else interpolation
    )
    prepared_topology = prepare_topology(snapshot.stations, topology_spec)
    unique_field = prepared_topology.aggregate_field(snapshot.field)
    duplicate_statistics = prepared_topology.duplicate_statistics((snapshot.field,))

    staged = Path(tempfile.mkdtemp(prefix=f".{output.name}.build-", dir=output.parent))
    try:
        source_tiff = staged / "source.tif"
        cog_path = staged / f"flow-t{time_index:02d}.cog.tif"
        manifest_path = staged / "manifest.json"
        support = _write_intermediate_tiff(
            source_tiff,
            snapshot,
            plan,
            prepared_topology,
            unique_field,
            interpolation_spec,
        )
        _translate_cog(source_tiff, cog_path, encoding)
        validation = _validate_cog(
            cog_path,
            plan.grid,
            encoding,
            support["pixelSha256"],
            expected_source_hash=snapshot.source_hash,
            expected_time_index=snapshot.field_descriptor.time_index,
        )
        source_tiff.unlink()
        manifest = _build_manifest(
            snapshot,
            plan,
            encoding,
            prepared_topology.manifest(duplicate_statistics),
            interpolation_spec.manifest(),
            support,
            cog_path,
            validation,
        )
        manifest_path.write_text(
            json.dumps(manifest, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        staged.joinpath(COG_ARTIFACT_MARKER).write_text(
            json.dumps({
                "kind": "geoscratch-flow-field-cog-artifact",
                "contentVersion": manifest["contentVersion"],
            }, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        _install_cog_directory(staged, output)
    finally:
        if staged.exists():
            shutil.rmtree(staged)
    installed_cog = output / f"flow-t{time_index:02d}.cog.tif"
    return CogBuildResult(
        output_directory=output,
        cog_path=installed_cog,
        manifest_path=output / "manifest.json",
        content_version=manifest["contentVersion"],
        cog_sha256=manifest["construction"]["facts"]["cog"]["sha256"],
        cog_size_bytes=installed_cog.stat().st_size,
    )


def verify_velocity_cog_snapshot(
    output_directory: str | Path = DEFAULT_COG_OUTPUT_DIRECTORY,
) -> dict[str, Any]:
    output = Path(output_directory).resolve()
    if not _is_owned_cog_directory(output):
        raise ValueError("Flow Field COG directory ownership is invalid")
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != 1
        or manifest.get("artifactType") != "flow-field-cog-snapshot"
        or manifest.get("quality")
        != {
            "artifactRole": "reconstruction-prototype",
            "particleSimulation": "not-approved",
            "approvalReason": "single-snapshot-statistical-resolution-unvalidated",
        }
    ):
        raise ValueError("Flow Field COG manifest contract is invalid")
    construction = manifest.get("construction")
    if not isinstance(construction, dict) or not isinstance(construction.get("facts"), dict):
        raise ValueError("Flow Field COG construction facts are invalid")
    facts = construction["facts"]
    expected_construction = hashlib.sha256(
        json.dumps(facts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if construction.get("sha256") != expected_construction:
        raise ValueError("Flow Field COG construction identity is invalid")
    source_facts = facts.get("source")
    snapshot_facts = facts.get("snapshot")
    topology_facts = facts.get("topology")
    cog = facts.get("cog")
    plan_facts = facts.get("plan")
    encoding_facts = facts.get("encoding")
    if (
        not isinstance(source_facts, dict)
        or not isinstance(snapshot_facts, dict)
        or not isinstance(topology_facts, dict)
        or not isinstance(cog, dict)
        or not isinstance(plan_facts, dict)
        or not isinstance(encoding_facts, dict)
    ):
        raise ValueError("Flow Field COG artifact facts are invalid")
    if (
        manifest.get("datasetId") != source_facts.get("datasetId")
        or manifest.get("sourceRevision") != source_facts.get("sourceRevision")
        or manifest.get("sourceHash") != source_facts.get("sourceHash")
        or manifest.get("source") != source_facts
        or manifest.get("snapshot") != snapshot_facts
    ):
        raise ValueError("Flow Field COG source or snapshot identity is invalid")
    try:
        source_bounds = _require_geographic_bounds(source_facts["geographicBounds"])
        station_count = source_facts["stationCount"]
        time_index = snapshot_facts["timeIndex"]
        model_time = snapshot_facts["modelTime"]
        grid_facts = plan_facts["grid"]
        selected_grid_facts = plan_facts["selectedGrid"]
        matrix_id = int(grid_facts["matrixId"])
        selected_matrix_id = int(
            plan_facts["resolution"]["resolved"]["matrixId"]
        )
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        raise ValueError("Flow Field COG source, snapshot, or grid facts are invalid") from error
    if (
        isinstance(station_count, bool)
        or not isinstance(station_count, int)
        or station_count < 3
        or isinstance(time_index, bool)
        or not isinstance(time_index, int)
        or time_index < 0
        or isinstance(model_time, bool)
        or not isinstance(model_time, int)
        or not _is_sha256(source_facts.get("sourceHash"))
        or not _is_sha256(source_facts.get("stationHash"))
        or not _is_sha256(snapshot_facts.get("velocityHash"))
        or not isinstance(source_facts.get("datasetId"), str)
        or not source_facts["datasetId"]
        or not isinstance(source_facts.get("sourceRevision"), str)
        or not source_facts["sourceRevision"]
        or not all(
            isinstance(snapshot_facts.get(key), str) and snapshot_facts[key]
            for key in ("unit", "basis", "phase")
        )
        or source_facts.get("crs") != "EPSG:4326"
        or topology_facts.get("sourceStationCount") != station_count
    ):
        raise ValueError("Flow Field COG source or snapshot facts are invalid")
    expected_grid = _cog_grid(source_bounds, matrix_id)
    if not isinstance(grid_facts, dict) or grid_facts != expected_grid.manifest():
        raise ValueError("Flow Field COG grid identity is invalid")
    expected_selected_grid = _cog_grid(source_bounds, selected_matrix_id)
    if (
        not isinstance(selected_grid_facts, dict)
        or selected_grid_facts != expected_selected_grid.manifest()
    ):
        raise ValueError("Flow Field COG selected-grid identity is invalid")
    matrix_override = plan_facts.get("matrixOverride")
    if matrix_override is None:
        if matrix_id != selected_matrix_id:
            raise ValueError("Flow Field COG matrix decision is invalid")
    elif (
        isinstance(matrix_override, bool)
        or not isinstance(matrix_override, int)
        or matrix_override != matrix_id
    ):
        raise ValueError("Flow Field COG matrix override is invalid")
    expected_relation = (
        "coarser-explicit-override"
        if matrix_id < selected_matrix_id
        else "finer-explicit-override"
        if matrix_id > selected_matrix_id
        else "statistically-selected"
    )
    if plan_facts.get("matrixDecision") != {
        "selectedMatrixId": str(selected_matrix_id),
        "outputMatrixId": str(matrix_id),
        "relation": expected_relation,
    }:
        raise ValueError("Flow Field COG matrix decision is invalid")
    preflight = manifest.get("preflight")
    if not isinstance(preflight, dict) or set(preflight) != {"selected", "output"}:
        raise ValueError("Flow Field COG preflight facts are invalid")
    _validate_budget_manifest(preflight["selected"], expected_selected_grid)
    _validate_budget_manifest(preflight["output"], expected_grid)
    if not preflight["output"]["approved"]:
        raise ValueError("Flow Field COG output was not budget-approved")
    encoding = CogEncoding()
    if encoding_facts != encoding.manifest():
        raise ValueError("Flow Field COG encoding identity is invalid")
    expected_content_version = (
        f"flow-cog-{expected_construction[:16]}-t{time_index:02d}-z{matrix_id}-v1"
    )
    if manifest.get("contentVersion") != expected_content_version:
        raise ValueError("Flow Field COG content identity is invalid")
    marker = json.loads(
        output.joinpath(COG_ARTIFACT_MARKER).read_text(encoding="utf-8")
    )
    if marker != {
        "kind": "geoscratch-flow-field-cog-artifact",
        "contentVersion": expected_content_version,
    }:
        raise ValueError("Flow Field COG artifact marker is invalid")
    cog_name = cog.get("path")
    expected_cog_name = f"flow-t{time_index:02d}.cog.tif"
    if not isinstance(cog_name, str) or cog_name != expected_cog_name:
        raise ValueError("Flow Field COG path identity is invalid")
    cog_path = output / cog_name
    if (
        cog_path.is_symlink()
        or not cog_path.is_file()
        or cog_path.stat().st_size != cog.get("sizeBytes")
        or _sha256(cog_path) != cog.get("sha256")
    ):
        raise ValueError("Flow Field COG file identity is invalid")
    validation = _validate_cog(
        cog_path,
        expected_grid,
        encoding,
        cog["pixelSha256"],
        expected_source_hash=source_facts["sourceHash"],
        expected_time_index=time_index,
    )
    if any(cog.get(key) != value for key, value in validation.items()):
        raise ValueError("Flow Field COG validation facts are invalid")
    return {
        "contentVersion": expected_content_version,
        "cogSha256": cog["sha256"],
        "cogSizeBytes": cog["sizeBytes"],
        "pixelSha256": validation["pixelSha256"],
        "matrixId": str(matrix_id),
        "particleSimulation": "not-approved",
    }


def main() -> None:
    defaults = CogBuildBudget()
    parser = argparse.ArgumentParser(
        description="Plan or build one statistically resolved Flow Field COG snapshot"
    )
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_DATA_DIRECTORY,
        help="directory containing station.bin and the selected uv_N.bin",
    )
    parser.add_argument(
        "--descriptor",
        type=Path,
        default=DEFAULT_DESCRIPTOR_PATH,
        help="source dataset descriptor",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_COG_OUTPUT_DIRECTORY,
        help="owned cog-cache output directory",
    )
    parser.add_argument(
        "--time-index",
        type=int,
        default=0,
        help="single ordinal U/V snapshot to build",
    )
    parser.add_argument(
        "--matrix",
        type=int,
        help=(
            "explicit output WebMercatorQuad matrix override; the statistical "
            "selection remains recorded and is never silently coarsened"
        ),
    )
    parser.add_argument(
        "--max-blocks",
        type=int,
        default=defaults.max_blocks,
        help="maximum 256 by 256 blocks accepted by the build",
    )
    parser.add_argument(
        "--max-raw-bytes",
        type=int,
        default=defaults.max_raw_bytes,
        help="maximum uncompressed two-band pixel bytes accepted by the build",
    )
    parser.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=defaults.minimum_free_bytes,
        help="free-space reserve retained after two raw-size staging estimates",
    )
    parser.add_argument(
        "--plan-only",
        action="store_true",
        help="inspect selected/output grids and budgets without writing files",
    )
    parser.add_argument(
        "--verify-existing",
        action="store_true",
        help="verify the installed manifest, marker, container, and pixel identity",
    )
    arguments = parser.parse_args()
    if arguments.verify_existing:
        print(json.dumps(
            verify_velocity_cog_snapshot(arguments.output),
            sort_keys=True,
        ))
        return
    if arguments.plan_only:
        snapshot = load_source_snapshot(
            arguments.source,
            time_index=arguments.time_index,
            descriptor_path=arguments.descriptor,
        )
        budget = CogBuildBudget(
            max_blocks=arguments.max_blocks,
            max_raw_bytes=arguments.max_raw_bytes,
            minimum_free_bytes=arguments.minimum_free_bytes,
        )
        result = plan_velocity_cog_snapshot(
            snapshot.stations,
            snapshot.geographic_bounds,
            arguments.output.parent,
            matrix_override=arguments.matrix,
            budget=budget,
        )
        print(json.dumps(result.manifest(), sort_keys=True))
        return
    budget = CogBuildBudget(
        max_blocks=arguments.max_blocks,
        max_raw_bytes=arguments.max_raw_bytes,
        minimum_free_bytes=arguments.minimum_free_bytes,
    )
    result = build_velocity_cog_snapshot(
        arguments.source,
        arguments.output,
        time_index=arguments.time_index,
        descriptor_path=arguments.descriptor,
        matrix_override=arguments.matrix,
        budget=budget,
    )
    print(json.dumps({
        "cog": str(result.cog_path),
        "cogSha256": result.cog_sha256,
        "cogSizeBytes": result.cog_size_bytes,
        "contentVersion": result.content_version,
        "manifest": str(result.manifest_path),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
