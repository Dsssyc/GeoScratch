from __future__ import annotations

from pathlib import Path
import runpy

import numpy as np
import pytest

from geoscratch_flow_field_tiles.cog_overviews import LEGACY_SEMANTIC_OVERVIEW_POLICY, reduce_semantic_overview
from geoscratch_flow_field_tiles.contracts import DelaunayTopology, TriangleLinearInterpolation
from geoscratch_flow_field_tiles.interpolation import prepare_triangle_linear_stencil
from geoscratch_flow_field_tiles.topology import prepare_topology


proof = runpy.run_path(str(Path(__file__).parents[1] / "proofs" / "uv_support_policy.py"))
reduce_uv = proof["reduce_nonexpanding_uv"]
gate = proof["sample_zero_gated_bilinear"]


def test_candidate_has_separate_identity_and_explicit_limits():
    manifest = proof["candidate_policy_manifest"]()
    assert manifest["candidateOnly"] is True
    assert manifest["candidateConstructionPolicyVersion"] == 3
    assert manifest["overviewPolicy"] != "recursive-conservative-vector-box-v1"
    assert "sub-base-pixel" in manifest["geometryLimit"]
    assert "bilinear" in manifest["frontendLimit"]


def test_no_extra_erosion_of_uniform_flow_or_neighboring_parent_cells():
    child = np.ones((10, 10, 2), dtype=np.float32)
    assert np.all(reduce_uv(child) == 1.0)
    child[4, 4] = 0.0
    actual = reduce_uv(child)
    assert np.count_nonzero(np.any(actual != 0.0, axis=2)) == 24
    assert np.array_equal(actual[2, 2], [0.0, 0.0])
    assert np.count_nonzero(reduce_semantic_overview(child, policy=LEGACY_SEMANTIC_OVERVIEW_POLICY).values) == 0


@pytest.mark.parametrize("width", [2, 4, 6])
def test_aligned_narrow_channel_survives_until_its_real_pixel_footprint_limit(width):
    child = np.zeros((32, 32, 2), dtype=np.float32)
    child[:, 12:12 + width, 0] = 1.0
    result = reduce_uv(child)
    assert np.count_nonzero(np.any(result != 0.0, axis=2)) == 16 * (width // 2)
    if width <= 4:
        assert np.count_nonzero(reduce_semantic_overview(child, policy=LEGACY_SEMANTIC_OVERVIEW_POLICY).values) == 0


@pytest.mark.parametrize("dry_column", [15, 16, 17, 31, 32])
def test_one_base_pixel_dry_separator_remains_zero_at_every_ancestor(dry_column):
    current = np.ones((64, 64, 2), dtype=np.float32)
    current[:, dry_column] = 0.0
    for level in range(1, 7):
        current = reduce_uv(current)
        assert np.all(current[:, dry_column // (2 ** level)] == 0.0)


def test_any_child_average_counterexample_would_revive_a_zero_separator():
    children = np.ones((8, 8, 2), dtype=np.float32)
    children[:, 3] = 0.0
    ordinary_mean = children.reshape(4, 2, 4, 2, 2).mean(axis=(1, 3))
    assert np.all(ordinary_mean[:, 1] != 0.0)
    assert np.all(reduce_uv(children)[:, 1] == 0.0)


def test_vector_cancellation_and_float32_underflow_never_revive():
    values = np.ones((8, 8, 2), dtype=np.float32)
    values[2:4, 2:4] = [[[1, 0], [-1, 0]], [[1, 0], [-1, 0]]]
    first = reduce_uv(values)
    assert np.array_equal(first[1, 1], [0, 0])
    assert np.array_equal(reduce_uv(first)[0, 0], [0, 0])
    tiny = np.nextafter(np.float32(0), np.float32(1))
    values = np.full((4, 4, 2), tiny, dtype=np.float32)
    values[1::2, 1::2] = -2 * tiny
    assert np.all(reduce_uv(values) == 0.0)
    assert not np.signbit(reduce_uv(values)).any()


def test_odd_edge_only_rejects_parent_footprints_with_missing_children():
    result = reduce_uv(np.ones((9, 9, 2), dtype=np.float32))
    assert result.shape == (5, 5, 2)
    assert np.all(result[:4, :4] == 1.0)
    assert np.all(result[-1] == 0.0)
    assert np.all(result[:, -1] == 0.0)


def test_every_nonzero_parent_has_only_nonzero_base_descendants():
    rng = np.random.default_rng(2701)
    base = np.ones((64, 64, 2), dtype=np.float32)
    base[rng.random((64, 64)) < 0.01] = 0.0
    current = base
    for level in range(1, 7):
        current = reduce_uv(current)
        factor = 2 ** level
        support = np.any(base != 0.0, axis=2).reshape(
            64 // factor, factor, 64 // factor, factor
        ).all(axis=(1, 3))
        assert np.array_equal(np.any(current != 0.0, axis=2), support)


@pytest.mark.parametrize("values", [
    np.ones((0, 4, 2)), np.ones((4, 4)), np.full((4, 4, 2), np.nan),
    np.full((4, 4, 2), np.inf),
])
def test_invalid_values_are_not_silently_treated_as_dry(values):
    with pytest.raises(ValueError):
        reduce_uv(values)


def test_ordinary_linear_base_does_not_discard_a_triangle_with_one_zero_vertex():
    topology = prepare_topology(np.array([[0, 0], [.1, 0], [0, .1]]),
        DelaunayTopology(maximum_edge_ratio=None, maximum_edge_length_meters=None))
    stencil = prepare_triangle_linear_stencil(topology, np.array([.025]), np.array([.025]),
        TriangleLinearInterpolation(stationary_policy="require-all-moving"))
    values = topology.aggregate_field(np.array([[0, 0], [2, 0], [0, 2]]))
    linear = proof["sample_tin_centers"](stencil, values, all_moving=False)
    conservative = proof["sample_tin_centers"](stencil, values, all_moving=True)
    assert linear[0] == pytest.approx([.5, .5], rel=1e-5)
    assert np.all(conservative == 0.0)


def test_nearest_texel_gate_preserves_the_whole_single_pixel_dry_footprint():
    values = np.ones((8, 8, 2), dtype=np.float32)
    values[:, 3] = 0.0
    xy = np.column_stack((np.linspace(2.5, 3.5, 101, endpoint=False), np.full(101, 3.2)))
    assert np.all(gate(values, xy) == 0.0)
    assert np.all(gate(values, np.array([[2.49, 3.2], [3.5, 3.2]])) > 0.0)
    # Every coarser stored zero has a complete zero footprint too.
    coarser = reduce_uv(values)
    xy[:, 0] = np.linspace(.5, 1.5, 101, endpoint=False)
    xy[:, 1] = 1.2
    assert np.all(gate(coarser, xy) == 0.0)


def test_gate_preserves_zero_cells_but_does_not_invent_an_unsampled_dry_barrier():
    # A geometric dry slit between all-wet centers is not encoded in these UVs.
    # Neither reconstruction nor a zero gate can recover that missing authority.
    values = np.ones((4, 4, 2), dtype=np.float32)
    assert np.all(gate(values, np.array([[1.5, 1.5]])) == 1.0)
    assert np.all(gate(values, np.array([[-.51, 1], [3.5, 1]])) == 0.0)
    assert np.all(gate(values, np.array([[-.5, 1], [3.49, 1]])) == 1.0)


def test_zero_gate_does_not_renormalize_velocity_near_a_supported_edge():
    values = np.ones((4, 4, 2), dtype=np.float32)
    values[:, 2] = 0.0
    assert gate(values, np.array([[1.25, 1.0]]))[0] == pytest.approx([.75, .75])
