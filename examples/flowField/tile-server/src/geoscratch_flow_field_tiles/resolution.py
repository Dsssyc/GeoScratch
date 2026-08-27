from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal, TypeAlias

import numpy as np
from scipy.spatial import cKDTree

from .topology import WEB_MERCATOR_RADIUS, project_lon_lat


class UnsupportedResolutionError(ValueError):
    """Raised when a snapshot requests a resolution strategy not implemented here."""

    code = "UNSUPPORTED_RESOLUTION"


@dataclass(frozen=True, slots=True)
class StationSpacingResolution:
    """Selects a WebMercator matrix from a robust lower local-spacing quantile."""

    kind: Literal["station-spacing-quantile"] = field(
        default="station-spacing-quantile",
        init=False,
    )
    neighbor_count: int = 8
    spacing_quantile: float = 0.10
    samples_per_spacing: float = 2.0
    snap: Literal["nearest"] = "nearest"
    minimum_matrix: int = 0
    maximum_matrix: int = 24

    def __post_init__(self) -> None:
        if (
            isinstance(self.neighbor_count, bool)
            or not isinstance(self.neighbor_count, int)
            or self.neighbor_count < 2
        ):
            raise ValueError("neighbor_count must be an integer greater than one")
        if not _finite_between(self.spacing_quantile, 0.0, 1.0, exclusive=True):
            raise ValueError("spacing_quantile must be strictly between zero and one")
        if not _finite_positive(self.samples_per_spacing):
            raise ValueError("samples_per_spacing must be finite and positive")
        if self.snap != "nearest":
            raise ValueError("snap must be nearest")
        for name, value in (
            ("minimum_matrix", self.minimum_matrix),
            ("maximum_matrix", self.maximum_matrix),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 24:
                raise ValueError(f"{name} must be an integer in [0, 24]")
        if self.minimum_matrix > self.maximum_matrix:
            raise ValueError("minimum_matrix cannot exceed maximum_matrix")

    def manifest(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "neighborCount": self.neighbor_count,
            "spacingQuantile": self.spacing_quantile,
            "samplesPerSpacing": self.samples_per_spacing,
            "snap": self.snap,
            "minimumMatrix": self.minimum_matrix,
            "maximumMatrix": self.maximum_matrix,
        }


ResolutionSpec: TypeAlias = StationSpacingResolution


@dataclass(frozen=True, slots=True)
class ResolutionSelection:
    """Immutable evidence for one statistically selected WebMercator resolution."""

    strategy: StationSpacingResolution
    source_station_count: int
    unique_station_count: int
    duplicate_station_count: int
    effective_spacing_meters: float
    target_pixel_size_meters: float
    matrix_id: int
    matrix_pixel_size_meters: float
    spacing_quantiles_meters: tuple[tuple[str, float], ...]

    @property
    def resolved_samples_per_spacing(self) -> float:
        return self.effective_spacing_meters / self.matrix_pixel_size_meters

    def manifest(self) -> dict[str, Any]:
        return {
            "requested": self.strategy.manifest(),
            "resolved": {
                "matrixSet": "WebMercatorQuad",
                "matrixId": str(self.matrix_id),
                "matrixPixelSizeMeters": self.matrix_pixel_size_meters,
                "resolvedSamplesPerSpacing": self.resolved_samples_per_spacing,
            },
            "sourceStationCount": self.source_station_count,
            "uniqueStationCount": self.unique_station_count,
            "duplicateStationCount": self.duplicate_station_count,
            "localSpacingStatistic": "median-nearest-k",
            "effectiveSpacingMeters": self.effective_spacing_meters,
            "targetPixelSizeMeters": self.target_pixel_size_meters,
            "spacingQuantilesMeters": {
                name: value for name, value in self.spacing_quantiles_meters
            },
        }


def resolve_resolution(value: object | None) -> StationSpacingResolution:
    if value is None:
        return StationSpacingResolution()
    if isinstance(value, StationSpacingResolution):
        return value
    raise UnsupportedResolutionError(
        f"unsupported Flow Field resolution specification: {type(value).__name__}"
    )


def select_resolution(
    stations: np.ndarray,
    resolution: ResolutionSpec | None = None,
) -> ResolutionSelection:
    strategy = resolve_resolution(resolution)
    coordinates = np.asarray(stations, dtype=np.float64)
    if coordinates.ndim != 2 or coordinates.shape[1] != 2:
        raise ValueError("station coordinates must have shape (station_count, 2)")
    if not np.isfinite(coordinates).all():
        raise ValueError("station coordinates must be finite")
    unique = np.unique(coordinates, axis=0)
    required = strategy.neighbor_count + 1
    if unique.shape[0] < required:
        raise ValueError(
            f"resolution selection requires at least {required} unique stations"
        )
    projected = project_lon_lat(unique)
    distances, _indices = cKDTree(projected).query(
        projected,
        k=required,
        workers=-1,
    )
    local_spacing = np.median(distances[:, 1:], axis=1)
    if not np.isfinite(local_spacing).all() or np.any(local_spacing <= 0.0):
        raise ValueError("station spacing must be finite and positive after deduplication")
    effective_spacing = float(np.quantile(
        local_spacing,
        strategy.spacing_quantile,
        method="linear",
    ))
    target_pixel_size = effective_spacing / strategy.samples_per_spacing
    candidates = tuple(
        (
            matrix_id,
            web_mercator_matrix_pixel_size(matrix_id),
        )
        for matrix_id in range(strategy.minimum_matrix, strategy.maximum_matrix + 1)
    )
    matrix_id, matrix_pixel_size = min(
        candidates,
        key=lambda candidate: (
            abs(math.log2(candidate[1] / target_pixel_size)),
            -candidate[0],
        ),
    )
    quantile_records = tuple(
        (label, float(np.quantile(local_spacing, quantile, method="linear")))
        for label, quantile in (
            ("minimum", 0.0),
            ("p01", 0.01),
            ("p05", 0.05),
            ("p10", 0.10),
            ("p25", 0.25),
            ("p50", 0.50),
            ("p90", 0.90),
            ("p99", 0.99),
            ("maximum", 1.0),
        )
    )
    return ResolutionSelection(
        strategy=strategy,
        source_station_count=int(coordinates.shape[0]),
        unique_station_count=int(unique.shape[0]),
        duplicate_station_count=int(coordinates.shape[0] - unique.shape[0]),
        effective_spacing_meters=effective_spacing,
        target_pixel_size_meters=target_pixel_size,
        matrix_id=matrix_id,
        matrix_pixel_size_meters=matrix_pixel_size,
        spacing_quantiles_meters=quantile_records,
    )


def web_mercator_matrix_pixel_size(matrix_id: int) -> float:
    if isinstance(matrix_id, bool) or not isinstance(matrix_id, int) or not 0 <= matrix_id <= 24:
        raise ValueError("matrix_id must be an integer in [0, 24]")
    return 2.0 * math.pi * WEB_MERCATOR_RADIUS / (256 * (1 << matrix_id))


def _finite_positive(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and value > 0.0
    )


def _finite_between(
    value: object,
    minimum: float,
    maximum: float,
    *,
    exclusive: bool,
) -> bool:
    if not _finite_positive(value):
        return False
    numeric = float(value)
    return minimum < numeric < maximum if exclusive else minimum <= numeric <= maximum
