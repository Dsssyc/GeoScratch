from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from rasterio.transform import Affine


SEMANTIC_OVERVIEW_POLICY = "recursive-conservative-vector-box-v1"


@dataclass(frozen=True, slots=True)
class SemanticOverviewLevel:
    index: int
    nominal_factor: int
    width: int
    height: int
    transform: tuple[float, float, float, float, float, float]
    effective_decimation_x: float
    effective_decimation_y: float

    def manifest(self) -> dict[str, object]:
        return {
            "index": self.index,
            "nominalFactor": self.nominal_factor,
            "width": self.width,
            "height": self.height,
            "transform": list(self.transform),
            "effectiveDecimationX": self.effective_decimation_x,
            "effectiveDecimationY": self.effective_decimation_y,
        }


@dataclass(frozen=True, slots=True)
class SemanticOverviewBlock:
    values: np.ndarray
    candidate_valid_count: int
    bilinear_safe_count: int
    cancellation_to_zero_count: int


def plan_semantic_overview_levels(
    width: int,
    height: int,
    transform: tuple[float, float, float, float, float, float],
    *,
    block_size: int,
) -> tuple[SemanticOverviewLevel, ...]:
    _require_positive_integer(width, "width")
    _require_positive_integer(height, "height")
    _require_positive_integer(block_size, "block_size")
    affine = Affine(*transform)
    if (
        not all(math.isfinite(value) for value in affine[:6])
        or affine.a <= 0.0
        or affine.e >= 0.0
        or affine.b != 0.0
        or affine.d != 0.0
    ):
        raise ValueError("overview transform must be finite north-up with no rotation")

    base_width = width
    base_height = height
    extent_width = affine.a * base_width
    extent_height = -affine.e * base_height
    levels: list[SemanticOverviewLevel] = []
    factor = 1
    while width > block_size or height > block_size:
        width = (width + 1) // 2
        height = (height + 1) // 2
        factor *= 2
        level_transform = Affine(
            extent_width / width,
            0.0,
            affine.c,
            0.0,
            -extent_height / height,
            affine.f,
        )
        levels.append(SemanticOverviewLevel(
            index=len(levels),
            nominal_factor=factor,
            width=width,
            height=height,
            transform=tuple(level_transform)[:6],
            effective_decimation_x=base_width / width,
            effective_decimation_y=base_height / height,
        ))
    return tuple(levels)


def reduce_semantic_overview(child_values: np.ndarray) -> SemanticOverviewBlock:
    values = _require_velocity_values(child_values)
    child_height, child_width, _components = values.shape
    parent_height = (child_height + 1) // 2
    parent_width = (child_width + 1) // 2
    padded = np.zeros(
        (2 * (parent_height + 2), 2 * (parent_width + 2), 2),
        dtype="<f4",
    )
    padded[2:2 + child_height, 2:2 + child_width] = values
    return reduce_semantic_overview_block(
        padded,
        output_height=parent_height,
        output_width=parent_width,
    )


def reduce_semantic_overview_block(
    child_values_with_parent_halo: np.ndarray,
    *,
    output_height: int,
    output_width: int,
) -> SemanticOverviewBlock:
    _require_positive_integer(output_height, "output_height")
    _require_positive_integer(output_width, "output_width")
    values = _require_velocity_values(child_values_with_parent_halo)
    expected_shape = (2 * (output_height + 2), 2 * (output_width + 2), 2)
    if values.shape != expected_shape:
        raise ValueError(
            "semantic overview block requires two child samples for every "
            "output pixel and one parent-pixel halo"
        )

    candidate_values, candidate_valid, cancellation = _reduce_candidates(values)
    bilinear_safe = np.lib.stride_tricks.sliding_window_view(
        candidate_valid,
        (3, 3),
    ).all(axis=(2, 3))
    central_values = candidate_values[1:-1, 1:-1].copy()
    central_candidates = candidate_valid[1:-1, 1:-1]
    central_cancellation = cancellation[1:-1, 1:-1]
    central_values[~bilinear_safe] = 0.0
    central_values[central_values == 0.0] = 0.0
    return SemanticOverviewBlock(
        values=central_values.astype("<f4", copy=False),
        candidate_valid_count=int(np.count_nonzero(central_candidates)),
        bilinear_safe_count=int(np.count_nonzero(bilinear_safe)),
        cancellation_to_zero_count=int(np.count_nonzero(central_cancellation)),
    )


def _reduce_candidates(
    child_values: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    height, width, _components = child_values.shape
    if height % 2 or width % 2:
        raise ValueError("candidate reduction requires even child dimensions")
    rows = height // 2
    columns = width // 2
    values = np.asarray(child_values, dtype=np.float64).reshape(
        rows,
        2,
        columns,
        2,
        2,
    )
    first_row = values[:, 0]
    second_row = values[:, 1]
    averaged = (
        (first_row[:, :, 0] + first_row[:, :, 1])
        + (second_row[:, :, 0] + second_row[:, :, 1])
    ) * 0.25
    child_valid = np.any(values != 0.0, axis=4)
    all_children_valid = child_valid.all(axis=(1, 3))
    mean_is_nonzero = np.any(averaged != 0.0, axis=2)
    cancellation = all_children_valid & ~mean_is_nonzero
    candidate_valid = all_children_valid & mean_is_nonzero
    averaged[~candidate_valid] = 0.0
    averaged[averaged == 0.0] = 0.0
    return averaged.astype("<f4"), candidate_valid, cancellation


def _require_velocity_values(value: np.ndarray) -> np.ndarray:
    values = np.asarray(value, dtype="<f4")
    if values.ndim != 3 or values.shape[2] != 2:
        raise ValueError("semantic overview input must have shape (height, width, 2)")
    if not np.isfinite(values).all():
        raise ValueError("semantic overview input must contain finite U/V values")
    return values


def _require_positive_integer(value: object, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
