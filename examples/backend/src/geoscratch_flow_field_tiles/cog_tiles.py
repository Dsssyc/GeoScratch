from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import morecantile
import numpy as np
import rasterio
from rasterio.enums import MaskFlags
from rasterio.windows import Window

from .cog import CogEncoding
from .cog_overviews import (
    LEGACY_SEMANTIC_OVERVIEW_POLICY,
    SEMANTIC_OVERVIEW_POLICY,
    reduce_semantic_overview_block,
)


TILE_SIZE = 256
CHANNEL_COUNT = 2
TILE_BYTE_LENGTH = TILE_SIZE * TILE_SIZE * CHANNEL_COUNT * np.dtype("<f4").itemsize
MINIMUM_MATRIX = 4
WEB_MERCATOR_QUAD = morecantile.tms.get("WebMercatorQuad")


@dataclass(frozen=True, slots=True)
class CogVelocityTile:
    content: bytes
    sha256: str
    maximum_speed: float


@dataclass(frozen=True, slots=True)
class _PhysicalLevel:
    matrix: int
    overview_index: int | None
    nominal_factor: int
    width: int
    height: int
    global_col: int
    global_row: int


@dataclass(frozen=True, slots=True)
class _ArrayLevel:
    matrix: int
    global_col: int
    global_row: int
    values: np.ndarray


class CogVelocityTileReader:
    """Reads immutable WMQ RG32F tiles from one verified Flow Field COG snapshot."""

    def __init__(self, manifest_path: str | Path, cog_path: str | Path) -> None:
        self.manifest_path = Path(manifest_path).resolve()
        self.cog_path = Path(cog_path).resolve()
        if not self.manifest_path.is_file():
            raise FileNotFoundError(f"Flow Field COG manifest does not exist: {self.manifest_path}")
        if self.cog_path.is_symlink() or not self.cog_path.is_file():
            raise FileNotFoundError(f"Flow Field COG does not exist: {self.cog_path}")

        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        parsed = _parse_manifest(manifest, self.cog_path)
        self._schema_version = parsed["schema_version"]
        self._overview_policy = parsed["overview_policy"]
        self.time_index = parsed["time_index"]
        self.base_matrix = parsed["base_matrix"]
        self.source_bounds = parsed["source_bounds"]
        self._physical_levels = parsed["physical_levels"]
        self._overview_shapes = parsed["overview_shapes"]
        self.minimum_physical_matrix = min(self._physical_levels)
        self._coverage = _coverage(self.source_bounds, self.base_matrix)
        self._validate_container()
        self._derived_levels = self._derive_lower_levels()

    @property
    def schema_version(self) -> int:
        """Immutable artifact schema controlling this reader's sampling semantics."""
        return self._schema_version

    @property
    def overview_policy(self) -> str:
        """Verified reduction policy shared by physical and derived overview pages."""
        return self._overview_policy

    @property
    def supported_matrices(self) -> tuple[int, ...]:
        return tuple(range(MINIMUM_MATRIX, self.base_matrix + 1))

    def tile_limits(self, matrix: str | int) -> tuple[int, int, int, int]:
        level = _matrix_level(matrix)
        limits = self._coverage.get(level)
        if limits is None:
            raise KeyError((matrix,))
        return limits

    def read_tile(
        self,
        matrix: str | int,
        tile_row: int,
        tile_col: int,
    ) -> CogVelocityTile:
        level = _matrix_level(matrix)
        if (
            isinstance(tile_row, bool)
            or not isinstance(tile_row, int)
            or isinstance(tile_col, bool)
            or not isinstance(tile_col, int)
        ):
            raise TypeError("Flow Field COG tile row and column must be integers")
        limits = self._coverage.get(level)
        if limits is None or not (
            limits[0] <= tile_row <= limits[1]
            and limits[2] <= tile_col <= limits[3]
        ):
            raise KeyError((str(level), tile_row, tile_col))

        global_col = tile_col * TILE_SIZE
        global_row = tile_row * TILE_SIZE
        physical = self._physical_levels.get(level)
        if physical is not None:
            values = self._read_physical_window(
                physical,
                global_col,
                global_row,
                TILE_SIZE,
                TILE_SIZE,
            )
        else:
            derived = self._derived_levels.get(level)
            if derived is None:
                raise KeyError((str(level), tile_row, tile_col))
            values = _array_window(
                derived,
                global_col,
                global_row,
                TILE_SIZE,
                TILE_SIZE,
            )
        _validate_values(values, "Flow Field COG tile")
        payload = np.asarray(values, dtype="<f4", order="C").tobytes(order="C")
        if len(payload) != TILE_BYTE_LENGTH:
            raise RuntimeError("Flow Field COG tile has an invalid byte length")
        speed = np.hypot(
            values[..., 0].astype(np.float64),
            values[..., 1].astype(np.float64),
        )
        return CogVelocityTile(
            content=payload,
            sha256=hashlib.sha256(payload).hexdigest(),
            maximum_speed=float(speed.max(initial=0.0)),
        )

    def _validate_container(self) -> None:
        base = self._physical_levels[self.base_matrix]
        with rasterio.open(self.cog_path) as dataset:
            _validate_dataset(
                dataset,
                base.width,
                base.height,
                "Flow Field COG base",
                require_descriptions=True,
            )
            if len(dataset.overviews(1)) != len(self._overview_shapes):
                raise ValueError("Flow Field COG overview count does not match its manifest")
            if dataset.tags().get("GEOSCRATCH_OVERVIEW_POLICY") != self.overview_policy:
                raise ValueError("Flow Field COG stored overview policy is inconsistent")
        for overview_index, width, height in self._overview_shapes:
            with rasterio.open(self.cog_path, OVERVIEW_LEVEL=overview_index) as dataset:
                _validate_dataset(
                    dataset,
                    width,
                    height,
                    f"Flow Field COG overview {overview_index}",
                    require_descriptions=False,
                )

    def _read_physical_window(
        self,
        level: _PhysicalLevel,
        global_col: int,
        global_row: int,
        width: int,
        height: int,
    ) -> np.ndarray:
        result = np.zeros((height, width, CHANNEL_COUNT), dtype="<f4")
        source_col = global_col - level.global_col
        source_row = global_row - level.global_row
        source_col_start = max(0, source_col)
        source_row_start = max(0, source_row)
        source_col_end = min(level.width, source_col + width)
        source_row_end = min(level.height, source_row + height)
        if source_col_start >= source_col_end or source_row_start >= source_row_end:
            return result

        options = (
            {}
            if level.overview_index is None
            else {"OVERVIEW_LEVEL": level.overview_index}
        )
        with rasterio.open(self.cog_path, **options) as dataset:
            bands = dataset.read(
                (1, 2),
                window=Window(
                    source_col_start,
                    source_row_start,
                    source_col_end - source_col_start,
                    source_row_end - source_row_start,
                ),
                out_dtype="float32",
            )
        values = np.moveaxis(bands, 0, 2)
        _validate_values(values, "Flow Field COG window")
        destination_col = source_col_start - source_col
        destination_row = source_row_start - source_row
        result[
            destination_row:destination_row + values.shape[0],
            destination_col:destination_col + values.shape[1],
        ] = values
        return result

    def _derive_lower_levels(self) -> dict[int, _ArrayLevel]:
        if self.minimum_physical_matrix <= MINIMUM_MATRIX:
            return {}
        source_spec = self._physical_levels[self.minimum_physical_matrix]
        source_values = self._read_physical_window(
            source_spec,
            source_spec.global_col,
            source_spec.global_row,
            source_spec.width,
            source_spec.height,
        )
        source_values.setflags(write=False)
        source = _ArrayLevel(
            matrix=source_spec.matrix,
            global_col=source_spec.global_col,
            global_row=source_spec.global_row,
            values=source_values,
        )
        derived: dict[int, _ArrayLevel] = {}
        for matrix in range(self.minimum_physical_matrix - 1, MINIMUM_MATRIX - 1, -1):
            source = _reduce_global_level(source, matrix, policy=self.overview_policy)
            derived[matrix] = source
        return derived


def _parse_manifest(manifest: object, cog_path: Path) -> dict[str, Any]:
    if not isinstance(manifest, dict):
        raise ValueError("Flow Field COG manifest must be an object")
    construction = manifest.get("construction")
    facts = construction.get("facts") if isinstance(construction, dict) else None
    schema_version = manifest.get("schemaVersion")
    if (
        isinstance(schema_version, bool)
        or not isinstance(schema_version, int)
        or schema_version not in {2, 3}
        or manifest.get("artifactType") != "flow-field-cog-snapshot"
        or not isinstance(facts, dict)
    ):
        raise ValueError("Flow Field COG manifest contract is invalid")
    expected_construction = hashlib.sha256(
        json.dumps(facts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if construction.get("sha256") != expected_construction:
        raise ValueError("Flow Field COG construction identity is invalid")

    source = facts.get("source")
    snapshot = facts.get("snapshot")
    plan = facts.get("plan")
    encoding = facts.get("encoding")
    cog = facts.get("cog")
    if not all(isinstance(value, dict) for value in (source, snapshot, plan, encoding, cog)):
        raise ValueError("Flow Field COG manifest facts are invalid")
    grid = plan.get("grid")
    overviews = plan.get("overviewLevels")
    overview_policy = encoding.get("overviewPolicy")
    expected_policy = (
        LEGACY_SEMANTIC_OVERVIEW_POLICY if schema_version == 2
        else SEMANTIC_OVERVIEW_POLICY
    )
    if (
        not isinstance(grid, dict)
        or not isinstance(overviews, list)
        or not isinstance(overview_policy, dict)
        or encoding != CogEncoding(overview_policy=expected_policy).manifest()
        or grid.get("sampleRegistration") != "pixel-center"
        or encoding.get("bands") != 2
        or encoding.get("sampleType") != "float32"
        or encoding.get("componentOrder") != ["u", "v"]
        or cog.get("path") != cog_path.name
        or cog.get("sizeBytes") != cog_path.stat().st_size
    ):
        raise ValueError("Flow Field COG encoding or file identity is invalid")

    base_matrix = _canonical_integer(grid.get("matrixId"), "matrixId", MINIMUM_MATRIX)
    width = _canonical_integer(grid.get("width"), "width", 1)
    height = _canonical_integer(grid.get("height"), "height", 1)
    limits = grid.get("tileLimits")
    if not isinstance(limits, dict):
        raise ValueError("Flow Field COG tile limits are invalid")
    min_row = _canonical_integer(limits.get("minTileRow"), "minTileRow", 0)
    max_row = _canonical_integer(limits.get("maxTileRow"), "maxTileRow", min_row)
    min_col = _canonical_integer(limits.get("minTileCol"), "minTileCol", 0)
    max_col = _canonical_integer(limits.get("maxTileCol"), "maxTileCol", min_col)
    if (
        width != (max_col - min_col + 1) * TILE_SIZE
        or height != (max_row - min_row + 1) * TILE_SIZE
    ):
        raise ValueError("Flow Field COG base grid is not tile aligned")

    physical_levels: dict[int, _PhysicalLevel] = {}
    base_col, base_row = _global_pixel_origin(min_col, min_row, 1)
    physical_levels[base_matrix] = _PhysicalLevel(
        matrix=base_matrix,
        overview_index=None,
        nominal_factor=1,
        width=width,
        height=height,
        global_col=base_col,
        global_row=base_row,
    )
    previous_width = width
    previous_height = height
    overview_shapes: list[tuple[int, int, int]] = []
    for index, value in enumerate(overviews):
        if not isinstance(value, dict):
            raise ValueError("Flow Field COG overview facts are invalid")
        factor = _canonical_integer(value.get("nominalFactor"), "nominalFactor", 2)
        expected_factor = 1 << (index + 1)
        level_width = _canonical_integer(value.get("width"), "overview width", 1)
        level_height = _canonical_integer(value.get("height"), "overview height", 1)
        matrix = base_matrix - index - 1
        if (
            value.get("index") != index
            or factor != expected_factor
            or level_width != (previous_width + 1) // 2
            or level_height != (previous_height + 1) // 2
            or matrix < 0
        ):
            raise ValueError("Flow Field COG overview sequence is invalid")
        overview_shapes.append((index, level_width, level_height))
        if factor <= 256:
            global_col, global_row = _global_pixel_origin(min_col, min_row, factor)
            physical_levels[matrix] = _PhysicalLevel(
                matrix=matrix,
                overview_index=index,
                nominal_factor=factor,
                width=level_width,
                height=level_height,
                global_col=global_col,
                global_row=global_row,
            )
        previous_width = level_width
        previous_height = level_height

    source_bounds = source.get("geographicBounds")
    if (
        not isinstance(source_bounds, list)
        or len(source_bounds) != 4
        or not all(_finite_number(value) for value in source_bounds)
        or not source_bounds[0] < source_bounds[2]
        or not source_bounds[1] < source_bounds[3]
    ):
        raise ValueError("Flow Field COG geographic bounds are invalid")
    time_index = _canonical_integer(snapshot.get("timeIndex"), "timeIndex", 0)
    expected_version = (
        f"flow-cog-{expected_construction[:16]}-t{time_index:02d}-"
        f"z{base_matrix}-v{schema_version}"
    )
    if manifest.get("contentVersion") != expected_version:
        raise ValueError("Flow Field COG content identity is invalid")
    return {
        "schema_version": schema_version,
        "overview_policy": expected_policy,
        "time_index": time_index,
        "base_matrix": base_matrix,
        "source_bounds": tuple(float(value) for value in source_bounds),
        "physical_levels": physical_levels,
        "overview_shapes": tuple(overview_shapes),
    }


def _validate_dataset(
    dataset: Any,
    width: int,
    height: int,
    label: str,
    *,
    require_descriptions: bool,
) -> None:
    if (
        dataset.width != width
        or dataset.height != height
        or dataset.count != CHANNEL_COUNT
        or dataset.dtypes != ("float32", "float32")
        or dataset.nodata is not None
        or (require_descriptions and dataset.descriptions != ("U", "V"))
        or any(flags != [MaskFlags.all_valid] for flags in dataset.mask_flag_enums)
    ):
        raise ValueError(f"{label} structure is invalid")


def _reduce_global_level(
    source: _ArrayLevel,
    matrix: int,
    *,
    policy: str = SEMANTIC_OVERVIEW_POLICY,
) -> _ArrayLevel:
    if matrix != source.matrix - 1:
        raise ValueError("Flow Field semantic reduction matrices must be contiguous")
    source_height, source_width, _channels = source.values.shape
    parent_col = source.global_col // 2
    parent_row = source.global_row // 2
    parent_col_end = (source.global_col + source_width + 1) // 2
    parent_row_end = (source.global_row + source_height + 1) // 2
    parent_width = parent_col_end - parent_col
    parent_height = parent_row_end - parent_row
    child = _array_window(
        source,
        (parent_col - 1) * 2,
        (parent_row - 1) * 2,
        (parent_width + 2) * 2,
        (parent_height + 2) * 2,
    )
    reduced = reduce_semantic_overview_block(
        child,
        output_height=parent_height,
        output_width=parent_width,
        policy=policy,
    ).values
    _validate_values(reduced, f"Flow Field derived z{matrix} level")
    reduced.setflags(write=False)
    return _ArrayLevel(
        matrix=matrix,
        global_col=parent_col,
        global_row=parent_row,
        values=reduced,
    )


def _array_window(
    level: _ArrayLevel,
    global_col: int,
    global_row: int,
    width: int,
    height: int,
) -> np.ndarray:
    result = np.zeros((height, width, CHANNEL_COUNT), dtype="<f4")
    source_height, source_width, _channels = level.values.shape
    source_col = global_col - level.global_col
    source_row = global_row - level.global_row
    source_col_start = max(0, source_col)
    source_row_start = max(0, source_row)
    source_col_end = min(source_width, source_col + width)
    source_row_end = min(source_height, source_row + height)
    if source_col_start >= source_col_end or source_row_start >= source_row_end:
        return result
    destination_col = source_col_start - source_col
    destination_row = source_row_start - source_row
    result[
        destination_row:destination_row + source_row_end - source_row_start,
        destination_col:destination_col + source_col_end - source_col_start,
    ] = level.values[
        source_row_start:source_row_end,
        source_col_start:source_col_end,
    ]
    return result


def _coverage(
    bounds: tuple[float, float, float, float],
    base_matrix: int,
) -> dict[int, tuple[int, int, int, int]]:
    west, south, east, north = bounds
    result: dict[int, tuple[int, int, int, int]] = {}
    for matrix in range(MINIMUM_MATRIX, base_matrix + 1):
        northwest = WEB_MERCATOR_QUAD.tile(west, north, matrix)
        southeast = WEB_MERCATOR_QUAD.tile(east, south, matrix)
        result[matrix] = (
            northwest.y,
            southeast.y,
            northwest.x,
            southeast.x,
        )
    return result


def _global_pixel_origin(
    base_min_tile_col: int,
    base_min_tile_row: int,
    nominal_factor: int,
) -> tuple[int, int]:
    numerator_col = base_min_tile_col * TILE_SIZE
    numerator_row = base_min_tile_row * TILE_SIZE
    if numerator_col % nominal_factor or numerator_row % nominal_factor:
        raise ValueError(
            "Flow Field COG nominal overview is not aligned to the global WMQ pixel lattice"
        )
    return numerator_col // nominal_factor, numerator_row // nominal_factor


def _matrix_level(value: str | int) -> int:
    if isinstance(value, bool):
        raise TypeError("Flow Field COG matrix must be a canonical integer")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit() and str(int(value)) == value:
        return int(value)
    raise TypeError("Flow Field COG matrix must be a canonical integer")


def _canonical_integer(value: object, name: str, minimum: int) -> int:
    if isinstance(value, bool):
        raise ValueError(f"Flow Field COG {name} must be an integer")
    if isinstance(value, int):
        result = value
    elif isinstance(value, str) and value.isdigit() and str(int(value)) == value:
        result = int(value)
    else:
        raise ValueError(f"Flow Field COG {name} must be an integer")
    if result < minimum:
        raise ValueError(f"Flow Field COG {name} is out of range")
    return result


def _validate_values(values: np.ndarray, label: str) -> None:
    if values.ndim != 3 or values.shape[2] != CHANNEL_COUNT:
        raise ValueError(f"{label} must have two components")
    if values.dtype != np.dtype("float32"):
        raise ValueError(f"{label} must contain float32 values")
    if not np.isfinite(values).all():
        raise ValueError(f"{label} contains a non-finite component")
    if np.signbit(values[values == 0.0]).any():
        raise ValueError(f"{label} contains a negative zero component")


def _finite_number(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )
