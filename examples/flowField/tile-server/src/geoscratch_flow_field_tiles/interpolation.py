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
        values_by_vertex = np.asarray(unique_field, dtype=np.float64)
        if values_by_vertex.ndim != 2 or values_by_vertex.shape[1] != 2:
            raise ValueError("prepared velocity field must contain U/V pairs")
        if not np.isfinite(values_by_vertex).all():
            raise ValueError("prepared velocity field must contain finite U/V pairs")
        output = np.zeros((self.target_count, 2), dtype=np.float64)
        if self.target_indices.size:
            if int(self.vertex_indices.max(initial=-1)) >= values_by_vertex.shape[0]:
                raise ValueError("prepared velocity field does not cover the stencil vertices")
            values = values_by_vertex[self.vertex_indices]
            moving = np.all(
                np.linalg.norm(values, axis=2)
                > self.interpolation.stationary_epsilon,
                axis=1,
            )
            interpolated = np.einsum(
                "ki,kic->kc",
                self.weights,
                values,
                optimize=True,
            )
            output[self.target_indices[moving]] = interpolated[moving]
        return output.astype("<f4")

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
    # indexing. Source: https://docs.scipy.org/doc/scipy/reference/generated/scipy.spatial.Delaunay.find_simplex.html
    simplex_ids = topology.triangulation.find_simplex(
        normalized,
        tol=_BARYCENTRIC_TOLERANCE,
    )
    inside = simplex_ids >= 0
    accepted = np.zeros(target_count, dtype=bool)
    accepted[inside] = topology.accepted_simplices[simplex_ids[inside]]
    candidate_indices = np.flatnonzero(accepted)
    numerical = np.zeros(target_count, dtype=bool)

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
    for array in (target_indices, vertex_indices, weights):
        array.setflags(write=False)
    return TriangleLinearStencil(
        interpolation=spec,
        target_count=target_count,
        target_indices=target_indices,
        vertex_indices=vertex_indices,
        weights=weights,
        outside_target_count=outside_target_count,
        rejected_target_count=rejected_target_count,
        numerical_target_count=numerical_target_count,
    )
