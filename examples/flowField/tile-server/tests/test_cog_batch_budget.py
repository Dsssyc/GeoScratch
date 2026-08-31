from __future__ import annotations

from types import SimpleNamespace

import pytest

import geoscratch_flow_field_tiles.cog_batch as batch_module
from geoscratch_flow_field_tiles.cog_batch import (
    CogBatchStagingGuard,
    CogSnapshotBatchExecutionBudget,
    CogSnapshotBatchItem,
    validate_snapshot_batch_items,
)


def _items(tmp_path, count=2):
    items = []
    for time_index in range(count):
        parent = tmp_path / f"time-{time_index}"
        parent.mkdir()
        items.append(CogSnapshotBatchItem(
            time_index=time_index,
            output_directory=parent / "cog-cache",
            job_id=f"job-{time_index}",
        ))
    return tuple(items)


def test_batch_execution_defaults_are_bounded_to_two_snapshots():
    budget = CogSnapshotBatchExecutionBudget()

    assert budget.max_snapshots == 2
    assert budget.max_staged_bytes == 16 * 1024**3
    assert budget.minimum_free_bytes == 8 * 1024**3
    with pytest.raises(ValueError, match="cannot exceed 2"):
        CogSnapshotBatchExecutionBudget(max_snapshots=3)


@pytest.mark.parametrize(
    ("arguments", "message"),
    (
        ({"time_index": -1, "output_directory": "."}, "time_index"),
        ({"time_index": True, "output_directory": "."}, "time_index"),
        ({"time_index": 0, "output_directory": ".", "job_id": ""}, "job_id"),
    ),
)
def test_batch_item_validates_time_and_job_identity(arguments, message):
    with pytest.raises(ValueError, match=message):
        CogSnapshotBatchItem(**arguments)


def test_batch_items_reject_empty_duplicate_time_and_size_limit(tmp_path):
    with pytest.raises(ValueError, match="at least one"):
        validate_snapshot_batch_items(())

    items = _items(tmp_path, 2)
    duplicate_time = (
        items[0],
        CogSnapshotBatchItem(0, items[1].output_directory),
    )
    with pytest.raises(ValueError, match="time indices must be unique"):
        validate_snapshot_batch_items(duplicate_time)

    third_parent = tmp_path / "time-2"
    third_parent.mkdir()
    too_many = items + (CogSnapshotBatchItem(2, third_parent / "cog-cache"),)
    with pytest.raises(ValueError, match="batch size 3 exceeds 2"):
        validate_snapshot_batch_items(too_many)


def test_batch_items_reject_duplicate_canonical_outputs_through_parent_symlink(
    tmp_path,
):
    real_parent = tmp_path / "real"
    real_parent.mkdir()
    alias_parent = tmp_path / "alias"
    alias_parent.symlink_to(real_parent, target_is_directory=True)
    first = CogSnapshotBatchItem(0, real_parent / "cog-cache")
    second = CogSnapshotBatchItem(1, alias_parent / "cog-cache")

    assert first.output_directory == second.output_directory
    with pytest.raises(ValueError, match="canonical output directories must be unique"):
        validate_snapshot_batch_items((first, second))


def test_batch_items_require_one_filesystem(tmp_path, monkeypatch):
    items = _items(tmp_path, 2)
    first_parent = items[0].output_directory.parent

    monkeypatch.setattr(
        batch_module,
        "_filesystem_device",
        lambda path: 1 if path == first_parent else 2,
    )

    with pytest.raises(ValueError, match="share one filesystem"):
        validate_snapshot_batch_items(items)


def test_aggregate_guard_counts_only_registered_regular_files_across_roots(
    tmp_path,
    monkeypatch,
):
    items = _items(tmp_path, 2)
    free_values = iter((1_000, 900, 800))
    monkeypatch.setattr(
        batch_module.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=next(free_values)),
    )
    guard = CogBatchStagingGuard(
        items,
        CogSnapshotBatchExecutionBudget(
            max_staged_bytes=100,
            minimum_free_bytes=100,
        ),
    )
    first_root = items[0].output_directory.parent / ".cog-cache.build-a"
    second_root = items[1].output_directory.parent / ".cog-cache.build-b"
    first_root.mkdir()
    second_root.mkdir()
    nested = second_root / "nested"
    nested.mkdir()
    first_root.joinpath("base.tif").write_bytes(b"1234")
    second_root.joinpath("base.tif").write_bytes(b"123456")
    nested.joinpath("overview.tif").write_bytes(b"123")
    items[0].output_directory.parent.joinpath("unregistered.bin").write_bytes(b"x" * 50)
    guard.register(first_root)
    guard.register(second_root)

    first = guard.observe("base-1")
    nested.joinpath("more.tif").write_bytes(b"12345")
    second = guard.observe("base-2")

    assert first.registered_root_count == 2
    assert first.staged_bytes == 13
    assert first.available_bytes == 900
    assert first.peak_staged_bytes == 13
    assert first.minimum_available_bytes == 900
    assert first.observation_count == 1
    assert second.staged_bytes == 18
    assert second.available_bytes == 800
    assert second.peak_staged_bytes == 18
    assert second.minimum_available_bytes == 800
    assert second.observation_count == 2


def test_aggregate_guard_enforces_staging_cap_and_free_reserve(
    tmp_path,
    monkeypatch,
):
    items = _items(tmp_path, 1)
    root = items[0].output_directory.parent / ".cog-cache.build-a"
    root.mkdir()
    root.joinpath("base.tif").write_bytes(b"123456")

    monkeypatch.setattr(
        batch_module.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=100),
    )
    staging_guard = CogBatchStagingGuard(
        items,
        CogSnapshotBatchExecutionBudget(
            max_staged_bytes=5,
            minimum_free_bytes=1,
        ),
    )
    staging_guard.register(root)
    with pytest.raises(OSError, match="staging budget exceeded"):
        staging_guard.observe("base")
    assert staging_guard.peak_staged_bytes == 6
    assert staging_guard.observation_count == 1

    free_values = iter((100, 4))
    monkeypatch.setattr(
        batch_module.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=next(free_values)),
    )
    free_guard = CogBatchStagingGuard(
        items,
        CogSnapshotBatchExecutionBudget(
            max_staged_bytes=100,
            minimum_free_bytes=5,
        ),
    )
    free_guard.register(root)
    with pytest.raises(OSError, match="free-space reserve"):
        free_guard.observe("base")
    assert free_guard.minimum_available_bytes == 4
    assert free_guard.observation_count == 1


def test_aggregate_guard_rejects_symlink_roots_and_entries(tmp_path, monkeypatch):
    items = _items(tmp_path, 1)
    monkeypatch.setattr(
        batch_module.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=1_000),
    )
    guard = CogBatchStagingGuard(
        items,
        CogSnapshotBatchExecutionBudget(
            max_staged_bytes=100,
            minimum_free_bytes=1,
        ),
    )
    real_root = items[0].output_directory.parent / ".cog-cache.build-real"
    real_root.mkdir()
    linked_root = items[0].output_directory.parent / ".cog-cache.build-link"
    linked_root.symlink_to(real_root, target_is_directory=True)
    with pytest.raises(ValueError, match="root cannot be a symbolic link"):
        guard.register(linked_root)

    guard.register(real_root)
    external = tmp_path / "external.bin"
    external.write_bytes(b"x" * 20)
    real_root.joinpath("linked.bin").symlink_to(external)
    with pytest.raises(ValueError, match="cannot contain symbolic links"):
        guard.observe("base")


def test_aggregate_guard_rejects_duplicate_or_unowned_roots(tmp_path, monkeypatch):
    items = _items(tmp_path, 1)
    monkeypatch.setattr(
        batch_module.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=1_000),
    )
    guard = CogBatchStagingGuard(
        items,
        CogSnapshotBatchExecutionBudget(
            max_staged_bytes=100,
            minimum_free_bytes=1,
        ),
    )
    root = items[0].output_directory.parent / ".cog-cache.build-a"
    root.mkdir()
    guard.register(root)
    with pytest.raises(ValueError, match="already registered"):
        guard.register(root)

    unowned = tmp_path / "unowned"
    unowned.mkdir()
    with pytest.raises(ValueError, match="belong to an output parent"):
        guard.register(unowned)
