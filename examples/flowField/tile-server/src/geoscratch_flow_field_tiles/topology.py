from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass

import numpy as np
import scipy
from scipy.spatial import Delaunay, QhullError, cKDTree

from .contracts import DelaunayTopology, TopologySpec, resolve_topology


WEB_MERCATOR_RADIUS = 6_378_137.0
WEB_MERCATOR_LATITUDE_LIMIT = 85.0511287798066
QHULL_OPTIONS = "Qbb Qc Qz Q12"
_SIMPLEX_TOLERANCE = 64.0 * np.finfo(np.float64).eps


class DuplicateStationError(ValueError):
    """Raised when exact station duplicates conflict with a strict topology policy."""

    code = "DUPLICATE_STATION_COORDINATE"


class DegenerateTopologyError(ValueError):
    """Raised when stations cannot define a stable two-dimensional triangulation."""

    code = "DEGENERATE_TOPOLOGY"


@dataclass(frozen=True, slots=True)
class DuplicateStatistics:
    location_count: int
    extra_source_point_count: int
    maximum_velocity_difference: float


@dataclass(frozen=True, slots=True)
class PreparedDelaunayTopology:
    spec: DelaunayTopology
    triangulation: Delaunay
    source_station_count: int
    vertices_lon_lat: np.ndarray
    vertices_projected: np.ndarray
    source_to_vertex: np.ndarray
    first_source_indices: np.ndarray
    duplicate_counts: np.ndarray
    accepted_simplices: np.ndarray
    numeric_degenerate_simplices: np.ndarray
    bridge_rejected_simplices: np.ndarray
    connectivity_sha256: str
    normalization_origin: np.ndarray
    normalization_scale: float

    @property
    def vertex_count(self) -> int:
        return int(self.vertices_lon_lat.shape[0])

    @property
    def triangle_count(self) -> int:
        return int(self.triangulation.simplices.shape[0])

    @property
    def accepted_triangle_count(self) -> int:
        return int(np.count_nonzero(self.accepted_simplices))

    def normalize_projected(self, points: np.ndarray) -> np.ndarray:
        return (points - self.normalization_origin) / self.normalization_scale

    def aggregate_field(self, field: np.ndarray) -> np.ndarray:
        values = np.asarray(field, dtype=np.float64)
        if values.shape != (self.source_station_count, 2):
            raise ValueError(
                "velocity field must contain one U/V pair for every source station"
            )
        if not np.isfinite(values).all():
            raise ValueError("velocity field must contain finite U/V pairs")
        if self.spec.duplicate_policy in {"error", "first"}:
            return values[self.first_source_indices].copy()
        if self.spec.duplicate_policy == "mean":
            reduced = np.zeros((self.vertex_count, 2), dtype=np.float64)
            np.add.at(reduced, self.source_to_vertex, values)
            reduced /= self.duplicate_counts[:, None]
            return reduced
        return values.copy()

    def duplicate_statistics(
        self,
        fields: tuple[np.ndarray, ...],
    ) -> DuplicateStatistics:
        duplicate_vertices = np.flatnonzero(self.duplicate_counts > 1)
        maximum_difference = 0.0
        for vertex in duplicate_vertices:
            members = np.flatnonzero(self.source_to_vertex == vertex)
            for field in fields:
                values = np.asarray(field, dtype=np.float64)[members]
                maximum_difference = max(
                    maximum_difference,
                    _maximum_pairwise_distance(values),
                )
        return DuplicateStatistics(
            location_count=int(duplicate_vertices.size),
            extra_source_point_count=int(
                self.source_station_count - self.vertex_count
            ),
            maximum_velocity_difference=maximum_difference,
        )

    def manifest(self, duplicate_statistics: DuplicateStatistics) -> dict[str, object]:
        return {
            "requested": self.spec.kind,
            "resolved": self.spec.kind,
            "inferred": True,
            "implementation": "scipy.spatial.Delaunay",
            "implementationVersion": scipy.__version__,
            "qhullOptions": QHULL_OPTIONS,
            "coordinateSpace": "EPSG:3857",
            "sourceStationCount": self.source_station_count,
            "vertexCount": self.vertex_count,
            "duplicateLocationCount": duplicate_statistics.location_count,
            "duplicateSourcePointCount": (
                duplicate_statistics.extra_source_point_count
            ),
            "maximumDuplicateVelocityDifference": (
                duplicate_statistics.maximum_velocity_difference
            ),
            "duplicatePolicy": self.spec.duplicate_policy,
            "triangleCount": self.triangle_count,
            "acceptedTriangleCount": self.accepted_triangle_count,
            "rejectedTriangleCount": self.triangle_count - self.accepted_triangle_count,
            "rejectedReasons": {
                "numericDegenerate": int(
                    np.count_nonzero(self.numeric_degenerate_simplices)
                ),
                "bridgeHeuristic": int(
                    np.count_nonzero(self.bridge_rejected_simplices)
                ),
            },
            "supportHeuristic": {
                "kind": "local-spacing-edge",
                "localSpacingNeighbors": self.spec.local_spacing_neighbors,
                "maximumEdgeRatio": self.spec.maximum_edge_ratio,
                "maximumEdgeLengthMeters": self.spec.maximum_edge_length_meters,
            },
            "sha256": self.connectivity_sha256,
        }


def project_lon_lat(points: np.ndarray) -> np.ndarray:
    coordinates = np.asarray(points, dtype=np.float64)
    if coordinates.ndim != 2 or coordinates.shape[1] != 2:
        raise ValueError("station coordinates must have shape (station_count, 2)")
    if not np.isfinite(coordinates).all():
        raise ValueError("station coordinates must be finite")
    longitude = coordinates[:, 0]
    latitude = coordinates[:, 1]
    if np.any(longitude < -180.0) or np.any(longitude > 180.0):
        raise ValueError("station longitude must be within [-180, 180]")
    if np.any(np.abs(latitude) > WEB_MERCATOR_LATITUDE_LIMIT):
        raise ValueError("station latitude is outside WebMercatorQuad coverage")
    radians_longitude = np.radians(longitude)
    radians_latitude = np.radians(latitude)
    return np.column_stack((
        WEB_MERCATOR_RADIUS * radians_longitude,
        WEB_MERCATOR_RADIUS * np.arcsinh(np.tan(radians_latitude)),
    ))


def _maximum_pairwise_distance(values: np.ndarray, block_size: int = 256) -> float:
    maximum = 0.0
    for first_start in range(0, values.shape[0], block_size):
        first = values[first_start:first_start + block_size]
        for second_start in range(first_start, values.shape[0], block_size):
            second = values[second_start:second_start + block_size]
            differences = first[:, None, :] - second[None, :, :]
            maximum = max(
                maximum,
                float(np.linalg.norm(differences, axis=2).max(initial=0.0)),
            )
    return maximum


def prepare_topology(
    stations: np.ndarray,
    topology: TopologySpec | None = None,
) -> PreparedDelaunayTopology:
    spec = resolve_topology(topology)
    coordinates = np.asarray(stations, dtype=np.float64)
    if coordinates.ndim != 2 or coordinates.shape[1] != 2:
        raise ValueError("station coordinates must have shape (station_count, 2)")
    if coordinates.shape[0] < 3:
        raise DegenerateTopologyError("Delaunay topology requires at least three stations")
    if not np.isfinite(coordinates).all():
        raise ValueError("station coordinates must be finite")

    unique, first, inverse, counts = np.unique(
        coordinates,
        axis=0,
        return_index=True,
        return_inverse=True,
        return_counts=True,
    )
    duplicate_locations = int(np.count_nonzero(counts > 1))
    if duplicate_locations and spec.duplicate_policy == "error":
        raise DuplicateStationError(
            f"Delaunay topology received {duplicate_locations} duplicate station locations"
        )
    if unique.shape[0] < 3:
        raise DegenerateTopologyError(
            "Delaunay topology requires at least three unique stations"
        )

    projected = project_lon_lat(unique)
    minimum = projected.min(axis=0)
    maximum = projected.max(axis=0)
    origin = (minimum + maximum) * 0.5
    scale = float(np.ptp(projected, axis=0).max())
    if not math.isfinite(scale) or scale <= 0.0:
        raise DegenerateTopologyError("station coordinates have no two-dimensional extent")
    normalized = (projected - origin) / scale
    if np.linalg.matrix_rank(normalized - normalized.mean(axis=0)) < 2:
        raise DegenerateTopologyError("station coordinates are collinear")
    try:
        # SciPy documents the simplex/connectivity contract and the possibility of
        # omitted points here:
        # https://docs.scipy.org/doc/scipy/reference/generated/scipy.spatial.Delaunay.html
        triangulation = Delaunay(normalized, qhull_options=QHULL_OPTIONS)
    except QhullError as error:
        raise DegenerateTopologyError(f"Delaunay construction failed: {error}") from error
    if triangulation.coplanar.size:
        raise DegenerateTopologyError(
            "Delaunay construction omitted one or more unique stations"
        )

    simplices = triangulation.simplices.astype(np.int64, copy=False)
    if np.unique(simplices).size != unique.shape[0]:
        raise DegenerateTopologyError(
            "Delaunay construction omitted one or more unique stations"
        )
    vertices = projected[simplices]
    first_edge = vertices[:, 1] - vertices[:, 0]
    second_edge = vertices[:, 2] - vertices[:, 0]
    double_area = np.abs(
        first_edge[:, 0] * second_edge[:, 1]
        - first_edge[:, 1] * second_edge[:, 0]
    )
    edge_lengths = np.stack((
        np.linalg.norm(vertices[:, 0] - vertices[:, 1], axis=1),
        np.linalg.norm(vertices[:, 1] - vertices[:, 2], axis=1),
        np.linalg.norm(vertices[:, 2] - vertices[:, 0], axis=1),
    ), axis=1)
    maximum_edge = edge_lengths.max(axis=1)
    numeric_degenerate = (
        ~np.isfinite(triangulation.transform).all(axis=(1, 2))
        | (double_area / np.maximum(maximum_edge * maximum_edge, np.finfo(float).tiny)
           <= _SIMPLEX_TOLERANCE)
    )

    bridge_rejected = np.zeros(simplices.shape[0], dtype=bool)
    if spec.maximum_edge_ratio is not None:
        neighbor_count = min(spec.local_spacing_neighbors + 1, unique.shape[0])
        distances, _ = cKDTree(projected).query(
            projected,
            k=neighbor_count,
            workers=-1,
        )
        distances = np.asarray(distances, dtype=np.float64)
        if distances.ndim == 1:
            distances = distances[:, None]
        local_spacing = np.median(distances[:, 1:], axis=1)
        edge_pairs = ((0, 1), (1, 2), (2, 0))
        edge_ratios = np.stack(tuple(
            edge_lengths[:, edge_index] / np.maximum(
                local_spacing[simplices[:, first_vertex]],
                local_spacing[simplices[:, second_vertex]],
            )
            for edge_index, (first_vertex, second_vertex) in enumerate(edge_pairs)
        ), axis=1)
        bridge_rejected |= edge_ratios.max(axis=1) > spec.maximum_edge_ratio
    if spec.maximum_edge_length_meters is not None:
        bridge_rejected |= maximum_edge > spec.maximum_edge_length_meters

    accepted = ~(numeric_degenerate | bridge_rejected)
    canonical = np.sort(simplices, axis=1)
    canonical = canonical[np.lexsort((
        canonical[:, 2],
        canonical[:, 1],
        canonical[:, 0],
    ))]
    connectivity = canonical.astype("<u4", copy=False).tobytes(order="C")
    for array in (
        unique,
        projected,
        inverse,
        first,
        counts,
        accepted,
        numeric_degenerate,
        bridge_rejected,
        origin,
    ):
        array.setflags(write=False)
    return PreparedDelaunayTopology(
        spec=spec,
        triangulation=triangulation,
        source_station_count=int(coordinates.shape[0]),
        vertices_lon_lat=unique,
        vertices_projected=projected,
        source_to_vertex=inverse,
        first_source_indices=first,
        duplicate_counts=counts,
        accepted_simplices=accepted,
        numeric_degenerate_simplices=numeric_degenerate,
        bridge_rejected_simplices=bridge_rejected,
        connectivity_sha256=hashlib.sha256(connectivity).hexdigest(),
        normalization_origin=origin,
        normalization_scale=scale,
    )
