from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

import geoscratch_flow_field_tiles.collection as collection_module
from geoscratch_flow_field_tiles.cog import CogBuildBudget
from geoscratch_flow_field_tiles.cog_batch import CogSnapshotBatchExecutionBudget
from geoscratch_flow_field_tiles.collection import (
    COG_COLLECTION_MARKER,
    CogCollectionBudget,
    _capture_collection_output_state,
    _install_collection_directory,
    _safe_collection_output,
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
    for value in ("", "0,", "0, 1", "zero", "01", "+1"):
        with pytest.raises(ValueError):
            parse_time_indices(value, 2)
    for value in (
        "0", ":2", "0:", "1:1", "2:1", "-1:1", "0:3", "00:2", " 0:2",
    ):
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


def test_collection_plan_accounts_batch_execution_without_changing_request_identity(
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "cog-collection"
    custom_execution = CogSnapshotBatchExecutionBudget(
        max_snapshots=1,
        max_staged_bytes=128 * 1024 * 1024,
        minimum_free_bytes=64 * 1024 * 1024,
    )
    custom = plan_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=CogCollectionBudget(
            max_collection_bytes=1024**3,
            estimated_snapshot_bytes=4 * 1024 * 1024,
        ),
        batch_execution_budget=custom_execution,
    )
    default = plan_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=CogCollectionBudget(
            max_collection_bytes=1024**3,
            estimated_snapshot_bytes=4 * 1024 * 1024,
        ),
    )

    assert custom.request_sha256 == default.request_sha256
    assert custom.request_facts == default.request_facts
    assert custom.budget.required_available_bytes == (
        2 * 4 * 1024 * 1024
        + custom_execution.max_staged_bytes
        + custom_execution.minimum_free_bytes
    )
    assert custom.manifest()["collectionBudget"]["limits"]["batchExecution"] == {
        "maxSnapshots": 1,
        "maxStagedBytes": 128 * 1024 * 1024,
        "minimumFreeBytes": 64 * 1024 * 1024,
    }
    assert "batchExecution" not in custom.request_facts


def test_collection_plan_reserves_batch_capacity_without_a_snapshot_estimate(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    available_bytes = 100 * 1024 * 1024
    monkeypatch.setattr(
        collection_module.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=available_bytes),
    )
    snapshot_budget = CogBuildBudget(
        max_blocks=128,
        max_raw_pyramid_bytes=256 * 1024 * 1024,
        max_staged_bytes=1 * 1024 * 1024,
        minimum_free_bytes=1 * 1024 * 1024,
    )
    batch_budget = CogSnapshotBatchExecutionBudget(
        max_snapshots=1,
        max_staged_bytes=128 * 1024 * 1024,
        minimum_free_bytes=64 * 1024 * 1024,
    )

    plan = plan_velocity_cog_collection(
        synthetic_source.directory,
        tmp_path / "cog-collection",
        time_indices=(0,),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=snapshot_budget,
        collection_budget=CogCollectionBudget(max_collection_bytes=1024**3),
        batch_execution_budget=batch_budget,
    )

    assert plan.snapshot_plan.budget.approved
    assert plan.budget.required_available_bytes == 192 * 1024 * 1024
    assert plan.budget.violations == (
        f"collection free-space budget {192 * 1024 * 1024} > {available_bytes}",
    )
    with pytest.raises(ValueError, match="collection free-space budget"):
        plan.require_output_approved()


def _write_minimal_owned_collection(path, version="flow-test-v1"):
    path.mkdir()
    snapshot = path.joinpath("snapshots", "t00")
    snapshot.mkdir(parents=True)
    snapshot.joinpath(".flow-field-cog-artifact.json").write_text(
        "{}\n",
        encoding="utf-8",
    )
    snapshot.joinpath("manifest.json").write_text("{}\n", encoding="utf-8")
    snapshot.joinpath("flow-t00.cog.tif").write_bytes(b"test")
    manifest = {
        "schemaVersion": 1,
        "artifactType": "flow-field-cog-collection",
        "contentVersion": version,
        "snapshots": [{
            "timeIndex": 0,
            "directory": "snapshots/t00",
            "cogPath": "snapshots/t00/flow-t00.cog.tif",
        }],
    }
    path.joinpath("manifest.json").write_text(
        json.dumps(manifest),
        encoding="utf-8",
    )
    path.joinpath("runtime-manifest.json").write_text("{}\n", encoding="utf-8")
    path.joinpath(COG_COLLECTION_MARKER).write_text(
        json.dumps({
            "kind": "geoscratch-flow-field-cog-collection",
            "contentVersion": version,
        }),
        encoding="utf-8",
    )


def test_collection_output_is_explicit_owned_and_atomically_installed(tmp_path):
    output = _safe_collection_output(tmp_path / "cog-collection")
    expected = _capture_collection_output_state(output)
    staged = tmp_path / "staged"
    _write_minimal_owned_collection(staged)

    _install_collection_directory(
        staged,
        output,
        expected,
        replace_existing=False,
    )

    assert _capture_collection_output_state(output).kind == "owned"
    assert not staged.exists()
    with pytest.raises(ValueError, match="explicit cog-collection"):
        _safe_collection_output(tmp_path / "other")


def test_collection_install_refuses_content_added_during_build(tmp_path):
    output = tmp_path / "cog-collection"
    _write_minimal_owned_collection(output, "old")
    expected = _capture_collection_output_state(output)
    output.joinpath("belongs-to-user.txt").write_text("keep\n", encoding="utf-8")
    staged = tmp_path / "staged"
    _write_minimal_owned_collection(staged, "new")

    with pytest.raises(ValueError, match="unowned"):
        _install_collection_directory(
            staged,
            output,
            expected,
            replace_existing=True,
        )

    assert output.joinpath("belongs-to-user.txt").read_text(encoding="utf-8") == "keep\n"
    assert staged.is_dir()


def test_collection_replacement_preserves_backup_and_later_content(tmp_path):
    output = tmp_path / "cog-collection"
    _write_minimal_owned_collection(output, "old")
    expected = _capture_collection_output_state(output)
    staged = tmp_path / "staged"
    _write_minimal_owned_collection(staged, "new")

    def add_later_content():
        backup = next(tmp_path.glob(".cog-collection.backup-*"))
        backup.joinpath("later-user-content.txt").write_text("keep\n", encoding="utf-8")

    backup = _install_collection_directory(
        staged,
        output,
        expected,
        replace_existing=True,
        commit_callback=add_later_content,
    )

    assert backup is not None and backup.is_dir()
    assert backup.joinpath("later-user-content.txt").read_text(encoding="utf-8") == "keep\n"
    assert _capture_collection_output_state(output).kind == "owned"
