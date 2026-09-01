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


@dataclass(frozen=True, slots=True)
class FixedWebMercatorResolution:
    """Selects one explicit OGC WebMercatorQuad matrix as the COG base grid."""

    matrix_id: int
    kind: Literal["fixed-web-mercator-matrix"] = field(
        default="fixed-web-mercator-matrix",
        init=False,
    )

    def __post_init__(self) -> None:
        if (
            isinstance(self.matrix_id, bool)
            or not isinstance(self.matrix_id, int)
            or not 0 <= self.matrix_id <= 24
        ):
            raise ValueError("matrix_id must be an integer in [0, 24]")

    def manifest(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "matrixSet": "WebMercatorQuad",
            "matrixId": str(self.matrix_id),
        }


ResolutionSpec: TypeAlias = StationSpacingResolution | FixedWebMercatorResolution


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

    @property
    def matrix_relation(self) -> Literal["statistically-selected"]:
        return "statistically-selected"


@dataclass(frozen=True, slots=True)
class FixedResolutionSelection:
    """Immutable evidence for one explicitly selected WebMercator resolution."""

    strategy: FixedWebMercatorResolution
    source_station_count: int
    unique_station_count: int
    duplicate_station_count: int
    matrix_id: int
    matrix_pixel_size_meters: float

    def manifest(self) -> dict[str, Any]:
        return {
            "requested": self.strategy.manifest(),
            "resolved": {
                "matrixSet": "WebMercatorQuad",
                "matrixId": str(self.matrix_id),
                "matrixPixelSizeMeters": self.matrix_pixel_size_meters,
            },
            "sourceStationCount": self.source_station_count,
            "uniqueStationCount": self.unique_station_count,
            "duplicateStationCount": self.duplicate_station_count,
        }

    @property
    def matrix_relation(self) -> Literal["explicitly-requested"]:
        return "explicitly-requested"


SelectedResolution: TypeAlias = ResolutionSelection | FixedResolutionSelection


def validate_resolution_selection_manifest(
    value: object,
    *,
    source_station_count: object,
) -> tuple[int, str]:
    """Validates a persisted resolution choice and returns its matrix and relation."""

    if not isinstance(value, dict):
        raise ValueError("Flow Field COG resolution selection is invalid")
    requested = value.get("requested")
    resolved = value.get("resolved")
    if not isinstance(requested, dict) or not isinstance(resolved, dict):
        raise ValueError("Flow Field COG resolution selection is invalid")
    kind = requested.get("kind")
    if kind == "fixed-web-mercator-matrix":
        expected_keys = {
            "requested",
            "resolved",
            "sourceStationCount",
            "uniqueStationCount",
            "duplicateStationCount",
        }
        if set(value) != expected_keys:
            raise ValueError("Flow Field COG fixed resolution selection is invalid")
        try:
            matrix_id = _manifest_matrix_id(requested["matrixId"])
            strategy = FixedWebMercatorResolution(matrix_id)
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(
                "Flow Field COG fixed resolution selection is invalid"
            ) from error
        expected_resolved = {
            "matrixSet": "WebMercatorQuad",
            "matrixId": str(matrix_id),
            "matrixPixelSizeMeters": web_mercator_matrix_pixel_size(matrix_id),
        }
        if requested != strategy.manifest() or resolved != expected_resolved:
            raise ValueError("Flow Field COG fixed resolution selection is invalid")
        _validate_station_counts(value, source_station_count)
        return matrix_id, "explicitly-requested"
    if kind != "station-spacing-supported-mode":
        raise ValueError("Flow Field COG resolution strategy is unsupported")
    expected_keys = {
        "requested",
        "resolved",
        "sourceStationCount",
        "uniqueStationCount",
        "duplicateStationCount",
        "localSpacingStatistic",
        "supportThreshold",
        "selectedMode",
        "candidateModes",
        "targetPixelSizeMeters",
        "spacingQuantilesMeters",
    }
    if set(value) != expected_keys:
        raise ValueError("Flow Field COG statistical resolution selection is invalid")
    try:
        strategy = StationSpacingResolution(
            histogram_bin_width_octaves=requested["histogramBinWidthOctaves"],
            support_half_width_octaves=requested["supportHalfWidthOctaves"],
            minimum_support_fraction=requested["minimumSupportFraction"],
            minimum_support_points=requested["minimumSupportPoints"],
            minimum_prominence_ratio=requested["minimumProminenceRatio"],
            samples_per_spacing=requested["samplesPerSpacing"],
            snap=requested["snap"],
            minimum_matrix=requested["minimumMatrix"],
            maximum_matrix=requested["maximumMatrix"],
        )
        matrix_id = _manifest_matrix_id(resolved["matrixId"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(
            "Flow Field COG statistical resolution selection is invalid"
        ) from error
    if requested != strategy.manifest():
        raise ValueError("Flow Field COG statistical resolution selection is invalid")
    unique_station_count = _validate_station_counts(value, source_station_count)
    selected_mode = value["selectedMode"]
    candidate_modes = value["candidateModes"]
    if (
        value["localSpacingStatistic"] != "nearest-non-self"
        or not isinstance(candidate_modes, list)
        or not candidate_modes
        or selected_mode != candidate_modes[0]
    ):
        raise ValueError("Flow Field COG statistical resolution selection is invalid")
    validated_modes = tuple(
        _validate_spacing_mode(mode, unique_station_count=unique_station_count)
        for mode in candidate_modes
    )
    selected_spacing = validated_modes[0][0]
    support_threshold = value["supportThreshold"]
    expected_support_threshold = max(
        strategy.minimum_support_points,
        math.ceil(strategy.minimum_support_fraction * unique_station_count),
    )
    target_pixel_size = selected_spacing / strategy.samples_per_spacing
    try:
        expected_matrix = _select_matrix_for_target_pixel_size(
            target_pixel_size,
            minimum_matrix=strategy.minimum_matrix,
            maximum_matrix=strategy.maximum_matrix,
        )
    except ValueError as error:
        raise ValueError(
            "Flow Field COG statistical resolution selection is invalid"
        ) from error
    matrix_pixel_size = web_mercator_matrix_pixel_size(matrix_id)
    resolved_samples_per_spacing = selected_spacing / matrix_pixel_size
    if not _finite_positive(resolved_samples_per_spacing):
        raise ValueError("Flow Field COG statistical resolution selection is invalid")
    expected_resolved = {
        "matrixSet": "WebMercatorQuad",
        "matrixId": str(matrix_id),
        "matrixPixelSizeMeters": matrix_pixel_size,
        "resolvedSamplesPerSpacing": resolved_samples_per_spacing,
    }
    quantiles = value["spacingQuantilesMeters"]
    quantile_keys = (
        "minimum",
        "p01",
        "p05",
        "p10",
        "p25",
        "p50",
        "p90",
        "p99",
        "maximum",
    )
    if (
        isinstance(support_threshold, bool)
        or not isinstance(support_threshold, int)
        or support_threshold != expected_support_threshold
        or any(mode[1] < support_threshold for mode in validated_modes)
        or any(
            mode[2] < strategy.minimum_prominence_ratio
            or abs(math.log2(mode[0]) - math.log2(mode[3]))
            > strategy.support_half_width_octaves
            for mode in validated_modes
        )
        or any(
            left[3] >= right[3]
            for left, right in zip(validated_modes, validated_modes[1:])
        )
        or matrix_id != expected_matrix
        or resolved != expected_resolved
        or value["targetPixelSizeMeters"] != target_pixel_size
        or not isinstance(quantiles, dict)
        or set(quantiles) != set(quantile_keys)
        or not all(_finite_positive(quantiles[key]) for key in quantile_keys)
        or any(
            quantiles[left] > quantiles[right]
            for left, right in zip(quantile_keys, quantile_keys[1:])
        )
    ):
        raise ValueError("Flow Field COG statistical resolution selection is invalid")
    return matrix_id, "statistically-selected"


def resolve_resolution(value: object | None) -> ResolutionSpec:
    if value is None:
        return StationSpacingResolution()
    if isinstance(value, (StationSpacingResolution, FixedWebMercatorResolution)):
        return value
    raise UnsupportedResolutionError(
        f"unsupported Flow Field resolution specification: {type(value).__name__}"
    )


def select_resolution(
    stations: np.ndarray,
    resolution: ResolutionSpec | None = None,
) -> SelectedResolution:
    strategy = resolve_resolution(resolution)
    coordinates = np.asarray(stations, dtype=np.float64)
    if coordinates.ndim != 2 or coordinates.shape[1] != 2:
        raise ValueError("station coordinates must have shape (station_count, 2)")
    if not np.isfinite(coordinates).all():
        raise ValueError("station coordinates must be finite")
    unique = np.unique(coordinates, axis=0)
    if unique.shape[0] < 3:
        raise ValueError("resolution selection requires at least three unique stations")
    source_station_count = int(coordinates.shape[0])
    unique_station_count = int(unique.shape[0])
    duplicate_station_count = source_station_count - unique_station_count
    if isinstance(strategy, FixedWebMercatorResolution):
        return FixedResolutionSelection(
            strategy=strategy,
            source_station_count=source_station_count,
            unique_station_count=unique_station_count,
            duplicate_station_count=duplicate_station_count,
            matrix_id=strategy.matrix_id,
            matrix_pixel_size_meters=web_mercator_matrix_pixel_size(strategy.matrix_id),
        )
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
    matrix_id = _select_matrix_for_target_pixel_size(
        target_pixel_size,
        minimum_matrix=strategy.minimum_matrix,
        maximum_matrix=strategy.maximum_matrix,
    )
    matrix_pixel_size = web_mercator_matrix_pixel_size(matrix_id)
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
        source_station_count=source_station_count,
        unique_station_count=unique_station_count,
        duplicate_station_count=duplicate_station_count,
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


def _select_matrix_for_target_pixel_size(
    target_pixel_size: float,
    *,
    minimum_matrix: int,
    maximum_matrix: int,
) -> int:
    if not _finite_positive(target_pixel_size):
        raise ValueError("target pixel size must be finite and positive")
    for matrix_id in range(minimum_matrix, maximum_matrix + 1):
        if web_mercator_matrix_pixel_size(matrix_id) <= target_pixel_size:
            return matrix_id
    raise ValueError("maximum_matrix is too coarse for the selected station spacing")


def _finite_positive(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and value > 0.0
    )


def _manifest_matrix_id(value: object) -> int:
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
        raise ValueError("matrixId must be an unsigned decimal string")
    matrix_id = int(value)
    if str(matrix_id) != value or not 0 <= matrix_id <= 24:
        raise ValueError("matrixId must identify a matrix in [0, 24]")
    return matrix_id


def _validate_station_counts(value: dict[str, Any], source_station_count: object) -> int:
    unique_station_count = value.get("uniqueStationCount")
    duplicate_station_count = value.get("duplicateStationCount")
    if (
        isinstance(source_station_count, bool)
        or not isinstance(source_station_count, int)
        or source_station_count < 3
        or value.get("sourceStationCount") != source_station_count
        or isinstance(unique_station_count, bool)
        or not isinstance(unique_station_count, int)
        or unique_station_count < 3
        or unique_station_count > source_station_count
        or isinstance(duplicate_station_count, bool)
        or not isinstance(duplicate_station_count, int)
        or duplicate_station_count != source_station_count - unique_station_count
    ):
        raise ValueError("Flow Field COG resolution station counts are invalid")
    return unique_station_count


def _validate_spacing_mode(
    value: object,
    *,
    unique_station_count: int,
) -> tuple[float, int, float, float]:
    expected_keys = {
        "peakCenterMeters",
        "effectiveSpacingMeters",
        "supportCount",
        "supportFraction",
        "prominenceRatio",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise ValueError("Flow Field COG statistical spacing mode is invalid")
    support_count = value["supportCount"]
    support_fraction = value["supportFraction"]
    prominence_ratio = value["prominenceRatio"]
    peak_center = value["peakCenterMeters"]
    effective_spacing = value["effectiveSpacingMeters"]
    if (
        not _finite_positive(peak_center)
        or not _finite_positive(effective_spacing)
        or isinstance(support_count, bool)
        or not isinstance(support_count, int)
        or support_count <= 0
        or support_count > unique_station_count
        or not _finite_positive_at_most_one(support_fraction)
        or support_fraction != support_count / unique_station_count
        or not _finite_positive_at_most_one(prominence_ratio)
    ):
        raise ValueError("Flow Field COG statistical spacing mode is invalid")
    return (
        float(effective_spacing),
        support_count,
        float(prominence_ratio),
        float(peak_center),
    )


def _finite_positive_at_most_one(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and 0.0 < value <= 1.0
    )


def _finite_unit_interval(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and 0.0 < value < 1.0
    )
