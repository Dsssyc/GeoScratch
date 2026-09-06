from __future__ import annotations

import json
import shutil
import hashlib
from types import SimpleNamespace

import pytest

import geoscratch_flow_field_tiles.collection as collection_module
import geoscratch_flow_field_tiles.cog_batch as batch_module
from geoscratch_flow_field_tiles.cog import CogBuildBudget, verify_velocity_cog_snapshot
from geoscratch_flow_field_tiles.cog_batch import CogSnapshotBatchExecutionBudget
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
from geoscratch_flow_field_tiles.resolution import (
    FixedWebMercatorResolution,
    StationSpacingResolution,
    web_mercator_matrix_pixel_size,
)
from geoscratch_flow_field_tiles.job_control import (
    OutputLock,
    OutputLockConflictError,
)
from geoscratch_flow_field_tiles.source import (
    source_descriptor_identity_manifest_hash,
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


class RecordingSink:
    def __init__(self):
        self.events = []

    def emit(self, event):
        self.events.append(event)


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


@pytest.fixture(scope="module")
def fixed_collection(synthetic_source, tmp_path_factory):
    output = tmp_path_factory.mktemp("flow-fixed-cog-collection") / "cog-collection"
    return build_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0,),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=FixedWebMercatorResolution(10),
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
    assert manifest["source"]["fieldCount"] == 2
    assert manifest["selection"]["timeIndices"] == [0, 1]
    assert [record["directory"] for record in manifest["snapshots"]] == [
        "snapshots/t00",
        "snapshots/t01",
    ]
    assert runtime["contentVersion"] == manifest["contentVersion"]
    assert len(runtime["pages"]) == 18
    assert runtime["schemaVersion"] == 2
    assert manifest["schemaVersion"] == 3
    assert manifest["contentVersion"].endswith("-v3")
    assert runtime["construction"]["adapterVersion"] == "flow-cog-wmq-rg32f-v3"
    assert runtime["representation"]["activitySupport"] == "nearest-texel-zero"
    assert runtime["representation"]["sampleRegistration"] == "pixel-center"
    assert runtime["representation"]["missingPageSemantics"] == "unavailable"
    assert runtime["quality"] == manifest["quality"]
    assert runtime["authority"] == manifest["source"]["authority"]
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


def test_fresh_full_collection_uses_one_batch_two_call(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    calls = []
    sink = RecordingSink()
    real_builder = collection_module.build_velocity_cog_snapshot_batch

    def record_builder(*args, **kwargs):
        calls.append(tuple(item.time_index for item in kwargs["items"]))
        return real_builder(*args, **kwargs)

    monkeypatch.setattr(
        collection_module,
        "build_velocity_cog_snapshot_batch",
        record_builder,
    )

    result = build_velocity_cog_collection(
        synthetic_source.directory,
        tmp_path / "cog-collection",
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=_collection_budget(),
        progress=sink,
    )

    assert calls == [(0, 1)]
    snapshot_events = [
        event
        for event in sink.events
        if event.stage == "snapshot" and event.event == "stage.completed"
    ]
    assert [(event.time_index, event.sequence) for event in snapshot_events] == [
        (0, 1),
        (1, 1),
    ]
    assert len({event.job_id for event in snapshot_events}) == 2
    assert verify_velocity_cog_collection(result.output_directory, deep=True)[
        "timeIndices"
    ] == (0, 1)


@pytest.mark.parametrize(
    "resolution",
    (_resolution(), FixedWebMercatorResolution(10)),
    ids=("statistical", "explicit-z10"),
)
def test_batch_size_one_and_two_preserve_collection_identity(
    synthetic_source,
    tmp_path,
    monkeypatch,
    resolution,
):
    fixed_free_bytes = 100 * 1024**3
    monkeypatch.setattr(
        collection_module.shutil,
        "disk_usage",
        lambda _path: SimpleNamespace(free=fixed_free_bytes),
    )
    execution_one = CogSnapshotBatchExecutionBudget(
        max_snapshots=1,
        max_staged_bytes=64 * 1024 * 1024,
        minimum_free_bytes=32 * 1024 * 1024,
    )
    execution_two = CogSnapshotBatchExecutionBudget(
        max_snapshots=2,
        max_staged_bytes=64 * 1024 * 1024,
        minimum_free_bytes=32 * 1024 * 1024,
    )
    first = build_velocity_cog_collection(
        synthetic_source.directory,
        tmp_path / "one" / "cog-collection",
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=resolution,
        snapshot_budget=_snapshot_budget(),
        batch_execution_budget=execution_one,
        collection_budget=_collection_budget(),
    )
    second = build_velocity_cog_collection(
        synthetic_source.directory,
        tmp_path / "two" / "cog-collection",
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=resolution,
        snapshot_budget=_snapshot_budget(),
        batch_execution_budget=execution_two,
        collection_budget=_collection_budget(),
    )

    first_manifest = json.loads(first.manifest_path.read_text(encoding="utf-8"))
    second_manifest = json.loads(second.manifest_path.read_text(encoding="utf-8"))
    assert first.content_version == second.content_version
    assert first_manifest["construction"] == second_manifest["construction"]
    assert first.runtime_manifest_path.read_bytes() == (
        second.runtime_manifest_path.read_bytes()
    )
    assert "batch" not in first_manifest["construction"]["facts"]


def test_same_collection_is_verified_and_skipped_without_rewriting(
    built_collection,
    synthetic_source,
):
    before = {
        path: path.stat().st_mtime_ns
        for path in built_collection.output_directory.rglob("*")
    }
    sink = RecordingSink()

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
        progress=sink,
    )

    assert repeated.status == "already-published"
    assert repeated.content_version == built_collection.content_version
    assert [
        (event.event, event.stage, event.sequence)
        for event in sink.events
    ] == [("job.skipped", "collection", 1)]
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
    called: list[tuple[int, ...]] = []
    real_builder = collection_module.build_velocity_cog_snapshot_batch

    def record_builder(*args, **kwargs):
        called.append(tuple(item.time_index for item in kwargs["items"]))
        return real_builder(*args, **kwargs)

    monkeypatch.setattr(
        collection_module,
        "build_velocity_cog_snapshot_batch",
        record_builder,
    )

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
    assert called == [(1,)]
    assert verify_velocity_cog_collection(output, deep=True)["timeIndices"] == (0, 1)


def test_resume_promotes_batch_partial_success_and_only_builds_remaining_time(
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
    real_finalize = batch_module._finalize_velocity_cog_snapshot

    def fail_second(**kwargs):
        if kwargs["snapshot"].field_descriptor.time_index == 1:
            raise RuntimeError("batch t01 finalize failed")
        return real_finalize(**kwargs)

    monkeypatch.setattr(
        batch_module,
        "_finalize_velocity_cog_snapshot",
        fail_second,
    )
    with pytest.raises(RuntimeError, match="t01 finalize failed"):
        build_velocity_cog_collection(
            synthetic_source.directory,
            output,
            time_indices=(0, 1),
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_resolution(),
            snapshot_budget=_snapshot_budget(),
            collection_budget=_collection_budget(),
        )

    work = output.parent / f".{output.name}.work-{plan.request_sha256[:24]}"
    completed_t00 = work / "snapshot-builds" / "t00" / "cog-cache"
    assert verify_velocity_cog_snapshot(completed_t00)["contentVersion"].endswith(
        "-t00-z9-v3"
    )
    assert not (work / "snapshot-builds" / "t01" / "cog-cache").exists()
    deep_verify_calls = []
    real_snapshot_verifier = collection_module.verify_velocity_cog_snapshot

    def count_snapshot_verify(path):
        deep_verify_calls.append(path)
        return real_snapshot_verifier(path)

    monkeypatch.setattr(
        collection_module,
        "verify_velocity_cog_snapshot",
        count_snapshot_verify,
    )
    partial_plan = plan_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=CogCollectionBudget(max_collection_bytes=1024**3),
    )
    assert deep_verify_calls == []
    assert partial_plan.budget.existing_snapshot_count == 1
    assert partial_plan.budget.remaining_snapshot_count == 1
    assert partial_plan.budget.required_available_bytes == (
        CogSnapshotBatchExecutionBudget().max_staged_bytes
        + CogSnapshotBatchExecutionBudget().minimum_free_bytes
    )
    assert partial_plan.budget.approved

    monkeypatch.setattr(
        batch_module,
        "_finalize_velocity_cog_snapshot",
        real_finalize,
    )
    calls = []
    real_batch = collection_module.build_velocity_cog_snapshot_batch

    def record_batch(*args, **kwargs):
        calls.append(tuple(item.time_index for item in kwargs["items"]))
        return real_batch(*args, **kwargs)

    monkeypatch.setattr(
        collection_module,
        "build_velocity_cog_snapshot_batch",
        record_batch,
    )
    resumed = build_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=_collection_budget(),
        resume=True,
    )

    assert resumed.status == "published"
    assert calls == [(1,)]
    assert deep_verify_calls == [completed_t00]
    assert verify_velocity_cog_collection(output, deep=True)["timeIndices"] == (0, 1)


def test_resume_state_uses_verified_set_for_nonprefix_existing_snapshot(
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
        built_collection.output_directory / "snapshots" / "t01",
        work / "payload" / "snapshots" / "t01",
    )
    observed_state = []
    calls = []
    real_batch = collection_module.build_velocity_cog_snapshot_batch

    def inspect_state(*args, **kwargs):
        calls.append(tuple(item.time_index for item in kwargs["items"]))
        observed_state.append(json.loads(
            work.joinpath("state.json").read_text(encoding="utf-8")
        )["verifiedTimeIndices"])
        return real_batch(*args, **kwargs)

    monkeypatch.setattr(
        collection_module,
        "build_velocity_cog_snapshot_batch",
        inspect_state,
    )

    result = build_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0, 1),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
        collection_budget=_collection_budget(),
        resume=True,
    )

    assert calls == [(0,)]
    assert observed_state == [[1]]
    assert verify_velocity_cog_collection(result.output_directory, deep=True)[
        "timeIndices"
    ] == (0, 1)


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

    with pytest.raises(
        ValueError,
        match="runtime identity|storage identity|page-set identity",
    ):
        verify_velocity_cog_collection(output, deep=False)


def test_collection_verifier_rejects_root_symlink_alias(
    built_collection,
    tmp_path,
):
    alias = tmp_path / "collection-alias"
    alias.symlink_to(built_collection.output_directory, target_is_directory=True)

    with pytest.raises(ValueError, match="symbolic link"):
        verify_velocity_cog_collection(alias, deep=False)


def test_fixed_collection_identity_only_verification_cross_checks_resolution(
    fixed_collection,
    tmp_path,
):
    verified = verify_velocity_cog_collection(
        fixed_collection.output_directory,
        deep=False,
    )
    runtime = json.loads(
        fixed_collection.runtime_manifest_path.read_text(encoding="utf-8")
    )
    assert verified["contentVersion"] == fixed_collection.content_version
    assert runtime["sourceCeiling"] == {
        "tileMatrixSetId": "WebMercatorQuad",
        "matrixId": "10",
        "selectionRelation": "explicitly-requested",
    }
    assert runtime["tileMatrixSet"]["tileMatrixIds"] == [
        str(matrix) for matrix in range(4, 11)
    ]
    assert any(page["matrixId"] == "10" for page in runtime["pages"])

    output = tmp_path / "cog-collection"
    shutil.copytree(fixed_collection.output_directory, output)
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    plan = manifest["construction"]["facts"]["sharedSnapshotContract"]["plan"]
    plan["resolution"]["requested"]["matrixId"] = "09"
    manifest["construction"]["sha256"] = hashlib.sha256(
        json.dumps(
            manifest["construction"]["facts"],
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="resolution identity"):
        verify_velocity_cog_collection(output, deep=False)


def test_collection_identity_rejects_a_source_ceiling_below_z9(
    fixed_collection,
):
    manifest = json.loads(fixed_collection.manifest_path.read_text(encoding="utf-8"))
    runtime_bytes = fixed_collection.runtime_manifest_path.read_bytes()
    plan = manifest["construction"]["facts"]["sharedSnapshotContract"]["plan"]
    plan["resolution"]["requested"]["matrixId"] = "8"
    plan["resolution"]["resolved"] = {
        "matrixSet": "WebMercatorQuad",
        "matrixId": "8",
        "matrixPixelSizeMeters": web_mercator_matrix_pixel_size(8),
    }
    plan["matrixDecision"] = {
        "selectedMatrixId": "8",
        "outputMatrixId": "8",
        "relation": "explicitly-requested",
    }
    plan["grid"]["matrixId"] = "8"
    facts = manifest["construction"]["facts"]
    manifest["construction"]["sha256"] = hashlib.sha256(
        json.dumps(facts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    with pytest.raises(ValueError, match="at least z9"):
        _validate_collection_manifest_identity(manifest, runtime_bytes)


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


@pytest.mark.parametrize("target", ["schema", "shared-schema", "page-index-adapter"])
def test_collection_rejects_mixed_old_and_new_versions_after_rehash(built_collection, target):
    manifest = json.loads(built_collection.manifest_path.read_text(encoding="utf-8"))
    facts = manifest["construction"]["facts"]
    if target == "schema":
        manifest["schemaVersion"] = 2
    elif target == "shared-schema":
        facts["sharedSnapshotContract"].pop("snapshotSchemaVersion")
    else:
        facts["runtimePageIndex"]["adapterVersion"] = "flow-cog-wmq-rg32f-v2"
    manifest["construction"]["sha256"] = hashlib.sha256(json.dumps(
        facts, sort_keys=True, separators=(",", ":")
    ).encode()).hexdigest()
    with pytest.raises(ValueError, match="construction version"):
        _validate_collection_manifest_identity(manifest, built_collection.runtime_manifest_path.read_bytes())


@pytest.mark.parametrize("schema", [[], {}, True, 2.0, "3"])
def test_collection_rejects_invalid_schema_types_as_contract_errors(schema):
    with pytest.raises(ValueError, match="manifest contract"):
        _validate_collection_manifest_identity({"schemaVersion": schema}, b"{}")


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


def test_collection_validator_cross_binds_source_field_count(
    built_collection,
):
    manifest = json.loads(built_collection.manifest_path.read_text(encoding="utf-8"))
    runtime_bytes = built_collection.runtime_manifest_path.read_bytes()
    facts = manifest["construction"]["facts"]
    facts["source"]["fieldCount"] = 3
    facts["selection"]["sourceFieldCount"] = 3
    facts["selection"]["coverage"] = "subset"
    facts["request"]["source"]["fieldCount"] = 3
    facts["request"]["selection"]["coverage"] = "subset"
    facts["requestSha256"] = hashlib.sha256(
        json.dumps(
            facts["request"],
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    manifest["construction"]["sha256"] = hashlib.sha256(
        json.dumps(
            facts,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    with pytest.raises(ValueError, match="semantic contract"):
        _validate_collection_manifest_identity(manifest, runtime_bytes)


def test_collection_validator_binds_selected_filename_to_snapshot_identity(
    built_collection,
):
    manifest = json.loads(built_collection.manifest_path.read_text(encoding="utf-8"))
    runtime_bytes = built_collection.runtime_manifest_path.read_bytes()
    facts = manifest["construction"]["facts"]
    descriptor_identity = facts["source"]["descriptorIdentity"]
    descriptor_identity["fields"][0]["file"] = "renamed-uv-0.bin"
    changed_source_hash = source_descriptor_identity_manifest_hash(
        descriptor_identity
    )
    facts["source"]["sourceHash"] = changed_source_hash
    facts["request"]["source"]["sourceHash"] = changed_source_hash
    facts["runtimePageIndex"]["descriptorSha256"] = changed_source_hash
    facts["requestSha256"] = hashlib.sha256(
        json.dumps(
            facts["request"],
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    manifest["construction"]["sha256"] = hashlib.sha256(
        json.dumps(facts, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    with pytest.raises(ValueError, match="semantic contract"):
        _validate_collection_manifest_identity(manifest, runtime_bytes)


@pytest.mark.parametrize(
    "mutation",
    (
        lambda page_index: page_index.update({"invented": True}),
        lambda page_index: page_index.update({"limits": []}),
        lambda page_index: page_index.update({"timeMaximumSpeeds": []}),
        lambda page_index: page_index.update({"maximumSpeed": 999.0}),
    ),
)
def test_collection_validator_cross_binds_complete_runtime_page_index(
    built_collection,
    mutation,
):
    manifest = json.loads(built_collection.manifest_path.read_text(encoding="utf-8"))
    runtime_bytes = built_collection.runtime_manifest_path.read_bytes()
    page_index = manifest["construction"]["facts"]["runtimePageIndex"]
    mutation(page_index)
    manifest["construction"]["sha256"] = hashlib.sha256(
        json.dumps(
            manifest["construction"]["facts"],
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()

    with pytest.raises(
        ValueError,
        match="semantic contract|runtime contract|runtime page index",
    ):
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


def test_collection_progress_emits_one_failed_terminal_after_started_error(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    sink = RecordingSink()

    def fail_runtime_index(*_args, **_kwargs):
        raise RuntimeError("synthetic runtime index failure")

    monkeypatch.setattr(
        collection_module,
        "build_cog_runtime_page_index",
        fail_runtime_index,
    )

    with pytest.raises(RuntimeError, match="runtime index failure"):
        build_velocity_cog_collection(
            synthetic_source.directory,
            tmp_path / "cog-collection",
            time_indices=(0,),
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_resolution(),
            snapshot_budget=_snapshot_budget(),
            collection_budget=_collection_budget(),
            progress=sink,
        )

    started = next(
        event
        for event in sink.events
        if event.event == "job.started" and event.stage == "collection"
    )
    job_events = [event for event in sink.events if event.job_id == started.job_id]
    terminals = [
        event for event in job_events if event.event in {"job.completed", "job.failed"}
    ]
    assert [event.sequence for event in job_events] == list(
        range(1, len(job_events) + 1)
    )
    assert [(event.event, event.sequence) for event in terminals] == [
        ("job.failed", job_events[-1].sequence),
    ]
    assert job_events[-1].event == "job.failed"


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
        "sampleKey": "t01",
        "timeIndex": 1,
        "modelTime": 1.75,
        "unit": "hour",
        "phase": "unspecified",
        "sourceHash": descriptor["fields"][1]["sha256"],
    }]
    assert runtime["temporal"] == {
        "coverage": "subset",
        "sourceSampleCount": 2,
        "sampleAdjacency": [],
    }
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


def test_resume_preserves_a_dangling_snapshot_target(
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
    )
    work = _prepare_collection_work(output, plan, resume=False)
    target = work / "payload" / "snapshots" / "t00"
    target.symlink_to(tmp_path / "missing-target", target_is_directory=True)

    with pytest.raises(ValueError, match="snapshot target is invalid"):
        build_velocity_cog_collection(
            synthetic_source.directory,
            output,
            time_indices=(0,),
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_resolution(),
            snapshot_budget=_snapshot_budget(),
            resume=True,
        )

    assert target.is_symlink()
    assert not target.exists()


def test_batch_promotion_preserves_a_snapshot_target_that_appears_later(
    synthetic_source,
    tmp_path,
    monkeypatch,
):
    output = tmp_path / "cog-collection"
    plan = plan_velocity_cog_collection(
        synthetic_source.directory,
        output,
        time_indices=(0,),
        descriptor_path=synthetic_source.descriptor_path,
        resolution=_resolution(),
        snapshot_budget=_snapshot_budget(),
    )
    work = output.parent / f".{output.name}.work-{plan.request_sha256[:24]}"
    target = work / "payload" / "snapshots" / "t00"
    real_batch = collection_module.build_velocity_cog_snapshot_batch

    def inject_target(*args, **kwargs):
        result = real_batch(*args, **kwargs)
        target.symlink_to(tmp_path / "later-missing", target_is_directory=True)
        return result

    monkeypatch.setattr(
        collection_module,
        "build_velocity_cog_snapshot_batch",
        inject_target,
    )

    with pytest.raises(
        collection_module.CogCollectionConflictError,
        match="appeared during build",
    ):
        build_velocity_cog_collection(
            synthetic_source.directory,
            output,
            time_indices=(0,),
            descriptor_path=synthetic_source.descriptor_path,
            resolution=_resolution(),
            snapshot_budget=_snapshot_budget(),
        )

    assert target.is_symlink()
    assert not target.exists()
    assert work.joinpath("snapshot-builds", "t00", "cog-cache").is_dir()


@pytest.mark.parametrize("discard_incomplete", (False, True))
def test_resume_never_deletes_unmarked_incomplete_staging_by_name(
    tmp_path,
    discard_incomplete,
):
    build_parent = tmp_path / "snapshot-build"
    build_parent.mkdir()
    residue = build_parent / ".cog-cache.build-user-data"
    residue.mkdir()
    residue.joinpath("keep.txt").write_text("belongs to user\n", encoding="utf-8")

    with pytest.raises(ValueError, match="unmarked"):
        _recover_snapshot_build(
            build_parent,
            resume=True,
            request_sha256="a" * 64,
            time_index=0,
            discard_incomplete=discard_incomplete,
        )

    assert not build_parent.joinpath(
        collection_module.COG_SNAPSHOT_WORK_MARKER
    ).exists()
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
