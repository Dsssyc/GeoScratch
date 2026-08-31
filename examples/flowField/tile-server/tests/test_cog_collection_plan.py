from __future__ import annotations

import pytest

from geoscratch_flow_field_tiles.cog import CogBuildBudget
from geoscratch_flow_field_tiles.collection import (
    CogCollectionBudget,
    canonical_time_indices,
    parse_time_indices,
    parse_time_range,
    plan_velocity_cog_collection,
)
from geoscratch_flow_field_tiles.resolution import StationSpacingResolution


def _resolution() -> StationSpacingResolution:
    return StationSpacingResolution(
        minimum_support_points=3,
        minimum_support_fraction=0.10,
        minimum_matrix=9,
        maximum_matrix=9,
    )


def _snapshot_budget() -> CogBuildBudget:
    return CogBuildBudget(
        max_blocks=128,
        max_raw_pyramid_bytes=256 * 1024 * 1024,
        max_staged_bytes=64 * 1024 * 1024,
        minimum_free_bytes=32 * 1024 * 1024,
    )


def test_time_selection_is_explicit_unique_bounded_and_canonical():
    assert canonical_time_indices((1, 0), 2) == (0, 1)
    assert parse_time_indices("1,0", 2) == (0, 1)
    assert parse_time_range("0:2", 2) == (0, 1)

    for value in ((), (0, 0), (-1,), (2,), (True,)):
        with pytest.raises(ValueError):
            canonical_time_indices(value, 2)
    for value in ("", "0,", "0, 1", "zero"):
        with pytest.raises(ValueError):
            parse_time_indices(value, 2)
    for value in ("0", ":2", "0:", "1:1", "2:1", "-1:1", "0:3"):
        with pytest.raises(ValueError):
            parse_time_range(value, 2)


def test_collection_plan_binds_selection_and_requires_compressed_estimate(
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "cog-collection"
    missing_estimate = plan_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=CogCollectionBudget(max_collection_bytes=1024**3),
    )
    planned = plan_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(1, 0),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=CogCollectionBudget(
            max_collection_bytes=1024**3,
            estimated_snapshot_bytes=4 * 1024 * 1024,
        ),
    )

    assert not missing_estimate.budget.approved
    assert missing_estimate.budget.violations == (
        "compressed snapshot estimate is required for multi-time output",
    )
    assert planned.budget.approved
    assert planned.time_indices == (0, 1)
    assert planned.coverage == "full"
    assert planned.snapshot_plan.grid.matrix_id == 9
    assert planned.request_facts["selection"] == {
        "timeIndices": [0, 1],
        "coverage": "full",
    }
    planned.require_output_approved()


def test_collection_plan_rejects_capacity_without_lowering_resolution(
    synthetic_source,
    tmp_path,
):
    plan = plan_velocity_cog_collection(
        synthetic_source.directory,
        tmp_path / "cog-collection",
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=CogCollectionBudget(
            max_collection_bytes=1,
            estimated_snapshot_bytes=4 * 1024 * 1024,
        ),
    )

    assert not plan.budget.approved
    assert plan.snapshot_plan.grid.matrix_id == 9
    with pytest.raises(ValueError, match="collection byte budget"):
        plan.require_output_approved()
