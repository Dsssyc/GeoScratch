from __future__ import annotations

import json
from types import SimpleNamespace

import numpy as np
import pytest

import geoscratch_flow_field_tiles.cog_batch as batch_module
import geoscratch_flow_field_tiles.cog as cog_module
import geoscratch_flow_field_tiles.source as source_module
from geoscratch_flow_field_tiles.cog_batch import (
    CogBatchStagingGuard,
    CogSnapshotBatchExecutionBudget,
    CogSnapshotBatchItem,
    build_velocity_cog_snapshot_batch,
    validate_snapshot_batch_items,
)
from geoscratch_flow_field_tiles.cog import (
    build_velocity_cog_snapshot,
    verify_velocity_cog_snapshot,
)
from geoscratch_flow_field_tiles.resolution import StationSpacingResolution
from geoscratch_flow_field_tiles.topology import PreparedDelaunayTopology


class RecordingProgressSink:
    def __init__(self):
        self.events = []

    def emit(self, event):
        self.events.append(event)


class FailingInstallProgressSink:
    def emit(self, event):
        if (
            event.time_index == 1
            and event.stage == "install"
            and event.event == "stage.completed"
        ):
            raise RuntimeError("second install progress failed")


def _test_resolution() -> StationSpacingResolution:
    return StationSpacingResolution(
        minimum_support_points=3,
        minimum_support_fraction=0.10,
        minimum_matrix=9,
        maximum_matrix=9,
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

    duplicate_job = (
        CogSnapshotBatchItem(0, items[0].output_directory, job_id="same-job"),
        CogSnapshotBatchItem(1, items[1].output_directory, job_id="same-job"),
    )
    with pytest.raises(ValueError, match="job IDs must be unique"):
        validate_snapshot_batch_items(duplicate_job)


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


def test_aggregate_guard_reserves_transient_copy_capacity(tmp_path, monkeypatch):
    items = _items(tmp_path, 1)
    root = items[0].output_directory.parent / ".cog-cache.build-a"
    root.mkdir()
    root.joinpath("base.tif").write_bytes(b"123456")
    monkeypatch.setattr(
        batch_module.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=100),
    )
    staged_guard = CogBatchStagingGuard(
        items,
        CogSnapshotBatchExecutionBudget(
            max_staged_bytes=10,
            minimum_free_bytes=5,
        ),
    )
    staged_guard.register(root)
    with pytest.raises(OSError, match="cannot hold the final copy"):
        staged_guard.require_additional_capacity(5, "copy")

    free_guard = CogBatchStagingGuard(
        items,
        CogSnapshotBatchExecutionBudget(
            max_staged_bytes=100,
            minimum_free_bytes=95,
        ),
    )
    free_guard.register(root)
    with pytest.raises(OSError, match="enough free space for the final copy"):
        free_guard.require_additional_capacity(6, "copy")


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


def test_batch_two_is_byte_equivalent_and_reuses_topology_and_stencils(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    sequential_counts = {"topology": 0, "stencil": 0, "apply": 0}
    original_cog_topology = cog_module.prepare_topology
    original_stencil = cog_module.prepare_triangle_linear_stencil
    original_apply = cog_module.apply_pixel_center_block

    def sequential_topology(*args, **kwargs):
        sequential_counts["topology"] += 1
        return original_cog_topology(*args, **kwargs)

    def sequential_stencil(*args, **kwargs):
        sequential_counts["stencil"] += 1
        return original_stencil(*args, **kwargs)

    def sequential_apply(*args, **kwargs):
        sequential_counts["apply"] += 1
        return original_apply(*args, **kwargs)

    monkeypatch.setattr(cog_module, "prepare_topology", sequential_topology)
    monkeypatch.setattr(
        cog_module,
        "prepare_triangle_linear_stencil",
        sequential_stencil,
    )
    monkeypatch.setattr(cog_module, "apply_pixel_center_block", sequential_apply)
    sequential = []
    for time_index in (0, 1):
        parent = tmp_path / "sequential" / f"t{time_index:02d}"
        parent.mkdir(parents=True)
        sequential.append(build_velocity_cog_snapshot(
            synthetic_source.directory,
            parent / "cog-cache",
            time_index=time_index,
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
        ))

    monkeypatch.setattr(cog_module, "prepare_topology", original_cog_topology)
    monkeypatch.setattr(
        cog_module,
        "prepare_triangle_linear_stencil",
        original_stencil,
    )
    monkeypatch.setattr(cog_module, "apply_pixel_center_block", original_apply)

    batch_counts = {
        "source": [],
        "plan": 0,
        "topology": 0,
        "stencil": 0,
        "apply": 0,
    }
    original_pair_reader = source_module._read_float32_pairs
    original_batch_plan = batch_module.plan_velocity_cog_snapshot
    original_batch_topology = batch_module.prepare_topology
    original_duplicate_statistics = PreparedDelaunayTopology.duplicate_statistics
    duplicate_field_batches = []

    def batch_pair_reader(path, *args, **kwargs):
        batch_counts["source"].append(path.name)
        return original_pair_reader(path, *args, **kwargs)

    def batch_plan(*args, **kwargs):
        batch_counts["plan"] += 1
        return original_batch_plan(*args, **kwargs)

    def batch_topology(*args, **kwargs):
        batch_counts["topology"] += 1
        return original_batch_topology(*args, **kwargs)

    def batch_duplicate_statistics(self, fields):
        duplicate_field_batches.append(tuple(fields))
        return original_duplicate_statistics(self, fields)

    def batch_stencil(*args, **kwargs):
        batch_counts["stencil"] += 1
        return original_stencil(*args, **kwargs)

    def batch_apply(*args, **kwargs):
        batch_counts["apply"] += 1
        return original_apply(*args, **kwargs)

    monkeypatch.setattr(source_module, "_read_float32_pairs", batch_pair_reader)
    monkeypatch.setattr(batch_module, "plan_velocity_cog_snapshot", batch_plan)
    monkeypatch.setattr(batch_module, "prepare_topology", batch_topology)
    monkeypatch.setattr(
        PreparedDelaunayTopology,
        "duplicate_statistics",
        batch_duplicate_statistics,
    )
    monkeypatch.setattr(cog_module, "prepare_triangle_linear_stencil", batch_stencil)
    monkeypatch.setattr(cog_module, "apply_pixel_center_block", batch_apply)
    items = []
    for time_index in (1, 0):
        parent = tmp_path / "batch" / f"t{time_index:02d}"
        parent.mkdir(parents=True)
        items.append(CogSnapshotBatchItem(
            time_index,
            parent / "cog-cache",
            job_id=f"job-t{time_index:02d}",
        ))
    sink = RecordingProgressSink()
    batch = build_velocity_cog_snapshot_batch(
        synthetic_source.directory,
        items=tuple(items),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
        progress=sink,
    )

    first_manifest = json.loads(batch[0].manifest_path.read_text(encoding="utf-8"))
    block_count = first_manifest["construction"]["facts"]["plan"]["grid"][
        "blockCount"
    ]
    assert sequential_counts == {
        "topology": 2,
        "stencil": block_count * 2,
        "apply": block_count * 2,
    }
    assert batch_counts == {
        "source": ["station.bin", "uv_0.bin", "uv_1.bin"],
        "plan": 1,
        "topology": 1,
        "stencil": block_count,
        "apply": block_count * 2,
    }
    assert len(duplicate_field_batches) == 2
    assert all(len(fields) == 1 for fields in duplicate_field_batches)
    assert np.array_equal(duplicate_field_batches[0][0], synthetic_source.fields[1])
    assert np.array_equal(duplicate_field_batches[1][0], synthetic_source.fields[0])
    assert [result.output_directory for result in batch] == [
        item.output_directory for item in items
    ]
    sequential_by_time = {
        time_index: result for time_index, result in enumerate(sequential)
    }
    for item, actual in zip(items, batch, strict=True):
        expected = sequential_by_time[item.time_index]
        expected_manifest = json.loads(
            expected.manifest_path.read_text(encoding="utf-8")
        )
        actual_manifest = json.loads(actual.manifest_path.read_text(encoding="utf-8"))
        assert actual.cog_sha256 == expected.cog_sha256
        assert actual.cog_size_bytes == expected.cog_size_bytes
        assert actual.content_version == expected.content_version
        assert actual_manifest["construction"] == expected_manifest["construction"]
        assert actual_manifest["construction"]["facts"]["support"] == (
            expected_manifest["construction"]["facts"]["support"]
        )
        assert [
            level["pixelSha256"]
            for level in actual_manifest["construction"]["facts"]["support"][
                "overviewLevels"
            ]
        ] == [
            level["pixelSha256"]
            for level in expected_manifest["construction"]["facts"]["support"][
                "overviewLevels"
            ]
        ]
        assert "batch" not in actual_manifest["construction"]["facts"]
        assert verify_velocity_cog_snapshot(actual.output_directory)[
            "contentVersion"
        ] == actual.content_version
    for time_index in (0, 1):
        events = [event for event in sink.events if event.time_index == time_index]
        assert [event.sequence for event in events] == list(range(1, len(events) + 1))
        assert all("batch" not in event.manifest() for event in events)


def test_batch_finalize_failure_preserves_first_verified_snapshot(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    items = []
    for time_index in (0, 1):
        parent = tmp_path / f"failure-t{time_index:02d}"
        parent.mkdir()
        items.append(CogSnapshotBatchItem(time_index, parent / "cog-cache"))
    original_finalize = batch_module._finalize_velocity_cog_snapshot

    def fail_second(**kwargs):
        if kwargs["snapshot"].field_descriptor.time_index == 1:
            raise RuntimeError("second finalize failed")
        return original_finalize(**kwargs)

    monkeypatch.setattr(
        batch_module,
        "_finalize_velocity_cog_snapshot",
        fail_second,
    )

    with pytest.raises(RuntimeError, match="second finalize failed"):
        build_velocity_cog_snapshot_batch(
            synthetic_source.directory,
            items=tuple(items),
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
        )

    first_output = items[0].output_directory
    second_output = items[1].output_directory
    assert verify_velocity_cog_snapshot(first_output)["contentVersion"].endswith(
        "-t00-z9-v3"
    )
    assert not second_output.exists()
    assert list(first_output.parent.glob(".cog-cache.build-*")) == []
    assert list(second_output.parent.glob(".cog-cache.build-*")) == []


def test_batch_cleanup_does_not_remove_a_recreated_completed_staging_path(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    items = []
    for time_index in (0, 1):
        parent = tmp_path / f"recreated-t{time_index:02d}"
        parent.mkdir()
        items.append(CogSnapshotBatchItem(time_index, parent / "cog-cache"))
    original_finalize = batch_module._finalize_velocity_cog_snapshot
    completed_staging = []

    def recreate_then_fail(**kwargs):
        if kwargs["snapshot"].field_descriptor.time_index == 0:
            completed_staging.append(kwargs["staged"])
            return original_finalize(**kwargs)
        recreated = completed_staging[0]
        recreated.mkdir()
        recreated.joinpath("belongs-to-later-work.txt").write_text(
            "preserve me\n",
            encoding="utf-8",
        )
        raise RuntimeError("second finalize failed after recreation")

    monkeypatch.setattr(
        batch_module,
        "_finalize_velocity_cog_snapshot",
        recreate_then_fail,
    )

    with pytest.raises(RuntimeError, match="failed after recreation"):
        build_velocity_cog_snapshot_batch(
            synthetic_source.directory,
            items=tuple(items),
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
        )

    sentinel = completed_staging[0] / "belongs-to-later-work.txt"
    assert sentinel.read_text(encoding="utf-8") == "preserve me\n"
    assert verify_velocity_cog_snapshot(items[0].output_directory)[
        "contentVersion"
    ].endswith("-t00-z9-v3")
    assert not items[1].output_directory.exists()


def test_batch_cleanup_does_not_remove_a_replaced_active_staging_path(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    items = []
    for time_index in (0, 1):
        parent = tmp_path / f"active-replaced-t{time_index:02d}"
        parent.mkdir()
        items.append(CogSnapshotBatchItem(time_index, parent / "cog-cache"))
    original_finalize = batch_module._finalize_velocity_cog_snapshot
    moved_staging = []
    recreated_staging = []

    def replace_active_then_fail(**kwargs):
        if kwargs["snapshot"].field_descriptor.time_index == 0:
            return original_finalize(**kwargs)
        staged = kwargs["staged"]
        moved = staged.with_name(f"{staged.name}.moved")
        staged.rename(moved)
        staged.mkdir()
        staged.joinpath("belongs-to-other-work.txt").write_text(
            "preserve me\n",
            encoding="utf-8",
        )
        moved_staging.append(moved)
        recreated_staging.append(staged)
        raise RuntimeError("second active staging was replaced")

    monkeypatch.setattr(
        batch_module,
        "_finalize_velocity_cog_snapshot",
        replace_active_then_fail,
    )

    with pytest.raises(RuntimeError, match="active staging was replaced"):
        build_velocity_cog_snapshot_batch(
            synthetic_source.directory,
            items=tuple(items),
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
        )

    sentinel = recreated_staging[0] / "belongs-to-other-work.txt"
    assert sentinel.read_text(encoding="utf-8") == "preserve me\n"
    assert moved_staging[0].is_dir()
    assert verify_velocity_cog_snapshot(items[0].output_directory)[
        "contentVersion"
    ].endswith("-t00-z9-v3")


def test_batch_records_each_output_parents_available_bytes(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    items = []
    free_by_parent = {}
    for time_index, free_bytes in ((0, 100 * 1024**3), (1, 90 * 1024**3)):
        parent = tmp_path / f"available-t{time_index:02d}"
        parent.mkdir()
        item = CogSnapshotBatchItem(time_index, parent / "cog-cache")
        items.append(item)
        free_by_parent[parent.resolve()] = free_bytes

    def disk_usage(path):
        resolved = path.resolve()
        for parent, free_bytes in free_by_parent.items():
            if resolved == parent or resolved.is_relative_to(parent):
                return SimpleNamespace(free=free_bytes)
        raise AssertionError(f"unexpected disk-usage path: {resolved}")

    monkeypatch.setattr(batch_module.shutil, "disk_usage", disk_usage)

    results = build_velocity_cog_snapshot_batch(
        synthetic_source.directory,
        items=tuple(items),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
    )

    assert [
        json.loads(result.manifest_path.read_text(encoding="utf-8"))["preflight"][
            "budget"
        ]["observed"]["availableBytes"]
        for result in results
    ] == [100 * 1024**3, 90 * 1024**3]


def test_batch_second_replacement_rolls_back_when_install_sink_fails(
    synthetic_source,
    tmp_path,
):
    first_parent = tmp_path / "replacement-t00"
    second_parent = tmp_path / "replacement-t01"
    first_parent.mkdir()
    second_parent.mkdir()
    second_output = second_parent / "cog-cache"
    previous_second = build_velocity_cog_snapshot(
        synthetic_source.directory,
        second_output,
        time_index=1,
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
    )
    previous_manifest = previous_second.manifest_path.read_bytes()
    items = (
        CogSnapshotBatchItem(0, first_parent / "cog-cache", job_id="job-t00"),
        CogSnapshotBatchItem(1, second_output, job_id="job-t01"),
    )

    with pytest.raises(RuntimeError, match="second install progress failed"):
        build_velocity_cog_snapshot_batch(
            synthetic_source.directory,
            items=items,
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
            progress=FailingInstallProgressSink(),
        )

    assert verify_velocity_cog_snapshot(items[0].output_directory)[
        "contentVersion"
    ].endswith("-t00-z9-v3")
    assert previous_second.manifest_path.read_bytes() == previous_manifest
    assert verify_velocity_cog_snapshot(second_output)["contentVersion"] == (
        previous_second.content_version
    )
    assert list(first_parent.glob(".cog-cache.build-*")) == []
    assert list(second_parent.glob(".cog-cache.build-*")) == []


def test_batch_aggregate_staging_cap_fails_before_install(
    synthetic_source,
    tmp_path,
):
    items = []
    for time_index in (0, 1):
        parent = tmp_path / f"cap-t{time_index:02d}"
        parent.mkdir()
        items.append(CogSnapshotBatchItem(time_index, parent / "cog-cache"))

    with pytest.raises(OSError, match="batch staging budget exceeded"):
        build_velocity_cog_snapshot_batch(
            synthetic_source.directory,
            items=tuple(items),
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
            execution_budget=CogSnapshotBatchExecutionBudget(
                max_staged_bytes=1,
                minimum_free_bytes=1,
            ),
        )

    assert all(not item.output_directory.exists() for item in items)
    assert all(
        list(item.output_directory.parent.glob(".cog-cache.build-*")) == []
        for item in items
    )


def test_batch_reserves_aggregate_copy_capacity_before_cog_copy(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    observations = []
    original_capacity = CogBatchStagingGuard.require_additional_capacity

    def record_capacity(self, additional_bytes, stage):
        observation = original_capacity(self, additional_bytes, stage)
        observations.append((observation.staged_bytes, additional_bytes))
        return observation

    monkeypatch.setattr(
        CogBatchStagingGuard,
        "require_additional_capacity",
        record_capacity,
    )
    calibration_items = []
    for time_index in (0, 1):
        parent = tmp_path / f"copy-calibration-t{time_index:02d}"
        parent.mkdir()
        calibration_items.append(CogSnapshotBatchItem(
            time_index,
            parent / "cog-cache",
        ))
    build_velocity_cog_snapshot_batch(
        synthetic_source.directory,
        items=tuple(calibration_items),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_test_resolution(),
    )
    first_staged, first_copy = observations[0]
    constrained_cap = first_staged + first_copy - 1

    copy_calls = 0
    original_copy = cog_module.assemble_semantic_overview_cog

    def copy_spy(*args, **kwargs):
        nonlocal copy_calls
        copy_calls += 1
        return original_copy(*args, **kwargs)

    monkeypatch.setattr(cog_module, "assemble_semantic_overview_cog", copy_spy)
    constrained_items = []
    for time_index in (0, 1):
        parent = tmp_path / f"copy-constrained-t{time_index:02d}"
        parent.mkdir()
        constrained_items.append(CogSnapshotBatchItem(
            time_index,
            parent / "cog-cache",
        ))

    with pytest.raises(OSError, match="cannot hold the final copy"):
        build_velocity_cog_snapshot_batch(
            synthetic_source.directory,
            items=tuple(constrained_items),
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_test_resolution(),
            execution_budget=CogSnapshotBatchExecutionBudget(
                max_staged_bytes=constrained_cap,
                minimum_free_bytes=1,
            ),
        )

    assert copy_calls == 0
    assert all(not item.output_directory.exists() for item in constrained_items)
