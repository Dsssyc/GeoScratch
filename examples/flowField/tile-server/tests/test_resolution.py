from __future__ import annotations

import copy

import numpy as np
import pytest
import geoscratch_flow_field_tiles.resolution as resolution_module

from geoscratch_flow_field_tiles import (
    FixedWebMercatorResolution,
    StationSpacingResolution,
    UnsupportedResolutionError,
)
from geoscratch_flow_field_tiles.resolution import (
    _select_matrix_for_target_pixel_size,
    resolve_resolution,
    select_resolution,
    validate_resolution_selection_manifest,
    web_mercator_matrix_pixel_size,
)


def _regular_grid(spacing_degrees: float, size: int = 12) -> np.ndarray:
    x, y = np.meshgrid(
        120.0 + np.arange(size) * spacing_degrees,
        31.0 + np.arange(size) * spacing_degrees,
    )
    return np.column_stack((x.reshape(-1), y.reshape(-1)))


def _test_strategy(**changes) -> StationSpacingResolution:
    values = {
        "minimum_support_points": 16,
        "minimum_support_fraction": 0.05,
    }
    values.update(changes)
    return StationSpacingResolution(**values)


def test_supported_mode_ignores_duplicates_and_subthreshold_close_outliers():
    stations = _regular_grid(0.001)
    contaminated = np.vstack((
        stations,
        stations[0],
        stations[:4] + [1.0e-8, 0.0],
    ))

    reference = select_resolution(stations, _test_strategy())
    selection = select_resolution(contaminated, _test_strategy())

    assert selection.duplicate_station_count == 1
    assert selection.matrix_id == reference.matrix_id
    assert selection.effective_spacing_meters == pytest.approx(
        reference.effective_spacing_meters,
        rel=0.03,
    )


def test_selection_is_invariant_to_station_order():
    stations = _regular_grid(0.002)
    permutation = np.random.default_rng(20260827).permutation(stations.shape[0])

    first = select_resolution(stations, _test_strategy())
    second = select_resolution(stations[permutation], _test_strategy())

    assert first == second


def test_fixed_web_mercator_resolution_skips_spacing_statistics(monkeypatch):
    class UnexpectedTree:
        def __init__(self, _points):
            raise AssertionError("fixed resolution must not construct a spacing tree")

    monkeypatch.setattr(resolution_module, "cKDTree", UnexpectedTree)
    stations = np.vstack((_regular_grid(0.001), _regular_grid(0.001)[0]))

    selection = select_resolution(stations, FixedWebMercatorResolution(10))

    assert selection.matrix_id == 10
    assert selection.matrix_pixel_size_meters == web_mercator_matrix_pixel_size(10)
    assert selection.source_station_count == 145
    assert selection.unique_station_count == 144
    assert selection.duplicate_station_count == 1
    assert selection.manifest() == {
        "requested": {
            "kind": "fixed-web-mercator-matrix",
            "matrixSet": "WebMercatorQuad",
            "matrixId": "10",
        },
        "resolved": {
            "matrixSet": "WebMercatorQuad",
            "matrixId": "10",
            "matrixPixelSizeMeters": web_mercator_matrix_pixel_size(10),
        },
        "sourceStationCount": 145,
        "uniqueStationCount": 144,
        "duplicateStationCount": 1,
    }
    assert selection.matrix_relation == "explicitly-requested"


def test_supported_nested_fine_grid_resolves_a_finer_matrix():
    coarse = _regular_grid(0.004, 16)
    fine = _regular_grid(0.0005, 10) + [0.02, 0.02]
    strategy = _test_strategy(minimum_support_fraction=0.10)

    nested = select_resolution(np.vstack((coarse, fine)), strategy)
    coarse_only = select_resolution(coarse, strategy)

    assert nested.effective_spacing_meters < coarse_only.effective_spacing_meters
    assert nested.matrix_id > coarse_only.matrix_id


def test_selected_matrix_is_not_coarser_than_the_target_pixel_size():
    selection = select_resolution(_regular_grid(0.001), _test_strategy())

    assert selection.matrix_pixel_size_meters <= selection.target_pixel_size_meters
    if selection.matrix_id > selection.strategy.minimum_matrix:
        assert web_mercator_matrix_pixel_size(selection.matrix_id - 1) > (
            selection.target_pixel_size_meters
        )


def test_matrix_selection_is_exact_at_adjacent_float_thresholds():
    for matrix_id in range(24):
        threshold = web_mercator_matrix_pixel_size(matrix_id)
        assert _select_matrix_for_target_pixel_size(
            threshold,
            minimum_matrix=0,
            maximum_matrix=24,
        ) == matrix_id
        assert _select_matrix_for_target_pixel_size(
            np.nextafter(threshold, 0.0),
            minimum_matrix=0,
            maximum_matrix=24,
        ) == matrix_id + 1
        assert _select_matrix_for_target_pixel_size(
            np.nextafter(threshold, np.inf),
            minimum_matrix=0,
            maximum_matrix=24,
        ) == matrix_id

    with pytest.raises(ValueError, match="maximum_matrix"):
        _select_matrix_for_target_pixel_size(
            np.nextafter(web_mercator_matrix_pixel_size(24), 0.0),
            minimum_matrix=0,
            maximum_matrix=24,
        )


def test_selection_rejects_a_flat_histogram_without_a_prominent_mode(monkeypatch):
    station_count = 32
    width = 1.0 / 16.0
    nearest = 2.0 ** ((np.arange(station_count, dtype=np.float64) + 0.5) * width)

    class FlatSpacingTree:
        def __init__(self, _points):
            pass

        def query(self, points, *, k, workers):
            assert points.shape[0] == station_count
            assert k == 2
            assert workers == -1
            return np.column_stack((np.zeros(station_count), nearest)), None

    monkeypatch.setattr(resolution_module, "cKDTree", FlatSpacingTree)
    stations = np.column_stack((
        np.linspace(120.0, 121.0, station_count),
        np.linspace(31.0, 32.0, station_count),
    ))

    with pytest.raises(ValueError, match="no statistically supported"):
        select_resolution(
            stations,
            StationSpacingResolution(
                minimum_support_points=1,
                minimum_support_fraction=0.01,
            ),
        )


def test_resolution_manifest_freezes_the_supported_mode_algorithm():
    requested = _test_strategy().manifest()

    assert requested["distanceSpace"] == "EPSG:3857"
    assert requested["localSpacingStatistic"] == "nearest-non-self"
    assert requested["histogramScale"] == "log2-meters"
    assert requested["histogramAnchorMeters"] == 1.0
    assert requested["smoothingKernelWeights"] == [1, 4, 6, 4, 1]
    assert requested["smoothingKernelDivisor"] == 16
    assert requested["peakSelection"] == "leftmost-supported"


def test_statistical_manifest_validator_rejects_self_consistent_false_evidence():
    stations = _regular_grid(0.001)
    manifest = select_resolution(stations, _test_strategy()).manifest()
    assert validate_resolution_selection_manifest(
        manifest,
        source_station_count=stations.shape[0],
    )[1] == "statistically-selected"

    false_fraction = copy.deepcopy(manifest)
    false_fraction["selectedMode"]["supportFraction"] = 0.5
    false_fraction["candidateModes"][0]["supportFraction"] = 0.5
    with pytest.raises(ValueError, match="statistical"):
        validate_resolution_selection_manifest(
            false_fraction,
            source_station_count=stations.shape[0],
        )

    false_prominence = copy.deepcopy(manifest)
    false_prominence["selectedMode"]["prominenceRatio"] = 0.01
    false_prominence["candidateModes"][0]["prominenceRatio"] = 0.01
    with pytest.raises(ValueError, match="statistical"):
        validate_resolution_selection_manifest(
            false_prominence,
            source_station_count=stations.shape[0],
        )

    clipped_too_coarse = copy.deepcopy(manifest)
    spacing = clipped_too_coarse["selectedMode"]["effectiveSpacingMeters"]
    z0_pixel_size = web_mercator_matrix_pixel_size(0)
    clipped_too_coarse["requested"]["maximumMatrix"] = 0
    clipped_too_coarse["resolved"] = {
        "matrixSet": "WebMercatorQuad",
        "matrixId": "0",
        "matrixPixelSizeMeters": z0_pixel_size,
        "resolvedSamplesPerSpacing": spacing / z0_pixel_size,
    }
    with pytest.raises(ValueError, match="statistical"):
        validate_resolution_selection_manifest(
            clipped_too_coarse,
            source_station_count=stations.shape[0],
        )

    for tiny_spacing in (5.0e-324, 1.0e-323):
        underflowed = copy.deepcopy(manifest)
        underflowed["selectedMode"]["effectiveSpacingMeters"] = tiny_spacing
        underflowed["candidateModes"][0]["effectiveSpacingMeters"] = tiny_spacing
        with pytest.raises(ValueError):
            validate_resolution_selection_manifest(
                underflowed,
                source_station_count=stations.shape[0],
            )


def test_resolution_contract_rejects_invalid_and_unimplemented_modes():
    assert resolve_resolution(None) == StationSpacingResolution()
    with pytest.raises(ValueError, match="histogram_bin_width_octaves"):
        StationSpacingResolution(histogram_bin_width_octaves=0.0)
    with pytest.raises(ValueError, match="minimum_support_fraction"):
        StationSpacingResolution(minimum_support_fraction=1.0)
    with pytest.raises(ValueError, match="samples_per_spacing"):
        StationSpacingResolution(samples_per_spacing=0.0)
    for matrix_id in (True, -1, 25, 10.0):
        with pytest.raises(ValueError, match="matrix_id"):
            FixedWebMercatorResolution(matrix_id)  # type: ignore[arg-type]
    with pytest.raises(UnsupportedResolutionError) as error:
        resolve_resolution({"kind": "minimum-distance"})

    assert error.value.code == "UNSUPPORTED_RESOLUTION"
