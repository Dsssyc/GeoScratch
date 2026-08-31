from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
import uuid
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import morecantile
import numpy as np
import rasterio
import rio_cogeo
from rasterio.enums import MaskFlags
from rasterio.transform import Affine
from rasterio.windows import Window
from rio_cogeo.cogeo import cog_validate

from .contracts import InterpolationSpec, TopologySpec, resolve_interpolation, resolve_topology
from .cog_overviews import (
    SEMANTIC_OVERVIEW_POLICY,
    SemanticOverviewArtifact,
    SemanticOverviewLevel,
    SemanticOverviewProgress,
    assemble_semantic_overview_cog,
    plan_semantic_overview_levels,
    reduce_semantic_overview_block,
    write_explicit_overview_vrt,
    write_semantic_overviews,
)
from .interpolation import apply_bilinear_safe_block, prepare_triangle_linear_stencil
from .job_control import ProgressEmitter, ProgressSink
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
from .topology import (
    DuplicateStatistics,
    PreparedDelaunayTopology,
    WEB_MERCATOR_RADIUS,
    prepare_topology,
)


COG_BLOCK_SIZE = 256
COG_BYTES_PER_PIXEL = 2 * np.dtype("<f4").itemsize
STAGING_OBSERVATION_BLOCK_INTERVAL = 64
COG_ARTIFACT_MARKER = ".flow-field-cog-artifact.json"
TILE_SERVER_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COG_OUTPUT_DIRECTORY = TILE_SERVER_ROOT / "cog-cache"
WEB_MERCATOR_QUAD = morecantile.tms.get("WebMercatorQuad")
WEB_MERCATOR_MAX_LATITUDE = math.degrees(math.atan(math.sinh(math.pi)))


@dataclass(frozen=True, slots=True)
class CogBuildBudget:
    """Bounds a single-snapshot COG before any topology or raster allocation."""

    max_blocks: int = 131_072
    max_raw_pyramid_bytes: int = 64 * 1024 * 1024 * 1024
    max_staged_bytes: int = 32 * 1024 * 1024 * 1024
    minimum_free_bytes: int = 8 * 1024 * 1024 * 1024

    def __post_init__(self) -> None:
        for name, value in (
            ("max_blocks", self.max_blocks),
            ("max_raw_pyramid_bytes", self.max_raw_pyramid_bytes),
            ("max_staged_bytes", self.max_staged_bytes),
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
    overview_policy: str = SEMANTIC_OVERVIEW_POLICY
    temporary_compression_level: int = 1

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
        if self.overview_policy != SEMANTIC_OVERVIEW_POLICY:
            raise ValueError(
                f"overview_policy must be {SEMANTIC_OVERVIEW_POLICY}"
            )
        if self.temporary_compression_level != 1:
            raise ValueError("temporary_compression_level must be 1")

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
            "pixelDigestLayout": {
                "blockOrder": "top-to-bottom-left-to-right",
                "withinBlock": "band-first-north-up-row-major",
                "sampleEncoding": "float32-le",
                "partialBlocks": "logical-window-only",
            },
            "overviewPolicy": {
                "kind": self.overview_policy,
                "childFootprint": "2x2-nw-ne-sw-se",
                "childSupport": "finite-and-not-both-exact-zero",
                "componentReduction": (
                    "fixed-row-major-float64-mean-cast-float32-once"
                ),
                "roundedZero": "non-advectable-never-resurrected",
                "bilinearSafety": "all-3x3-representable-candidates",
                "outsideExtent": "non-advectable",
                "signedZero": "canonical-positive",
                "recursion": "immediately-finer-stored-level",
                "assembly": "vrt-explicit-overviews-cog-force-use-existing",
            },
            "temporaryCompressionLevel": self.temporary_compression_level,
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
    overview_levels: tuple[SemanticOverviewLevel, ...]
    budget: CogBuildBudget
    available_bytes: int
    required_peak_bytes: int
    violations: tuple[str, ...]

    @property
    def approved(self) -> bool:
        return not self.violations

    @property
    def overview_block_count(self) -> int:
        return sum(
            level.block_count(COG_BLOCK_SIZE) for level in self.overview_levels
        )

    @property
    def total_block_count(self) -> int:
        return self.grid.block_count + self.overview_block_count

    @property
    def overview_raw_bytes(self) -> int:
        return sum(level.raw_bytes for level in self.overview_levels)

    @property
    def total_raw_pyramid_bytes(self) -> int:
        return self.grid.raw_bytes + self.overview_raw_bytes

    def manifest(self) -> dict[str, Any]:
        return {
            "approved": self.approved,
            "violations": list(self.violations),
            "limits": {
                "maxBlocks": self.budget.max_blocks,
                "maxRawPyramidBytes": self.budget.max_raw_pyramid_bytes,
                "maxStagedBytes": self.budget.max_staged_bytes,
                "minimumFreeBytes": self.budget.minimum_free_bytes,
            },
            "observed": {
                "baseBlockCount": self.grid.block_count,
                "overviewBlockCount": self.overview_block_count,
                "totalBlockCount": self.total_block_count,
                "baseRawBytes": self.grid.raw_bytes,
                "overviewRawBytes": self.overview_raw_bytes,
                "totalRawPyramidBytes": self.total_raw_pyramid_bytes,
                "availableBytes": self.available_bytes,
                "requiredPeakBytes": self.required_peak_bytes,
            },
        }


@dataclass(frozen=True, slots=True)
class CogBuildPlan:
    selection: ResolutionSelection
    grid: CogGrid
    budget: CogBudgetAssessment
    overview_levels: tuple[SemanticOverviewLevel, ...]

    def construction_manifest(self) -> dict[str, Any]:
        return {
            "resolution": self.selection.manifest(),
            "matrixDecision": {
                "selectedMatrixId": str(self.selection.matrix_id),
                "outputMatrixId": str(self.grid.matrix_id),
                "relation": "statistically-selected",
            },
            "grid": self.grid.manifest(),
            "overviewLevels": [
                level.manifest() for level in self.overview_levels
            ],
        }

    def manifest(self) -> dict[str, Any]:
        return {
            **self.construction_manifest(),
            "preflight": {
                "budget": self.budget.manifest(),
                "staging": None,
            },
        }

    def require_output_approved(self) -> None:
        if self.budget.approved:
            return
        observed = self.budget.manifest()["observed"]
        raise ValueError(
            "Flow Field COG output plan exceeds configured budgets: "
            + ", ".join(self.budget.violations)
            + f"; blocks={observed['totalBlockCount']}, "
            + f"rawBytes={observed['totalRawPyramidBytes']}, "
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


@dataclass(slots=True)
class CogStagingGuard:
    root: Path
    budget: CogBuildBudget
    initial_available_bytes: int
    peak_staged_bytes: int = 0
    minimum_available_bytes: int | None = None
    observation_count: int = 0
    copy_capacity_bytes: int | None = None

    def observe(self, stage: str) -> None:
        staged_bytes = sum(
            path.stat().st_size
            for path in self.root.iterdir()
            if path.is_file()
        )
        available_bytes = shutil.disk_usage(self.root).free
        self.peak_staged_bytes = max(self.peak_staged_bytes, staged_bytes)
        self.minimum_available_bytes = (
            available_bytes
            if self.minimum_available_bytes is None
            else min(self.minimum_available_bytes, available_bytes)
        )
        self.observation_count += 1
        if staged_bytes > self.budget.max_staged_bytes:
            raise OSError(
                f"Flow Field COG staging budget exceeded during {stage}: "
                f"{staged_bytes} > {self.budget.max_staged_bytes}"
            )
        if available_bytes < self.budget.minimum_free_bytes:
            raise OSError(
                f"Flow Field COG free-space reserve was crossed during {stage}: "
                f"{available_bytes} < {self.budget.minimum_free_bytes}"
            )

    def require_copy_capacity(self) -> None:
        self.observe("before-cog-copy")
        current_staged_bytes = self.peak_staged_bytes
        available_bytes = shutil.disk_usage(self.root).free
        self.copy_capacity_bytes = current_staged_bytes
        if current_staged_bytes * 2 > self.budget.max_staged_bytes:
            raise OSError(
                "Flow Field COG staging budget cannot hold both the compressed "
                "intermediate pyramid and final COG"
            )
        if available_bytes < current_staged_bytes + self.budget.minimum_free_bytes:
            raise OSError(
                "Flow Field COG does not have enough free space for the final copy"
            )

    def manifest(self) -> dict[str, int]:
        if self.minimum_available_bytes is None:
            raise RuntimeError("Flow Field COG staging was never observed")
        return {
            "maxStagedBytes": self.budget.max_staged_bytes,
            "minimumFreeBytes": self.budget.minimum_free_bytes,
            "initialAvailableBytes": self.initial_available_bytes,
            "peakStagedBytes": self.peak_staged_bytes,
            "minimumAvailableBytes": self.minimum_available_bytes,
            "copyCapacityBytes": self.copy_capacity_bytes or 0,
            "observationCount": self.observation_count,
        }


@dataclass(frozen=True, slots=True)
class _CogBaseWriteItem:
    path: Path
    snapshot: SourceSnapshot
    unique_field: np.ndarray
    staging_guard: CogStagingGuard
    progress_callback: Callable[[int, int], None] | None = None


@dataclass(slots=True)
class _CogBaseWriteState:
    item: _CogBaseWriteItem
    dataset: Any
    pixel_digest: Any
    raw_advectable_count: int = 0
    representable_advectable_count: int = 0
    rounded_zero_count: int = 0
    bilinear_safe_count: int = 0

    def support_manifest(self) -> dict[str, Any]:
        return {
            "pixelSha256": self.pixel_digest.hexdigest(),
            "rawAdvectablePixelCount": self.raw_advectable_count,
            "representableAdvectablePixelCount": (
                self.representable_advectable_count
            ),
            "roundedZeroPixelCount": self.rounded_zero_count,
            "bilinearSafePixelCount": self.bilinear_safe_count,
        }


def _staging_observation_due(completed_blocks: int) -> bool:
    return (
        completed_blocks > 0
        and completed_blocks % STAGING_OBSERVATION_BLOCK_INTERVAL == 0
    )


def plan_velocity_cog_snapshot(
    stations: np.ndarray,
    geographic_bounds: tuple[float, float, float, float],
    output_parent: str | Path,
    *,
    resolution: ResolutionSpec | None = None,
    budget: CogBuildBudget = CogBuildBudget(),
) -> CogBuildPlan:
    if not isinstance(budget, CogBuildBudget):
        raise TypeError("budget must be a CogBuildBudget")
    selection = select_resolution(stations, resolution)
    grid = _cog_grid(geographic_bounds, selection.matrix_id)
    parent = Path(output_parent).resolve()
    if not parent.is_dir():
        raise FileNotFoundError(f"COG output parent does not exist: {parent}")
    available = shutil.disk_usage(parent).free
    overview_levels = plan_semantic_overview_levels(
        grid.width,
        grid.height,
        grid.transform,
        block_size=COG_BLOCK_SIZE,
    )
    assessment = _assess_cog_budget(
        grid,
        overview_levels,
        budget,
        available,
    )
    return CogBuildPlan(
        selection=selection,
        grid=grid,
        budget=assessment,
        overview_levels=overview_levels,
    )


def _assess_cog_budget(
    grid: CogGrid,
    overview_levels: tuple[SemanticOverviewLevel, ...],
    budget: CogBuildBudget,
    available_bytes: int,
) -> CogBudgetAssessment:
    assessment = CogBudgetAssessment(
        grid=grid,
        overview_levels=overview_levels,
        budget=budget,
        available_bytes=available_bytes,
        required_peak_bytes=(
            budget.max_staged_bytes + budget.minimum_free_bytes
        ),
        violations=(),
    )
    violations: list[str] = []
    if assessment.total_block_count > budget.max_blocks:
        violations.append(
            f"block budget {assessment.total_block_count} > {budget.max_blocks}"
        )
    if assessment.total_raw_pyramid_bytes > budget.max_raw_pyramid_bytes:
        violations.append(
            "raw pyramid byte budget "
            f"{assessment.total_raw_pyramid_bytes} > "
            f"{budget.max_raw_pyramid_bytes}"
        )
    if available_bytes < assessment.required_peak_bytes:
        violations.append(
            "free-space budget "
            f"{assessment.required_peak_bytes} > {available_bytes}"
        )
    return CogBudgetAssessment(
        grid=grid,
        overview_levels=overview_levels,
        budget=budget,
        available_bytes=available_bytes,
        required_peak_bytes=assessment.required_peak_bytes,
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
            max_raw_pyramid_bytes=limits["maxRawPyramidBytes"],
            max_staged_bytes=limits["maxStagedBytes"],
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
    overview_levels = plan_semantic_overview_levels(
        grid.width,
        grid.height,
        grid.transform,
        block_size=COG_BLOCK_SIZE,
    )
    expected = _assess_cog_budget(
        grid,
        overview_levels,
        budget,
        available_bytes,
    ).manifest()
    if value != expected:
        raise ValueError("Flow Field COG budget identity is invalid")


def _validate_staging_manifest(
    value: object,
    budget_manifest: dict[str, Any],
) -> None:
    if not isinstance(value, dict) or set(value) != {
        "maxStagedBytes",
        "minimumFreeBytes",
        "initialAvailableBytes",
        "peakStagedBytes",
        "minimumAvailableBytes",
        "copyCapacityBytes",
        "observationCount",
    }:
        raise ValueError("Flow Field COG staging facts are invalid")
    if any(
        isinstance(item, bool) or not isinstance(item, int) or item < 0
        for item in value.values()
    ):
        raise ValueError("Flow Field COG staging facts are invalid")
    limits = budget_manifest["limits"]
    if (
        value["maxStagedBytes"] != limits["maxStagedBytes"]
        or value["minimumFreeBytes"] != limits["minimumFreeBytes"]
        or value["peakStagedBytes"] > value["maxStagedBytes"]
        or value["minimumAvailableBytes"] < value["minimumFreeBytes"]
        or value["copyCapacityBytes"] > value["peakStagedBytes"]
        or value["observationCount"] <= 0
    ):
        raise ValueError("Flow Field COG staging identity is invalid")


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


def _finite_model_time(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and (not isinstance(value, float) or math.isfinite(value))
    )


def _valid_source_authority(value: object) -> bool:
    if not isinstance(value, dict) or set(value) != {
        "unit",
        "basis",
        "time",
        "phase",
        "topology",
    }:
        return False
    return (
        all(
            value[key] in {"authoritative", "unconfirmed"}
            for key in ("unit", "basis", "time", "phase")
        )
        and value["topology"] in {"authoritative", "inferred"}
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
    encoding: CogEncoding,
    staging_guard: CogStagingGuard,
    progress_callback: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    return _write_intermediate_tiff_batch(
        (_CogBaseWriteItem(
            path=path,
            snapshot=snapshot,
            unique_field=unique_field,
            staging_guard=staging_guard,
            progress_callback=progress_callback,
        ),),
        plan,
        topology,
        interpolation,
        encoding,
    )[0]


def _write_intermediate_tiff_batch(
    items: tuple[_CogBaseWriteItem, ...],
    plan: CogBuildPlan,
    topology,
    interpolation,
    encoding: CogEncoding,
) -> tuple[dict[str, Any], ...]:
    batch = tuple(items)
    if not batch:
        raise ValueError("Flow Field COG base batch cannot be empty")
    paths = tuple(item.path for item in batch)
    if len(set(paths)) != len(paths):
        raise ValueError("Flow Field COG base batch paths must be unique")
    with rasterio.Env(
        GDAL_CACHEMAX=256 * 1024 * 1024,
        GDAL_NUM_THREADS="ALL_CPUS",
    ):
        try:
            return _write_intermediate_tiff_batch_in_environment(
                batch,
                plan,
                topology,
                interpolation,
                encoding,
            )
        except BaseException:
            for item in batch:
                if item.path.is_file() or item.path.is_symlink():
                    item.path.unlink()
            raise


def _write_intermediate_tiff_batch_in_environment(
    items: tuple[_CogBaseWriteItem, ...],
    plan: CogBuildPlan,
    topology,
    interpolation,
    encoding: CogEncoding,
) -> tuple[dict[str, Any], ...]:
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
        "zlevel": encoding.temporary_compression_level,
        "interleave": "pixel",
        "BIGTIFF": "IF_SAFER",
        "NUM_THREADS": "ALL_CPUS",
    }
    completed_blocks = 0
    states: list[_CogBaseWriteState] = []
    with ExitStack() as stack:
        for item in items:
            dataset = stack.enter_context(rasterio.open(item.path, "w", **profile))
            dataset.set_band_description(1, "U")
            dataset.set_band_description(2, "V")
            dataset.update_tags(
                AREA_OR_POINT="Point",
                GEOSCRATCH_ARTIFACT="flow-field-cog-snapshot",
                GEOSCRATCH_SOURCE_HASH=item.snapshot.source_hash,
                GEOSCRATCH_TIME_INDEX=str(
                    item.snapshot.field_descriptor.time_index
                ),
                GEOSCRATCH_SAMPLE_REGISTRATION="pixel-center",
            )
            dataset.update_tags(1, GEOSCRATCH_COMPONENT="u")
            dataset.update_tags(2, GEOSCRATCH_COMPONENT="v")
            states.append(_CogBaseWriteState(
                item=item,
                dataset=dataset,
                pixel_digest=hashlib.sha256(),
            ))
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
                window = Window(
                    block_col * COG_BLOCK_SIZE,
                    block_row * COG_BLOCK_SIZE,
                    COG_BLOCK_SIZE,
                    COG_BLOCK_SIZE,
                )
                for state in states:
                    rendered = apply_bilinear_safe_block(
                        stencil,
                        state.item.unique_field,
                        block_size=COG_BLOCK_SIZE,
                        require_representable_motion=True,
                    )
                    band_first = np.moveaxis(rendered.values, 2, 0).astype(
                        "<f4",
                        copy=False,
                    )
                    state.dataset.write(
                        band_first,
                        window=window,
                    )
                    state.pixel_digest.update(band_first.tobytes(order="C"))
                    state.raw_advectable_count += rendered.raw_advectable_count
                    state.representable_advectable_count += (
                        rendered.representable_advectable_count
                    )
                    state.rounded_zero_count += rendered.rounded_zero_count
                    state.bilinear_safe_count += rendered.bilinear_safe_count
                completed_blocks += 1
                if _staging_observation_due(completed_blocks):
                    for state in states:
                        state.item.staging_guard.observe(
                            f"base-block-{completed_blocks}"
                        )
                if (
                    _staging_observation_due(completed_blocks)
                    or completed_blocks == grid.block_count
                ):
                    for state in states:
                        if state.item.progress_callback is not None:
                            state.item.progress_callback(
                                completed_blocks,
                                grid.block_count,
                            )
    for state in states:
        state.item.staging_guard.observe("base-complete")
    return tuple(state.support_manifest() for state in states)


def _validate_cog(
    path: Path,
    grid: CogGrid,
    encoding: CogEncoding,
    expected_pixel_sha256: str,
    expected_base_support: dict[str, Any],
    expected_overviews: tuple[dict[str, Any], ...],
    *,
    expected_source_hash: str,
    expected_time_index: int,
) -> dict[str, Any]:
    with rasterio.Env(
        GDAL_CACHEMAX=256 * 1024 * 1024,
        GDAL_NUM_THREADS="ALL_CPUS",
    ):
        return _validate_cog_in_environment(
            path,
            grid,
            encoding,
            expected_pixel_sha256,
            expected_base_support,
            expected_overviews,
            expected_source_hash=expected_source_hash,
            expected_time_index=expected_time_index,
        )


def _validate_cog_in_environment(
    path: Path,
    grid: CogGrid,
    encoding: CogEncoding,
    expected_pixel_sha256: str,
    expected_base_support: dict[str, Any],
    expected_overviews: tuple[dict[str, Any], ...],
    *,
    expected_source_hash: str,
    expected_time_index: int,
) -> dict[str, Any]:
    valid, errors, warnings = cog_validate(path, strict=True, quiet=True)
    if not valid or errors or warnings:
        raise RuntimeError(
            "Generated Flow Field COG failed validation: "
            + json.dumps({
                "errors": errors,
                "warnings": warnings,
            }, sort_keys=True)
        )
    pixel_digest = hashlib.sha256()
    base_stored_nonzero_count = 0
    with rasterio.open(path) as dataset:
        root_tags = dataset.tags()
        image_structure = dataset.tags(ns="IMAGE_STRUCTURE")
        observed_decimations = dataset.overviews(1)
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
            or dataset.overviews(2) != observed_decimations
            or len(observed_decimations) != len(expected_overviews)
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
            or root_tags.get("GEOSCRATCH_OVERVIEW_POLICY")
            != SEMANTIC_OVERVIEW_POLICY
            or root_tags.get("GEOSCRATCH_OVERVIEW_COUNT")
            != str(len(expected_overviews))
            or root_tags.get("GEOSCRATCH_OVERVIEW_FACTORS")
            != ",".join(
                str(record["nominalFactor"]) for record in expected_overviews
            )
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
            if np.signbit(values[values == 0.0]).any():
                raise RuntimeError(
                    "Generated Flow Field COG contains non-canonical signed zero"
                )
            pixel_digest.update(np.asarray(values, dtype="<f4").tobytes(order="C"))
            base_stored_nonzero_count += int(np.count_nonzero(
                np.any(values != 0.0, axis=0)
            ))
    if pixel_digest.hexdigest() != expected_pixel_sha256:
        raise RuntimeError("Generated Flow Field COG pixels changed during translation")
    _validate_base_support_counts(
        expected_base_support,
        total_pixels=grid.width * grid.height,
        stored_nonzero_count=base_stored_nonzero_count,
        expected_pixel_sha256=expected_pixel_sha256,
    )
    validated_overviews: list[dict[str, Any]] = []
    previous_safe_count = base_stored_nonzero_count
    for index, expected in enumerate(expected_overviews):
        overview_digest = hashlib.sha256()
        overview_stored_nonzero_count = 0
        observed_candidate_count = 0
        observed_cancellation_count = 0
        finer_options = {} if index == 0 else {"OVERVIEW_LEVEL": index - 1}
        with (
            rasterio.open(path, **finer_options) as finer,
            rasterio.open(path, OVERVIEW_LEVEL=index) as overview,
        ):
            observed_transform = list(tuple(overview.transform)[:6])
            overview_image_structure = overview.tags(ns="IMAGE_STRUCTURE")
            if (
                overview.count != 2
                or overview.dtypes != ("float32", "float32")
                or overview.nodata is not None
                or overview.block_shapes != [
                    (encoding.block_size, encoding.block_size),
                    (encoding.block_size, encoding.block_size),
                ]
                or overview.width != expected["width"]
                or overview.height != expected["height"]
                or overview.width != (finer.width + 1) // 2
                or overview.height != (finer.height + 1) // 2
                or not np.allclose(
                    tuple(overview.transform)[:6],
                    expected["transform"],
                    rtol=1.0e-14,
                    atol=1.0e-10,
                )
                or any(
                    flags != [MaskFlags.all_valid]
                    for flags in overview.mask_flag_enums
                )
                or overview_image_structure.get("COMPRESSION")
                != encoding.compression
                or overview_image_structure.get("INTERLEAVE") != "PIXEL"
                or overview_image_structure.get("PREDICTOR")
                != str(encoding.predictor)
            ):
                raise RuntimeError(
                    f"Generated Flow Field COG overview {index} structure is invalid"
                )
            for _block, window in overview.block_windows(1):
                values = overview.read((1, 2), window=window, out_dtype="float32")
                if not np.isfinite(values).all():
                    raise RuntimeError(
                        f"Generated Flow Field COG overview {index} is non-finite"
                    )
                if np.signbit(values[values == 0.0]).any():
                    raise RuntimeError(
                        f"Generated Flow Field COG overview {index} contains signed zero"
                    )
                child_window = Window(
                    (int(window.col_off) - 1) * 2,
                    (int(window.row_off) - 1) * 2,
                    (int(window.width) + 2) * 2,
                    (int(window.height) + 2) * 2,
                )
                child = finer.read(
                    (1, 2),
                    window=child_window,
                    boundless=True,
                    fill_value=0.0,
                    out_dtype="float32",
                )
                reduced = reduce_semantic_overview_block(
                    np.moveaxis(child, 0, 2),
                    output_height=int(window.height),
                    output_width=int(window.width),
                )
                expected_values = np.moveaxis(reduced.values, 2, 0)
                if not np.array_equal(values, expected_values):
                    raise RuntimeError(
                        f"Generated Flow Field COG overview {index} violates "
                        "the recursive semantic reduction"
                    )
                observed_candidate_count += reduced.candidate_valid_count
                observed_cancellation_count += (
                    reduced.cancellation_to_zero_count
                )
                overview_digest.update(
                    np.asarray(values, dtype="<f4").tobytes(order="C")
                )
                overview_stored_nonzero_count += int(np.count_nonzero(
                    np.any(values != 0.0, axis=0)
                ))
        digest = overview_digest.hexdigest()
        if digest != expected["pixelSha256"]:
            raise RuntimeError(
                f"Generated Flow Field COG overview {index} pixels changed"
            )
        _validate_overview_support_counts(
            expected,
            stored_nonzero_count=overview_stored_nonzero_count,
            previous_safe_count=previous_safe_count,
            observed_candidate_count=observed_candidate_count,
            observed_cancellation_count=observed_cancellation_count,
        )
        previous_safe_count = overview_stored_nonzero_count
        validated_overviews.append({
            "index": index,
            "nominalFactor": expected["nominalFactor"],
            "observedDecimation": observed_decimations[index],
            "width": expected["width"],
            "height": expected["height"],
            "transform": observed_transform,
            "pixelSha256": digest,
        })
    return {
        "pixelSha256": pixel_digest.hexdigest(),
        "overviewCount": len(expected_overviews),
        "overviewDecimations": observed_decimations,
        "overviewLevels": validated_overviews,
        "blockCount": grid.block_count,
        "validationWarnings": warnings,
    }


def _validate_base_support_counts(
    support: dict[str, Any],
    *,
    total_pixels: int,
    stored_nonzero_count: int,
    expected_pixel_sha256: str,
) -> None:
    expected_keys = {
        "pixelSha256",
        "rawAdvectablePixelCount",
        "representableAdvectablePixelCount",
        "roundedZeroPixelCount",
        "bilinearSafePixelCount",
        "overviewPolicy",
        "overviewLevels",
    }
    if set(support) != expected_keys:
        raise ValueError("Flow Field COG base support facts are invalid")
    counts = tuple(
        support.get(key)
        for key in (
            "rawAdvectablePixelCount",
            "representableAdvectablePixelCount",
            "roundedZeroPixelCount",
            "bilinearSafePixelCount",
        )
    )
    if any(
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 <= value <= total_pixels
        for value in counts
    ):
        raise ValueError("Flow Field COG base support counts are invalid")
    raw, representable, rounded_zero, bilinear_safe = counts
    if (
        support.get("pixelSha256") != expected_pixel_sha256
        or representable + rounded_zero != raw
        or bilinear_safe > representable
        or bilinear_safe != stored_nonzero_count
    ):
        raise ValueError("Flow Field COG base support identity is invalid")


def _validate_overview_support_counts(
    record: dict[str, Any],
    *,
    stored_nonzero_count: int,
    previous_safe_count: int,
    observed_candidate_count: int,
    observed_cancellation_count: int,
) -> None:
    expected_keys = {
        "index",
        "nominalFactor",
        "width",
        "height",
        "transform",
        "effectiveDecimationX",
        "effectiveDecimationY",
        "rawBytes",
        "pixelSha256",
        "candidateValidPixelCount",
        "bilinearSafePixelCount",
        "cancellationToZeroPixelCount",
        "intermediateSizeBytes",
    }
    if set(record) != expected_keys:
        raise ValueError("Flow Field COG overview support facts are invalid")
    total_pixels = record["width"] * record["height"]
    counts = tuple(
        record.get(key)
        for key in (
            "candidateValidPixelCount",
            "bilinearSafePixelCount",
            "cancellationToZeroPixelCount",
        )
    )
    if any(
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 <= value <= total_pixels
        for value in counts
    ):
        raise ValueError("Flow Field COG overview support counts are invalid")
    candidate, bilinear_safe, cancellation = counts
    intermediate_size = record.get("intermediateSizeBytes")
    if (
        isinstance(intermediate_size, bool)
        or not isinstance(intermediate_size, int)
        or intermediate_size <= 0
        or bilinear_safe > candidate
        or candidate + cancellation > total_pixels
        or candidate != observed_candidate_count
        or cancellation != observed_cancellation_count
        or bilinear_safe != stored_nonzero_count
        or 4 * (candidate + cancellation) > previous_safe_count
    ):
        raise ValueError("Flow Field COG overview support identity is invalid")


def _build_manifest(
    snapshot: SourceSnapshot,
    plan: CogBuildPlan,
    encoding: CogEncoding,
    topology_manifest: dict[str, Any],
    interpolation_manifest: dict[str, Any],
    support: dict[str, Any],
    cog_path: Path,
    cog_validation: dict[str, Any],
    staging_facts: dict[str, int],
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
    if snapshot.descriptor.schema_version == 3:
        semantics = {
            "unit": snapshot.descriptor.unit,
            "basis": snapshot.descriptor.basis,
            "timeUnit": snapshot.descriptor.time_unit,
            "phase": snapshot.descriptor.phase,
            "authority": snapshot.descriptor.authority.manifest(),
        }
        source_facts.update({
            "descriptorSchemaVersion": 3,
            **semantics,
        })
        snapshot_facts.update({
            "timeUnit": snapshot.descriptor.time_unit,
            "authority": snapshot.descriptor.authority.manifest(),
        })
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
        "schemaVersion": 2,
        "artifactType": "flow-field-cog-snapshot",
        "datasetId": source_facts["datasetId"],
        "sourceRevision": source_facts["sourceRevision"],
        "sourceHash": source_facts["sourceHash"],
        "contentVersion": (
            f"flow-cog-{construction_sha256[:16]}-t{time_index:02d}-"
            f"z{plan.grid.matrix_id}-v2"
        ),
        "snapshot": snapshot_facts,
        "source": source_facts,
        "construction": {
            "sha256": construction_sha256,
            "facts": construction,
        },
        "preflight": {
            "budget": plan.budget.manifest(),
            "staging": staging_facts,
        },
        "quality": {
            "artifactRole": "reconstruction-prototype",
            "particleSimulation": "not-approved",
            "approvalReason": "inferred-topology-and-source-semantics-unapproved",
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


def _install_cog_directory(
    staged: Path,
    output: Path,
    *,
    commit_callback: Callable[[], None] | None = None,
) -> None:
    if not output.exists():
        os.replace(staged, output)
        try:
            if commit_callback is not None:
                commit_callback()
        except BaseException:
            os.replace(output, staged)
            raise
        return
    backup = output.parent / f".{output.name}.backup-{uuid.uuid4().hex}"
    os.replace(output, backup)
    try:
        os.replace(staged, output)
        if commit_callback is not None:
            commit_callback()
    except BaseException:
        if output.exists():
            os.replace(output, staged)
        os.replace(backup, output)
        raise
    shutil.rmtree(backup)


def _finalize_velocity_cog_snapshot(
    *,
    snapshot: SourceSnapshot,
    plan: CogBuildPlan,
    prepared_topology: PreparedDelaunayTopology,
    duplicate_statistics: DuplicateStatistics,
    interpolation: InterpolationSpec,
    encoding: CogEncoding,
    staging_guard: CogStagingGuard,
    staged: Path,
    output: Path,
    source_tiff: Path,
    support: dict[str, Any],
    emitter: ProgressEmitter,
) -> CogBuildResult:
    """Finalize one prepared base; the caller owns staging cleanup on failure."""

    time_index = snapshot.field_descriptor.time_index
    source_vrt = staged / "semantic-overviews.vrt"
    cog_path = staged / f"flow-t{time_index:02d}.cog.tif"
    manifest_path = staged / "manifest.json"

    def report_overview(value: SemanticOverviewProgress) -> None:
        stage = f"overview-{value.level_index:02d}"
        if value.event == "progress":
            emitter.emit(
                "stage.progress",
                stage=stage,
                completed=value.completed_blocks,
                total=value.total_blocks,
                unit="blocks",
            )
        else:
            emitter.emit(f"stage.{value.event}", stage=stage)

    overview_artifacts = write_semantic_overviews(
        source_tiff,
        staged,
        plan.overview_levels,
        block_size=encoding.block_size,
        temporary_compression_level=encoding.temporary_compression_level,
        staging_observer=staging_guard.observe,
        progress_callback=report_overview,
    )
    overview_records = tuple(
        artifact.manifest() for artifact in overview_artifacts
    )
    support["overviewPolicy"] = encoding.manifest()["overviewPolicy"]
    support["overviewLevels"] = list(overview_records)
    write_explicit_overview_vrt(
        source_vrt,
        source_tiff,
        overview_artifacts,
    )
    emitter.emit("stage.started", stage="cog-copy")
    staging_guard.require_copy_capacity()
    # VRT explicit overviews and COG FORCE_USE_EXISTING are the documented
    # GDAL path for copying project-computed overview pixels without invoking
    # a generic resampler:
    # https://gdal.org/en/stable/drivers/raster/vrt.html#vrtrasterband
    # https://gdal.org/en/stable/drivers/raster/cog.html#creation-options
    assemble_semantic_overview_cog(
        source_vrt,
        cog_path,
        block_size=encoding.block_size,
        compression_level=encoding.compression_level,
        big_tiff=encoding.big_tiff,
    )
    staging_guard.observe("cog-copy-complete")
    emitter.emit(
        "stage.progress",
        stage="cog-copy",
        completed=1,
        total=1,
        unit="copies",
    )
    emitter.emit("stage.completed", stage="cog-copy")
    emitter.emit("stage.started", stage="semantic-verification")
    validation = _validate_cog(
        cog_path,
        plan.grid,
        encoding,
        support["pixelSha256"],
        support,
        overview_records,
        expected_source_hash=snapshot.source_hash,
        expected_time_index=time_index,
    )
    emitter.emit(
        "stage.progress",
        stage="semantic-verification",
        completed=1,
        total=1,
        unit="datasets",
    )
    emitter.emit("stage.completed", stage="semantic-verification")
    source_tiff.unlink()
    source_vrt.unlink()
    for artifact in overview_artifacts:
        artifact.path.unlink()
    emitter.emit("stage.started", stage="manifest")
    manifest = _build_manifest(
        snapshot,
        plan,
        encoding,
        prepared_topology.manifest(duplicate_statistics),
        interpolation.manifest(),
        support,
        cog_path,
        validation,
        staging_guard.manifest(),
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
    emitter.emit(
        "stage.progress",
        stage="manifest",
        completed=2,
        total=2,
        unit="files",
    )
    emitter.emit("stage.completed", stage="manifest")
    emitter.emit("stage.started", stage="install")

    def complete_install() -> None:
        emitter.emit(
            "stage.progress",
            stage="install",
            completed=1,
            total=1,
            unit="directories",
        )
        emitter.emit("stage.completed", stage="install")

    _install_cog_directory(
        staged,
        output,
        commit_callback=complete_install,
    )
    installed_cog = output / f"flow-t{time_index:02d}.cog.tif"
    return CogBuildResult(
        output_directory=output,
        cog_path=installed_cog,
        manifest_path=output / "manifest.json",
        content_version=manifest["contentVersion"],
        cog_sha256=manifest["construction"]["facts"]["cog"]["sha256"],
        cog_size_bytes=installed_cog.stat().st_size,
    )


def build_velocity_cog_snapshot(
    data_directory: str | Path = DEFAULT_DATA_DIRECTORY,
    output_directory: str | Path = DEFAULT_COG_OUTPUT_DIRECTORY,
    *,
    time_index: int = 0,
    descriptor_path: str | Path = DEFAULT_DESCRIPTOR_PATH,
    topology: TopologySpec | None = None,
    interpolation: InterpolationSpec | None = None,
    resolution: ResolutionSpec | None = None,
    encoding: CogEncoding = CogEncoding(),
    budget: CogBuildBudget = CogBuildBudget(),
    progress: ProgressSink | None = None,
    job_id: str | None = None,
) -> CogBuildResult:
    if not isinstance(encoding, CogEncoding):
        raise TypeError("encoding must be a CogEncoding")
    output = _safe_cog_output(output_directory)
    emitter = ProgressEmitter(
        f"flow-cog-{uuid.uuid4().hex}" if job_id is None else job_id,
        time_index,
        progress,
    )
    emitter.emit("stage.started", stage="source")
    snapshot = load_source_snapshot(
        data_directory,
        time_index=time_index,
        descriptor_path=descriptor_path,
    )
    emitter.emit(
        "stage.progress",
        stage="source",
        completed=2,
        total=2,
        unit="files",
    )
    emitter.emit("stage.completed", stage="source")
    emitter.emit("stage.started", stage="planning")
    plan = plan_velocity_cog_snapshot(
        snapshot.stations,
        snapshot.geographic_bounds,
        output.parent,
        resolution=resolution,
        budget=budget,
    )
    plan.require_output_approved()
    emitter.emit(
        "stage.progress",
        stage="planning",
        completed=1,
        total=1,
        unit="plans",
    )
    emitter.emit("stage.completed", stage="planning")
    emitter.emit("stage.started", stage="topology")
    topology_spec = resolve_topology(
        snapshot.descriptor.topology if topology is None else topology
    )
    interpolation_spec = resolve_interpolation(
        snapshot.descriptor.interpolation if interpolation is None else interpolation
    )
    prepared_topology = prepare_topology(snapshot.stations, topology_spec)
    unique_field = prepared_topology.aggregate_field(snapshot.field)
    duplicate_statistics = prepared_topology.duplicate_statistics((snapshot.field,))
    emitter.emit(
        "stage.progress",
        stage="topology",
        completed=1,
        total=1,
        unit="topologies",
    )
    emitter.emit("stage.completed", stage="topology")

    staged = Path(tempfile.mkdtemp(prefix=f".{output.name}.build-", dir=output.parent))
    try:
        staging_guard = CogStagingGuard(
            root=staged,
            budget=budget,
            initial_available_bytes=shutil.disk_usage(staged).free,
        )
        staging_guard.observe("staging-created")
        source_tiff = staged / "base.tif"
        emitter.emit("stage.started", stage="base")

        def report_base(completed: int, total: int) -> None:
            emitter.emit(
                "stage.progress",
                stage="base",
                completed=completed,
                total=total,
                unit="blocks",
            )

        support = _write_intermediate_tiff(
            source_tiff,
            snapshot,
            plan,
            prepared_topology,
            unique_field,
            interpolation_spec,
            encoding,
            staging_guard,
            report_base,
        )
        emitter.emit("stage.completed", stage="base")
        result = _finalize_velocity_cog_snapshot(
            snapshot=snapshot,
            plan=plan,
            prepared_topology=prepared_topology,
            duplicate_statistics=duplicate_statistics,
            interpolation=interpolation_spec,
            encoding=encoding,
            staging_guard=staging_guard,
            staged=staged,
            output=output,
            source_tiff=source_tiff,
            support=support,
            emitter=emitter,
        )
    finally:
        if staged.exists():
            shutil.rmtree(staged)
    return result


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
        or manifest.get("schemaVersion") != 2
        or manifest.get("artifactType") != "flow-field-cog-snapshot"
        or manifest.get("quality")
        != {
            "artifactRole": "reconstruction-prototype",
            "particleSimulation": "not-approved",
            "approvalReason": "inferred-topology-and-source-semantics-unapproved",
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
    support_facts = facts.get("support")
    if (
        not isinstance(source_facts, dict)
        or not isinstance(snapshot_facts, dict)
        or not isinstance(topology_facts, dict)
        or not isinstance(cog, dict)
        or not isinstance(plan_facts, dict)
        or not isinstance(encoding_facts, dict)
        or not isinstance(support_facts, dict)
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
        matrix_id = int(grid_facts["matrixId"])
        selected_matrix_id = int(
            plan_facts["resolution"]["resolved"]["matrixId"]
        )
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        raise ValueError("Flow Field COG source, snapshot, or grid facts are invalid") from error
    descriptor_schema_version = source_facts.get("descriptorSchemaVersion", 2)
    if descriptor_schema_version == 2:
        semantic_identity_valid = (
            isinstance(model_time, int)
            and not isinstance(model_time, bool)
            and not any(
                key in source_facts
                for key in (
                    "descriptorSchemaVersion",
                    "unit",
                    "basis",
                    "timeUnit",
                    "phase",
                    "authority",
                )
            )
            and "timeUnit" not in snapshot_facts
            and "authority" not in snapshot_facts
        )
    elif descriptor_schema_version == 3:
        authority = source_facts.get("authority")
        semantic_identity_valid = (
            _finite_model_time(model_time)
            and _valid_source_authority(authority)
            and all(
                isinstance(source_facts.get(key), str) and source_facts[key]
                for key in ("unit", "basis", "timeUnit", "phase")
            )
            and snapshot_facts.get("unit") == source_facts.get("unit")
            and snapshot_facts.get("basis") == source_facts.get("basis")
            and snapshot_facts.get("timeUnit") == source_facts.get("timeUnit")
            and snapshot_facts.get("phase") == source_facts.get("phase")
            and snapshot_facts.get("authority") == authority
            and topology_facts.get("resolved") == "delaunay"
            and authority.get("topology") == "inferred"
        )
    else:
        semantic_identity_valid = False
    if (
        isinstance(station_count, bool)
        or not isinstance(station_count, int)
        or station_count < 3
        or isinstance(time_index, bool)
        or not isinstance(time_index, int)
        or time_index < 0
        or not semantic_identity_valid
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
    if matrix_id != selected_matrix_id:
        raise ValueError("Flow Field COG output must use the statistically selected grid")
    expected_overview_plan = plan_semantic_overview_levels(
        expected_grid.width,
        expected_grid.height,
        expected_grid.transform,
        block_size=COG_BLOCK_SIZE,
    )
    if plan_facts.get("overviewLevels") != [
        level.manifest() for level in expected_overview_plan
    ]:
        raise ValueError("Flow Field COG overview plan identity is invalid")
    if plan_facts.get("matrixDecision") != {
        "selectedMatrixId": str(selected_matrix_id),
        "outputMatrixId": str(matrix_id),
        "relation": "statistically-selected",
    }:
        raise ValueError("Flow Field COG matrix decision is invalid")
    preflight = manifest.get("preflight")
    if not isinstance(preflight, dict) or set(preflight) != {"budget", "staging"}:
        raise ValueError("Flow Field COG preflight facts are invalid")
    _validate_budget_manifest(preflight["budget"], expected_grid)
    if not preflight["budget"]["approved"]:
        raise ValueError("Flow Field COG output was not budget-approved")
    _validate_staging_manifest(preflight["staging"], preflight["budget"])
    encoding = CogEncoding()
    if encoding_facts != encoding.manifest():
        raise ValueError("Flow Field COG encoding identity is invalid")
    overview_records = support_facts.get("overviewLevels")
    if (
        support_facts.get("overviewPolicy")
        != encoding.manifest()["overviewPolicy"]
        or not isinstance(overview_records, list)
        or len(overview_records) != len(expected_overview_plan)
    ):
        raise ValueError("Flow Field COG overview support facts are invalid")
    for expected_level, record in zip(
        expected_overview_plan,
        overview_records,
        strict=True,
    ):
        if not isinstance(record, dict) or any(
            record.get(key) != value
            for key, value in expected_level.manifest().items()
        ):
            raise ValueError("Flow Field COG overview support facts are invalid")
    expected_content_version = (
        f"flow-cog-{expected_construction[:16]}-t{time_index:02d}-z{matrix_id}-v2"
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
        support_facts,
        tuple(overview_records),
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
        "--max-blocks",
        type=int,
        default=defaults.max_blocks,
        help="maximum 256 by 256 blocks accepted by the build",
    )
    parser.add_argument(
        "--max-raw-pyramid-bytes",
        type=int,
        default=defaults.max_raw_pyramid_bytes,
        help="maximum uncompressed base plus overview bytes accepted by the build",
    )
    parser.add_argument(
        "--max-staged-bytes",
        type=int,
        default=defaults.max_staged_bytes,
        help="maximum compressed bytes permitted in the owned staging directory",
    )
    parser.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=defaults.minimum_free_bytes,
        help=(
            "minimum free-space reserve enforced throughout compressed staging "
            "and the final COG copy"
        ),
    )
    parser.add_argument(
        "--plan-only",
        action="store_true",
        help=(
            "inspect the statistically selected grid, semantic overview plan, "
            "and budgets without writing files"
        ),
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
            max_raw_pyramid_bytes=arguments.max_raw_pyramid_bytes,
            max_staged_bytes=arguments.max_staged_bytes,
            minimum_free_bytes=arguments.minimum_free_bytes,
        )
        result = plan_velocity_cog_snapshot(
            snapshot.stations,
            snapshot.geographic_bounds,
            arguments.output.parent,
            budget=budget,
        )
        print(json.dumps(result.manifest(), sort_keys=True))
        return
    budget = CogBuildBudget(
        max_blocks=arguments.max_blocks,
        max_raw_pyramid_bytes=arguments.max_raw_pyramid_bytes,
        max_staged_bytes=arguments.max_staged_bytes,
        minimum_free_bytes=arguments.minimum_free_bytes,
    )
    result = build_velocity_cog_snapshot(
        arguments.source,
        arguments.output,
        time_index=arguments.time_index,
        descriptor_path=arguments.descriptor,
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
