from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .contracts import (
    InterpolationSpec,
    TriangleLinearInterpolation,
    resolve_interpolation,
)
from .topology import PreparedDelaunayTopology, project_lon_lat


_BARYCENTRIC_TOLERANCE = 64.0 * np.finfo(np.float64).eps


@dataclass(frozen=True, slots=True)
class TriangleLinearStencil:
    interpolation: TriangleLinearInterpolation
    target_count: int
    target_indices: np.ndarray
    vertex_indices: np.ndarray
    weights: np.ndarray
    status: np.ndarray
    outside_target_count: int
    rejected_target_count: int
    numerical_target_count: int

    @property
    def valid_target_count(self) -> int:
        return int(self.target_indices.size)

    def apply(
        self,
        topology: PreparedDelaunayTopology,
        field: np.ndarray,
    ) -> np.ndarray:
        return self.apply_unique(topology.aggregate_field(field))

    def apply_unique(self, unique_field: np.ndarray) -> np.ndarray:
        output, _advectable = self.apply_unique_with_support(unique_field)
        return output

    def apply_unique_with_support(
        self,
        unique_field: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray]:
        values_by_vertex = np.asarray(unique_field, dtype=np.float64)
        if values_by_vertex.ndim != 2 or values_by_vertex.shape[1] != 2:
            raise ValueError("prepared velocity field must contain U/V pairs")
        if not np.isfinite(values_by_vertex).all():
            raise ValueError("prepared velocity field must contain finite U/V pairs")
        output = np.zeros((self.target_count, 2), dtype=np.float64)
        advectable = np.zeros(self.target_count, dtype=bool)
        if self.target_indices.size:
            if int(self.vertex_indices.max(initial=-1)) >= values_by_vertex.shape[0]:
                raise ValueError("prepared velocity field does not cover the stencil vertices")
            values = values_by_vertex[self.vertex_indices]
            interpolated = np.einsum("ki,kic->kc", self.weights, values, optimize=True)
            if self.interpolation.stationary_policy == "require-all-moving":
                moving = np.all(
                    np.linalg.norm(values, axis=2) > self.interpolation.stationary_epsilon,
                    axis=1,
                )
            else:
                moving = np.linalg.norm(interpolated, axis=1) > self.interpolation.stationary_epsilon
            if moving.any():
                selected_targets = self.target_indices[moving]
                output[selected_targets] = interpolated[moving]
                advectable[selected_targets] = True
        return output.astype("<f4"), advectable

    def manifest(self) -> dict[str, object]:
        return {
            "kind": self.interpolation.kind,
            "weightPrecision": "float64",
            "outputPrecision": "float32-le",
            "targetCount": self.target_count,
            "validTargetCount": self.valid_target_count,
            "outsideTargetCount": self.outside_target_count,
            "rejectedTargetCount": self.rejected_target_count,
            "numericalTargetCount": self.numerical_target_count,
        }


@dataclass(frozen=True, slots=True)
class BilinearSafeBlock:
    values: np.ndarray
    raw_advectable_count: int
    representable_advectable_count: int
    rounded_zero_count: int
    bilinear_safe_count: int


@dataclass(frozen=True, slots=True)
class PixelCenterBlock:
    """Un-eroded U/V samples; the consumer owns nearest-texel activity support."""

    values: np.ndarray
    candidate_count: int
    zero_stored_candidate_count: int
    stored_nonzero_count: int


def apply_pixel_center_block(
    stencil: TriangleLinearStencil,
    unique_field: np.ndarray,
    *,
    block_size: int,
) -> PixelCenterBlock:
    """Store only the block's center samples without rejecting neighboring pixels."""
    if isinstance(block_size, bool) or not isinstance(block_size, int) or block_size <= 0:
        raise ValueError("block_size must be a positive integer")
    side = block_size + 2
    if stencil.target_count != side * side:
        raise ValueError("pixel-center block requires the shared one-texel stencil halo")
    values, raw = stencil.apply_unique_with_support(unique_field)
    block = values.reshape(side, side, 2)[1:-1, 1:-1].copy()
    raw = raw.reshape(side, side)[1:-1, 1:-1]
    stored = np.any(block != 0.0, axis=2)
    block[block == 0.0] = 0.0
    return PixelCenterBlock(
        values=block,
        candidate_count=int(raw.sum()),
        zero_stored_candidate_count=int((raw & ~stored).sum()),
        stored_nonzero_count=int(stored.sum()),
    )


def apply_bilinear_safe_block(
    stencil: TriangleLinearStencil,
    unique_field: np.ndarray,
    *,
    block_size: int,
    require_representable_motion: bool = False,
) -> BilinearSafeBlock:
    if isinstance(block_size, bool) or not isinstance(block_size, int) or block_size <= 0:
        raise ValueError("block_size must be a positive integer")
    side = block_size + 2
    if stencil.target_count != side * side:
        raise ValueError("bilinear-safe block requires a one-texel stencil halo")
    values, raw_advectable = stencil.apply_unique_with_support(unique_field)
    values = values.reshape(side, side, 2)
    raw_advectable = raw_advectable.reshape(side, side)
    representable_advectable = raw_advectable.copy()
    if require_representable_motion:
        representable_advectable &= np.any(values != 0.0, axis=2)
    bilinear_safe = np.ones((block_size, block_size), dtype=bool)
    for row_offset in range(3):
        for column_offset in range(3):
            bilinear_safe &= representable_advectable[
                row_offset:row_offset + block_size,
                column_offset:column_offset + block_size,
            ]
    block = values[1:-1, 1:-1].copy()
    block[~bilinear_safe] = 0.0
    if require_representable_motion:
        block[block == 0.0] = 0.0
    return BilinearSafeBlock(
        values=block,
        raw_advectable_count=int(np.count_nonzero(raw_advectable[1:-1, 1:-1])),
        representable_advectable_count=int(np.count_nonzero(
            representable_advectable[1:-1, 1:-1]
        )),
        rounded_zero_count=int(np.count_nonzero(
            raw_advectable[1:-1, 1:-1]
            & ~representable_advectable[1:-1, 1:-1]
        )),
        bilinear_safe_count=int(np.count_nonzero(bilinear_safe)),
    )


def prepare_triangle_linear_stencil(
    topology: PreparedDelaunayTopology,
    longitudes: np.ndarray,
    latitudes: np.ndarray,
    interpolation: InterpolationSpec | None = None,
) -> TriangleLinearStencil:
    spec = resolve_interpolation(interpolation)
    longitude = np.asarray(longitudes, dtype=np.float64)
    latitude = np.asarray(latitudes, dtype=np.float64)
    if longitude.shape != latitude.shape:
        raise ValueError("longitude and latitude arrays must have matching shapes")
    if longitude.ndim != 1:
        raise ValueError("longitude and latitude arrays must be one-dimensional")
    if not np.isfinite(longitude).all() or not np.isfinite(latitude).all():
        raise ValueError("target longitude and latitude must be finite")

    target_count = int(longitude.size)
    normalized = topology.normalize_projected(
        project_lon_lat(np.column_stack((longitude, latitude)))
    )
    # `find_simplex` returns -1 outside the triangulation; filter it before any
    # indexing. Source:
    # https://docs.scipy.org/doc/scipy/reference/generated/scipy.spatial.Delaunay.find_simplex.html
    simplex_ids = topology.triangulation.find_simplex(
        normalized,
        tol=_BARYCENTRIC_TOLERANCE,
    )
    inside = simplex_ids >= 0
    accepted = np.zeros(target_count, dtype=bool)
    accepted[inside] = topology.accepted_simplices[simplex_ids[inside]]
    candidate_indices = np.flatnonzero(accepted)
    numerical = np.zeros(target_count, dtype=bool)
    status = np.zeros(target_count, dtype=np.uint8)
    status[inside] = 2

    if candidate_indices.size:
        candidate_simplex_ids = simplex_ids[candidate_indices]
        transforms = topology.triangulation.transform[candidate_simplex_ids]
        relative = normalized[candidate_indices] - transforms[:, 2]
        first_two = np.einsum(
            "kij,kj->ki",
            transforms[:, :2],
            relative,
            optimize=True,
        )
        weights = np.column_stack((
            first_two,
            1.0 - first_two.sum(axis=1),
        ))
        stable = np.isfinite(weights).all(axis=1)
        stable &= np.all(weights >= -_BARYCENTRIC_TOLERANCE, axis=1)
        stable &= np.all(weights <= 1.0 + _BARYCENTRIC_TOLERANCE, axis=1)
        numerical[candidate_indices[~stable]] = True
        target_indices = candidate_indices[stable]
        status[target_indices] = 1
        status[candidate_indices[~stable]] = 3
        simplex_indices = candidate_simplex_ids[stable]
        weights = np.clip(weights[stable], 0.0, 1.0)
        weights /= weights.sum(axis=1, keepdims=True)
        vertex_indices = topology.triangulation.simplices[simplex_indices].astype(
            np.int32,
            copy=True,
        )
    else:
        target_indices = np.empty(0, dtype=np.int64)
        vertex_indices = np.empty((0, 3), dtype=np.int32)
        weights = np.empty((0, 3), dtype=np.float64)

    outside_target_count = int(np.count_nonzero(~inside))
    rejected_target_count = int(np.count_nonzero(inside & ~accepted))
    numerical_target_count = int(np.count_nonzero(numerical))
    target_indices = target_indices.astype(np.int32, copy=False)
    for array in (target_indices, vertex_indices, weights, status):
        array.setflags(write=False)
    return TriangleLinearStencil(
        interpolation=spec,
        target_count=target_count,
        target_indices=target_indices,
        vertex_indices=vertex_indices,
        weights=weights,
        status=status,
        outside_target_count=outside_target_count,
        rejected_target_count=rejected_target_count,
        numerical_target_count=numerical_target_count,
    )
