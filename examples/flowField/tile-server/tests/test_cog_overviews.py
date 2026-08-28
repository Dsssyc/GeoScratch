from __future__ import annotations

import numpy as np
import pytest

from geoscratch_flow_field_tiles.cog_overviews import (
    plan_semantic_overview_levels,
    reduce_semantic_overview,
)


def test_overview_plan_reduces_the_real_grid_to_one_cog_block():
    levels = plan_semantic_overview_levels(
        70_400,
        77_056,
        (4.777314267823516, 0.0, 13_362_415.536701374,
         0.0, -4.777314267823516, 3_798_614.5576601196),
        block_size=256,
    )

    assert [level.nominal_factor for level in levels] == [
        2, 4, 8, 16, 32, 64, 128, 256, 512,
    ]
    assert [(level.width, level.height) for level in levels][-2:] == [
        (275, 301),
        (138, 151),
    ]
    assert levels[-1].effective_decimation_x == pytest.approx(70_400 / 138)
    assert levels[-1].effective_decimation_y == pytest.approx(77_056 / 151)
    assert levels[-1].width <= 256
    assert levels[-1].height <= 256


def test_all_valid_children_are_averaged_then_eroded_for_bilinear_safety():
    child = np.empty((10, 10, 2), dtype=np.float32)
    child[..., 0] = np.arange(100, dtype=np.float32).reshape(10, 10) + 1.0
    child[..., 1] = 2.0

    reduced = reduce_semantic_overview(child)

    assert reduced.values.shape == (5, 5, 2)
    assert reduced.candidate_valid_count == 25
    assert reduced.bilinear_safe_count == 9
    assert reduced.cancellation_to_zero_count == 0
    assert np.array_equal(reduced.values[0], np.zeros((5, 2), dtype=np.float32))
    assert np.array_equal(reduced.values[-1], np.zeros((5, 2), dtype=np.float32))
    assert reduced.values[2, 2] == pytest.approx([50.5, 2.0])


def test_one_invalid_child_erodes_the_neighboring_parent_footprint():
    child = np.ones((10, 10, 2), dtype=np.float32)
    child[4, 4] = 0.0

    reduced = reduce_semantic_overview(child)

    assert reduced.candidate_valid_count == 24
    assert reduced.bilinear_safe_count == 0
    assert np.array_equal(reduced.values, np.zeros((5, 5, 2), dtype=np.float32))
    assert not np.signbit(reduced.values).any()


def test_vector_cancellation_becomes_non_advectable_and_cannot_revive():
    child = np.ones((10, 10, 2), dtype=np.float32)
    child[4:6, 4:6] = np.asarray([
        [[1.0, 0.0], [-1.0, 0.0]],
        [[1.0, 0.0], [-1.0, 0.0]],
    ], dtype=np.float32)

    reduced = reduce_semantic_overview(child)

    assert reduced.cancellation_to_zero_count == 1
    assert reduced.candidate_valid_count == 24
    assert np.array_equal(reduced.values[2, 2], [0.0, 0.0])
    assert not np.signbit(reduced.values).any()


def test_odd_missing_edge_children_are_invalid():
    child = np.ones((9, 9, 2), dtype=np.float32)

    reduced = reduce_semantic_overview(child)

    assert reduced.values.shape == (5, 5, 2)
    assert reduced.candidate_valid_count == 16
    assert reduced.bilinear_safe_count == 4
    assert np.array_equal(reduced.values[-1], np.zeros((5, 2), dtype=np.float32))
    assert np.array_equal(reduced.values[:, -1], np.zeros((5, 2), dtype=np.float32))


def test_overview_contract_rejects_nonfinite_and_invalid_shapes():
    with pytest.raises(ValueError, match="shape"):
        reduce_semantic_overview(np.ones((4, 4), dtype=np.float32))
    values = np.ones((4, 4, 2), dtype=np.float32)
    values[0, 0, 0] = np.nan
    with pytest.raises(ValueError, match="finite"):
        reduce_semantic_overview(values)
    with pytest.raises(ValueError, match="block_size"):
        plan_semantic_overview_levels(
            256,
            256,
            (1.0, 0.0, 0.0, 0.0, -1.0, 256.0),
            block_size=0,
        )
