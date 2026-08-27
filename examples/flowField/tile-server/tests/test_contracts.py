from __future__ import annotations

import pytest

from geoscratch_flow_field_tiles import (
    DelaunayTopology,
    TriangleLinearInterpolation,
    UnsupportedInterpolationError,
    UnsupportedTopologyError,
)
from geoscratch_flow_field_tiles.contracts import (
    read_interpolation_spec,
    read_topology_spec,
    resolve_interpolation,
    resolve_topology,
)


def test_omitted_strategies_permanently_resolve_to_delaunay_triangle_linear():
    assert resolve_topology(None) == DelaunayTopology()
    assert resolve_interpolation(None) == TriangleLinearInterpolation()


def test_source_specs_round_trip_as_typed_public_contracts():
    topology = read_topology_spec({
        "kind": "delaunay",
        "duplicatePolicy": "mean",
        "localSpacingNeighbors": 6,
        "maximumEdgeRatio": 12.0,
        "maximumEdgeLengthMeters": 5_000.0,
    })
    interpolation = read_interpolation_spec({"kind": "triangle-linear"})

    assert topology.manifest() == {
        "kind": "delaunay",
        "duplicatePolicy": "mean",
        "localSpacingNeighbors": 6,
        "maximumEdgeRatio": 12.0,
        "maximumEdgeLengthMeters": 5_000.0,
    }
    assert interpolation.manifest() == {"kind": "triangle-linear"}


def test_unimplemented_strategies_fail_instead_of_falling_back():
    with pytest.raises(UnsupportedTopologyError) as topology_error:
        resolve_topology({"kind": "rectilinear"})
    with pytest.raises(UnsupportedInterpolationError) as interpolation_error:
        resolve_interpolation({"kind": "bilinear"})

    assert topology_error.value.code == "UNSUPPORTED_TOPOLOGY"
    assert interpolation_error.value.code == "UNSUPPORTED_INTERPOLATION"


@pytest.mark.parametrize(
    ("arguments", "message"),
    (
        ({"duplicate_policy": "drop"}, "duplicate_policy"),
        ({"local_spacing_neighbors": 1}, "local_spacing_neighbors"),
        ({"maximum_edge_ratio": 1.0}, "maximum_edge_ratio"),
        ({"maximum_edge_length_meters": 0.0}, "maximum_edge_length_meters"),
    ),
)
def test_delaunay_configuration_is_validated_at_the_api_boundary(arguments, message):
    with pytest.raises(ValueError, match=message):
        DelaunayTopology(**arguments)
