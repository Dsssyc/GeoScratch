from __future__ import annotations

import numpy as np

from geoscratch_flow_field_tiles import DelaunayTopology
from geoscratch_flow_field_tiles.interpolation import (
    prepare_triangle_linear_stencil,
)
from geoscratch_flow_field_tiles.topology import prepare_topology
from geoscratch_flow_field_tiles.topology import project_lon_lat


def _affine_field(stations: np.ndarray) -> np.ndarray:
    projected = project_lon_lat(stations)
    origin = project_lon_lat(np.asarray([[120.0, 31.0]]))[0]
    x = (projected[:, 0] - origin[0]) / 10_000.0
    y = (projected[:, 1] - origin[1]) / 10_000.0
    return np.column_stack((
        2.0 * x - 3.0 * y + 4.0,
        -x + 5.0 * y - 2.0,
    ))


def test_triangle_linear_reproduces_affine_values_and_uses_convex_weights():
    stations = np.asarray([
        [120.00, 31.00],
        [120.10, 31.00],
        [120.00, 31.10],
    ])
    topology = prepare_topology(
        stations,
        DelaunayTopology(maximum_edge_ratio=None),
    )
    targets = np.asarray([[120.02, 31.03], [120.04, 31.01]])
    stencil = prepare_triangle_linear_stencil(
        topology,
        targets[:, 0],
        targets[:, 1],
    )

    expected = _affine_field(targets).astype(np.float32)
    assert np.allclose(
        stencil.apply(topology, _affine_field(stations)),
        expected,
        rtol=1e-6,
        atol=1e-6,
    )
    assert np.all(stencil.weights >= 0.0)
    assert np.allclose(stencil.weights.sum(axis=1), 1.0)


def test_outside_and_rejected_targets_lower_to_exact_positive_zero():
    stations = np.asarray([
        [120.000, 31.000],
        [120.005, 31.000],
        [120.000, 31.005],
        [121.000, 31.000],
        [121.005, 31.000],
        [121.000, 31.005],
    ])
    topology = prepare_topology(
        stations,
        DelaunayTopology(
            maximum_edge_ratio=None,
            maximum_edge_length_meters=2_000,
        ),
    )
    targets = np.asarray([
        [119.0, 30.0],
        [120.5, 31.001],
    ])
    stencil = prepare_triangle_linear_stencil(
        topology,
        targets[:, 0],
        targets[:, 1],
    )
    result = stencil.apply(topology, np.ones((stations.shape[0], 2)))

    assert stencil.outside_target_count == 1
    assert stencil.rejected_target_count == 1
    assert np.array_equal(result, np.zeros((2, 2), dtype=np.float32))
    assert not np.signbit(result).any()


def test_same_stencil_is_reused_for_multiple_velocity_times():
    stations = np.asarray([
        [120.00, 31.00],
        [120.10, 31.00],
        [120.00, 31.10],
    ])
    topology = prepare_topology(
        stations,
        DelaunayTopology(maximum_edge_ratio=None),
    )
    stencil = prepare_triangle_linear_stencil(
        topology,
        np.asarray([120.02]),
        np.asarray([31.03]),
    )

    first = stencil.apply(topology, np.ones((3, 2)))
    second = stencil.apply(topology, np.full((3, 2), 2.0))

    assert np.array_equal(first, np.ones((1, 2), dtype=np.float32))
    assert np.array_equal(second, np.full((1, 2), 2.0, dtype=np.float32))


def test_duplicate_mean_is_applied_before_barycentric_interpolation():
    stations = np.asarray([
        [120.0, 31.0],
        [120.0, 31.0],
        [120.1, 31.0],
        [120.0, 31.1],
    ])
    topology = prepare_topology(
        stations,
        DelaunayTopology(duplicate_policy="mean", maximum_edge_ratio=None),
    )
    stencil = prepare_triangle_linear_stencil(
        topology,
        np.asarray([120.0]),
        np.asarray([31.0]),
    )
    field = np.asarray([[0, 2], [4, 6], [8, 10], [12, 14]])

    assert np.allclose(stencil.apply(topology, field), [[2, 4]])
