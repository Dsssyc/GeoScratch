from __future__ import annotations

import numpy as np
import pytest

from geoscratch_flow_field_tiles import DelaunayTopology
from geoscratch_flow_field_tiles.topology import (
    DegenerateTopologyError,
    DuplicateStationError,
    prepare_topology,
)


def test_duplicate_policy_is_explicit_and_mean_preserves_both_uv_components():
    stations = np.asarray([
        [120.0, 31.0],
        [120.0, 31.0],
        [120.1, 31.0],
        [120.0, 31.1],
    ])
    field = np.asarray([[0, 2], [4, 6], [8, 10], [12, 14]], dtype=np.float32)

    with pytest.raises(DuplicateStationError):
        prepare_topology(stations)
    prepared = prepare_topology(
        stations,
        DelaunayTopology(duplicate_policy="mean", maximum_edge_ratio=None),
    )

    assert prepared.source_station_count == 4
    assert prepared.vertex_count == 3
    assert np.array_equal(
        prepared.aggregate_field(field),
        np.asarray([[2, 4], [12, 14], [8, 10]], dtype=np.float64),
    )


def test_topology_rejects_non_finite_and_collinear_coordinates():
    with pytest.raises(ValueError, match="finite"):
        prepare_topology(np.asarray([[120, 31], [121, np.nan], [122, 32]]))
    with pytest.raises(DegenerateTopologyError, match="collinear"):
        prepare_topology(np.asarray([[120, 31], [121, 31], [122, 31]]))


def test_hard_metric_cap_rejects_delaunay_bridges_between_distant_clusters():
    stations = np.asarray([
        [120.000, 31.000],
        [120.005, 31.000],
        [120.000, 31.005],
        [121.000, 31.000],
        [121.005, 31.000],
        [121.000, 31.005],
    ])
    prepared = prepare_topology(
        stations,
        DelaunayTopology(
            maximum_edge_ratio=None,
            maximum_edge_length_meters=2_000,
        ),
    )

    assert prepared.accepted_triangle_count == 2
    assert np.count_nonzero(prepared.bridge_rejected_simplices) > 0


def test_canonical_connectivity_is_stable_under_station_permutation():
    stations = np.asarray([
        [120.000, 31.000],
        [120.013, 31.002],
        [120.004, 31.017],
        [120.020, 31.021],
        [120.027, 31.009],
    ])
    spec = DelaunayTopology(maximum_edge_ratio=None)
    first = prepare_topology(stations, spec)
    second = prepare_topology(stations[[3, 0, 4, 1, 2]], spec)

    assert first.connectivity_sha256 == second.connectivity_sha256
    assert first.triangle_count == second.triangle_count

    field = np.column_stack((stations[:, 0] - 120.0, stations[:, 1] - 31.0))
    permutation = np.asarray([3, 0, 4, 1, 2])
    assert np.allclose(
        first.aggregate_field(field),
        second.aggregate_field(field[permutation]),
    )


def test_velocity_field_validation_happens_before_interpolation():
    stations = np.asarray([[120, 31], [120.1, 31], [120, 31.1]])
    prepared = prepare_topology(
        stations,
        DelaunayTopology(maximum_edge_ratio=None),
    )

    with pytest.raises(ValueError, match="one U/V pair"):
        prepared.aggregate_field(np.ones((2, 2)))
    with pytest.raises(ValueError, match="finite"):
        prepared.aggregate_field(np.asarray([[1, 2], [3, np.nan], [5, 6]]))
