from __future__ import annotations

import numpy as np
import pytest
from rasterio.transform import Affine

from geoscratch_flow_field_tiles.cog import (
    CogBuildBudget,
    CogEncoding,
    _cog_pixel_centers_window,
    _cog_grid,
    build_velocity_cog_snapshot,
    plan_velocity_cog_snapshot,
)
from geoscratch_flow_field_tiles.resolution import StationSpacingResolution
from geoscratch_flow_field_tiles.topology import project_lon_lat


def _resolution_for_tests() -> StationSpacingResolution:
    return StationSpacingResolution(
        minimum_support_points=3,
        minimum_support_fraction=0.10,
    )


def test_tile_aligned_cog_grid_has_exact_block_and_raw_byte_facts(synthetic_source):
    grid = _cog_grid((120.9275, 31.6900, 120.9475, 31.7100), 9)

    assert grid.width % 256 == 0
    assert grid.height % 256 == 0
    assert grid.raw_bytes == grid.width * grid.height * 2 * 4
    assert grid.transform[0] > 0
    assert grid.transform[4] < 0


def test_default_statistical_matrix_can_fail_budget_without_silent_coarsening(
    synthetic_source,
    tmp_path,
):
    plan = plan_velocity_cog_snapshot(
        synthetic_source.stations,
        (
            float(synthetic_source.stations[:, 0].min()),
            float(synthetic_source.stations[:, 1].min()),
            float(synthetic_source.stations[:, 0].max()),
            float(synthetic_source.stations[:, 1].max()),
        ),
        tmp_path,
        resolution=_resolution_for_tests(),
        budget=CogBuildBudget(max_blocks=1),
    )

    assert plan.matrix_override is None
    assert plan.grid == plan.selected_grid
    assert not plan.output_budget.approved
    assert plan.output_budget.violations[0].startswith("block budget")
    with pytest.raises(ValueError, match="block budget"):
        plan.require_output_approved()


def test_explicit_matrix_override_is_visible_and_budgeted(
    synthetic_source,
    tmp_path,
):
    plan = plan_velocity_cog_snapshot(
        synthetic_source.stations,
        (
            float(synthetic_source.stations[:, 0].min()),
            float(synthetic_source.stations[:, 1].min()),
            float(synthetic_source.stations[:, 0].max()),
            float(synthetic_source.stations[:, 1].max()),
        ),
        tmp_path,
        resolution=_resolution_for_tests(),
        matrix_override=9,
    )

    assert plan.matrix_override == 9
    assert plan.grid.matrix_id == 9
    manifest = plan.manifest()
    assert manifest["resolution"]["resolved"]["matrixId"] != "9"
    assert manifest["selectedGrid"] == plan.selected_grid.manifest()
    assert manifest["matrixDecision"] == {
        "selectedMatrixId": str(plan.selection.matrix_id),
        "outputMatrixId": "9",
        "relation": "finer-explicit-override",
    }
    assert manifest["preflight"]["output"]["approved"]


def test_build_enforces_a_rejected_default_plan_without_writing(
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "cog-cache"

    with pytest.raises(ValueError, match="block budget"):
        build_velocity_cog_snapshot(
            synthetic_source.directory,
            output,
            time_index=0,
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_resolution_for_tests(),
            budget=CogBuildBudget(max_blocks=1),
        )

    assert not output.exists()


def test_cog_windows_use_affine_pixel_centers_and_share_tile_halos():
    grid = _cog_grid((120.9275, 31.6900, 120.9475, 31.7100), 9)
    longitudes, latitudes = _cog_pixel_centers_window(
        grid.matrix_id,
        grid.min_tile_row,
        grid.min_tile_col,
        padding=0,
    )
    projected = project_lon_lat(np.column_stack((longitudes[:1], latitudes[:1])))[0]
    expected_x, expected_y = Affine(*grid.transform) * (0.5, 0.5)

    assert projected == pytest.approx((expected_x, expected_y), abs=1.0e-7)

    left_lon, left_lat = _cog_pixel_centers_window(
        grid.matrix_id,
        grid.min_tile_row,
        grid.min_tile_col,
        padding=1,
    )
    right_lon, right_lat = _cog_pixel_centers_window(
        grid.matrix_id,
        grid.min_tile_row,
        grid.min_tile_col + 1,
        padding=1,
    )
    side = 258
    left_lon = left_lon.reshape(side, side)
    left_lat = left_lat.reshape(side, side)
    right_lon = right_lon.reshape(side, side)
    right_lat = right_lat.reshape(side, side)

    assert np.array_equal(left_lon[:, -1], right_lon[:, 1])
    assert np.array_equal(left_lon[:, -2], right_lon[:, 0])
    assert np.array_equal(left_lat, right_lat)


def test_cog_grid_rejects_invalid_webmercator_bounds():
    with pytest.raises(ValueError, match="longitude"):
        _cog_grid((121.0, 31.0, 120.0, 32.0), 9)
    with pytest.raises(ValueError, match="WebMercator"):
        _cog_grid((120.0, -90.0, 121.0, 32.0), 9)


def test_cog_contracts_reject_unimplemented_encoding_and_invalid_budgets():
    with pytest.raises(ValueError, match="compression"):
        CogEncoding(compression="ZSTD")
    with pytest.raises(ValueError, match="max_blocks"):
        CogBuildBudget(max_blocks=0)
