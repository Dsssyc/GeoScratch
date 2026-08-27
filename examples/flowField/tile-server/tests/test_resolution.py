from __future__ import annotations

import numpy as np
import pytest

from geoscratch_flow_field_tiles import (
    StationSpacingResolution,
    UnsupportedResolutionError,
)
from geoscratch_flow_field_tiles.resolution import (
    resolve_resolution,
    select_resolution,
    web_mercator_matrix_pixel_size,
)


def _regular_grid(spacing_degrees: float, size: int = 8) -> np.ndarray:
    x, y = np.meshgrid(
        120.0 + np.arange(size) * spacing_degrees,
        31.0 + np.arange(size) * spacing_degrees,
    )
    return np.column_stack((x.reshape(-1), y.reshape(-1)))


def test_default_selection_uses_a_robust_local_spacing_quantile():
    stations = _regular_grid(0.001)
    stations = np.vstack((stations, stations[0], stations[0] + [1.0e-8, 0.0]))

    selection = select_resolution(stations)

    assert selection.source_station_count == 66
    assert selection.unique_station_count == 65
    assert selection.duplicate_station_count == 1
    assert selection.effective_spacing_meters > 50.0
    assert selection.target_pixel_size_meters == pytest.approx(
        selection.effective_spacing_meters / 2.0
    )
    assert selection.matrix_pixel_size_meters == web_mercator_matrix_pixel_size(
        selection.matrix_id
    )


def test_selection_is_invariant_to_station_order():
    stations = _regular_grid(0.002)
    permutation = np.random.default_rng(20260827).permutation(stations.shape[0])

    first = select_resolution(stations)
    second = select_resolution(stations[permutation])

    assert first == second


def test_lower_spacing_quantile_resolves_a_finer_matrix():
    coarse = _regular_grid(0.004, 12)
    fine = _regular_grid(0.0005, 6) + [0.01, 0.01]
    stations = np.vstack((coarse, fine))

    lower = select_resolution(
        stations,
        StationSpacingResolution(spacing_quantile=0.10),
    )
    median = select_resolution(
        stations,
        StationSpacingResolution(spacing_quantile=0.50),
    )

    assert lower.effective_spacing_meters < median.effective_spacing_meters
    assert lower.matrix_id > median.matrix_id


def test_resolution_contract_rejects_invalid_and_unimplemented_modes():
    with pytest.raises(ValueError, match="neighbor_count"):
        StationSpacingResolution(neighbor_count=1)
    with pytest.raises(ValueError, match="spacing_quantile"):
        StationSpacingResolution(spacing_quantile=1.0)
    with pytest.raises(ValueError, match="samples_per_spacing"):
        StationSpacingResolution(samples_per_spacing=0.0)
    with pytest.raises(UnsupportedResolutionError) as error:
        resolve_resolution({"kind": "minimum-distance"})

    assert error.value.code == "UNSUPPORTED_RESOLUTION"
