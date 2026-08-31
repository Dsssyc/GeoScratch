from __future__ import annotations

import json
import shutil
import hashlib

import pytest

import geoscratch_flow_field_tiles.collection as collection_module
from geoscratch_flow_field_tiles.cog import CogBuildBudget
from geoscratch_flow_field_tiles.collection import (
    COG_COLLECTION_MARKER,
    CogCollectionBudget,
    _prepare_collection_work,
    _recover_snapshot_build,
    _validate_collection_manifest_identity,
    build_velocity_cog_collection,
    plan_velocity_cog_collection,
    verify_velocity_cog_collection,
)
from geoscratch_flow_field_tiles.resolution import StationSpacingResolution
from geoscratch_flow_field_tiles.job_control import (
    OutputLock,
    OutputLockConflictError,
)


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


def _collection_budget() -> CogCollectionBudget:
    return CogCollectionBudget(
        max_collection_bytes=1024**3,
        estimated_snapshot_bytes=4 * 1024 * 1024,
    )


@pytest.fixture(scope="module")
def built_collection(synthetic_source, tmp_path_factory):
    output = tmp_path_factory.mktemp("flow-cog-collection") / "cog-collection"
    return build_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=_collection_budget(),
    )


def test_collection_publishes_immutable_snapshots_runtime_pages_and_identity(
    built_collection,
):
    manifest = json.loads(built_collection.manifest_path.read_text(encoding="utf-8"))
    runtime = json.loads(
        built_collection.runtime_manifest_path.read_text(encoding="utf-8")
    )
    verified = verify_velocity_cog_collection(
        built_collection.output_directory,
        deep=True,
    )

    assert built_collection.status == "published"
    assert built_collection.snapshot_count == 2
    assert built_collection.page_count == 18
    assert verified["contentVersion"] == built_collection.content_version
    assert verified["timeIndices"] == (0, 1)
    assert manifest["coverage"] == "full"
    assert manifest["selection"]["timeIndices"] == [0, 1]
    assert [record["directory"] for record in manifest["snapshots"]] == [
        "snapshots/t00",
        "snapshots/t01",
    ]
    assert runtime["contentVersion"] == manifest["contentVersion"]
    assert len(runtime["pages"]) == 18
    assert runtime["construction"]["sampleRegistration"] == "pixel-center"
    assert manifest["storage"]["totalArtifactBytes"] == sum(
        path.stat().st_size
        for path in built_collection.output_directory.rglob("*")
        if path.is_file()
    )
    assert set(path.name for path in built_collection.output_directory.iterdir()) == {
        COG_COLLECTION_MARKER,
        "manifest.json",
        "runtime-manifest.json",
        "snapshots",
    }


def test_same_collection_is_verified_and_skipped_without_rewriting(
    built_collection,
    synthetic_source,
):
    before = {
        path: path.stat().st_mtime_ns
        for path in built_collection.output_directory.rglob("*")
    }

    repeated = build_velocity_cog_collection(
        synthetic_source.directory,
        built_collection.output_directory,
        time_indices=(1, 0),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=CogCollectionBudget(
            max_collection_bytes=1,
            estimated_snapshot_bytes=1,
        ),
    )

    assert repeated.status == "already-published"
    assert repeated.content_version == built_collection.content_version
    assert before == {
        path: path.stat().st_mtime_ns
        for path in built_collection.output_directory.rglob("*")
    }


def test_resume_skips_verified_snapshot_and_builds_only_missing_time(
    built_collection,
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    output = tmp_path / "cog-collection"
    plan = plan_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=_collection_budget(),
    )
    work = _prepare_collection_work(output, plan, resume=False)
    shutil.copytree(
        built_collection.output_directory / "snapshots" / "t00",
        work / "payload" / "snapshots" / "t00",
    )
    resumed_plan = plan_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=CogCollectionBudget(max_collection_bytes=1024**3),
    )
    assert resumed_plan.budget.existing_snapshot_count == 1
    assert resumed_plan.budget.remaining_snapshot_count == 1
    assert resumed_plan.budget.approved
    called: list[int] = []
    real_builder = collection_module.build_velocity_cog_snapshot

    def record_builder(*args, **kwargs):
        called.append(kwargs["time_index"])
        return real_builder(*args, **kwargs)

    monkeypatch.setattr(collection_module, "build_velocity_cog_snapshot", record_builder)

    resumed = build_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=CogCollectionBudget(max_collection_bytes=1024**3),
        resume=True,
    )

    assert resumed.status == "published"
    assert called == [1]
    assert verify_velocity_cog_collection(output, deep=True)["timeIndices"] == (0, 1)


def test_collection_verifier_rejects_runtime_manifest_drift(
    built_collection,
    tmp_path,
):
    output = tmp_path / "cog-collection"
    shutil.copytree(built_collection.output_directory, output)
    runtime_path = output / "runtime-manifest.json"
    runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
    runtime["pages"][0]["sha256"] = "0" * 64
    runtime_path.write_text(json.dumps(runtime), encoding="utf-8")

    with pytest.raises(ValueError, match="runtime identity|storage identity"):
        verify_velocity_cog_collection(output, deep=False)


def test_collection_verifier_rejects_root_symlink_alias(
    built_collection,
    tmp_path,
):
    alias = tmp_path / "collection-alias"
    alias.symlink_to(built_collection.output_directory, target_is_directory=True)

    with pytest.raises(ValueError, match="symbolic link"):
        verify_velocity_cog_collection(alias, deep=False)


def test_collection_validator_rejects_self_consistent_adapter_drift(
    built_collection,
):
    manifest = json.loads(built_collection.manifest_path.read_text(encoding="utf-8"))
    runtime_bytes = built_collection.runtime_manifest_path.read_bytes()
    manifest["construction"]["facts"]["adapter"]["version"] = "generic-average-v0"
    manifest["construction"]["sha256"] = hashlib.sha256(
        json.dumps(
            manifest["construction"]["facts"],
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    with pytest.raises(ValueError, match="semantic contract"):
        _validate_collection_manifest_identity(manifest, runtime_bytes)


def test_collection_validator_cross_binds_source_authority_to_children(
    built_collection,
):
    manifest = json.loads(built_collection.manifest_path.read_text(encoding="utf-8"))
    runtime_bytes = built_collection.runtime_manifest_path.read_bytes()
    manifest["construction"]["facts"]["source"]["authority"][
        "topology"
    ] = "authoritative"
    manifest["construction"]["sha256"] = hashlib.sha256(
        json.dumps(
            manifest["construction"]["facts"],
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    with pytest.raises(ValueError, match="semantic contract"):
        _validate_collection_manifest_identity(manifest, runtime_bytes)


def test_progress_sink_failure_during_install_leaves_no_published_collection(
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "cog-collection"

    class FailingSink:
        def emit(self, event):
            if event.event == "job.completed":
                raise RuntimeError("sink failed")

    with pytest.raises(RuntimeError, match="sink failed"):
        build_velocity_cog_collection(
            synthetic_source.directory,
            output,
            time_indices=(0,),
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_resolution(),
            snapshot_budget=_snapshot_budget(),
            collection_budget=_collection_budget(),
            progress=FailingSink(),
        )

    assert not output.exists()
    work_directories = tuple(tmp_path.glob(".cog-collection.work-*"))
    assert len(work_directories) == 1
    assert work_directories[0].joinpath("payload").is_dir()


def test_actual_snapshot_bytes_cannot_overrun_an_underestimated_collection_cap(
    built_collection,
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "cog-collection"
    manifest = json.loads(built_collection.manifest_path.read_text(encoding="utf-8"))
    cog_bytes_only = manifest["snapshots"][0]["cogSizeBytes"]

    with pytest.raises(OSError, match="compressed byte budget was exceeded"):
        build_velocity_cog_collection(
            synthetic_source.directory,
            output,
            time_indices=(0,),
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_resolution(),
            snapshot_budget=_snapshot_budget(),
            collection_budget=CogCollectionBudget(
                max_collection_bytes=cog_bytes_only,
                estimated_snapshot_bytes=1,
            ),
        )

    assert not output.exists()
    work = next(tmp_path.glob(".cog-collection.work-*"))
    assert work.joinpath("payload", "snapshots", "t00").is_dir()


def test_schema_three_subset_preserves_authority_and_original_model_time(
    synthetic_source,
    tmp_path,
):
    descriptor = json.loads(
        synthetic_source.descriptor_path.read_text(encoding="utf-8")
    )
    descriptor.update({
        "schemaVersion": 3,
        "timeUnit": "hour",
        "authority": {
            "unit": "authoritative",
            "basis": "authoritative",
            "time": "authoritative",
            "phase": "unconfirmed",
            "topology": "inferred",
        },
    })
    descriptor["unit"] = "meter-per-second"
    descriptor["basis"] = "east-north"
    descriptor["fields"][0]["modelTime"] = 0.25
    descriptor["fields"][1]["modelTime"] = 1.75
    descriptor_path = tmp_path / "source-v3.json"
    descriptor_path.write_text(json.dumps(descriptor), encoding="utf-8")
    output_parent = tmp_path / "collection-output"
    output_parent.mkdir()
    output = output_parent / "cog-collection"

    built = build_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(1,),
        descriptor_path=descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=_collection_budget(),
    )
    manifest = json.loads(built.manifest_path.read_text(encoding="utf-8"))
    runtime = json.loads(built.runtime_manifest_path.read_text(encoding="utf-8"))

    assert manifest["coverage"] == "subset"
    assert manifest["source"]["timeUnit"] == "hour"
    assert manifest["source"]["authority"]["time"] == "authoritative"
    assert runtime["times"] == [{
        "timeIndex": 1,
        "modelTime": 1.75,
        "unit": "hour",
        "phase": "unspecified",
        "sourceHash": descriptor["fields"][1]["sha256"],
    }]
    assert verify_velocity_cog_collection(output, deep=True)["timeIndices"] == (1,)


def test_resume_refuses_symlinked_owned_work_subdirectories(
    synthetic_source,
    tmp_path,
):
    output = tmp_path / "cog-collection"
    plan = plan_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0,),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=_collection_budget(),
    )
    work = _prepare_collection_work(output, plan, resume=False)
    shutil.rmtree(work / "payload")
    external = tmp_path / "belongs-to-user"
    external.mkdir()
    (work / "payload").symlink_to(external, target_is_directory=True)

    with pytest.raises(ValueError, match="work directory is invalid"):
        build_velocity_cog_collection(
            synthetic_source.directory,
            output,
            time_indices=(0,),
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_resolution(),
            snapshot_budget=_snapshot_budget(),
            collection_budget=_collection_budget(),
            resume=True,
        )

    assert list(external.iterdir()) == []


def test_resume_never_deletes_unmarked_incomplete_staging_by_name(tmp_path):
    build_parent = tmp_path / "snapshot-build"
    build_parent.mkdir()
    residue = build_parent / ".cog-cache.build-user-data"
    residue.mkdir()
    residue.joinpath("keep.txt").write_text("belongs to user\n", encoding="utf-8")

    with pytest.raises(
        collection_module.CogCollectionConflictError,
        match="preserved",
    ):
        _recover_snapshot_build(
            build_parent,
            resume=True,
            request_sha256="a" * 64,
            time_index=0,
            discard_incomplete=False,
        )

    assert residue.joinpath("keep.txt").read_text(encoding="utf-8") == (
        "belongs to user\n"
    )


def test_descriptor_drift_between_plan_and_lock_is_rejected(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    descriptor = json.loads(
        synthetic_source.descriptor_path.read_text(encoding="utf-8")
    )
    descriptor_path = tmp_path / "source.json"
    descriptor_path.write_text(json.dumps(descriptor), encoding="utf-8")
    real_plan = collection_module.plan_velocity_cog_collection
    calls = 0

    def drifting_plan(*args, **kwargs):
        nonlocal calls
        result = real_plan(*args, **kwargs)
        calls += 1
        if calls == 1:
            changed = json.loads(descriptor_path.read_text(encoding="utf-8"))
            changed["sourceRevision"] = "changed-after-plan"
            descriptor_path.write_text(json.dumps(changed), encoding="utf-8")
        return result

    monkeypatch.setattr(
        collection_module,
        "plan_velocity_cog_collection",
        drifting_plan,
    )

    with pytest.raises(
        collection_module.CogCollectionConflictError,
        match="SOURCE_CHANGED",
    ):
        build_velocity_cog_collection(
            synthetic_source.directory,
            tmp_path / "cog-collection",
            time_indices=(0,),
            descriptor_path=descriptor_path,
            resolution=_resolution(),
            snapshot_budget=_snapshot_budget(),
            collection_budget=_collection_budget(),
        )

    assert not tmp_path.joinpath("cog-collection").exists()


def test_collection_lock_is_acquired_before_resume_plan_reads(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    output = tmp_path / "cog-collection"
    lock_path = tmp_path / ".cog-collection.lock"
    plan_called = False

    def unexpected_plan(*_args, **_kwargs):
        nonlocal plan_called
        plan_called = True
        raise AssertionError("plan ran before output lock")

    monkeypatch.setattr(
        collection_module,
        "plan_velocity_cog_collection",
        unexpected_plan,
    )

    with OutputLock(lock_path, metadata={"jobId": "first"}):
        with pytest.raises(OutputLockConflictError):
            build_velocity_cog_collection(
                synthetic_source.directory,
                output,
                time_indices=(0,),
                descriptor_path=synthetic_source.descriptor_path,
                resolution=_resolution(),
                snapshot_budget=_snapshot_budget(),
                collection_budget=_collection_budget(),
            )

    assert not plan_called
