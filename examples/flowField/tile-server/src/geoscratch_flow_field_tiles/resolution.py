from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal, TypeAlias

import numpy as np
from scipy.signal import find_peaks, peak_prominences
from scipy.spatial import cKDTree

from .topology import WEB_MERCATOR_RADIUS, project_lon_lat


_HISTOGRAM_ANCHOR_METERS = 1.0
_SMOOTHING_KERNEL_WEIGHTS = (1, 4, 6, 4, 1)
_SMOOTHING_KERNEL_DIVISOR = 16


class UnsupportedResolutionError(ValueError):
    """Raised when a snapshot requests a resolution strategy not implemented here."""

    code = "UNSUPPORTED_RESOLUTION"


@dataclass(frozen=True, slots=True)
class StationSpacingResolution:
    """Selects the finest statistically supported station-spacing mode."""

    kind: Literal["station-spacing-supported-mode"] = field(
        default="station-spacing-supported-mode",
        init=False,
    )
    histogram_bin_width_octaves: float = 1.0 / 16.0
    support_half_width_octaves: float = 0.25
    minimum_support_fraction: float = 0.01
    minimum_support_points: int = 1_024
    minimum_prominence_ratio: float = 0.25
    samples_per_spacing: float = 2.0
    snap: Literal["not-coarser"] = "not-coarser"
    minimum_matrix: int = 0
    maximum_matrix: int = 24

    def __post_init__(self) -> None:
        for name, value in (
            ("histogram_bin_width_octaves", self.histogram_bin_width_octaves),
            ("support_half_width_octaves", self.support_half_width_octaves),
            ("samples_per_spacing", self.samples_per_spacing),
        ):
            if not _finite_positive(value):
                raise ValueError(f"{name} must be finite and positive")
        for name, value in (
            ("minimum_support_fraction", self.minimum_support_fraction),
            ("minimum_prominence_ratio", self.minimum_prominence_ratio),
        ):
            if not _finite_unit_interval(value):
                raise ValueError(f"{name} must be strictly between zero and one")
        if (
            isinstance(self.minimum_support_points, bool)
            or not isinstance(self.minimum_support_points, int)
            or self.minimum_support_points <= 0
        ):
            raise ValueError("minimum_support_points must be a positive integer")
        if self.snap != "not-coarser":
            raise ValueError("snap must be not-coarser")
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
            "distanceSpace": "EPSG:3857",
            "localSpacingStatistic": "nearest-non-self",
            "histogramScale": "log2-meters",
            "histogramAnchorMeters": _HISTOGRAM_ANCHOR_METERS,
            "histogramBinWidthOctaves": self.histogram_bin_width_octaves,
            "smoothingKernelWeights": list(_SMOOTHING_KERNEL_WEIGHTS),
            "smoothingKernelDivisor": _SMOOTHING_KERNEL_DIVISOR,
            "supportHalfWidthOctaves": self.support_half_width_octaves,
            "minimumSupportFraction": self.minimum_support_fraction,
            "minimumSupportPoints": self.minimum_support_points,
            "minimumProminenceRatio": self.minimum_prominence_ratio,
            "peakSelection": "leftmost-supported",
            "samplesPerSpacing": self.samples_per_spacing,
            "snap": self.snap,
            "minimumMatrix": self.minimum_matrix,
            "maximumMatrix": self.maximum_matrix,
        }


ResolutionSpec: TypeAlias = StationSpacingResolution


@dataclass(frozen=True, slots=True)
class SpacingMode:
    peak_center_meters: float
    effective_spacing_meters: float
    support_count: int
    support_fraction: float
    prominence_ratio: float

    def manifest(self) -> dict[str, float | int]:
        return {
            "peakCenterMeters": self.peak_center_meters,
            "effectiveSpacingMeters": self.effective_spacing_meters,
            "supportCount": self.support_count,
            "supportFraction": self.support_fraction,
            "prominenceRatio": self.prominence_ratio,
        }


@dataclass(frozen=True, slots=True)
class ResolutionSelection:
    """Immutable evidence for one statistically selected WebMercator resolution."""

    strategy: StationSpacingResolution
    source_station_count: int
    unique_station_count: int
    duplicate_station_count: int
    support_threshold: int
    selected_mode: SpacingMode
    candidate_modes: tuple[SpacingMode, ...]
    target_pixel_size_meters: float
    matrix_id: int
    matrix_pixel_size_meters: float
    spacing_quantiles_meters: tuple[tuple[str, float], ...]

    @property
    def effective_spacing_meters(self) -> float:
        return self.selected_mode.effective_spacing_meters

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
            "localSpacingStatistic": "nearest-non-self",
            "supportThreshold": self.support_threshold,
            "selectedMode": self.selected_mode.manifest(),
            "candidateModes": [mode.manifest() for mode in self.candidate_modes],
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
    if unique.shape[0] < 3:
        raise ValueError("resolution selection requires at least three unique stations")
    projected = project_lon_lat(unique)
    distances, _indices = cKDTree(projected).query(projected, k=2, workers=-1)
    nearest = distances[:, 1]
    if not np.isfinite(nearest).all() or np.any(nearest <= 0.0):
        raise ValueError("station spacing must be finite and positive after deduplication")

    log_spacing = np.log2(nearest / _HISTOGRAM_ANCHOR_METERS)
    width = strategy.histogram_bin_width_octaves
    lower = math.floor(float(log_spacing.min()) / width) * width
    upper = math.ceil(float(log_spacing.max()) / width) * width
    edges = np.arange(lower, upper + width * 1.5, width, dtype=np.float64)
    counts, _edges = np.histogram(log_spacing, edges)
    kernel = (
        np.asarray(_SMOOTHING_KERNEL_WEIGHTS, dtype=np.float64)
        / _SMOOTHING_KERNEL_DIVISOR
    )
    smoothed = np.convolve(np.pad(counts, (2, 2), mode="edge"), kernel, mode="valid")
    peak_indices = find_peaks(smoothed)[0]
    prominences = peak_prominences(smoothed, peak_indices)[0]
    peak_records = list(zip(peak_indices, prominences, strict=True))
    if smoothed.size == 1 or smoothed[0] > smoothed[1]:
        peak_records.insert(0, (0, smoothed[0]))
    if smoothed.size > 1 and smoothed[-1] > smoothed[-2]:
        peak_records.append((smoothed.size - 1, smoothed[-1]))
    support_threshold = max(
        strategy.minimum_support_points,
        math.ceil(strategy.minimum_support_fraction * unique.shape[0]),
    )
    candidates: list[SpacingMode] = []
    for peak_index, prominence in peak_records:
        peak_height = float(smoothed[peak_index])
        if peak_height <= 0.0:
            continue
        peak_center_log = float((edges[peak_index] + edges[peak_index + 1]) * 0.5)
        supported = np.abs(log_spacing - peak_center_log) <= (
            strategy.support_half_width_octaves
        )
        support_count = int(np.count_nonzero(supported))
        prominence_ratio = float(prominence / peak_height)
        if (
            support_count < support_threshold
            or prominence_ratio < strategy.minimum_prominence_ratio
        ):
            continue
        candidates.append(SpacingMode(
            peak_center_meters=(
                _HISTOGRAM_ANCHOR_METERS * 2.0 ** peak_center_log
            ),
            effective_spacing_meters=float(np.median(nearest[supported])),
            support_count=support_count,
            support_fraction=support_count / unique.shape[0],
            prominence_ratio=prominence_ratio,
        ))
    if not candidates:
        raise ValueError("no statistically supported station-spacing mode was found")
    selected = candidates[0]
    target_pixel_size = selected.effective_spacing_meters / strategy.samples_per_spacing
    matrix_id = math.ceil(math.log2(
        web_mercator_matrix_pixel_size(0) / target_pixel_size
    ))
    matrix_id = max(strategy.minimum_matrix, min(strategy.maximum_matrix, matrix_id))
    matrix_pixel_size = web_mercator_matrix_pixel_size(matrix_id)
    if matrix_pixel_size > target_pixel_size and matrix_id == strategy.maximum_matrix:
        raise ValueError("maximum_matrix is too coarse for the selected station spacing")
    quantile_records = tuple(
        (label, float(np.quantile(nearest, quantile, method="linear")))
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
        support_threshold=support_threshold,
        selected_mode=selected,
        candidate_modes=tuple(candidates),
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


def _finite_unit_interval(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and 0.0 < value < 1.0
    )
